// Entrypoint: pull every ServerCharacters `.fch` profile, parse the full stat
// suite, and post each player's stats to the dashboard webhook. Designed to run
// periodically under systemd (stats change slowly, so a few-minute cadence is
// plenty). Pass `--once` to run a single sweep and exit (cron / manual use).
//
// Source modes (STATS_SOURCE):
//   sftp — pull *.fch from a remote directory on the game host (production).
//   dir  — read *.fch from a local directory (testing against real profiles).

import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { parseProfile, toPlayerStats } from './fch.js';
import { createHeartbeatSender } from './heartbeat.js';

const log = console;

function required(name) {
  const v = process.env[name];
  if (!v) {
    log.error(`[config] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

// Optional allowlist of character names to ingest (comma-separated, in
// CHARACTERS). A player's `.fch` folder is a lifelong pile of characters —
// singleplayer alts, dead test vikings, other servers — so when we read a
// local Steam profile dir we must restrict to the vikings that actually play
// THIS server. Empty/unset = ingest every named profile (the old behaviour,
// correct for a dedicated ServerCharacters folder that only holds joiners).
const characterAllow = new Set(
  (process.env.CHARACTERS || '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
);

const cfg = {
  source: process.env.STATS_SOURCE || 'sftp', // 'sftp' | 'dir'
  // Remote (sftp) or local (dir) directory holding the .fch profiles.
  charactersPath: process.env.CHARACTERS_PATH || 'ServerCharacters',
  // Lowercased set of character names to keep; empty = keep all.
  characterAllow,
  webhookUrl: required('WEBHOOK_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '300000', 10), // 5 min
  // Pin exploration % to the live server's world if known; else best world.
  worldUid: process.env.WORLD_UID ? BigInt(process.env.WORLD_UID) : undefined,
  sftp: {
    host: process.env.SFTP_HOST,
    port: parseInt(process.env.SFTP_PORT || '8822', 10),
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
    readyTimeout: parseInt(process.env.SFTP_TIMEOUT_MS || '15000', 10),
  },
};

if (cfg.source === 'sftp') {
  for (const k of ['host', 'username', 'password']) {
    if (!cfg.sftp[k]) {
      const env = k === 'username' ? 'SFTP_USER' : `SFTP_${k.toUpperCase()}`;
      log.error(`[config] STATS_SOURCE=sftp requires ${env}`);
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
  return fetchFromSftp();
}

async function fetchFromDir() {
  // A player's Steam character folder is littered with Valheim's own rolling
  // saves — `<name>_backup_*.fch` and `*.fch.old` — alongside the live profile
  // `<name>.fch`. Ingesting those too would parse the same viking many times
  // and let a stale backup win the last-write upsert, so keep only the live
  // profiles. (A clean ServerCharacters mirror has no such files; harmless there.)
  const names = (await readdir(cfg.charactersPath)).filter(
    (n) => n.toLowerCase().endsWith('.fch') && !/_backup|\.fch\.old$/i.test(n)
  );
  const out = [];
  for (const name of names) {
    out.push({ name, buffer: await readFile(join(cfg.charactersPath, name)) });
  }
  return out;
}

async function fetchFromSftp() {
  const sftp = new SftpClient();
  try {
    await sftp.connect(cfg.sftp);
    const entries = await sftp.list(cfg.charactersPath);
    const out = [];
    for (const e of entries) {
      // ssh2-sftp-client: type '-' is a regular file, 'd' a directory.
      if (e.type !== '-' || !e.name.toLowerCase().endsWith('.fch')) continue;
      // get() with no destination returns the file contents as a Buffer.
      const buffer = await sftp.get(`${cfg.charactersPath}/${e.name}`);
      out.push({ name: e.name, buffer });
    }
    return out;
  } finally {
    await sftp.end();
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

// Ops cockpit heartbeat: reports the last sweep's scan/push counts + world
// pin every ~60s of runtime (sent right after each sweep completes, success
// or failure). Best-effort — sendHeartbeat never throws (see heartbeat.js),
// and skips entirely if OPS_HEARTBEAT_TOKEN unset.
const sendHeartbeat = createHeartbeatSender('stats-parser', log);
let lastSweepAt = 0;

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
      // Restrict to the configured server vikings (if an allowlist is set).
      if (cfg.characterAllow.size && !cfg.characterAllow.has(profile.playerName.toLowerCase())) {
        log.info(`[skip] ${name}: "${profile.playerName}" not in CHARACTERS allowlist`);
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
  lastSweepAt = Date.now();
  return { scanned: profiles.length, pushed };
}

// Run one sweep and report its outcome to the ops cockpit. Heartbeat failures
// never throw (see heartbeat.js); a sweep failure IS reported (status=error)
// but is otherwise handled the same as before by the caller.
async function sweepAndReportHeartbeat() {
  try {
    const { scanned, pushed } = await sweep();
    await sendHeartbeat({
      status: 'ok',
      metrics: {
        profilesScanned: scanned,
        profilesPushed: pushed,
        lastSweepAt: new Date(lastSweepAt).toISOString(),
        worldUid: cfg.worldUid != null ? cfg.worldUid.toString() : null,
        source: cfg.source,
      },
    });
  } catch (err) {
    await sendHeartbeat({
      status: 'error',
      error: err.message,
      metrics: {
        lastSweepAt: lastSweepAt ? new Date(lastSweepAt).toISOString() : null,
        worldUid: cfg.worldUid != null ? cfg.worldUid.toString() : null,
        source: cfg.source,
      },
    });
    throw err;
  }
}

const once = process.argv.includes('--once');

async function main() {
  if (once) {
    await sweepAndReportHeartbeat();
    return;
  }
  log.info(
    `[stats] starting; source=${cfg.source}:${cfg.charactersPath} interval=${cfg.intervalMs}ms ` +
      `world=${cfg.worldUid ?? 'best'} allow=${cfg.characterAllow.size ? [...cfg.characterAllow].join('/') : 'all'} ` +
      `target=${cfg.webhookUrl}`
  );
  let stopped = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info(`[stats] received ${sig}, shutting down`);
      stopped = true;
      process.exit(0);
    });
  }
  while (!stopped) {
    try {
      await sweepAndReportHeartbeat();
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
