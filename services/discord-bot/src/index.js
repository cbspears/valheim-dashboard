// Eilif Discord bot entrypoint.
//   real mode : login, relay events -> #server, announce boss kills + recaps -> #valheim
//   dry-run   : no Discord login; print what it would post (validates formatting)
import 'dotenv/config';
import { loadState, saveState as persistState } from './state.js';
import { readClient, serviceClient } from './supabase.js';
import { createDiscordPoster, createDryRunPoster } from './discord.js';
import { createRelay } from './relay.js';
import { createBossWatcher } from './bosses.js';
import { createRecap } from './recap.js';
import { createEventsSync } from './events.js';
import { createGalleryIngest } from './gallery.js';
import { createOathIngest } from './oaths.js';
import { createVoiceEngine } from './voice.js';

const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const POLL = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
const TZ = process.env.TZ || 'America/Chicago';
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

  const relay = createRelay({ db, post, state, saveState });
  const bosses = createBossWatcher({ db, post, state, saveState });
  const writeDb = process.env.SUPABASE_SERVICE_ROLE_KEY ? serviceClient() : null;
  if (!writeDb) console.warn('[recap] no SUPABASE_SERVICE_ROLE_KEY — Player-of-the-Day archive disabled');

  // Optional: the Voice of the Hall brain. Off by default (VOICE_ENGINE=1).
  // Created before the recap so the evening POTY crown can hook into it.
  const voice = process.env.VOICE_ENGINE === '1'
    ? createVoiceEngine({ client: poster.client, db, post, state, saveState })
    : null;

  const recap = createRecap({
    db, post, state, saveState, writeDb, tz: TZ, startsAt: recapsStart,
    onPotyCrowned: voice ? voice.announcePoty : null,
  });

  await bosses.init(); // seed already-felled bosses so we don't retro-announce
  await saveState();
  recap.schedule();

  let stopped = false;
  const safe = (label, fn) => async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (e) {
      console.error(`[${label}]`, e.message);
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

  // Optional: the Voice of the Hall — ambient cadence + event lines queued to
  // the voice_lines table for the in-game Eilif plugin, plus `@Eilif say:`.
  if (voice) {
    voice.attach();
    const voiceLoop = safe('voice', () => voice.tick());
    await voiceLoop();
    timers.push(setInterval(voiceLoop, 60000));
    extra += ', voice engine on';
  }

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
