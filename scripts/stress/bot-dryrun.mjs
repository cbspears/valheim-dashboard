#!/usr/bin/env node
// A LONG-RUNNING dry-run Discord bot for the stress test.
//
// WHY THIS EXISTS RATHER THAN `npm run dry-run`. The bot's own dry-run
// (services/discord-bot/package.json → `DRY_RUN=1 node src/index.js`, index.js
// runDryRun) is a ONE-SHOT: it replays one relay tick, one boss tick and one
// recap, prints them, and calls process.exit(0). It never constructs the
// milestones announcer, the titles announcer, the voice engine, the identity
// loops or the heartbeat — so the four loops most likely to misbehave at 20
// players are exactly the ones its dry-run cannot exercise, and it cannot stay
// running alongside a load test at all.
//
// This driver builds the SAME modules the live path builds (imported straight
// out of services/discord-bot/src, no copies), wires them to the dry-run poster
// (which prints instead of posting to Discord), and runs them on a loop against
// whatever database SUPABASE_URL points at. Nothing here can reach Discord:
// there is no token, no gateway login, and `post` is createDryRunPoster().post.
//
//   BOT_DIR      services/discord-bot (default: resolved from this file)
//   TITLES_API   http://localhost:3400/api/titles
//   INTERVALS    RELAY_MS BOSS_MS MILESTONES_MS TITLES_MS VOICE_MS VOICE_EXPIRE_MS
//   GAPS         MILESTONE_MIN_GAP_MS VOICE_MIN_GAP_MS
//   CLOCK        BOT_COMPRESSION (see below)
//
// ⚠️ THE CLOCK, AND WHY EVERY NUMBER BELOW IS DERIVED RATHER THAN TYPED.
//
// The load harness replays a simulated minute every TICK_MS (2 s by default) —
// a 30x speed-up — so an evening's worth of deeds, titles and voice lines lands
// in thirteen real minutes. Run this bot at production cadence against that and
// it measures the wrong thing: 21 deeds at one per 120 s tick is 42 minutes of
// trickle, and the run is over long before. Run it with the anti-spam gaps
// switched OFF and it measures the wrong thing in the opposite direction — a bot
// that will never exist, announcing a burst production would have spaced out.
//
// So both the loop intervals AND the anti-spam gaps are the PRODUCTION values
// divided by one declared factor, BOT_COMPRESSION (default 30, i.e. 60000/TICK_MS).
// That keeps the ratio between gap, tick and simulated clock exactly what
// production runs at, which is the thing the anti-spam behaviour actually
// depends on. BOT_COMPRESSION=1 gives literal production values for a real-time
// rehearsal. Every effective value is printed at startup with its production
// counterpart, so no evidence this bot produces can be read without knowing what
// it was configured as.
//
// Run it with the LOCAL Supabase env only. See docs/STRESS-TEST.md.

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = process.env.BOT_DIR || resolve(here, '../../services/discord-bot');
const src = (f) => pathToFileURL(resolve(BOT_DIR, 'src', f)).href;

// Loopback HOSTNAME, not the substring: "localhost.example.com" contains it.
const loopbackHost = (u) => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (!process.env.SUPABASE_URL || !loopbackHost(process.env.SUPABASE_URL)) {
  console.error(`[bot-dryrun] SUPABASE_URL must be the LOCAL stack (got ${process.env.SUPABASE_URL ?? 'nothing'}). Refusing to run.`);
  process.exit(2);
}
if (process.env.DISCORD_TOKEN) {
  // Belt and braces: nothing in this file logs in, but an inherited token in the
  // environment is a smell worth refusing rather than explaining later.
  console.error('[bot-dryrun] DISCORD_TOKEN is set. Refusing to run — unset it.');
  process.exit(2);
}

const { readClient, serviceClient } = await import(src('supabase.js'));
const { createDryRunPoster } = await import(src('discord.js'));
const { createRelay } = await import(src('relay.js'));
const { createBossWatcher } = await import(src('bosses.js'));
const { createRecap } = await import(src('recap.js'));
const { createVoiceEngine } = await import(src('voice.js'));
const { createTitlesAnnouncer } = await import(src('titles.js'));
const { createMilestonesAnnouncer } = await import(src('milestones.js'));

const db = readClient();
const writeDb = serviceClient();
const post = createDryRunPoster().post;

// ── the clock ────────────────────────────────────────────────────────────────
//
// PRODUCTION values, read out of services/discord-bot/src/index.js so the
// comparison in the banner is against the real thing:
//   relay          POLL_INTERVAL_MS      15000   (index.js:22, :119)
//   bosses                               30000   (index.js:119)
//   milestones     MILESTONES_INTERVAL_MS 120000  (index.js:227)
//   titles         TITLES_INTERVAL_MS    600000  (index.js:197)
//   voice                                60000   (index.js:173)
//   voice-expire                        300000   (index.js:179)
//   deed gap       MILESTONE_MIN_GAP_MS  60000   (index.js:212, milestones.js:34)
//   ambient gap    VOICE_MIN_GAP_MS    1800000   (index.js:69)
const PRODUCTION = {
  RELAY_MS: 15000,
  BOSS_MS: 30000,
  MILESTONES_MS: 120000,
  TITLES_MS: 600000,
  VOICE_MS: 60000,
  VOICE_EXPIRE_MS: 300000,
  MILESTONE_MIN_GAP_MS: 60000,
  VOICE_MIN_GAP_MS: 1800000,
};

const parsedCompression = parseInt(process.env.BOT_COMPRESSION || '', 10);
const COMPRESSION = Number.isFinite(parsedCompression) && parsedCompression > 0 ? parsedCompression : 30;

const effective = {};
const provenance = {};
for (const [key, prod] of Object.entries(PRODUCTION)) {
  const raw = parseInt(process.env[key] ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) {
    effective[key] = raw;
    provenance[key] = 'ENV OVERRIDE';
  } else {
    // Floor at 250 ms so a large compression factor cannot turn a loop into a
    // busy-wait against the database.
    effective[key] = COMPRESSION === 1 ? prod : Math.max(250, Math.round(prod / COMPRESSION));
    provenance[key] = COMPRESSION === 1 ? 'production' : `production/${COMPRESSION}`;
  }
}

// Ephemeral state, like the real dry run — nothing is persisted to state.json.
const state = { relay: { lastEventAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }, announcedBosses: [] };
const saveState = async () => {};

// The voice engine only uses `client` to attach a messageCreate handler for
// `@Eilif say:`; a stub keeps the whole engine (ambient cadence, dawn lines,
// deed lines, death tiers, the queue writer) running with no gateway.
const stubClient = { on: () => {}, isReady: () => false, ws: { status: null } };

const relay = createRelay({ db, post, state, saveState });
const bosses = createBossWatcher({ db, post, state, saveState });
const recap = createRecap({ db, post, state, saveState, writeDb, tz: process.env.TZ || 'America/Chicago', channel: 'server' });
const voice = createVoiceEngine({
  client: stubClient,
  db,
  post,
  state,
  saveState,
  writeDb,
  minGapMs: effective.VOICE_MIN_GAP_MS,
});
const titles = createTitlesAnnouncer({
  db,
  post,
  writeDb,
  apiUrl: process.env.TITLES_API || 'http://localhost:3400/api/titles',
  channel: 'server',
});
const milestones = createMilestonesAnnouncer({
  db,
  writeDb,
  post,
  state,
  saveState,
  minGapMs: effective.MILESTONE_MIN_GAP_MS,
  channel: 'server',
});

let stopped = false;
const safe = (label, fn) => {
  let running = false;
  return async () => {
    if (stopped || running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${label}]`, e?.message ?? e);
    } finally {
      running = false;
    }
  };
};

await bosses.init();
voice.attach();

const loops = [
  ['relay', () => relay.tick(), effective.RELAY_MS],
  ['bosses', () => bosses.tick(), effective.BOSS_MS],
  ['milestones', () => milestones.tick(), effective.MILESTONES_MS],
  ['titles', () => titles.tick(), effective.TITLES_MS],
  ['voice', () => voice.tick(), effective.VOICE_MS],
  ['voice-expire', () => voice.expireStale(), effective.VOICE_EXPIRE_MS],
];

const timers = [];
for (const [label, fn, interval] of loops) {
  const loop = safe(label, fn);
  await loop();
  timers.push(setInterval(loop, interval));
}

// Declare the configuration in full BEFORE any evidence comes out of it. A
// number this bot produces (deeds announced, voice lines queued) means nothing
// without the cadence and the gaps it was produced under.
console.log(`[bot-dryrun] running against ${process.env.SUPABASE_URL}. Nothing posts to Discord.`);
console.log(`[bot-dryrun] clock: BOT_COMPRESSION=${COMPRESSION}${COMPRESSION === 1 ? ' (literal production values)' : ` (production values / ${COMPRESSION}, matching TICK_MS=${Math.round(60000 / COMPRESSION)})`}`);
const widest = Math.max(...Object.keys(PRODUCTION).map((k) => k.length));
for (const key of Object.keys(PRODUCTION)) {
  console.log(
    `[bot-dryrun]   ${key.padEnd(widest)}  production ${String(PRODUCTION[key]).padStart(7)}ms  ->  ` +
      `effective ${String(effective[key]).padStart(7)}ms  (${provenance[key]})`,
  );
}

// A recap on demand, so the recap formatting is exercised against the stressed
// data without waiting for 23:00 CT.
if (process.env.RECAP_NOW === '1') {
  await recap.postRecap('evening').catch((e) => console.error('[recap]', e?.message ?? e));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
    console.log(`[bot-dryrun] ${sig} — stopped`);
    process.exit(0);
  });
}
