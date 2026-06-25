// Entrypoint: pull every ServerCharacters `.fch` profile, parse the full stat
// suite, and post each player's stats to the dashboard webhook. Designed to run
// periodically under systemd (stats change slowly, so a few-minute cadence is
// plenty). Pass `--once` to run a single sweep and exit (cron / manual use).
//
// Source modes (STATS_SOURCE):
//   ftp  — pull *.fch from a remote directory on the game host (production).
//   dir  — read *.fch from a local directory (testing against real profiles).

import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { parseProfile, toPlayerStats } from './fch.js';

const log = console;

function required(name) {
  const v = process.env[name];
  if (!v) {
    log.error(`[config] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const cfg = {
  source: process.env.STATS_SOURCE || 'ftp', // 'ftp' | 'dir'
  // Remote (ftp) or local (dir) directory holding the .fch profiles.
  charactersPath: process.env.CHARACTERS_PATH || 'ServerCharacters',
  webhookUrl: required('WEBHOOK_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '300000', 10), // 5 min
  // Pin exploration % to the live server's world if known; else best world.
  worldUid: process.env.WORLD_UID ? BigInt(process.env.WORLD_UID) : undefined,
  ftp: {
    host: process.env.FTP_HOST,
    port: parseInt(process.env.FTP_PORT || '21', 10),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    timeoutMs: parseInt(process.env.FTP_TIMEOUT_MS || '15000', 10),
  },
};

if (cfg.source === 'ftp') {
  for (const k of ['host', 'user', 'password']) {
    if (!cfg.ftp[k]) {
      log.error(`[config] STATS_SOURCE=ftp requires FTP_${k.toUpperCase()}`);
      process.exit(1);
    }
  }
}

// SteamID prefix some ServerCharacters configs prepend, e.g. `76561198…_Bjorn.fch`.
function steamIdFromFilename(name) {
  const m = name.match(/^(\d{17})[_-]/);
  return m ? m[1] : null;
}

// --- Fetch the list of .fch files as { name, buffer } ---
async function fetchProfiles() {
  if (cfg.source === 'dir') return fetchFromDir();
  return fetchFromFtp();
}

async function fetchFromDir() {
  const names = (await readdir(cfg.charactersPath)).filter((n) => n.toLowerCase().endsWith('.fch'));
  const out = [];
  for (const name of names) {
    out.push({ name, buffer: await readFile(join(cfg.charactersPath, name)) });
  }
  return out;
}

async function fetchFromFtp() {
  const client = new FtpClient(cfg.ftp.timeoutMs);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: cfg.ftp.host,
      port: cfg.ftp.port,
      user: cfg.ftp.user,
      password: cfg.ftp.password,
      secure: false,
    });
    const entries = await client.list(cfg.charactersPath);
    const out = [];
    for (const e of entries) {
      if (!e.isFile || !e.name.toLowerCase().endsWith('.fch')) continue;
      const chunks = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      });
      await client.downloadTo(sink, `${cfg.charactersPath}/${e.name}`);
      out.push({ name: e.name, buffer: Buffer.concat(chunks) });
    }
    return out;
  } finally {
    client.close();
  }
}

async function postStats(payload) {
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': cfg.webhookSecret },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${text.slice(0, 120)}`);
  }
  return res.json().catch(() => ({}));
}

// One full sweep: parse every profile and push its stats.
async function sweep() {
  const profiles = await fetchProfiles();
  log.info(`[stats] ${profiles.length} profile(s) from ${cfg.source}:${cfg.charactersPath}`);
  let pushed = 0;
  for (const { name, buffer } of profiles) {
    let stats;
    try {
      const profile = parseProfile(buffer);
      // A character name is required to key the row; skip empty/unused profiles.
      if (!profile.playerName) {
        log.warn(`[skip] ${name}: no player name (v${profile.version}, ${profile.statCount} stats)`);
        continue;
      }
      stats = toPlayerStats(profile, cfg.worldUid);
      stats.steamId = steamIdFromFilename(name);
    } catch (err) {
      log.error(`[parse] ${name}: ${err.message}`);
      continue;
    }
    try {
      await postStats({ type: 'stats', characterName: stats.character_name, metadata: stats });
      pushed++;
      log.info(
        `[push] ${stats.character_name}: kills=${stats.kills} deaths=${stats.deaths} ` +
          `built=${stats.structures_built} explored=${stats.map_explored_pct ?? '—'}%`
      );
    } catch (err) {
      log.error(`[push] ${stats.character_name}: ${err.message}`);
    }
  }
  log.info(`[stats] sweep complete — ${pushed}/${profiles.length} pushed`);
}

const once = process.argv.includes('--once');

async function main() {
  if (once) {
    await sweep();
    return;
  }
  log.info(`[stats] starting; interval=${cfg.intervalMs}ms target=${cfg.webhookUrl}`);
  let stopped = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info(`[stats] received ${sig}, shutting down`);
      stopped = true;
      process.exit(0);
    });
  }
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!stopped) {
    try {
      await sweep();
    } catch (err) {
      log.error(`[sweep] ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((err) => {
  log.error('[stats] fatal:', err.message);
  process.exit(1);
});
