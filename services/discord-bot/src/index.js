// Eilif Discord bot entrypoint.
//   real mode : login, relay events -> #server, announce boss kills + recaps -> #valheim
//   dry-run   : no Discord login; print what it would post (validates formatting)
import 'dotenv/config';
import { loadState, saveState as persistState } from './state.js';
import { readClient, serviceClient } from './supabase.js';
import { createDiscordPoster, createDryRunPoster } from './discord.js';
import { createRelay } from './relay.js';
import { createBossWatcher } from './bosses.js';
import { createSkald } from './retelling.js';
import { createRecap } from './recap.js';
import { createEventsSync } from './events.js';
import { createGalleryIngest } from './gallery.js';
import { createOathIngest } from './oaths.js';
import { createIdentityLink, createIdentityConfirmations } from './identity.js';
import { createVoiceEngine } from './voice.js';
import { createTitlesAnnouncer } from './titles.js';
import { createMilestonesAnnouncer } from './milestones.js';
import { createChronicle } from './chronicle.js';
import { createBossPolls, createDiscordPollAdapter, createDryRunPollAdapter } from './bosspoll.js';
import { recordLoopResult, loopsSnapshot, createHeartbeatSender } from './heartbeat.js';

const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const POLL = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
const TZ = process.env.TZ || 'America/Chicago';
// Server launch date — also used to flag a pilot RECAPS_START pulled forward
// of it in the ops cockpit (see the heartbeat loop below).
const LAUNCH_DATE = new Date('2026-09-09T00:00:00');
// Recaps stay silent until this date (server launch). Invalid/unset => no gate.
const recapsStart = (() => {
  if (!process.env.RECAPS_START) return null;
  const d = new Date(`${process.env.RECAPS_START}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    console.warn('[recap] invalid RECAPS_START, ignoring gate');
    return null;
  }
  return d;
})();

const db = readClient();

// `--loop` keeps the DRY RUN running instead of exiting after one tick of each
// loop. It means nothing in live mode (the live bot always loops).
const DRY_LOOP = process.argv.includes('--loop');

// ── Two engagement features, both OFF unless their flag is exactly '1' ───────
// Nothing about launch night changes until Charlie flips them. Each prints ONE
// startup line saying which way it is set, in live mode and in the dry run.
const CHRONICLE_ON = process.env.WEEKLY_CHRONICLE === '1';
const BOSS_POLLS_ON = process.env.BOSS_POLLS === '1';
const CHRONICLE_CHANNEL = process.env.CHRONICLE_CHANNEL === 'server' ? 'server' : 'valheim';
const BOSS_POLL_CHANNEL = process.env.BOSS_POLL_CHANNEL === 'server' ? 'server' : 'valheim';
// Sunday 20:00 local, hour tunable the way RECAP_EVENING_HOUR is.
const CHRONICLE_HOUR = (() => {
  const n = parseInt(process.env.CHRONICLE_HOUR || '20', 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 20;
})();
const CHRONICLE_WEEKDAY = 0; // Sunday

async function main() {
  if (DRY) return runDryRun({ loop: DRY_LOOP });
  return runLive();
}

// One tick at a time, per loop. setInterval fires on the clock, not on
// completion: without this guard a slow Discord or Supabase call lets the
// next tick start on the SAME cursor and post the same events twice (the
// relay reads `> lastEventAt` and only advances it after each post).
//
// Shared by runLive and runDryRun so a rehearsal wraps its loops exactly the
// way production does, including recording each tick for the ops cockpit.
function makeSafe(isStopped) {
  return (label, fn) => {
    let running = false;
    return async () => {
      if (isStopped()) return;
      if (running) {
        console.log(`[${label}] previous tick still running, skipping this one`);
        return;
      }
      running = true;
      try {
        const result = await fn();
        recordLoopResult(label, true);
        return result;
      } catch (e) {
        console.error(`[${label}]`, e.message);
        recordLoopResult(label, false, e.message);
      } finally {
        running = false;
      }
    };
  };
}

/** setInterval must never be handed a NaN — that turns a loop into a busy-wait. */
function intervalMs(raw, fallback) {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function runLive() {
  const state = await loadState();
  const saveState = () => persistState(state);

  const poster = await createDiscordPoster({
    token: process.env.DISCORD_TOKEN,
    channels: { server: process.env.CHANNEL_SERVER, valheim: process.env.CHANNEL_VALHEIM },
  });
  const post = poster.post;

  const writeDb = process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null;
  if (!writeDb) console.warn('[recap] no SUPABASE_SERVICE_ROLE_KEY — Player-of-the-Day archive disabled');

  const relay = createRelay({ db, post, state, saveState });
  // The Skald writes a saga retelling once per newly-felled boss (best-effort;
  // never blocks the boss announcement). Needs the service-role client to persist.
  const skald = createSkald({ db, writeDb });
  const bosses = createBossWatcher({ db, post, state, saveState, skald });

  // Optional: the Voice of the Hall brain. Off by default (VOICE_ENGINE=1).
  // Created before the recap so the evening POTY crown can hook into it.
  // VOICE_MIN_GAP_MS gates AMBIENT lines only (atmosphere + callback): no ambient
  // line within this many ms of the last voice line of any kind. Dawn lines,
  // deeds, death milestones, POTY, titles and oath echoes are exempt.
  const voiceMinGapMs = parseInt(process.env.VOICE_MIN_GAP_MS || '1800000', 10);
  const voice = process.env.VOICE_ENGINE === '1'
    ? createVoiceEngine({
        client: poster.client, db, post, state, saveState,
        minGapMs: Number.isFinite(voiceMinGapMs) ? voiceMinGapMs : 1800000,
      })
    : null;

  const recap = createRecap({
    db, post, state, saveState, writeDb, tz: TZ, startsAt: recapsStart,
    onPotyCrowned: voice ? voice.announcePoty : null,
    channel: process.env.RECAP_CHANNEL || 'valheim',
  });

  await bosses.init(); // seed already-felled bosses so we don't retro-announce
  await saveState();
  recap.schedule();

  let stopped = false;
  const safe = makeSafe(() => stopped);

  const relayLoop = safe('relay', () => relay.tick());
  const bossLoop = safe('bosses', () => bosses.tick());

  // Kick once, then interval.
  await relayLoop();
  await bossLoop();
  const timers = [setInterval(relayLoop, POLL), setInterval(bossLoop, 30000)];

  // Optional: mirror Discord scheduled events to the dashboard. Off by default
  // (EVENTS_SYNC=1) so the seeded demo events stay put until real events exist.
  let extra = '';
  if (process.env.EVENTS_SYNC === '1') {
    const events = createEventsSync({
      client: poster.client,
      guildId: process.env.GUILD_ID,
      webhookUrl: process.env.WEBHOOK_URL,
      webhookSecret: process.env.WEBHOOK_SECRET,
    });
    const interval = parseInt(process.env.EVENTS_INTERVAL_MS || '600000', 10);
    const eventsLoop = safe('events', () => events.tick());
    await eventsLoop();
    timers.push(setInterval(eventsLoop, interval));
    extra += `, events every ${interval}ms`;
  }

  // Optional: ingest photos posted to Discord that @mention the bot.
  if (process.env.GALLERY_INGEST === '1') {
    createGalleryIngest({ client: poster.client }).attach();
    extra += ', gallery ingest on';
  }

  // Optional: record sworn oaths (+ bio/role) posted to Discord that @mention
  // the bot. Off by default (OATH_INGEST=1) like the gallery ingest.
  if (process.env.OATH_INGEST === '1') {
    createOathIngest({ client: poster.client }).attach();
    extra += ', oath ingest on';
  }

  // Discord↔character identity: `@Eilif I am <name>` mints a claim code (the
  // in-game `/oath <CODE>` webhook is what actually links it). On by default
  // (core to attaching photos to vikings); disable with IDENTITY_LINK=0.
  if (process.env.IDENTITY_LINK !== '0') {
    createIdentityLink({ client: poster.client }).attach();
    extra += ', identity link on';

    // Confirms claims once the webhook has consumed them (DMs the player,
    // marks announced_at). Same on/off gate as the mint side above.
    const identityConfirm = createIdentityConfirmations({ client: poster.client });
    const identityConfirmLoop = safe('identity-confirm', () => identityConfirm.tick());
    await identityConfirmLoop();
    timers.push(setInterval(identityConfirmLoop, 30000));
    extra += ', identity confirmations on';
  }

  // Optional: the Voice of the Hall — ambient cadence + event lines queued to
  // the voice_lines table for the in-game Eilif plugin, plus `@Eilif say:`.
  if (voice) {
    voice.attach();
    const voiceLoop = safe('voice', () => voice.tick());
    await voiceLoop();
    timers.push(setInterval(voiceLoop, 60000));
    // Expiring stale queued lines rides its OWN timer, not the voice tick: it
    // must keep running while the hall is empty AND while a voice tick is stuck
    // on a slow read (the in-flight guard above would otherwise skip it too).
    const expireLoop = safe('voice-expire', () => voice.expireStale());
    await expireLoop();
    timers.push(setInterval(expireLoop, 300000));
    extra += ', voice engine on';
  }

  // Living titles: poll the dashboard's /api/titles (the shared epithet engine)
  // and announce when a viking's title changes. On by default (TITLES_ANNOUNCE=0
  // to disable); needs the service-role client to write the registry.
  if (process.env.TITLES_ANNOUNCE !== '0') {
    const titles = createTitlesAnnouncer({
      db,
      post,
      writeDb,
      apiUrl: process.env.TITLES_API_URL || 'https://valheim-dashboard.vercel.app/api/titles',
      dryRun: process.env.TITLES_DRY === '1',
      // Titles have always proclaimed in #server, so 'server' stays the default.
      // Launch value is 'valheim' if titles should follow deeds/oaths/recaps.
      channel: process.env.TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server',
    });
    const interval = parseInt(process.env.TITLES_INTERVAL_MS || '600000', 10);
    const titlesLoop = safe('titles', () => titles.tick());
    await titlesLoop();
    timers.push(setInterval(titlesLoop, interval));
    extra += `, titles every ${interval}ms${process.env.TITLES_DRY === '1' ? ' (dry)' : ''}`;
  }

  // Collective Milestones ("Great Deeds"): announce achieved-but-unannounced
  // deeds — Discord embed + in-game voice line together — one per tick, oldest
  // first, with MILESTONE_MIN_GAP_MS (default 1 min) of quiet between deeds so
  // a burst still lands one deed at a time. On by default
  // (MILESTONES_ANNOUNCE=0 to disable); needs the service-role client to write
  // announced_at + voice_lines. Tolerates the milestones table not existing yet.
  if (process.env.MILESTONES_ANNOUNCE !== '0') {
    const MILESTONE_GAP_DEFAULT_MS = 60000;
    const parsedMilestoneGap = parseInt(process.env.MILESTONE_MIN_GAP_MS || '', 10);
    // Sanitized once, so a garbage env value can't reach the announcer OR the
    // startup log as NaN — both see the fallback number.
    const milestoneMinGapMs = Number.isFinite(parsedMilestoneGap) && parsedMilestoneGap >= 0
      ? parsedMilestoneGap
      : MILESTONE_GAP_DEFAULT_MS;
    const milestones = createMilestonesAnnouncer({
      db,
      writeDb,
      post,
      state,
      saveState,
      minGapMs: milestoneMinGapMs,
      channel: process.env.MILESTONE_CHANNEL || 'valheim',
    });
    const interval = parseInt(process.env.MILESTONES_INTERVAL_MS || '120000', 10);
    const milestonesLoop = safe('milestones', () => milestones.tick());
    await milestonesLoop();
    timers.push(setInterval(milestonesLoop, interval));
    extra += `, milestones every ${interval}ms (min gap ${milestoneMinGapMs}ms)`;
  }

  // The Skald's Chronicle: one weekly embed (Sunday 20:00 local by default).
  // OFF unless WEEKLY_CHRONICLE=1. Reads only; the sole write is state.json
  // (the weekly kill baseline + the last week it posted). It honours the same
  // RECAPS_START launch gate the nightly recap does, so flipping the flag on
  // before the world opens cannot publish a week of pre-launch demo rows.
  if (CHRONICLE_ON) {
    const chronicle = createChronicle({
      db,
      post,
      state,
      saveState,
      tz: TZ,
      channel: CHRONICLE_CHANNEL,
      hour: CHRONICLE_HOUR,
      weekday: CHRONICLE_WEEKDAY,
      startsAt: recapsStart,
    });
    // Through safe() like every other loop: a weekly post that throws is then
    // recorded for the ops cockpit instead of vanishing into a console line for
    // seven days, and the in-flight guard covers a hand-triggered second run.
    chronicle.schedule(safe('chronicle', () => chronicle.runScheduled()));
  }
  console.log(
    `[chronicle] ${
      CHRONICLE_ON
        ? `ON — Sundays ${String(CHRONICLE_HOUR).padStart(2, '0')}:00 ${TZ} to #${CHRONICLE_CHANNEL}` +
          (recapsStart ? ` (begins ${recapsStart.toISOString().slice(0, 10)})` : '')
        : 'off (set WEEKLY_CHRONICLE=1 to enable)'
    }`
  );

  // Boss polls: one native Discord poll per next objective, one follow-up line
  // when that boss falls. OFF unless BOSS_POLLS=1.
  let bossPollsStarted = false;
  if (BOSS_POLLS_ON) {
    const bossPolls = createBossPolls({
      db,
      post,
      adapter: createDiscordPollAdapter({
        client: poster.client,
        channelIds: { server: process.env.CHANNEL_SERVER, valheim: process.env.CHANNEL_VALHEIM },
      }),
      state,
      saveState,
      channel: BOSS_POLL_CHANNEL,
    });
    // Seeding the already-felled set is a HARD PREREQUISITE, not a nicety: an
    // unseeded cursor makes every boss felled this season look fresh, and the
    // first tick would open a poll behind a kill from weeks ago. It is also the
    // one Supabase call on this path that is not inside safe(), so a blip must
    // not take the live bot down with it. Both answers are the same: log it and
    // leave the feature asleep for this run. The next restart tries again.
    try {
      await bossPolls.init();
      bossPollsStarted = true;
    } catch (e) {
      console.error(`[boss-polls] could not seed the already-felled bosses, polls stay off this run: ${e.message}`);
    }
    if (bossPollsStarted) {
      const interval = intervalMs(process.env.BOSS_POLLS_INTERVAL_MS, 60000);
      const bossPollsLoop = safe('boss-polls', () => bossPolls.tick());
      await bossPollsLoop();
      timers.push(setInterval(bossPollsLoop, interval));
      extra += `, boss polls every ${interval}ms`;
    }
  }
  console.log(
    `[boss-polls] ${
      !BOSS_POLLS_ON
        ? 'off (set BOSS_POLLS=1 to enable)'
        : bossPollsStarted
          ? `ON — first-blood polls to #${BOSS_POLL_CHANNEL}`
          : 'ON but not started (the felled-boss seed failed); restart the bot to try again'
    }`
  );

  // Ops cockpit heartbeat: reports this bot's liveness + its gated sub-loops'
  // last-run/last-error/enabled state, plus non-secret pilot-flag booleans the
  // cockpit needs to flag before launch. Best-effort — sendHeartbeat never
  // throws (see heartbeat.js), and skips entirely if OPS_HEARTBEAT_TOKEN unset.
  const sendHeartbeat = createHeartbeatSender('discord-bot');
  const heartbeatTick = async () => {
    if (stopped) return;
    const snapshot = loopsSnapshot();
    // Cockpit chip key -> { enabled, loop } where `loop` is the safe() label
    // that records results for it (null = an event handler with no loop of its
    // own, so it only ever reports `enabled`).
    const subLoopSpec = {
      relay: { enabled: true, loop: 'relay' },
      bosses: { enabled: true, loop: 'bosses' },
      'events-sync': { enabled: process.env.EVENTS_SYNC === '1', loop: 'events' },
      'gallery-ingest': { enabled: process.env.GALLERY_INGEST === '1', loop: null },
      'oath-ingest': { enabled: process.env.OATH_INGEST === '1', loop: null },
      'identity-link': { enabled: process.env.IDENTITY_LINK !== '0', loop: null },
      'identity-confirm': { enabled: process.env.IDENTITY_LINK !== '0', loop: 'identity-confirm' },
      'voice-queue': { enabled: Boolean(voice), loop: 'voice' },
      'title-evaluator': { enabled: process.env.TITLES_ANNOUNCE !== '0', loop: 'titles' },
      'milestone-evaluator': { enabled: process.env.MILESTONES_ANNOUNCE !== '0', loop: 'milestones' },
      // Both off by default; the cockpit iterates its OWN list (lib/ops/health.ts
      // BOT_SUBLOOPS), so these extra keys are simply ignored until it adds them.
      // 'chronicle' is the safe() label the weekly cron files its result under.
      'weekly-chronicle': { enabled: CHRONICLE_ON, loop: 'chronicle' },
      // `enabled` is what actually RUNS, not what the flag asked for: a failed
      // seed leaves the flag on and the loop asleep, and the cockpit should see
      // the second fact rather than wait forever for a tick that never comes.
      'boss-polls': { enabled: BOSS_POLLS_ON && bossPollsStarted, loop: 'boss-polls' },
    };
    const subLoops = {};
    let anyLoopFailing = false;
    for (const [key, { enabled, loop }] of Object.entries(subLoopSpec)) {
      const last = (loop && snapshot[loop]) || snapshot[key] || null;
      subLoops[key] = { enabled, ...(last || {}) };
      if (enabled && last && last.ok === false) anyLoopFailing = true;
    }
    // Gateway health: a bot whose REST still posts but whose gateway is down
    // (or the reverse) must not read as healthy.
    const gatewayReady = Boolean(poster.client?.isReady?.());
    const wsStatus = poster.client?.ws?.status ?? null;
    await sendHeartbeat({
      status: !gatewayReady || anyLoopFailing ? 'degraded' : 'ok',
      metrics: {
        subLoops,
        // Same object under both keys: `subLoops` is what the cockpit has always
        // read, `loops` is the newer name. Keep both until every reader moves.
        loops: subLoops,
        gatewayReady,
        wsStatus,
        // Non-secret pilot flags the cockpit warns about before launch.
        recapChannelIsServer: (process.env.RECAP_CHANNEL || 'valheim') === 'server',
        milestoneChannelIsServer: (process.env.MILESTONE_CHANNEL || 'valheim') === 'server',
        recapsStartPulledForward: recapsStart ? recapsStart.getTime() < LAUNCH_DATE.getTime() : false,
        timerCount: timers.length,
      },
    });
  };
  await heartbeatTick();
  timers.push(setInterval(heartbeatTick, 60000));

  console.log(`[bot] live. relay every ${POLL}ms, boss check every 30s${extra}.`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[bot] ${sig} — shutting down`);
      stopped = true;
      for (const t of timers) clearInterval(t);
      poster.destroy();
      process.exit(0);
    });
  }
}

// ── Dry run ─────────────────────────────────────────────────────────────────
//
// A REHEARSAL of the live bot, not a subset of it. It builds the same loops
// runLive builds — relay, bosses, the voice engine, the titles announcer, the
// milestones announcer and the recap — out of the same modules, honouring the
// same env gates, and ticks each one once (`--loop` keeps them running).
//
// It used to build only relay + bosses + recap, which meant the three loops
// whose behaviour actually changes at twenty players — milestones, titles and
// the voice engine — were exactly the three that could never be rehearsed.
//
// TWO GUARANTEES, both structural rather than by convention:
//
//  1. NOTHING LOGS IN TO DISCORD. `post` is createDryRunPoster().post, the
//     voice engine gets a stub client (it only ever uses `client` to attach a
//     messageCreate handler for `@Eilif say:`), and DISCORD_TOKEN is never
//     read — a dry run works with no token in the environment at all.
//  2. NOTHING IS WRITTEN. The announcers return at their first line without a
//     service-role client (titles.js:105, milestones.js:207), so handing them
//     `null` would rehearse nothing at all. They get a READ-ONLY PROXY
//     instead: selects pass straight through to the real client, and
//     insert/update/upsert/delete are printed and skipped. The whole
//     read → decide → format → post → record path runs; no row moves.
//
// Because the writes are skipped, nothing is ever marked announced — a second
// pass re-announces the same deed or title. That is the point of a rehearsal,
// and `--loop` says so on the way in.
//
// FIVE THINGS ARE DELIBERATELY NOT REHEARSED. Each is named in the output, so
// the gap is visible rather than silent:
//   • events-sync      — reads the guild's scheduled events over the gateway
//                        and POSTs them to the dashboard webhook (a real write).
//   • identity-confirm — builds its OWN service-role client inside identity.js
//                        (no injection seam) and DMs real Discord users.
//   • the message ingests (gallery / oath / identity-link) — event handlers
//                        with nothing to tick; a stub client never emits.
//   • the Skald retelling — a ~90 s local-LLM call per boss, and a dry run
//                        makes every already-felled boss look fresh.
//   • the ops heartbeat — would tell /admin/ops a bot is alive when none is.

/** Row-changing verbs. Everything else on a query builder is a read. */
const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);

function describePayload(payload) {
  if (payload === undefined) return 'no payload';
  try {
    const s = JSON.stringify(payload);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '[unserialisable payload]';
  }
}

/**
 * Chainable, awaitable stand-in for the builder a write verb returns: every
 * further call (.eq/.is/.select/.single/…) returns itself, and awaiting it
 * yields the shape supabase-js returns on success, so a caller that checks
 * `error` takes the happy path exactly as it would live.
 */
function dryWriteBuilder() {
  const result = { data: null, error: null, count: null, status: 200, statusText: 'OK (dry run)' };
  const chain = new Proxy(
    { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return () => chain;
      },
    }
  );
  return chain;
}

/** Wrap a real Supabase client so reads pass through and writes are printed. */
function createReadOnlyDb(real) {
  return {
    from(table) {
      const builder = real.from(table);
      return new Proxy(builder, {
        get(target, prop) {
          if (typeof prop === 'string' && WRITE_VERBS.has(prop)) {
            return (payload) => {
              console.log(`  [dry-run db] ${table}.${prop} SKIPPED — ${describePayload(payload)}`);
              return dryWriteBuilder();
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rpc(name) {
      console.log(`  [dry-run db] rpc ${name} SKIPPED`);
      return dryWriteBuilder();
    },
  };
}

/**
 * Stand-in for the gateway client. The voice engine only uses `client` to
 * attach a messageCreate handler, so this keeps the whole engine (ambient
 * cadence, dawn lines, deed lines, death tiers, the queue writer) running with
 * no login at all. Same shape as scripts/stress/bot-dryrun.mjs.
 */
function dryRunClient() {
  return { on: () => {}, once: () => {}, isReady: () => false, ws: { status: null } };
}

async function runDryRun({ loop = false } = {}) {
  console.log('=== DRY RUN — no Discord login, no database writes ===');

  const state = {
    // Replay a year of history so feed formatting is visible against real rows.
    relay: { lastEventAt: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString() },
    // Force boss announcements to print for already-felled bosses.
    announcedBosses: [],
  };
  const saveState = async () => {}; // ephemeral — state.json is never touched
  const post = createDryRunPoster().post;
  const client = dryRunClient();

  // `false`, not `null`: createVoiceEngine treats a nullish writeDb as "not
  // injected" and would build a REAL service client for itself (voice.js:154).
  const writeDb = process.env.SUPABASE_SERVICE_ROLE_KEY ? createReadOnlyDb(serviceClient()) : false;

  const voiceOn = process.env.VOICE_ENGINE === '1';
  const titlesOn = process.env.TITLES_ANNOUNCE !== '0';
  const milestonesOn = process.env.MILESTONES_ANNOUNCE !== '0';

  console.log(`[dry-run] supabase: ${process.env.SUPABASE_URL || '(unset)'}`);
  console.log('[dry-run] DISCORD_TOKEN is never read; no gateway login happens.');
  console.log(
    `[dry-run] writes: ${
      writeDb
        ? 'intercepted and printed (the service-role client is wrapped read-only)'
        : 'no SUPABASE_SERVICE_ROLE_KEY — voice, titles and milestones will report themselves disabled, exactly as they would live'
    }`
  );
  console.log(
    '[dry-run] loops: relay, bosses, recap, ' +
      `voice ${voiceOn ? 'on' : 'OFF (VOICE_ENGINE≠1)'}, ` +
      `titles ${titlesOn ? 'on' : 'OFF (TITLES_ANNOUNCE=0)'}, ` +
      `milestones ${milestonesOn ? 'on' : 'OFF (MILESTONES_ANNOUNCE=0)'}`
  );
  // Same two startup lines the live bot prints, so a rehearsal says out loud
  // which way each flag is set.
  console.log(
    `[chronicle] ${
      CHRONICLE_ON
        ? `ON — Sundays ${String(CHRONICLE_HOUR).padStart(2, '0')}:00 ${TZ} to #${CHRONICLE_CHANNEL} (rehearsed below, the cron is not started)`
        : 'off (set WEEKLY_CHRONICLE=1 to enable)'
    }`
  );
  console.log(
    `[boss-polls] ${
      BOSS_POLLS_ON
        ? `ON — first-blood polls to #${BOSS_POLL_CHANNEL} (rehearsed below; the poll is PRINTED, never sent)`
        : 'off (set BOSS_POLLS=1 to enable)'
    }`
  );
  console.log(
    '[dry-run] not rehearsed: events-sync (needs a live gateway, and POSTs to the webhook), ' +
      'identity-confirm (builds its own service-role client and DMs real users), ' +
      'the gallery/oath/identity-link ingests (event handlers — a stub client never emits), ' +
      'the Skald retelling (a ~90 s local LLM call per boss, best-effort live), ' +
      'the ops heartbeat (must not tell /admin/ops a bot is alive).'
  );
  console.log('[dry-run] the RECAPS_START gate is ignored here so recap formatting is always visible.');

  // Built in runLive's order: voice before the recap, so the evening Player of
  // the Day crown can hook into it.
  const voiceMinGapMs = parseInt(process.env.VOICE_MIN_GAP_MS || '1800000', 10);
  const voice = voiceOn
    ? createVoiceEngine({
        client,
        db,
        post,
        state,
        saveState,
        writeDb,
        minGapMs: Number.isFinite(voiceMinGapMs) ? voiceMinGapMs : 1800000,
      })
    : null;

  const relay = createRelay({ db, post, state, saveState });
  // No skald: it is best-effort and never blocks the boss announcement live,
  // but it calls a local LLM that takes ~90 s per boss — and a dry run forces
  // EVERY already-felled boss to look fresh. A three-minute "one tick" reads
  // as a hang. See the not-rehearsed line above.
  const bosses = createBossWatcher({ db, post, state, saveState });
  const recap = createRecap({
    db,
    post,
    state,
    saveState,
    writeDb: writeDb || null,
    tz: TZ,
    onPotyCrowned: voice ? voice.announcePoty : null,
    channel: process.env.RECAP_CHANNEL || 'valheim',
  });
  const titles = titlesOn
    ? createTitlesAnnouncer({
        db,
        post,
        writeDb: writeDb || null,
        apiUrl: process.env.TITLES_API_URL || 'https://valheim-dashboard.vercel.app/api/titles',
        dryRun: process.env.TITLES_DRY === '1',
        channel: process.env.TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server',
      })
    : null;
  const parsedMilestoneGap = parseInt(process.env.MILESTONE_MIN_GAP_MS || '', 10);
  const milestones = milestonesOn
    ? createMilestonesAnnouncer({
        db,
        post,
        state,
        saveState,
        writeDb: writeDb || null,
        minGapMs: Number.isFinite(parsedMilestoneGap) && parsedMilestoneGap >= 0 ? parsedMilestoneGap : 60000,
        channel: process.env.MILESTONE_CHANNEL || 'valheim',
      })
    : null;

  // The weekly Chronicle. The cron is NOT scheduled here (a dry run would have
  // to wait for Sunday); postChronicle is ticked once below instead, which is
  // the same read → format → post path the cron takes.
  const chronicle = CHRONICLE_ON
    ? createChronicle({
        db,
        post,
        state,
        saveState,
        tz: TZ,
        channel: CHRONICLE_CHANNEL,
        hour: CHRONICLE_HOUR,
        weekday: CHRONICLE_WEEKDAY,
      })
    : null;

  // Boss polls, with the printing adapter: the poll is rendered to stdout and
  // nothing is sent. `state` here is the ephemeral dry-run object, so the seed
  // starts empty and every already-felled boss looks fresh (like the boss
  // watcher above), which is exactly what makes the poll visible.
  const bossPolls = BOSS_POLLS_ON
    ? createBossPolls({
        db,
        post,
        adapter: createDryRunPollAdapter(),
        state,
        saveState,
        channel: BOSS_POLL_CHANNEL,
      })
    : null;

  // Proves the `@Eilif say:` wiring constructs and attaches; the stub never emits.
  if (voice) voice.attach();

  let stopped = false;
  const safe = makeSafe(() => stopped);

  // [safe() label, section heading, tick, one-line summary — omit it when the
  // return value says nothing a reader wants (the recap returns its whole
  // stats object, which would bury the embed it just printed).]
  const sections = [
    ['relay', '#server feed (recent events)', () => relay.tick(), (n) => `relayed ${n} feed messages`],
    ['bosses', '#valheim boss kills', () => bosses.tick(), (n) => `would announce ${n} boss kills`],
    ...(voice
      ? [
          ['voice', 'Voice of the Hall (queued lines)', () => voice.tick(), null],
          ['voice-expire', 'Voice queue — expire stale lines', () => voice.expireStale(), (n) => `${n} stale lines expired`],
        ]
      : []),
    ...(titles
      ? [
          [
            'titles',
            'Living titles',
            () => titles.tick(),
            (r) => `${r.seeded} seeded, ${r.announced} announced, ${r.unchanged} unchanged`,
          ],
        ]
      : []),
    ...(milestones
      ? [['milestones', 'Great Deeds (milestones)', () => milestones.tick(), (n) => `${n} deed(s) announced`]]
      : []),
    ...(bossPolls
      ? [
          [
            'boss-polls',
            'Boss polls (first blood)',
            async () => (await bossPolls.tick()) + (await bossPolls.rehearseFollowUp()),
            (n) => `${n} poll message(s) would be sent`,
          ],
        ]
      : []),
    ...(chronicle
      ? [["chronicle", "The Skald's Chronicle (weekly)", () => chronicle.postChronicle(), null]]
      : []),
    ['recap', 'Daily recap (evening — the one that posts nightly)', () => recap.postRecap('evening'), null],
    ['recap-morning', 'Daily recap (morning — preview only)', () => recap.postRecap('morning'), null],
  ];

  for (const [label, heading, fn, summarize] of sections) {
    console.log(`\n--- ${heading} ---`);
    const result = await safe(label, fn)();
    if (summarize && result !== undefined && result !== null) console.log(`(${summarize(result)})`);
  }

  console.log('\n--- what the ops cockpit would have been told ---');
  for (const [label, r] of Object.entries(loopsSnapshot())) {
    console.log(`  ${label.padEnd(14)} ${r.ok ? 'ok' : `FAILED — ${r.lastError}`}`);
  }

  if (!loop) {
    console.log('\n=== DRY RUN complete (one tick of every loop) ===');
    process.exit(0);
  }

  // ── --loop: the same loops, at production cadence, until Ctrl-C ──────────
  const timers = [
    setInterval(safe('relay', () => relay.tick()), POLL),
    setInterval(safe('bosses', () => bosses.tick()), 30000),
  ];
  if (voice) {
    timers.push(setInterval(safe('voice', () => voice.tick()), 60000));
    timers.push(setInterval(safe('voice-expire', () => voice.expireStale()), 300000));
  }
  if (titles) {
    timers.push(setInterval(safe('titles', () => titles.tick()), intervalMs(process.env.TITLES_INTERVAL_MS, 600000)));
  }
  if (milestones) {
    timers.push(
      setInterval(safe('milestones', () => milestones.tick()), intervalMs(process.env.MILESTONES_INTERVAL_MS, 120000))
    );
  }
  if (bossPolls) {
    timers.push(
      setInterval(safe('boss-polls', () => bossPolls.tick()), intervalMs(process.env.BOSS_POLLS_INTERVAL_MS, 60000))
    );
  }
  // The Chronicle has no steady-state timer on purpose: it is a weekly cron, and
  // a rehearsal that waited until Sunday 20:00 would rehearse nothing. Its one
  // tick above is the whole path the cron takes.

  console.log(`\n=== DRY RUN steady state — ${timers.length} loops at production cadence, Ctrl-C to stop ===`);
  console.log(
    '[dry-run] the writes are skipped, so nothing is ever marked announced: the same deed, title or boss re-announces on every pass.'
  );

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[dry-run] ${sig} — stopping`);
      stopped = true;
      for (const t of timers) clearInterval(t);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[bot] fatal:', err.message);
  process.exit(1);
});
