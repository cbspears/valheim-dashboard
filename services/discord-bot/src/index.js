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
  const voice = process.env.VOICE_ENGINE === '1'
    ? createVoiceEngine({ client: poster.client, db, post, state, saveState })
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
  const safe = (label, fn) => async () => {
    if (stopped) return;
    try {
      await fn();
      recordLoopResult(label, true);
    } catch (e) {
      console.error(`[${label}]`, e.message);
      recordLoopResult(label, false, e.message);
    }
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
    });
    const interval = parseInt(process.env.TITLES_INTERVAL_MS || '600000', 10);
    const titlesLoop = safe('titles', () => titles.tick());
    await titlesLoop();
    timers.push(setInterval(titlesLoop, interval));
    extra += `, titles every ${interval}ms${process.env.TITLES_DRY === '1' ? ' (dry)' : ''}`;
  }

  // Collective Milestones ("Great Deeds"): announce achieved-but-unannounced
  // deeds to #valheim, one per tick. On by default (MILESTONES_ANNOUNCE=0 to
  // disable); needs the service-role client to write announced_at. Tolerates the
  // milestones table not existing yet (logs once, skips).
  if (process.env.MILESTONES_ANNOUNCE !== '0') {
    const milestones = createMilestonesAnnouncer({
      db,
      writeDb,
      post,
      channel: process.env.MILESTONE_CHANNEL || 'valheim',
    });
    const interval = parseInt(process.env.MILESTONES_INTERVAL_MS || '120000', 10);
    const milestonesLoop = safe('milestones', () => milestones.tick());
    await milestonesLoop();
    timers.push(setInterval(milestonesLoop, interval));
    extra += `, milestones every ${interval}ms`;
  }

  // Ops cockpit heartbeat: reports this bot's liveness + its gated sub-loops'
  // last-run/last-error/enabled state, plus non-secret pilot-flag booleans the
  // cockpit needs to flag before launch. Best-effort — sendHeartbeat never
  // throws (see heartbeat.js), and skips entirely if OPS_HEARTBEAT_TOKEN unset.
  const sendHeartbeat = createHeartbeatSender('discord-bot');
  const heartbeatTick = async () => {
    if (stopped) return;
    const snapshot = loopsSnapshot();
    const subLoopEnabled = {
      relay: true,
      bosses: true,
      'events-sync': process.env.EVENTS_SYNC === '1',
      'gallery-ingest': process.env.GALLERY_INGEST === '1',
      'oath-ingest': process.env.OATH_INGEST === '1',
      'identity-link': process.env.IDENTITY_LINK !== '0',
      'identity-confirm': process.env.IDENTITY_LINK !== '0',
      'voice-queue': Boolean(voice),
      'title-evaluator': process.env.TITLES_ANNOUNCE !== '0',
      'milestone-evaluator': process.env.MILESTONES_ANNOUNCE !== '0',
    };
    const subLoops = {};
    for (const [key, enabled] of Object.entries(subLoopEnabled)) {
      subLoops[key] = { enabled, ...(snapshot[key] || {}) };
    }
    await sendHeartbeat({
      status: 'ok',
      metrics: {
        subLoops,
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
