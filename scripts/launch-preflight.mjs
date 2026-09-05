#!/usr/bin/env node
// Launch-night preflight — READ-ONLY. Prints one PASS/FAIL/WARN/SKIP line per
// T-0 precondition and exits non-zero if anything FAILs.
//
//   export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//   node scripts/launch-preflight.mjs --world EilifRehearsal --phase post-start
//
// Phases (each check knows what it expects in each one):
//   pre-wipe    Before `launch-wipe.mjs --execute`. The three bridge services must be
//               STOPPED (the bot re-creates state.json within 60 s and would swallow
//               launch night's first boss announcement); prod data must still be there
//               (non-zero counts) so the wipe has something to wipe and the backups are real.
//   post-wipe   The LAST gate before the panel Start — NOT the first thing after the wipe.
//               Services still stopped, box still stopped, and every piece of stopped-window
//               work already done: prod counts zero, local state files gone, the launch world
//               uploaded, GS/world config moved onto it, worlds_local swept of anything that
//               resurrects the old world, the bot .env pilot overrides reverted, the pack pins
//               live on Thunderstore. Run it straight after `--execute` instead and ~10 of
//               these FAIL for the sole reason that their step has not happened yet, which
//               is how an operator learns to ignore FAILs on the one night that must not
//               happen. docs/LAUNCH-WIPE.md puts this run at the END of step 6.
//   post-start  After the panel Start and the service restarts. All three units RUNNING,
//               the box booted on <World>, /api/status reporting the new world's day.
//
// Read-only means read-only: `systemctl is-active` (never start/stop), SELECT-shaped
// GETs against the Supabase REST API with the ANON key, `vercel env ls` (names only),
// HTTP GETs, and ONE sftp session that only ever runs `get` and `ls`. Nothing here
// writes, deploys, restarts, or posts. Safe to run as often as you like — except the
// SFTP leg, which the GTX box rate-limits, hence the single batched session.
//
// Options:
//   --world <W>          REQUIRED. The world this phase is about.
//   --phase <p>          pre-wipe | post-wipe | post-start   (default: pre-wipe)
//   --posture <p>        GO-A | GO-B   (default: GO-A). GO-B is the vanilla contingency:
//                        the server runs 1.0 with the BepInEx plugins folder moved aside and
//                        players launch plain Valheim, so every mod-dependent expectation
//                        (plugins loaded, Emitter ingest, world day, the pack pins) is
//                        downgraded to informational instead of failing the run.
//   --recaps-start <d>   Launch value expected in the bot .env (default 2026-09-09)
//   --pins <list>        Comma-separated ns-name-version triples the next pack pins.
//                        Default = the pack v12 candidate set (see PACK_V12_PINS).
//   --deep-listing       Also walk the Thunderstore community listing index chunks
//                        (~20 MB) to prove r2modman can actually resolve each pin.
//   --skip-sftp          Skip the GTX leg (offline, or you already ran verify-restart.sh).
//   --skip-vercel        Skip `vercel env ls` (slow, needs the CLI logged in).
//   --no-color           Plain output for logs and pasting into the tracker.
//   --json               Machine-readable results on stdout instead of the table.
//
// Related: scripts/verify-restart.sh (what a Stop->Start actually armed),
// scripts/launch-wipe.mjs (the wipe itself), docs/LAUNCH-WIPE.md (the procedure).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── GTX box coordinates (same constants as scripts/verify-restart.sh) ────────
const GTX_HOST = '191.101.30.229';
const GTX_PORT = '8822';
const GTX_USER = 'charless3';
const GTX_NEST = `${GTX_HOST}_6028`;
const WEBMAP_URL = `http://${GTX_HOST}:3000/`;

const SITE_PRIMARY = 'https://eilif-dashboard.vercel.app';
// The mod configs hard-code this hostname's /api endpoints, so it must answer too.
const SITE_MOD_FACING = 'https://valheim-dashboard.vercel.app';

const VERCEL_SCOPE = 'charlie-9292s-projects';

// The versions pack v12 is expected to pin: pack v11's export.r2x set with the two custom
// client plugins bumped. Override wholesale with --pins when the ship/drop calls land (e.g.
// dropping EilifCompanionClient, or a 1.0 rebuild of everything).
//
// The two custom versions are READ OUT OF THE WORKING TREE, never written here: the csproj
// is the only place that number is decided, and a literal rots silently — this list said
// 0.3.1 hours after the tree had already moved to 0.3.2. Third-party pins stay literal
// because they are somebody else's release schedule.
function csprojVersion(rel, fallback) {
  try {
    const m = fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/<Version>([^<]+)<\/Version>/);
    return m ? m[1].trim() : fallback;
  } catch {
    return fallback;
  }
}
const PACK_V12_PINS = [
  'denikson-BepInExPack_Valheim-5.4.2333',
  'Grantapher-ValheimPlus_Grantapher_Temporary-9.17.1',
  'Advize-PlantEverything-1.20.0',
  'Proudlock_Technology-GsValheimStatsClient-0.2.12',
  `Eilif-EilifPaths-${csprojVersion('plugins/eilif-paths/EilifPaths.csproj', '1.4.0')}`,
  `Eilif-EilifCompanionClient-${csprojVersion('plugins/eilif-companion-client/EilifCompanionClient.csproj', '0.3.2')}`,
  'Azumatt-AzuCraftyBoxes-1.8.15',
];

const UA = 'eilif-launch-preflight/1.0';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const WORLD = opt('world');
const PHASE = opt('phase', 'pre-wipe');
const POSTURE = (opt('posture', 'GO-A') || 'GO-A').toUpperCase();
const RECAPS_START_LAUNCH = opt('recaps-start', '2026-09-09');
const PINS = (opt('pins') || PACK_V12_PINS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const DEEP_LISTING = flag('deep-listing');
const SKIP_SFTP = flag('skip-sftp');
const SKIP_VERCEL = flag('skip-vercel');
const JSON_OUT = flag('json');
const COLOR = !flag('no-color') && !JSON_OUT && process.stdout.isTTY;

const PHASES = ['pre-wipe', 'post-wipe', 'post-start'];
const POSTURES = ['GO-A', 'GO-B'];
if (!WORLD || !PHASES.includes(PHASE) || !POSTURES.includes(POSTURE)) {
  console.error('usage: node scripts/launch-preflight.mjs --world <World> [--phase pre-wipe|post-wipe|post-start]');
  console.error('       [--posture GO-A|GO-B] [--recaps-start 2026-09-09] [--pins ns-name-ver,...]');
  console.error('       [--deep-listing] [--skip-sftp] [--skip-vercel] [--no-color] [--json]');
  process.exit(2);
}

// GO-B (vanilla night) moves the BepInEx plugins folder aside on purpose, so the plugin
// list, the Emitter's ingest, the world day it feeds and the whole modpack are absent BY
// DESIGN. Grading them would make the tool contradict the plan on the branch that is
// already the stressed one.
const MODDED = POSTURE === 'GO-A';
const GO_B_NOTE = 'GO-B: expected absent (plugins folder moved aside), not graded';

// ── result collection ───────────────────────────────────────────────────────
const results = [];
const C = {
  pass: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  fail: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  warn: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  skip: (s) => (COLOR ? `\x1b[90m${s}\x1b[0m` : s),
  dim: (s) => (COLOR ? `\x1b[90m${s}\x1b[0m` : s),
  head: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
};

function check(id, title, status, evidence) {
  results.push({ id, title, status, evidence: String(evidence ?? '') });
}

/**
 * Grade a boolean against what THIS phase expects.
 *   want === true   -> ok is required        (false = FAIL)
 *   want === false  -> ok must be false      (true  = FAIL)
 *   want === 'warn' -> report, never fail    (false = WARN)
 *   want === null   -> informational only    (always INFO/PASS-shaped SKIP)
 */
function graded(id, title, ok, evidence, want) {
  if (want === null || want === undefined) return check(id, title, 'SKIP', evidence);
  if (want === 'warn') return check(id, title, ok ? 'PASS' : 'WARN', evidence);
  const good = want === true ? ok : !ok;
  check(id, title, good ? 'PASS' : 'FAIL', evidence);
}

function section(name) {
  results.push({ section: name });
}

// ── small helpers ───────────────────────────────────────────────────────────
function readEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function httpGet(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, ...headers } });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function sh(cmd, args, { timeout = 30000, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Local systemd units
// ═══════════════════════════════════════════════════════════════════════════
// The wipe is destructive and the bot is the thing that undoes it: its voice tick
// ends in an unconditional saveState() every 60 s, so a running bot re-creates
// state.json (announcedBosses) inside a minute of the wipe deleting it, and launch
// night's real Eikthyr kill is then treated as already announced. Poller and
// map-snapshot are softer but still write.
function checkUnits() {
  section('Local services (systemctl is-active — never started or stopped by this script)');

  const bridge = ['eilif-discord-bot', 'eilif-log-poller', 'eilif-map-snapshot'];
  const wantRunning = PHASE === 'post-start' ? true : false;

  const whyStopped = {
    'eilif-discord-bot': 'must be STOPPED: it re-creates state.json (announcedBosses) within 60 s and would swallow launch night\'s first boss announcement',
    'eilif-log-poller': 'must be STOPPED: it keeps posting joins/leaves/deaths to the webhook, which re-populates the tables mid-wipe',
    'eilif-map-snapshot': 'must be STOPPED: it keeps uploading frames to the map bucket the wipe is emptying',
  };
  const whyRunning = {
    'eilif-discord-bot': 'must be RUNNING, started SECOND and only once bosses are all false and state.json is gone',
    'eilif-log-poller': 'must be RUNNING, started FIRST; confirm a join line in its journal',
    'eilif-map-snapshot': `must be RUNNING, started LAST and only after map_data/${WORLD} exists and /api/status shows the new day`,
  };
  for (const unit of bridge) {
    const { stdout } = sh('systemctl', ['is-active', unit], { timeout: 10000 });
    const state = stdout.trim() || 'unknown';
    const active = state === 'active';
    const note = PHASE === 'post-start' ? whyRunning[unit] : whyStopped[unit];
    graded(`unit:${unit}`, unit, active, `${state} — ${note}`, wantRunning);
  }

  // Retired 2026-08-23. It re-upserted player_stats from local .fch profiles every
  // ~15 min, so a wipe while it runs gets the same test-world junk straight back.
  {
    const { stdout } = sh('systemctl', ['is-active', 'eilif-stats-parser'], { timeout: 10000 });
    const state = stdout.trim() || 'unknown';
    const active = state === 'active';
    graded(
      'unit:eilif-stats-parser',
      'eilif-stats-parser (retired)',
      active,
      `${state} — retired 2026-08-23; active means someone re-enabled it and the wipe will be undone`,
      false,
    );
  }

  // Backups are the only copies: the Supabase project is on the Free plan and the
  // GTX panel only writes a Backups/*.7z at a Stop/Start.
  for (const timer of ['eilif-world-backup.timer', 'eilif-db-snapshot.timer']) {
    const { stdout } = sh('systemctl', ['is-active', timer], { timeout: 10000 });
    const state = stdout.trim() || 'unknown';
    graded(`unit:${timer}`, timer, state === 'active', `${state} — off-box world + DB copies`, 'warn');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Discord bot .env pilot overrides + the installed unit file
// ═══════════════════════════════════════════════════════════════════════════
// Ten pilot reverts live in six places. The nastiest is RECAPS_START: it is set in
// BOTH services/discord-bot/.env and the unit's own Environment= line, and systemd
// wins — so editing the .env alone changes nothing.
function checkBotEnv() {
  section('Discord bot pilot overrides (services/discord-bot/.env + installed unit)');

  const envFile = path.join(ROOT, 'services/discord-bot/.env');
  const unitFile = '/etc/systemd/system/eilif-discord-bot.service';
  const env = readEnvFile(envFile);
  // Only launch-relevant (non-secret) values are ever read or printed here.
  const unitText = fs.existsSync(unitFile) ? fs.readFileSync(unitFile, 'utf8') : '';

  // Pilot values are correct until the cutover, so pre-wipe only warns.
  const want = PHASE === 'pre-wipe' ? 'warn' : true;

  graded(
    'bot:RECAPS_START',
    '.env RECAPS_START',
    env.RECAPS_START === RECAPS_START_LAUNCH,
    `${env.RECAPS_START ?? '(unset)'} — launch value ${RECAPS_START_LAUNCH}`,
    want,
  );

  const unitRecaps = unitText.match(/^\s*Environment=RECAPS_START=(.*)$/m);
  graded(
    'bot:unit-RECAPS_START',
    'unit Environment=RECAPS_START',
    !unitRecaps,
    unitRecaps
      ? `unit sets RECAPS_START=${unitRecaps[1].trim()} and systemd WINS over .env — delete the line, then daemon-reload`
      : 'absent — .env owns RECAPS_START',
    want,
  );

  // The four rehearsal channel overrides. Absent (or anything but 'server') = launch.
  for (const key of ['RECAP_CHANNEL', 'MILESTONE_CHANNEL', 'OATH_CHANNEL', 'BOSS_CHANNEL']) {
    const v = env[key];
    graded(
      `bot:${key}`,
      `.env ${key}`,
      v !== 'server',
      v === undefined
        ? '(unset) — defaults to #valheim'
        : `${v}${v === 'server' ? ' — pilot override still routing to #server' : ''}`,
      want,
    );
  }

  // src/index.js: process.env.TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server'
  // i.e. this one defaults to #server and must be set explicitly for launch.
  graded(
    'bot:TITLE_CHANNEL',
    '.env TITLE_CHANNEL',
    env.TITLE_CHANNEL === 'valheim',
    `${env.TITLE_CHANNEL ?? '(unset)'} — defaults to #server; launch value is valheim (set it explicitly)`,
    want,
  );

  // Masked by NAME, not by what happens to be in there today (NODE_ENV, TZ, RECAPS_START).
  // This output is meant to be pasted into the tracker, and the day someone moves
  // DISCORD_TOKEN or WEBHOOK_SECRET into the unit to beat a systemd load-order problem, an
  // unmasked dump publishes it.
  const unitEnvLines = [...unitText.matchAll(/^\s*Environment=(.*)$/gm)].map((m) => m[1].trim());
  const masked = unitEnvLines.map((line) => {
    const i = line.indexOf('=');
    const key = i < 0 ? line : line.slice(0, i);
    return /TOKEN|SECRET|KEY|PASSWORD|PASS|WEBHOOK|AUTH/i.test(key) ? `${key}=<hidden>` : line;
  });
  check(
    'bot:unit-environment',
    'unit Environment= lines',
    'SKIP',
    masked.length ? masked.join(' | ') : '(none / unit not readable)',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Log poller .env world wiring
// ═══════════════════════════════════════════════════════════════════════════
function checkPollerEnv() {
  section('Log poller world wiring (services/log-poller/.env)');

  const env = readEnvFile(path.join(ROOT, 'services/log-poller/.env'));
  const mapDir = env.MAP_REMOTE_DIR ?? '';
  const logPath = env.LOG_PATH ?? '';

  // map-snapshot sources the WebMap pngs from here; pointed at the old world it
  // keeps framing the old world's map after the cutover.
  graded(
    'poller:MAP_REMOTE_DIR',
    'MAP_REMOTE_DIR names the world',
    mapDir.includes(WORLD),
    `${mapDir || '(unset)'} — must end in map_data/${WORLD}`,
    PHASE === 'pre-wipe' ? 'warn' : true,
  );

  // LOG_PATH is world-INDEPENDENT (BepInEx/LogOutput.log is per-server, not per-world),
  // so the only failure mode is a stray world name left in it.
  const strayWorld = /worlds_local|map_data/i.test(logPath) && !logPath.includes(WORLD);
  graded(
    'poller:LOG_PATH',
    'LOG_PATH points at this box',
    logPath.startsWith(GTX_NEST) && !strayWorld,
    `${logPath || '(unset)'} — world-independent by design; must start ${GTX_NEST}/ and name no other world`,
    true,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Vercel production env
// ═══════════════════════════════════════════════════════════════════════════
// Values are ENCRYPTED and genuinely unreadable from the CLI: `vercel env ls` prints
// the literal word "Encrypted" in the value column. So this check can only prove the
// NAME exists and report how long ago it was written. The real proof that
// GS_EXPECTED_WORLD holds the right world is /api/status showing the new world's day
// once the Emitter starts posting (see checkSite) — a wrong value makes every Emitter
// payload land as {"status":"ignored","reason":"world mismatch"} while still 200-ing.
function checkVercel() {
  section('Vercel production env (names only — values are encrypted and NOT readable)');

  if (SKIP_VERCEL) {
    check('vercel:env', 'vercel env ls production', 'SKIP', '--skip-vercel');
    return;
  }

  const r = sh('vercel', ['env', 'ls', 'production', '--scope', VERCEL_SCOPE], { timeout: 120000 });
  if (r.code !== 0) {
    check('vercel:env', 'vercel env ls production', 'SKIP', `CLI failed or not logged in (exit ${r.code})`);
    return;
  }

  // ` NAME                Encrypted           Production          9d ago` — four
  // whitespace-separated columns, the last of which ("9d ago") contains a space.
  const rows = new Map();
  for (const line of r.stdout.split('\n')) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 4) continue;
    const [name, value, envs, ...rest] = parts;
    if (!/^[A-Z][A-Z0-9_]+$/.test(name)) continue; // skips the "name value environments created" header
    rows.set(name, { value, envs, created: rest.join(' ').trim() });
  }

  const required = [
    'GS_EXPECTED_WORLD',
    'GS_EMITTER_TOKEN',
    'VOICE_API_TOKEN',
    'BOARDS_TOKEN',
    'WEBHOOK_SECRET',
    'OPS_HEARTBEAT_TOKEN',
    'OPS_PASSWORD',
    'TV_ACCESS_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ];
  const missing = required.filter((n) => !rows.has(n));
  graded(
    'vercel:required-names',
    'all required env names present',
    missing.length === 0,
    missing.length ? `MISSING: ${missing.join(', ')}` : `${required.length}/${required.length} present`,
    true,
  );

  const gs = rows.get('GS_EXPECTED_WORLD');
  check(
    'vercel:GS_EXPECTED_WORLD',
    'GS_EXPECTED_WORLD',
    gs ? 'PASS' : 'FAIL',
    gs
      ? `present, last written ${gs.created} — value is encrypted, so this CANNOT confirm it says "${WORLD}". Proof = /api/status worldDay > 0 after the Emitter posts.`
      : 'ABSENT — /api/gs-ingest then accepts payloads from ANY world',
  );

  // An env edit only takes effect on the next deploy.
  if (gs && PHASE === 'post-start') {
    // `vercel env ls` abbreviates ms-style: "5m ago", "3h ago", "9d ago" — never the words
    // "second"/"minute"/"hour". The launch-night case (set in step 7, checked in step 11) is
    // a few hours old, so anything but this regex WARNs on a variable that is perfectly fresh.
    const fresh = /^\s*\d+\s*[smh]\b/i.test(gs.created) || /^\s*[01]\s*d\b/i.test(gs.created);
    graded(
      'vercel:GS_EXPECTED_WORLD-fresh',
      'GS_EXPECTED_WORLD re-written for this world',
      fresh,
      `last written ${gs.created} — a cutover to a new world should have re-set it today (and redeployed; env edits need a deploy)`,
      'warn',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Live site
// ═══════════════════════════════════════════════════════════════════════════
async function checkSite() {
  section('Live site');

  let worldDay = null;
  for (const [label, base] of [
    ['canonical', SITE_PRIMARY],
    ['mod-facing', SITE_MOD_FACING],
  ]) {
    try {
      const res = await httpGet(`${base}/api/status`, { timeoutMs: 20000 });
      const body = await res.json();
      if (label === 'canonical') worldDay = body.worldDay;
      graded(
        `site:${label}`,
        `${base}/api/status`,
        res.ok,
        `HTTP ${res.status} online=${body.online} worldDay=${body.worldDay} players=${body.players}/${body.maxPlayers} updatedAt=${body.updatedAt}`,
        true,
      );
    } catch (e) {
      check(`site:${label}`, `${base}/api/status`, 'FAIL', `unreachable: ${e.message}`);
    }
  }

  if (worldDay === null) return;

  if (PHASE === 'post-wipe') {
    // The wipe zeroes server_status.world_day precisely so map-snapshot cannot frame a
    // stale day: currentWorldDay() guards on worldDay > 0.
    graded(
      'site:worldDay-zero',
      'world day zeroed by the wipe',
      worldDay === 0,
      `worldDay=${worldDay} — must be 0 after the wipe, or map-snapshot frames the OLD world's day`,
      true,
    );
  } else if (PHASE === 'post-start') {
    graded(
      'site:worldDay-live',
      'world day reported for the new world',
      typeof worldDay === 'number' && worldDay >= 1,
      `worldDay=${worldDay} — >0 means the Emitter is being accepted, i.e. GS_EXPECTED_WORLD matches the live world` +
        (MODDED ? '' : ` · ${GO_B_NOTE}: nothing posts a world day on a vanilla night`),
      MODDED ? true : null,
    );
  } else {
    graded(
      'site:worldDay-live',
      'world day reported',
      typeof worldDay === 'number' && worldDay > 0,
      `worldDay=${worldDay} — pilot data still live`,
      'warn',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Prod Supabase row counts (ANON key, read-only)
// ═══════════════════════════════════════════════════════════════════════════
// Uses NEXT_PUBLIC_* from .env.local and PostgREST's `Prefer: count=exact` with
// Range: 0-0, so it reads one row's worth of bytes and reports the total. anon has
// SELECT on all of these (INSERT/UPDATE were revoked 2026-09-04); the service-role
// key is deliberately NOT used here — nothing in this file should be able to write.
async function checkSupabase() {
  section('Prod Supabase row counts (anon key, SELECT-shaped GETs only)');

  const env = readEnvFile(path.join(ROOT, '.env.local'));
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    check('db:counts', 'Supabase counts', 'SKIP', 'NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.local');
    return;
  }

  const targets = [
    ['players', 'players?select=id'],
    ['sessions', 'sessions?select=id'],
    ['events', 'events?select=id'],
    ['milestones achieved', 'milestones?select=id&achieved_at=not.is.null'],
    ['bosses killed', 'bosses?select=id&is_killed=is.true'],
  ];

  for (const [label, q] of targets) {
    let count = null;
    let status = 0;
    try {
      const res = await httpGet(`${url}/rest/v1/${q}`, {
        timeoutMs: 20000,
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
      });
      status = res.status;
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)$/);
      count = m ? Number(m[1]) : null;
      await res.text();
    } catch (e) {
      check(`db:${label}`, label, 'FAIL', `query failed: ${e.message}`);
      continue;
    }

    if (count === null) {
      check(`db:${label}`, label, 'FAIL', `HTTP ${status}, no count in content-range (anon SELECT revoked?)`);
      continue;
    }

    if (PHASE === 'pre-wipe') {
      graded(`db:${label}`, label, count > 0, `${count} row${count === 1 ? '' : 's'} — pilot data present, so the wipe and its backups are real`, true);
    } else if (PHASE === 'post-wipe') {
      graded(`db:${label}`, label, count === 0, `${count} row${count === 1 ? '' : 's'} — must be 0 after the wipe`, true);
    } else {
      check(`db:${label}`, label, 'SKIP', `${count} row${count === 1 ? '' : 's'} — launch-world data, growing from 0 is normal`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Local state files
// ═══════════════════════════════════════════════════════════════════════════
// The bot's state.json carries announcedBosses; if it survives the wipe, launch
// night's first boss kill posts nothing. The map-snapshot state file carries the
// list of already-framed in-game days.
function checkStateFiles() {
  section('Local state files');

  const want = PHASE === 'post-wipe' ? true : null;

  // Two different files with two different failure modes — the bot's is the boss story,
  // the poller's is presence and a byte offset. A shared message trains the operator to
  // read the poller's FAIL as a copy/paste artefact and dismiss it.
  for (const [label, rel, why] of [
    [
      'bot state.json',
      'services/discord-bot/state.json',
      'STILL PRESENT — it carries announcedBosses, so launch night\'s first boss kill is treated as already announced: no @everyone, no skald retelling',
    ],
    [
      'poller state.json',
      'services/log-poller/state.json',
      'STILL PRESENT — it carries the LogOutput.log byte offset plus connections/pending/liveness, so the poller resumes mid-file and carries rehearsal connections into the launch world (mis-closed sessions)',
    ],
  ]) {
    const p = path.join(ROOT, rel);
    const exists = fs.existsSync(p);
    if (want === true) {
      graded(
        `state:${rel}`,
        `${label} absent`,
        !exists,
        exists ? `${rel} ${why}` : `${rel} absent`,
        true,
      );
    } else {
      check(`state:${rel}`, label, 'SKIP', exists ? `${rel} present (${fs.statSync(p).size} bytes)` : `${rel} absent`);
    }
  }

  const mapState = path.join(ROOT, 'scripts/.map-snapshot-state.json');
  let days = null;
  if (fs.existsSync(mapState)) {
    try {
      days = JSON.parse(fs.readFileSync(mapState, 'utf8')).days ?? [];
    } catch {
      days = null;
    }
  }
  const empty = !fs.existsSync(mapState) || (Array.isArray(days) && days.length === 0);
  const desc = !fs.existsSync(mapState)
    ? 'file absent'
    : days === null
      ? 'unparseable'
      : `days=[${days.length ? `${days[0]}..${days[days.length - 1]}, ${days.length} entries` : 'empty'}]`;

  if (PHASE === 'post-wipe') {
    graded('state:map-snapshot', 'map-snapshot days cleared', empty, `${desc} — stale days re-frame the OLD world`, true);
  } else {
    check('state:map-snapshot', 'map-snapshot days', 'SKIP', desc);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. GTX box — ONE read-only sftp session
// ═══════════════════════════════════════════════════════════════════════════
// The box bans on repeated auth failures, so everything the preflight needs comes out
// of a single batched session of `get` and `ls`. Password is read from the poller .env
// inside this process and handed to sshpass through the environment, never on a
// command line (same pattern as scripts/verify-restart.sh).
function checkGtx() {
  section(`GTX box (one read-only sftp session: get + ls only)`);

  if (SKIP_SFTP) {
    check('gtx:sftp', 'GTX sftp batch', 'SKIP', '--skip-sftp');
    return;
  }

  const pollerEnv = readEnvFile(path.join(ROOT, 'services/log-poller/.env'));
  const pw = pollerEnv.SFTP_PASSWORD;
  if (!pw) {
    check('gtx:sftp', 'GTX sftp batch', 'SKIP', 'SFTP_PASSWORD not found in services/log-poller/.env');
    return;
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eilif-preflight-'));
  // Commands go in on STDIN, not via `-b`: `sftp -b file` implies BatchMode=yes, which
  // disables password auth outright and the session dies with exit 255. This is the
  // same heredoc shape scripts/verify-restart.sh uses.
  const batchText =
    [
      `get ${GTX_NEST}/console.log ${out}/console.log`,
      `get ${GTX_NEST}/BepInEx/LogOutput.log ${out}/LogOutput.log`,
      `ls -la ${GTX_NEST}/worlds_local/`,
      `ls -la ${GTX_NEST}/BepInEx/plugins/WebMap/map_data/`,
      'bye',
    ].join('\n') + '\n';

  const r = spawnSync(
    'sshpass',
    [
      '-e',
      'sftp',
      '-q',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=20',
      '-P',
      GTX_PORT,
      `${GTX_USER}@${GTX_HOST}`,
    ],
    { encoding: 'utf8', timeout: 180000, input: batchText, env: { ...process.env, SSHPASS: pw } },
  );
  r.out = (r.stdout || '') + (r.stderr || '');
  r.code = r.status;

  const listing = r.out;
  const consoleLog = fs.existsSync(`${out}/console.log`) ? fs.readFileSync(`${out}/console.log`, 'latin1') : '';
  const logOutput = fs.existsSync(`${out}/LogOutput.log`) ? fs.readFileSync(`${out}/LogOutput.log`, 'latin1') : '';

  if (!consoleLog && !logOutput) {
    check('gtx:sftp', 'GTX sftp batch', 'FAIL', `no logs fetched (exit ${r.code}) — check the panel credentials pane; repeated auth failures get this PC banned`);
    return;
  }
  check('gtx:sftp', 'GTX sftp batch', 'PASS', `console.log ${consoleLog.length}B, LogOutput.log ${logOutput.length}B, batch exit ${r.code}`);

  // ── worlds_local ─────────────────────────────────────────────────────────
  // Valheim auto-restores from a leftover .old / *_backup_auto-* pair and resurrects
  // the old world, so a stopped-window sweep is mandatory, not cosmetic.
  // The transcript echoes every command as `sftp> <cmd>`, so a block ENDS at the next
  // prompt. Without that bound the worlds_local block ran to the end of the transcript and
  // swallowed the map_data listing below it — which made a map_data/<World>/ directory
  // satisfy "worlds_local has <World>", i.e. the one hard gate could never fail.
  const blockAfter = (cmd) => (listing.split(cmd)[1] || '').split('sftp>')[0];

  const wlLines = blockAfter(`ls -la ${GTX_NEST}/worlds_local/`).split('\n').slice(0, 400);
  const entries = wlLines
    .map((l) => l.match(/^([-d])[rwx-]{9}\s+\S+\s+\S+\s+\S+\s+\d+\s+\w+\s+\d+\s+[\d:]+\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => ({ dir: m[1] === 'd', name: m[2] }))
    .filter((e) => e.name !== '.' && e.name !== '..');
  const names = entries.map((e) => e.name);

  const flatPair = names.includes(`${WORLD}.db`) && names.includes(`${WORLD}.fwl`);
  // 1.0 chunked saves live in a DIRECTORY named for the world; derived from the parsed
  // entries rather than a regex built out of an un-escaped world name.
  const folderWorld = entries.some((e) => e.dir && e.name === WORLD);
  graded(
    'gtx:world-present',
    `worlds_local has ${WORLD}`,
    flatPair || folderWorld,
    flatPair
      ? `${WORLD}.db + ${WORLD}.fwl present (0.221.x flat pair)`
      : folderWorld
        ? `worlds_local/${WORLD}/ present (1.0 chunked folder layout)`
        : `NEITHER ${WORLD}.db+.fwl NOR worlds_local/${WORLD}/ found — wrong world name, or the pair was never uploaded`,
    PHASE === 'pre-wipe' ? 'warn' : true,
  );

  // Leftovers, split by whose they are. Valheim itself writes `<W>.db.old` on every
  // save and a `<W>_backup_auto-*` pair roughly twice a day, so once the launch world
  // is RUNNING its own leftovers are normal housekeeping. Any other world's leftovers
  // are not: Valheim auto-restores from a stray .old / backup_auto pair and resurrects
  // the world it belongs to, and `<other>.json` carries that world's seed in plaintext.
  const mine = (n) => n === WORLD || n.startsWith(`${WORLD}.`) || n.startsWith(`${WORLD}_`);
  const stale = {
    'Dedicated.* (retired test world)': names.filter((n) => /^Dedicated\./.test(n)),
    '*.old': names.filter((n) => /\.old$/.test(n)),
    '*_backup_auto-*': names.filter((n) => /_backup_auto-/.test(n)),
    '*.json (plaintext seed)': names.filter((n) => /\.json$/.test(n)),
  };
  for (const [label, hits] of Object.entries(stale)) {
    const foreign = hits.filter((n) => !mine(n));
    const own = hits.filter(mine);
    // pre-wipe: the old world is still live, so all of this is expected -> informational.
    // post-wipe: the stopped-window sweep should have removed every one of them.
    // post-start: only foreign leftovers matter; the running world regenerates its own.
    const want = PHASE === 'pre-wipe' ? null : PHASE === 'post-wipe' ? false : false;
    const offenders = PHASE === 'post-start' ? foreign : hits;
    graded(
      `gtx:stale:${label}`,
      `worlds_local swept of ${label}`,
      offenders.length > 0,
      offenders.length
        ? `${offenders.length}: ${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ', …' : ''}`
        : `none${PHASE === 'post-start' && own.length ? ` (${own.length} belonging to ${WORLD} itself, which is normal while it runs)` : ''}`,
      want,
    );
  }

  // ── map_data ─────────────────────────────────────────────────────────────
  const mdDirs = blockAfter(`ls -la ${GTX_NEST}/BepInEx/plugins/WebMap/map_data/`)
    .split('\n')
    .filter((l) => /^d/.test(l))
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((n) => n && n !== '.' && n !== '..');
  graded(
    'gtx:map_data',
    `WebMap map_data/${WORLD} exists`,
    mdDirs.includes(WORLD),
    `map_data dirs: ${mdDirs.join(', ') || '(none)'} — map-snapshot must not start before this exists`,
    PHASE === 'post-start' ? true : 'warn',
  );

  // docs/LAUNCH-WIPE.md step 5 lists `BepInEx/plugins/WebMap/map_data/<old world>/` as a
  // mandatory delete, and nothing regenerates a retired world's directory — WebMap only
  // writes the running world's. Same treatment as the worlds_local leftovers.
  const mdForeign = mdDirs.filter((d) => d !== WORLD);
  graded(
    'gtx:map_data-swept',
    'map_data swept of other worlds',
    mdForeign.length > 0,
    mdForeign.length
      ? `${mdForeign.join(', ')} — step 5 deletes these; WebMap keeps serving the old map and map-snapshot can be pointed back at it`
      : `only ${WORLD}`,
    PHASE === 'pre-wipe' ? null : false,
  );

  // ── console.log boot facts ───────────────────────────────────────────────
  const lastOf = (re) => {
    const hits = [...consoleLog.matchAll(re)];
    return hits.length ? hits[hits.length - 1] : null;
  };

  const ver = lastOf(/Valheim version:\s*([0-9.]+)\s*\(network version (\d+)\)/g);
  check(
    'gtx:version',
    'Valheim version (proof no Steam update ran)',
    ver ? 'PASS' : 'WARN',
    ver ? `${ver[1]} (network ${ver[2]})` : 'no "Valheim version:" line in this console.log',
  );

  const bootWorld = lastOf(/Get create world (.+)/g);
  const bw = bootWorld ? bootWorld[1].trim() : null;
  graded(
    'gtx:boot-world',
    'booted world',
    bw === WORLD,
    `${bw ?? 'unknown'} — this boot loaded ${bw ?? 'an unknown world'}`,
    PHASE === 'post-start' ? true : 'warn',
  );

  const dp = lastOf(/Setting world modifier: DeathPenalty->(\w+)/g);
  const tier = dp ? dp[1] : null;
  const keyEnforced = /\[EILIF_KEY\] enforced world key: deathkeepequip/.test(logOutput);
  graded(
    'gtx:death-penalty',
    'panel death penalty = Casual',
    tier === 'casual',
    `panel tier ${tier ?? 'unknown'}; Companion key injection ${keyEnforced ? 'ACTIVE' : 'not seen'} — only Casual grants deathkeepequip from the panel; ` +
      (tier === 'casual'
        ? 'durable'
        : keyEnforced
          ? 'FRAGILE: keep-gear is plugin-only, so the first boot where Companion fails to load everyone drops everything'
          : 'NO KEEP-GEAR AT ALL'),
    PHASE === 'post-start' ? true : 'warn',
  );

  const combat = lastOf(/Setting world modifier: Combat->(\w+)/g);
  check('gtx:combat', 'combat modifier', 'SKIP', `${combat ? combat[1] : 'unknown'} — decided separately; record the call before launch`);

  // ── plugins loaded this boot ─────────────────────────────────────────────
  const plugins = [...logOutput.matchAll(/Loading \[([^\]]+)\]/g)].map((m) => m[1]);
  graded(
    'gtx:plugins',
    'all 8 server plugins loaded',
    plugins.length >= 8,
    (plugins.length ? `${plugins.length}: ${plugins.join(', ')}` : 'no "Loading [" lines in LogOutput.log') +
      (MODDED ? '' : ` · ${GO_B_NOTE}`),
    !MODDED ? null : PHASE === 'post-start' ? true : 'warn',
  );

  const ingest = (logOutput.match(/ingest status: 200/g) || []).length;
  graded(
    'gtx:emitter',
    'stats Emitter ingesting',
    ingest > 0,
    `${ingest}× "ingest status: 200" this boot` + (MODDED ? '' : ` · ${GO_B_NOTE}: the Emitter is a plugin`),
    !MODDED ? null : PHASE === 'post-start' ? true : 'warn',
  );

  const boards = logOutput.match(/scan complete: (\d+) sign\(s\) in world, (\d+) claimed/);
  check('gtx:boards', 'Living Boards scan', boards ? 'PASS' : 'SKIP', boards ? boards[0] : 'no board scan line yet this boot');

  fs.rmSync(out, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. WebMap port 3000
// ═══════════════════════════════════════════════════════════════════════════
// gtx-1: on 2026-09-03 this was serving the full 4.5 MB map.png, the WebMap config and
// live player positions to the open internet. The fix is a GTX firewall ticket, NOT
// webmap.cfg server_port=0 (that NREs at world load).
async function checkPort3000() {
  section('WebMap port 3000 (must be closed to the public internet)');
  let open = false;
  let detail = '';
  try {
    const res = await httpGet(WEBMAP_URL, { timeoutMs: 8000 });
    open = true;
    detail = `HTTP ${res.status} from ${WEBMAP_URL} — the world map, config and live positions are public`;
    await res.text().catch(() => {});
  } catch (e) {
    detail = `no HTTP response within 8s (${e.name === 'AbortError' ? 'timeout' : e.message}) — closed, which is what launch wants`;
  }
  graded('gtx:port3000', 'port 3000 closed', open, detail, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Thunderstore pins for the next pack
// ═══════════════════════════════════════════════════════════════════════════
// A pack minted against a version Thunderstore has not indexed yet imports as "mod
// not found" for every player. Two independent signals: the experimental package API
// (does this exact version exist at all) and the community listing (what r2modman
// resolves against).
async function checkThunderstore() {
  section('Modpack pins on Thunderstore');

  const serverTs = fs.readFileSync(path.join(ROOT, 'config/server.ts'), 'utf8');
  const label = serverTs.match(/MODPACK_VERSION_LABEL\s*=\s*'([^']*)'/)?.[1] ?? '(unset)';
  const code = serverTs.match(/MODPACK_PROFILE_CODE\s*=\s*'([^']*)'/)?.[1] ?? '';
  check('pack:label', 'config/server.ts pack label', 'SKIP', `${label} · code ${code || '(unset)'}`);

  if (PHASE === 'post-start') {
    graded(
      'pack:label-bumped',
      'pack label bumped past v11',
      !/v11/i.test(label),
      `${label} — BUMP THIS EVERY TIME THE CODE IS RE-MINTED, or returning players cannot tell they are stale` +
        (MODDED ? '' : ' · GO-B: no pack is minted tonight, but the site is still advertising one players should not import'),
      // GO-B: nobody should be importing a pack at all, so a stale label is a copy problem
      // on /mods, not a cutover gate.
      MODDED ? true : 'warn',
    );
  }

  if (!MODDED) {
    check(
      'ts:pins',
      'modpack pins',
      'SKIP',
      `GO-B: players launch plain Valheim, so no pack is minted and these ${PINS.length} pin(s) are not gates tonight`,
    );
    return;
  }

  let listingIndex = null;
  if (DEEP_LISTING) listingIndex = await fetchListingIndex();

  for (const pin of PINS) {
    const m = pin.match(/^([^-]+)-(.+)-(\d+\.\d+\.\d+)$/);
    if (!m) {
      check(`ts:${pin}`, pin, 'FAIL', 'unparseable pin — expected Namespace-PackageName-x.y.z');
      continue;
    }
    const [, ns, name, ver] = m;

    let exists = false;
    let latest = '?';
    try {
      const res = await httpGet(`https://thunderstore.io/api/experimental/package/${ns}/${name}/${ver}/`, { timeoutMs: 25000 });
      exists = res.ok;
      await res.text().catch(() => {});
    } catch (e) {
      check(`ts:${pin}`, pin, 'SKIP', `Thunderstore unreachable: ${e.message}`);
      continue;
    }
    try {
      const res = await httpGet(`https://thunderstore.io/api/v1/package-metrics/${ns}/${name}/`, { timeoutMs: 25000 });
      if (res.ok) latest = (await res.json()).latest_version ?? '?';
      else await res.text().catch(() => {});
    } catch {
      /* metrics is a nice-to-have */
    }

    let listingNote = '';
    if (listingIndex) {
      const entry = listingIndex.get(`${ns}-${name}`.toLowerCase());
      const inListing = entry ? entry.includes(ver) : false;
      listingNote = entry
        ? `, community listing ${inListing ? 'HAS' : 'does NOT yet have'} ${ver}`
        : ', not in the community listing index at all';
    }

    graded(
      `ts:${pin}`,
      pin,
      exists,
      exists
        ? `version exists; community latest ${latest}${latest !== ver ? ' (pin is deliberately older — confirm that is intended)' : ''}${listingNote}`
        : `NOT UPLOADED — a pack pinning this imports as "mod not found" for every player${listingNote}`,
      // Before the wipe a not-yet-uploaded custom plugin is still a live decision.
      PHASE === 'pre-wipe' ? 'warn' : true,
    );
  }
}

// The community listing index is a gzipped JSON array of chunk URLs, each chunk a
// gzipped array of package records. ~20 MB total, hence --deep-listing.
async function fetchListingIndex() {
  try {
    const idxRes = await httpGet('https://thunderstore.io/c/valheim/api/v1/package-listing-index/', { timeoutMs: 60000 });
    const { gunzipSync } = await import('node:zlib');
    const chunks = JSON.parse(gunzipSync(Buffer.from(await idxRes.arrayBuffer())).toString());
    const map = new Map();
    for (const url of chunks) {
      const res = await httpGet(url, { timeoutMs: 60000 });
      const arr = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString());
      for (const pkg of arr) {
        map.set(String(pkg.full_name).toLowerCase(), (pkg.versions ?? []).map((v) => v.version_number));
      }
    }
    return map;
  } catch (e) {
    check('ts:listing-index', 'community listing index', 'SKIP', `could not walk the index: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// render
// ═══════════════════════════════════════════════════════════════════════════
function render() {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) if (r.status) counts[r.status]++;

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { world: WORLD, phase: PHASE, ranAt: new Date().toISOString(), counts, checks: results.filter((r) => r.status) },
        null,
        2,
      ),
    );
    return;
  }

  const badge = { PASS: C.pass('PASS'), FAIL: C.fail('FAIL'), WARN: C.warn('WARN'), SKIP: C.skip('SKIP') };
  const width = Math.max(...results.filter((r) => r.title).map((r) => r.title.length), 10);

  console.log('');
  console.log(
    C.head(
      `Launch preflight — world "${WORLD}", phase ${PHASE}, posture ${POSTURE}, ` +
        `${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
    ),
  );
  // The phase's assumption, on screen rather than in a file header nobody opens at 17:00.
  if (PHASE === 'post-wipe') {
    console.log(
      C.dim(
        '  post-wipe assumes the WHOLE stopped window is already done: world uploaded, cfgs moved,\n' +
          '  bot/poller reverts made, pins live. It is the last gate before the panel Start (LAUNCH-WIPE.md\n' +
          '  step 6). Run earlier and its FAILs only mean "that step has not happened yet".',
      ),
    );
  }
  if (!MODDED) {
    console.log(C.dim('  GO-B: plugin, Emitter, world-day and modpack checks report only. Nothing modded is graded.'));
  }

  for (const r of results) {
    if (r.section) {
      console.log('');
      console.log(C.head(`── ${r.section} ${'─'.repeat(Math.max(0, 76 - r.section.length))}`));
      continue;
    }
    console.log(`  ${badge[r.status]}  ${r.title.padEnd(width)}  ${C.dim('·')} ${r.evidence}`);
  }

  console.log('');
  console.log(
    C.head('Result: ') +
      `${C.pass(`${counts.PASS} pass`)}, ${counts.FAIL ? C.fail(`${counts.FAIL} FAIL`) : '0 fail'}, ` +
      `${counts.WARN ? C.warn(`${counts.WARN} warn`) : '0 warn'}, ${C.skip(`${counts.SKIP} info`)}`,
  );
  if (counts.FAIL) {
    console.log(C.fail('  HOLD. Every FAIL above is a T-0 precondition that is not met. Do not advance the cutover.'));
  } else if (counts.WARN) {
    console.log(C.warn('  No blockers. Read every WARN and decide deliberately before advancing.'));
  } else {
    console.log(C.pass('  All preconditions for this phase are met.'));
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  checkUnits();
  checkBotEnv();
  checkPollerEnv();
  checkVercel();
  await checkSite();
  await checkSupabase();
  checkStateFiles();
  checkGtx();
  await checkPort3000();
  await checkThunderstore();

  render();
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((e) => {
  console.error('preflight crashed:', e);
  process.exit(3);
});
