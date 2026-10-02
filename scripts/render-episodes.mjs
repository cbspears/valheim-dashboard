// Render the last N real nights of the Story page, in the terminal.
//
// WHY: the episode narrative (lib/episodes.ts) is pure template work with no
// LLM in it, so the only way to judge the VOICE is to read it against real
// data. This does exactly what app/events/page.tsx does — the same ten reads,
// the same buildEpisodes call — and prints each night's tier, title and
// description instead of rendering a card.
//
// It is a read-only development tool. It writes nothing and is not part of
// `npm test` (that glob is *.test.mjs).
//
//   export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//   npx tsx scripts/render-episodes.mjs [nights]
//
// Needs .env.local (Supabase URL + anon key; the service-role key as well, or
// the quotes are silently absent because `chat_lines` is service-role only).
import fs from 'node:fs';
import path from 'node:path';

// .env.local is loaded by Next, not by node, so load it here before anything
// imports lib/data.ts and reads process.env at module scope.
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// supabase-js constructs a RealtimeClient in its constructor and Node 20 has
// no global WebSocket. Nothing here subscribes to anything, so a stub is
// enough to get past the check; Node 22 does not need it.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class NoRealtimeWebSocket {
    constructor() {
      throw new Error('realtime is not used by this script');
    }
  };
}

const {
  getSessionsSince,
  getEventsSince,
  getOaths,
  getPinsForEpisodes,
  getTales,
  getTitleAwardsSince,
  getPotyAwardsSince,
  getFirstSeenByCharacter,
  getChatLinesSince,
  getKilledBosses,
  getBossFightSeconds,
} = await import('../lib/data.ts');
const { buildEpisodes, notability, BIG_NIGHT_SCORE } = await import('../lib/episodes.ts');
const { daysAgoCtKey } = await import('../lib/tales.ts');

const WINDOW_DAYS = 70;
const nights = Number(process.argv[2] ?? 7) || 7;

const [
  sessions, sagaEvents, oaths, pins, tales,
  titleAwards, potyAwards, firstSeen, chatLines, bossFights, bossFightSeconds,
] = await Promise.all([
    getSessionsSince(WINDOW_DAYS),
    getEventsSince(WINDOW_DAYS),
    getOaths(),
    getPinsForEpisodes(WINDOW_DAYS),
    getTales({ sinceDay: daysAgoCtKey(WINDOW_DAYS), limit: 200 }),
    getTitleAwardsSince(WINDOW_DAYS).catch(() => []),
    getPotyAwardsSince(WINDOW_DAYS).catch(() => []),
    getFirstSeenByCharacter().catch(() => []),
    getChatLinesSince(WINDOW_DAYS).catch(() => []),
    getKilledBosses().catch(() => []),
    getBossFightSeconds().catch(() => ({})),
  ]);

console.log(
  `reads: ${sessions.length} sessions, ${sagaEvents.length} events, ${titleAwards.length} title awards, ` +
    `${potyAwards.length} crowns, ${firstSeen.length} first sightings, ${chatLines.length} shouts, ` +
    `${bossFights.length} felled bosses\n`
);

const episodes = buildEpisodes(sessions, sagaEvents, oaths, pins, tales, {
  titleAwards,
  potyAwards,
  firstSeen,
  chatLines,
  bossFights,
  bossFightSeconds,
});

const CT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

for (const ep of episodes.slice(-nights)) {
  const { score, reasons } = notability(ep);
  // The tier is DECIDED by rank over the whole list (lib/episodes.ts
  // assignTiers) and carried on the episode; the score only picks the closing
  // pool, which is what "BIG" marks here.
  const tier =
    ep.tier === 'expressive' ? (score >= BIG_NIGHT_SCORE ? 'EXPRESSIVE/big' : 'EXPRESSIVE') : 'terse';
  console.log(`── Night ${ep.number} · ${CT.format(new Date(ep.startedAt))} · ${tier} (score ${score})`);
  if (reasons.length) console.log(`   why: ${reasons.join('; ')}`);
  console.log(`   ${ep.participants.length} vikings, ${ep.totalVikingHours} h, ${ep.deaths.length} deaths`);
  console.log(`   TITLE: ${ep.title}`);
  console.log(`   ${ep.description}\n`);
}
