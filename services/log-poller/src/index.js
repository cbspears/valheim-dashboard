// Entrypoint: load config from env, start the poller, shut down cleanly.
import 'dotenv/config';
import { Poller } from './poller.js';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  source: process.env.LOG_SOURCE || 'sftp', // 'sftp' | 'file'
  logPath: process.env.LOG_PATH || 'BepInEx/LogOutput.log',
  webhookUrl: required('WEBHOOK_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '20000', 10),
  syncEveryMs: parseInt(process.env.SYNC_EVERY_MS || '120000', 10),
  // Emit log-derived `death` events? Default true. Flip to false once
  // GsValheimStatsClient feeds real causes via /api/gs-ingest (avoids double-count).
  emitDeaths: (process.env.EMIT_DEATHS || 'true').toLowerCase() !== 'false',
  // In-game shout chat → Discord mirror. Optional — with neither configured,
  // chat mirroring is off. Chat goes straight to Discord and never through
  // the dashboard webhook (the site is public; chat is not). Preferred:
  // CHAT_DISCORD_WEBHOOK (channel webhook; posts AS the player). Fallback:
  // DISCORD_TOKEN + CHAT_CHANNEL_ID (bot-token post, "🗨️ **Name:** text").
  chatWebhookUrl: process.env.CHAT_DISCORD_WEBHOOK || '',
  discordToken: process.env.DISCORD_TOKEN || '',
  chatChannelId: process.env.CHAT_CHANNEL_ID || '',
  statePath: process.env.STATE_PATH || new URL('../state.json', import.meta.url).pathname,
  sftp: {
    host: process.env.SFTP_HOST,
    port: parseInt(process.env.SFTP_PORT || '8822', 10),
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
    readyTimeout: parseInt(process.env.SFTP_TIMEOUT_MS || '15000', 10),
  },
};

if (config.source === 'sftp') {
  for (const k of ['host', 'username', 'password']) {
    if (!config.sftp[k]) {
      const env = k === 'username' ? 'SFTP_USER' : `SFTP_${k.toUpperCase()}`;
      console.error(`[config] LOG_SOURCE=sftp requires ${env}`);
      process.exit(1);
    }
  }
}

const poller = new Poller(config);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.info(`[poller] received ${sig}, shutting down`);
    poller.stop();
    process.exit(0);
  });
}

poller.start().catch((err) => {
  console.error('[poller] fatal:', err.message);
  process.exit(1);
});
