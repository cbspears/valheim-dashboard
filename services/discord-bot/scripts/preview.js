// One-off preview: post a connection test + a sample recap to #server so you
// can see the formatting live before launch (keeps #valheim pristine).
//
// ⚠️ THIS POSTS FOR REAL. It logs in to Discord and writes two messages to
// #server. It is NOT a dry run: `npm run dry-run` is the non-posting preview.
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

// 2) Sample recap → #server (the real one posts nightly at 23:00 CT after launch)
const recap = createRecap({ db, post: poster.post, state: {}, saveState: async () => {}, tz: process.env.TZ });
const stats = await recap.buildStats('morning');
await poster.post('server', {
  content:
    '🔎 *Preview: this is the nightly recap. The real one posts to **#valheim** at 11 PM CT once the server launches:*',
});
await poster.post('server', formatRecap(stats));

console.log('✓ preview posted to #server');
poster.destroy();
process.exit(0);
