// One-off LIVE preview → posts the nightly recap format to #server so you can
// see it rendered in real Discord (keeps #valheim pristine). Shows a normal
// evening crown AND the 🌟 Unsung Hero spotlight. Writes no state/DB: it crafts
// sample stats through the REAL formatRecap + selectPlayerOfDay.
//
// ⚠️ THIS POSTS FOR REAL. It logs in to Discord and writes three messages to
// #server. It is NOT a dry run: `npm run dry-run` is the non-posting preview.
//   node scripts/preview-recap-live.js   (runs from anywhere; loads ../.env)
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

import { createDiscordPoster } from '../src/discord.js';
import { formatRecap } from '../src/format.js';
import { selectPlayerOfDay } from '../src/recap.js';

const poster = await createDiscordPoster({
  token: process.env.DISCORD_TOKEN,
  channels: { server: process.env.CHANNEL_SERVER, valheim: process.env.CHANNEL_VALHEIM },
});
const post = (p) => poster.post('server', p);

// Intro — clearly mark this as a preview so the channel isn't confused.
await post({
  content:
    '🔎 **Preview: Player of the Day.** (Pilot: the nightly recap currently posts here to **#server** at 11 PM CT; it moves to #valheim at launch.) Two samples below: a normal evening, then the **🌟 Unsung Hero** spotlight that occasionally crowns a quieter viking.',
});

// Sample 1 — a normal evening → 💀 The Bold (most deaths).
const potyA = selectPlayerOfDay({
  windowDeaths: { Knut: 5, Bjorn: 2, Sigrid: 1 },
  lastCause: { Knut: 'drowned in the swamp' },
  hours: { Knut: 3.5, Bjorn: 4.2, Sigrid: 5.0, Astrid: 1.2 },
  seed: 18,
});
await post(formatRecap({
  period: 'evening', playersActive: 4, hoursPlayed: 13.9, deaths: 8, bossKills: [],
  onlineNow: 2, worldDay: 18, quiet: false,
  onlineToday: [
    { name: 'Sigrid', hours: 5.0 }, { name: 'Bjorn', hours: 4.2 },
    { name: 'Knut', hours: 3.5 }, { name: 'Astrid', hours: 1.2 },
  ],
  fallenToday: [
    { name: 'Knut', count: 5 }, { name: 'Bjorn', count: 2 }, { name: 'Sigrid', count: 1 },
  ],
  poty: potyA,
}));

// Sample 2 — the 🌟 Unsung Hero spotlight (Astrid, the quietest who showed up).
const potyB = selectPlayerOfDay({
  windowDeaths: { Bjorn: 3, Knut: 2 }, lastCause: { Bjorn: 'was crushed by a troll' },
  hours: { Bjorn: 5.0, Knut: 3.2, Sigrid: 2.4, Astrid: 0.7 },
  lastWinner: 'Knut', winStreak: 0, forceUnderdog: true, seed: 19,
});
await post(formatRecap({
  period: 'evening', playersActive: 4, hoursPlayed: 11.3, deaths: 5, bossKills: [],
  onlineNow: 1, worldDay: 19, quiet: false,
  onlineToday: [
    { name: 'Bjorn', hours: 5.0 }, { name: 'Knut', hours: 3.2 },
    { name: 'Sigrid', hours: 2.4 }, { name: 'Astrid', hours: 0.7 },
  ],
  fallenToday: [
    { name: 'Bjorn', count: 3 }, { name: 'Knut', count: 2 },
  ],
  poty: potyB,
}));

console.log('✓ live preview posted to #server');
poster.destroy();
process.exit(0);
