// At-least-once delivery, the half that was missing.
//
// THE BUG (red-team, 2026-09-05). tick() restores this.offset and this.partial
// when a dispatch fails, so the same bytes are re-read next tick — "duplicates
// beat losses". But LogParser mutates its OWN state (online, nameToSteam,
// steamToName, pendingConnections) as a side effect of parsing, and
// tickAfterFetch parses the WHOLE batch before dispatching any of it. So a
// failure on the first event still left the parser advanced past the entire
// batch, and processLine only emits a join `if (!alreadyOnline)` — on the
// re-read, the join was simply gone.
//
// What that costs: the #server arrival line, the attendance grid entry, and that
// viking's session hours in the recap. `sync` self-heals players.is_online within
// ~120s, but it opens no `sessions` row — those are created only on a real join.
// A webhook 500 or a network blip on launch night is exactly the scenario the
// rewind was written for.
//
// Fully offline — no SFTP, no webhook. Run:
//   node test-rewind.js   (from services/log-poller)
import { Poller } from './src/poller.js';

let failed = 0;
const check = (label, pass) => {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed++;
};

const LINES = [
  '[Info   : Unity Log] 06/24/2026 18:01:10: Got connection SteamID 76561198000000001',
  '[Info   : Unity Log] 06/24/2026 18:01:15: Got character ZDOID from Bren : 12345:1',
  '[Info   : Unity Log] 06/24/2026 18:03:00: Got character ZDOID from Bren : 0:0',
];
const BATCH = LINES.join('\n') + '\n';

/** A poller wired to one canned batch, with the webhook replaced by `dispatch`. */
function harness(dispatch) {
  const p = new Poller(
    { statePath: '/dev/null', syncEveryMs: 24 * 3600 * 1000 },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  p.fetchNewBytes = async () => ({ text: BATCH, size: BATCH.length, mtimeMs: Date.now() });
  p.updateLiveness = async () => {};
  p.saveState = async () => {};
  // The periodic roster sync is not what is under test here, and it would
  // otherwise fire on the first tick (lastSyncAt starts at 0).
  p.lastSyncAt = Date.now();
  p.dispatch = dispatch;
  return p;
}

// ── The failing tick, then the re-read ──────────────────────────────────────
{
  const pass1 = [];
  const pass2 = [];
  let phase = 1;
  const p = harness(async (ev) => {
    const tag = `${ev.type}:${ev.characterName ?? ''}`;
    if (phase === 1) {
      pass1.push(tag);
      // The first event of the batch fails, exactly as a webhook 500 would.
      throw new Error('webhook 500: the whole batch is rewound');
    }
    pass2.push(tag);
  });

  let threw = false;
  try {
    await p.tick();
  } catch {
    threw = true;
  }
  check('a failed dispatch still rethrows, so the caller knows the tick failed', threw);
  check('the byte cursor was rewound', p.offset === 0);
  check('the join was the event being dispatched when it failed', pass1[0] === 'join:Bren');

  phase = 2;
  await p.tick();
  console.log(`  pass 1 dispatched: [${pass1.join(', ')}]`);
  console.log(`  pass 2 dispatched: [${pass2.join(', ')}]`);

  // THE ASSERTION. Before the parser snapshot, pass 2 was ['death:Bren'] — the
  // join had been consumed by the parser on pass 1 and could never be re-emitted.
  check("the re-read emits Bren's join again (duplicates beat losses)", pass2.includes('join:Bren'));
  check('and her death with it', pass2.includes('death:Bren'));
  check('in the original order', pass2.indexOf('join:Bren') < pass2.indexOf('death:Bren'));
  check('the cursor advanced on the successful pass', p.offset === BATCH.length);
  check('and the roster is right afterwards', p.parser.roster().join(',') === 'Bren');
}

// ── A successful tick is unaffected ─────────────────────────────────────────
{
  const seen = [];
  const p = harness(async (ev) => { seen.push(`${ev.type}:${ev.characterName ?? ''}`); });
  await p.tick();
  check('a clean tick dispatches join then death, in order', seen.join(',') === 'join:Bren,death:Bren');

  // The snapshot must not be RESTORED on success — that would undo the parse and
  // re-emit the join every tick, which is the opposite failure.
  await p.tick();
  check(
    'a second tick over the same bytes does NOT invent a second join',
    seen.filter((t) => t === 'join:Bren').length === 1,
  );
}

console.log(failed === 0 ? '\nOK — parser state is rewound with the byte cursor' : `\nFAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
