// One-off LIVE preview → posts the twice-daily recap format to #server so you
// can see it rendered in real Discord (keeps #valheim pristine). Shows a normal
// evening crown AND the new 🌟 Unsung Hero spotlight. Read-only: crafts sample
// stats through the REAL formatRecap + selectPlayerOfDay, writes no state/DB.
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
    '🔎 **Preview — Player of the Day.** (Pilot: recaps currently post here to **#server** at 8 AM & 10 PM; will move to #valheim at launch.) Two samples below: a normal evening, then the new **🌟 Unsung Hero** spotlight that occasionally crowns a quieter viking.',
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
  deathsBoard: [
    { name: 'Bjorn', total: 14, delta: 2 }, { name: 'Knut', total: 11, delta: 5 },
    { name: 'Sigrid', total: 7, delta: 1 }, { name: 'Astrid', total: 3, delta: 0 },
    { name: 'Leif', total: 2, delta: 0 },
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
  deathsBoard: [
    { name: 'Bjorn', total: 17, delta: 3 }, { name: 'Knut', total: 13, delta: 2 },
    { name: 'Sigrid', total: 7, delta: 0 }, { name: 'Astrid', total: 3, delta: 0 },
  ],
  poty: potyB,
}));

console.log('✓ live preview posted to #server');
poster.destroy();
process.exit(0);
