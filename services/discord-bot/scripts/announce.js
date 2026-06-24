// Post a manual @everyone announcement to #valheim.
//   node scripts/announce.js "The server is migrating to the Eilif world tonight!"
import 'dotenv/config';
import { createDiscordPoster } from '../src/discord.js';
import { formatAnnouncement } from '../src/format.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: node scripts/announce.js "Your announcement"');
  process.exit(1);
}

const poster = await createDiscordPoster({
  token: process.env.DISCORD_TOKEN,
  channels: { valheim: process.env.CHANNEL_VALHEIM },
});
await poster.post('valheim', formatAnnouncement(text));
console.log('✓ announced to #valheim');
poster.destroy();
process.exit(0);
