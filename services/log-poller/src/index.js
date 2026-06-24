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
  source: process.env.LOG_SOURCE || 'ftp', // 'ftp' | 'file'
  logPath: process.env.LOG_PATH || 'BepInEx/LogOutput.log',
  webhookUrl: required('WEBHOOK_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '20000', 10),
  syncEveryMs: parseInt(process.env.SYNC_EVERY_MS || '120000', 10),
  statePath: process.env.STATE_PATH || new URL('../state.json', import.meta.url).pathname,
  ftp: {
    host: process.env.FTP_HOST,
    port: parseInt(process.env.FTP_PORT || '21', 10),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    timeoutMs: parseInt(process.env.FTP_TIMEOUT_MS || '15000', 10),
  },
};

if (config.source === 'ftp') {
  for (const k of ['host', 'user', 'password']) {
    if (!config.ftp[k]) {
      console.error(`[config] LOG_SOURCE=ftp requires FTP_${k.toUpperCase()}`);
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
