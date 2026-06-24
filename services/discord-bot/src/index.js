// Eilif Discord bot entrypoint.
//   real mode : login, relay events -> #server, announce boss kills + recaps -> #valheim
//   dry-run   : no Discord login; print what it would post (validates formatting)
import 'dotenv/config';
import { loadState, saveState as persistState } from './state.js';
import { readClient } from './supabase.js';
import { createDiscordPoster, createDryRunPoster } from './discord.js';
import { createRelay } from './relay.js';
import { createBossWatcher } from './bosses.js';
import { createRecap } from './recap.js';

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
  const recap = createRecap({ db, post, state, saveState, tz: TZ, startsAt: recapsStart });

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
  const t1 = setInterval(relayLoop, POLL);
  const t2 = setInterval(bossLoop, 30000);

  console.log(`[bot] live. relay every ${POLL}ms, boss check every 30s.`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[bot] ${sig} — shutting down`);
      stopped = true;
      clearInterval(t1);
      clearInterval(t2);
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
