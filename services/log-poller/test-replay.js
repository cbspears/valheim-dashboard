// REPLAY AFTER A HANG (2026-09-12, the second half of the incident).
//
// The poller was wedged for 4.5 h (see test-hang.js). When it was restarted the
// remote log had been rotated, the shrink check correctly rewound the cursor to
// 0 — and the catch-up then dispatched four hours of history AS IF IT WERE
// LIVE: 12 joins, 6 leaves, 10 deaths, 4 shouts and 1 oath into #server inside
// three minutes, with every re-created session stamped joined_at = the replay's
// wall clock, so played-hours were undercounted.
//
// Two rules now. A line whose own stamp is older than REPLAY_STALE_MS (measured
// against the NEWEST line in the same batch — the box's timezone is unknown, so
// only differences between two log stamps mean anything; see
// parser.js parseLogLineTime) carries its real `occurredAt` to the webhook, and
// is NOT announced in Discord a second time. A fresh line behaves exactly as it
// always did: no occurredAt on the wire, mirror posts.
//
// Fully offline — no SFTP, no webhook, no Discord. Run:
//   node test-replay.js   (from services/log-poller)
import { Poller } from './src/poller.js';
import { parseLogLineTime } from './src/parser.js';

let failed = 0;
const check = (label, pass) => {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed++;
};

/**
 * A poller wired to one canned batch, with the webhook and Discord replaced by
 * recorders. Mirrors test-rewind.js's harness.
 */
function harness(lines) {
  const posted = []; // dashboard-webhook payloads
  const mirrored = []; // Discord chat-mirror bodies
  const warns = [];
  const text = lines.join('\r\n') + '\r\n'; // the GTX box is Windows: CRLF
  const p = new Poller(
    {
      statePath: '/dev/null',
      syncEveryMs: 24 * 3600 * 1000,
      chatWebhookUrl: 'https://discord.example/webhook',
    },
    { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
  );
  p.fetchNewBytes = async () => ({ text, size: text.length, mtimeMs: Date.now() });
  p.updateLiveness = async () => {};
  p.saveState = async () => {};
  p.lastSyncAt = Date.now();
  p.postEvent = async (payload) => {
    posted.push(payload);
    return {};
  };
  p.discordFetch = async (_url, init) => {
    mirrored.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  return { p, posted, mirrored, warns };
}

const unity = (stamp, rest) => `[Info   : Unity Log] ${stamp}: ${rest}`;
const pluginChat = (name, text) => `[Info   :Eilif Companion] [EILIF_CHAT] ${name} | ${text}`;
const of = (posted, type) => posted.filter((e) => e.type === type);

// ── 0. The line clock itself ────────────────────────────────────────────────
{
  const a = parseLogLineTime(unity('09/12/2026 08:42:02', 'Console: hi'));
  const b = parseLogLineTime(unity('09/12/2026 12:42:02', 'Console: hi'));
  check('a stamped line parses', Number.isFinite(a));
  check('and the DIFFERENCE between two is the real elapsed time', b - a === 4 * 3600 * 1000);
  check('an unstamped plugin line has no clock of its own', parseLogLineTime(pluginChat('Bren', 'x')) === null);
  check('nor does an unstamped junk line', parseLogLineTime('no date here') === null);
  check('an impossible reading is refused, not rolled over', parseLogLineTime('13/40/2026 08:00:00:') === null);
  check('and so is a nonsense hour', parseLogLineTime('09/12/2026 25:00:00:') === null);
}

// ── 1. THE REPLAY. Four hours of history caught up in one batch ─────────────
{
  const { p, posted, mirrored, warns } = harness([
    unity('09/12/2026 08:00:10', 'Got connection SteamID 76561198000000001'),
    unity('09/12/2026 08:00:15', 'Got character ZDOID from Bren : 12345:1'),
    // A plugin-captured shout: BepInEx writes it WITHOUT a timestamp, so it
    // inherits the clock of the Unity line above it. Before that carry-forward
    // this line was mirrored into #server on every replay.
    pluginChat('Bren', 'the longhouse is finished'),
    unity('09/12/2026 08:30:00', 'Got character ZDOID from Bren : 0:0'),
    // The tail of the log: written moments before this poll, so THIS is "now".
    unity('09/12/2026 12:30:00', 'Connections 0 ZDOS: 12345'),
  ]);

  const tickAt = Date.now();
  await p.tick();

  const join = of(posted, 'join')[0];
  const death = of(posted, 'death')[0];
  const chat = of(posted, 'chat')[0];
  check('the replayed join reached the webhook', Boolean(join));
  check('the replayed death reached the webhook', Boolean(death));
  check('the replayed shout reached the webhook', Boolean(chat));

  // (1) The events carry the time they REALLY happened, not the catch-up's.
  const joinMs = Date.parse(join?.occurredAt ?? '');
  const deathMs = Date.parse(death?.occurredAt ?? '');
  const chatMs = Date.parse(chat?.occurredAt ?? '');
  check('the join carries its own occurredAt', Number.isFinite(joinMs));
  check(
    'dated 4h29m45s before the catch-up, exactly as the log says',
    Math.abs(tickAt - joinMs - (4 * 3600 + 29 * 60 + 45) * 1000) < 2000,
  );
  check('the death is 30 minutes after the join, to the second', deathMs - joinMs === 29 * 60 * 1000 + 45 * 1000);
  check('the unstamped plugin shout inherited the join line\'s clock', chatMs === joinMs);
  check('and every replayed time is in the PAST (clampEventTime leaves those alone)', joinMs < tickAt && deathMs < tickAt);

  // (2) Nothing was announced in Discord a second time.
  check('the Discord chat mirror posted NOTHING for the replay', mirrored.length === 0);

  // (3) One summary line, not one line per replayed event.
  const summary = warns.filter((w) => w.startsWith('[replay] replayed'));
  check('exactly one [replay] summary line', summary.length === 1);
  check(`it counts lines, events and suppressions — "${summary[0]}"`,
    /^\[replay\] replayed \d+ lines, \d+ events, chat mirror suppressed for 1 lines$/.test(summary[0] ?? ''));
}

// ── 2. LIVE BEHAVIOUR IS UNCHANGED ──────────────────────────────────────────
// The same lines, all inside the 2-minute window: no backdating, no
// suppression, no summary line. This is the ordinary 20 s poll.
{
  const { p, posted, mirrored, warns } = harness([
    unity('09/12/2026 12:30:10', 'Got connection SteamID 76561198000000001'),
    unity('09/12/2026 12:30:15', 'Got character ZDOID from Bren : 12345:1'),
    pluginChat('Bren', 'the longhouse is finished'),
    unity('09/12/2026 12:30:40', 'Connections 1 ZDOS: 12345'),
  ]);
  await p.tick();

  const join = of(posted, 'join')[0];
  check('a fresh join still reaches the webhook', Boolean(join));
  check('with NO occurredAt — the webhook stamps it now, exactly as before', join?.occurredAt === undefined);
  check('the fresh shout IS mirrored to Discord', mirrored.length === 1);
  check('as the player, with the text intact', /longhouse is finished/.test(mirrored[0]?.content ?? ''));
  check('and no [replay] summary line is printed', warns.every((w) => !w.startsWith('[replay] replayed')));
}

// ── 3. A batch with no stamped line at all is treated as live ───────────────
// A log-format change must degrade to "behave as it did in August", never to
// "silently backdate everything".
{
  const { p, posted, mirrored } = harness([
    pluginChat('Bren', 'hello'),
    'Got character ZDOID from Bren : 12345:1',
  ]);
  await p.tick();
  check('unstamped batch: nothing is backdated', posted.every((e) => e.occurredAt === undefined));
  check('unstamped batch: the mirror still works', mirrored.length === 1);
}

// ── 4. Dedupe is untouched ──────────────────────────────────────────────────
// The twin suppression (plugin line + console echo of the same shout) predates
// all of this and must behave identically on a replayed batch.
{
  const { p, posted } = harness([
    unity('09/12/2026 08:00:15', 'Got character ZDOID from Bren : 12345:1'),
    pluginChat('Bren', 'skal'),
    unity('09/12/2026 08:00:16', 'Console: <color=orange>Bren</color>: <color=#FFEB04FF>SKAL</color>'),
    unity('09/12/2026 12:30:00', 'Connections 1 ZDOS: 12345'),
  ]);
  await p.tick();
  const chats = of(posted, 'chat');
  check('the echo twin is still suppressed on a replay (one chat, not two)', chats.length === 1);
  check('and it is the plugin line that survived (raw casing)', chats[0]?.message === 'skal');
}

// ── 5. The clock never runs forward ─────────────────────────────────────────
// A box clock that steps BACKWARDS mid-log would otherwise date an event after
// "now", which is the one thing lib/event-time.ts clamps away.
{
  const p = new Poller({ statePath: '/dev/null' }, { info: () => {}, warn: () => {}, error: () => {} });
  const now = 1_000_000_000;
  const batch = [{ type: 'join', logTimeMs: 5000 }, { type: 'join', logTimeMs: 9_000_000 }];
  const r = p.anchorBatchTimes(batch, [5000, 9_000_000], now, 120000);
  check('the newest line anchors to now', batch[1].occurredAtMs === undefined || batch[1].occurredAtMs <= now);
  check('an out-of-order (future) stamp is never dated ahead of now', batch.every((e) => (e.occurredAtMs ?? 0) <= now));
  check('and the old one is marked stale', batch[0].stale === true && r.staleEvents === 1);
}

console.log(
  failed === 0
    ? '\nOK — replayed history keeps its own timestamps and stays out of Discord'
    : `\nFAILED (${failed})`,
);
process.exit(failed === 0 ? 0 : 1);
