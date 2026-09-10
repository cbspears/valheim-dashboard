// One-shot: re-ingest images that tagged the bot in the last N hours (default 3).
// Uses the live gallery ingest, which skips anything already stored. Launch
// night 2026-09-09: two 4K screenshots were skipped by the old 12 MB cap.
import fs from 'node:fs';
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { Client, GatewayIntentBits, ChannelType } = await import('discord.js');
const { createGalleryIngest } = await import('../src/gallery.js');
const hours = Number(process.argv[2] || 3);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
await client.login(process.env.DISCORD_TOKEN);
await new Promise((r) => client.once('ready', r));
const ingest = createGalleryIngest({ client, log: console });
const guild = await client.guilds.fetch(process.env.GUILD_ID);
const channels = await guild.channels.fetch();
const after = String((BigInt(Date.now() - hours * 3600_000 - 1420070400000) << 22n));
let seen = 0, fed = 0;
for (const ch of channels.values()) {
  if (!ch || ch.type !== ChannelType.GuildText) continue;
  let msgs;
  try { msgs = await ch.messages.fetch({ after, limit: 100 }); } catch (e) { console.log(`skip #${ch.name}: ${e.message}`); continue; }
  for (const msg of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
    if (!msg.attachments.size || !msg.mentions.has(client.user)) continue;
    seen++;
    console.log(`feeding #${ch.name} ${msg.author.username} ${new Date(msg.createdTimestamp).toISOString().slice(11, 16)} (${msg.attachments.size} attachment(s))`);
    await ingest.handleMessage(msg); fed++;
  }
}
console.log(`done: ${seen} tagged image message(s) fed`);
await client.destroy();
process.exit(0);
