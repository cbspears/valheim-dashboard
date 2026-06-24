// One-off preview: post a connection test + a sample daily recap to #server
// so you can see the formatting live before launch (keeps #valheim pristine).
//   node scripts/preview.js
import 'dotenv/config';
import { readClient } from '../src/supabase.js';
import { createDiscordPoster } from '../src/discord.js';
import { createRecap } from '../src/recap.js';
import { formatRecap } from '../src/format.js';

const db = readClient();
const poster = await createDiscordPoster({
  token: process.env.DISCORD_TOKEN,
  channels: { server: process.env.CHANNEL_SERVER, valheim: process.env.CHANNEL_VALHEIM },
});

// 1) Connection test → #server
await poster.post('server', {
  content:
    '⚔️ **Eilif bot** is online and watching the realm. Joins, leaves, deaths, and raids will appear here as they happen.',
});

// 2) Sample daily recap → #server (the real one posts to #valheim at 8 AM / 10 PM after launch)
const recap = createRecap({ db, post: poster.post, state: {}, saveState: async () => {}, tz: process.env.TZ });
const stats = await recap.buildStats('morning');
await poster.post('server', {
  content:
    '🔎 *Preview — this is the daily recap. The real one posts to **#valheim** at 8 AM & 10 PM once the server launches (Sept 9):*',
});
await poster.post('server', formatRecap(stats));

console.log('✓ preview posted to #server');
poster.destroy();
process.exit(0);
