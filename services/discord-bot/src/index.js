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

async function main() {
  if (DRY) return runDryRun();
  return runLive();
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
  // One tick at a time, per loop. setInterval fires on the clock, not on
  // completion: without this guard a slow Discord or Supabase call lets the
  // next tick start on the SAME cursor and post the same events twice (the
  // relay reads `> lastEventAt` and only advances it after each post).
  const safe = (label, fn) => {
    let running = false;
    return async () => {
      if (stopped) return;
      if (running) {
        console.log(`[${label}] previous tick still running, skipping this one`);
        return;
      }
      running = true;
      try {
        await fn();
        recordLoopResult(label, true);
      } catch (e) {
        console.error(`[${label}]`, e.message);
        recordLoopResult(label, false, e.message);
      } finally {
        running = false;
      }
    };
  };

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

async function runDryRun() {
  console.log('=== DRY RUN (no Discord login; printing would-be posts) ===');
  const state = {}; // ephemeral
  const saveState = async () => {};
  const post = createDryRunPoster().post;

  // Replay recent history so we can see feed formatting against demo data.
  state.relay = { lastEventAt: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString() };
  // Force boss announcements to print for already-felled demo bosses.
  state.announcedBosses = [];

  const relay = createRelay({ db, post, state, saveState });
  const bosses = createBossWatcher({ db, post, state, saveState });
  const recap = createRecap({ db, post, state, saveState, tz: TZ });

  console.log('\n--- #server feed (recent events) ---');
  const posted = await relay.tick();
  console.log(`(relayed ${posted} feed messages)`);

  console.log('\n--- #valheim boss kills ---');
  const bk = await bosses.tick();
  console.log(`(would announce ${bk} boss kills)`);

  console.log('\n--- #valheim daily recap (morning) ---');
  await recap.postRecap('morning');

  console.log('\n=== DRY RUN complete ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('[bot] fatal:', err.message);
  process.exit(1);
});
