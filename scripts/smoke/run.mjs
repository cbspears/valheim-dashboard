#!/usr/bin/env node
// The pre-deploy smoke test: `npm run smoke`.
//
// WHAT IT IS. docs/STRESS-TEST.md describes a twelve-minute rehearsal that has
// to be assembled by hand — a local Supabase, a repointed build, a dry-run bot,
// a load run, a rate-limit probe — and every step of it is a place to get the
// wiring wrong in a way that reads as a pass. This script is that rehearsal
// with the assembly automated and the length cut to a scenario that fits inside
// a code review: twenty vikings, ninety simulated minutes, three real minutes of
// load, the same invariants.
//
// It is not a replacement for the full run. It is the thing you run to prove a
// change did not break the pipeline before you ask Charlie to deploy it.
//
//   npm run smoke                 the whole thing, ~5 minutes (measured table in
//                                 docs/STRESS-TEST.md, "Measured")
//   npm run smoke -- --keep       leave the database and the built copy behind
//                                 (the server itself still stops)
//   npm run smoke -- --reuse-build   skip `next build` (iterating on the harness
//                                    only — the summary says the build is stale)
//
// WHAT IT DOES, in order, timing each step:
//   1. starts its OWN Supabase stack, or reuses it if it is already up
//   2. rebuilds that database from db/*.sql (the ordering fix included)
//   3. copies the repo to scratch and BUILDS it with the local Supabase in the
//      environment, which is what "repointed" means: NEXT_PUBLIC_* is inlined at
//      build time, so a production .next cannot be pointed anywhere else
//   4. serves the copy, proves it answers from an EMPTY local database
//   5. runs scripts/stress/bot-dryrun.mjs beside it (the deed, title and voice
//      loops are what several invariants are actually about)
//   6. runs scripts/stress/run.mjs — the load and the invariant table
//   7. runs the bot's own one-shot dry run against the result: one tick of every
//      loop, formatting real rows, nothing posted anywhere
//   8. tears down what IT started. A Supabase stack that was already up stays up.
//
// WHY ITS OWN STACK RATHER THAN THE ONE IN docs/STRESS-TEST.md. Step 2 rebuilds
// the database from empty, and the hand-assembled stress stack on the default
// ports is often the middle of somebody's evening — a dress rehearsal, a
// half-verified fix, an afternoon of `--verify-only`. A pre-deploy check that
// destroys the environment it finds is a check nobody runs twice. So this one
// keeps its own project ("eilifsmoke") on the 544xx ports, alongside the 543xx
// stack rather than on top of it, and owns that database completely: no
// leftover row from another run can turn an invariant green.
//
// IT ALSO REFUSES A SECOND COPY OF ITSELF. The workspace and the database are
// taken as exclusive locks before anything is touched, because a peer smoke run
// is the one thing the foreign-cwd and foreign-container checks below cannot
// see — it looks exactly like this run's own leftovers. See "the locks".
//
// IT REFUSES TO RUN ANYWHERE BUT LOOPBACK. The database host is not
// configurable (only its port is); an inherited SUPABASE_URL or DISCORD_TOKEN is
// refused rather than ignored; the built copy is grepped for a hosted Supabase
// project ref AND for the local one; the site has to answer from an empty
// database; and the load harness then does its own sentinel check, because a
// localhost port can still be serving a production build (docs/STRESS-TEST.md
// §2). Four separate refusals for one accident, because the accident writes
// twelve thousand rows into production.
//
// Node 20 (nvm use 20). Everything else it needs is docker + the Supabase CLI
// through npx.

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── configuration ────────────────────────────────────────────────────────────

const intEnv = (name, dflt) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
};

// The Supabase project this harness owns. Its containers are named
// supabase_*_eilifsmoke and its ports are the default 543xx block shifted to
// 544xx, so it can sit beside the stress stack instead of fighting it.
const PROJECT_ID = 'eilifsmoke';

const cfg = {
  dir: process.env.SMOKE_DIR || '/tmp/eilif-smoke',
  port: intEnv('SMOKE_PORT', 3402),
  supabasePort: intEnv('SMOKE_SUPABASE_PORT', 54421),
  cli: process.env.SMOKE_SUPABASE_CLI || 'supabase@2.116.0',
  // The scenario. 90 simulated minutes at 2 s each is 3 real minutes of load at
  // EXACTLY the per-address request rate the 2026-09-05 baseline was measured
  // at, so the rate-limit budget the run exercises is the one production has.
  // Shortening the tick instead would multiply that rate and turn the smoke
  // test into a limiter test.
  simMinutes: intEnv('SIM_MINUTES', 90),
  tickMs: intEnv('TICK_MS', 2000),
  settleMs: intEnv('SETTLE_MS', 45000),
  players: intEnv('PLAYERS', 20),
  seed: intEnv('SEED', 20260909),
  keep: process.argv.includes('--keep') || process.env.SMOKE_KEEP === '1',
  reuseBuild: process.argv.includes('--reuse-build'),
};

cfg.supabaseUrl = `http://127.0.0.1:${cfg.supabasePort}`;

const BASE = `http://localhost:${cfg.port}`;
const SITE = join(cfg.dir, 'site');
const LOGS = join(cfg.dir, 'logs');
const RESULTS = join(cfg.dir, 'results.json');

// The two things a second run would trample: this workspace, and the database on
// this port. The workspace lock lives in the workspace; the stack lock cannot,
// because the whole point of it is a peer run whose SMOKE_DIR is somewhere else.
const WORKSPACE_LOCK = join(cfg.dir, 'run.lock');
const STACK_LOCK = join(tmpdir(), `eilif-smoke-stack-${cfg.supabasePort}.lock`);

// Local-only stand-ins for every secret the site reads. None of these is a
// credential anywhere: they exist so the routes have something to compare.
const LOCAL_SECRETS = {
  WEBHOOK_SECRET: 'smoke-secret',
  GS_EMITTER_TOKEN: 'smoke-emitter',
  VOICE_API_TOKEN: 'smoke-voice',
  BOARDS_TOKEN: 'smoke-boards',
  OPS_HEARTBEAT_TOKEN: 'smoke-hb',
  OPS_PASSWORD: 'smoke',
  TV_ACCESS_KEY: 'smoke',
  GS_EXPECTED_WORLD: 'SmokeWorld',
};

// ── output ───────────────────────────────────────────────────────────────────

const t0 = Date.now();
const steps = [];
const failures = [];
const notes = [];

const say = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`[smoke] FAIL  ${msg}`);
};
const secs = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const clock = (ms) => {
  // Round to whole seconds FIRST. Splitting the milliseconds and rounding the
  // remainder afterwards prints 299.6 s as "4m60s".
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`;
};

async function step(name, fn) {
  const started = Date.now();
  say(`${name}...`);
  try {
    const out = await fn();
    steps.push({ name, ms: Date.now() - started });
    return out;
  } catch (e) {
    steps.push({ name, ms: Date.now() - started, error: true });
    throw e;
  }
}

class Abort extends Error {}
const abort = (msg) => {
  throw new Abort(msg);
};

// ── the refusal ──────────────────────────────────────────────────────────────
//
// Shape only. Coherence — "is the thing on that port actually reading the
// database on this one" — cannot be decided here; the site has to be built and
// running first. It is checked twice later: assertRepointed() greps the build
// for a hosted project ref, and run.mjs's own preflight stamps a sentinel world
// day into the local database and requires the site to read it back.

const loopbackHost = (u) => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

function assertLoopback(label, url) {
  if (!loopbackHost(url)) {
    abort(
      `${label} is ${url}. This harness writes thousands of rows and runs only against 127.0.0.1. ` +
        'Refusing.',
    );
  }
}

// ── small process helpers ────────────────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) abort(`${cmd}: ${r.error.message}`);
  return r;
}

/** Keys are local-only demo values, but nothing that scrolls past should look like a credential. */
const redact = (s) =>
  String(s)
    .replace(/eyJ[A-Za-z0-9_.\-]{20,}/g, '<jwt>')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_.\-]+/g, '<key>');

function shOrDie(cmd, args, opts = {}) {
  const r = sh(cmd, args, opts);
  if (r.status !== 0) {
    const tail = redact(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-12).join('\n');
    abort(`${cmd} ${args.join(' ')} exited ${r.status}\n${tail}`);
  }
  return r;
}

const children = [];

/** Spawn a long-running child, tee its output to `logFile`, remember it for teardown. */
function background(label, cmd, args, { cwd, env, logFile, onLine }) {
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const feed = (chunk) => {
    log.write(chunk);
    if (!onLine) return;
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const entry = { label, child, log, exited: false, code: null, spawnError: null };
  child.on('exit', (code) => {
    entry.exited = true;
    entry.code = code;
  });
  // Without this listener an ENOENT from spawn — a missing next binary in the
  // copy, a broken execPath — is an unhandled 'error' event thrown from the
  // event loop, which the try/catch around main never sees: the process dies
  // with the Supabase stack still up and the site copy still on disk, which is
  // exactly the state teardown exists to prevent. Record it and let the caller
  // decide.
  child.on('error', (e) => {
    entry.exited = true;
    entry.code = entry.code ?? -1;
    entry.spawnError = e;
  });
  children.push(entry);
  return entry;
}

async function stopChild(entry, { graceMs = 4000 } = {}) {
  if (!entry || entry.exited) return;
  entry.child.kill('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (!entry.exited && Date.now() < deadline) await sleep(150);
  if (!entry.exited) entry.child.kill('SIGKILL');
  entry.log.end();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a child to completion, tee to a log, return {code, text}. */
function runToEnd(cmd, args, { cwd, env, logFile, onLine, timeoutMs }) {
  return new Promise((res) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let buf = '';
    const feed = (chunk) => {
      text += chunk;
      log.write(chunk);
      if (!onLine) return;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      log.end();
      res({ code, text });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      log.end();
      res({ code: -1, text: `${text}\n${e.message}` });
    });
  });
}

// ── the local Supabase stack ─────────────────────────────────────────────────

async function stackAnswering() {
  try {
    await fetch(`${cfg.supabaseUrl}/rest/v1/`, { signal: AbortSignal.timeout(2500) });
    return true; // 401 is an answer; the point is that something is listening
  } catch {
    return false;
  }
}

/** Containers of THIS harness's project, by the label the CLI stamps on every one. */
function smokeContainers() {
  const ps = sh('docker', ['ps', '--filter', `label=com.supabase.cli.project=${PROJECT_ID}`, '--format', '{{.Names}}']);
  return (ps.stdout || '').trim().split('\n').filter(Boolean);
}

/**
 * Create the project if it is not there, and move it off the default ports.
 *
 * The whole local Supabase default range is 54320-54329, so shifting it wholesale
 * to 544xx keeps the mapping obvious (api 54321 -> 54421) and cannot collide
 * with a stack on the defaults. The rewrite is idempotent: a second pass finds
 * no 543xx left to move.
 */
function ensureProject(projectDir) {
  mkdirSync(projectDir, { recursive: true });
  const config = join(projectDir, 'supabase', 'config.toml');
  if (!existsSync(config)) {
    say('creating the smoke Supabase project');
    shOrDie('npx', [cfg.cli, 'init', '--force'], { cwd: projectDir });
  }
  const before = readFileSync(config, 'utf8');
  const after = before
    .replace(/^project_id\s*=\s*".*"$/m, `project_id = "${PROJECT_ID}"`)
    .replace(/\b543(\d{2})\b/g, '544$1');
  if (after !== before) writeFileSync(config, after);
  if (!after.includes(`port = ${cfg.supabasePort}`)) {
    abort(`${config} does not carry api port ${cfg.supabasePort}; delete ${projectDir} and re-run.`);
  }
}

/**
 * Rewrite the project's migrations from db/*.sql.
 *
 * Two things this encodes that nothing else in the repo does. `0000_initial_schema.sql`
 * carries no date and has to sort first; and `2026-08-24_loa_zero_baseline.sql` was
 * never applied to production, so applying it here would test a database that
 * does not exist. (The pins-before-gallery_pin_link ordering that used to be a
 * trap is now carried by the filename `2026-07-04_a_pins.sql`, which is why a
 * plain lexicographic sort is correct.)
 */
function syncMigrations(projectDir) {
  // Files headed STATUS: UNAPPLIED that production has not run either, so a
  // rebuilt stack matches production rather than running ahead of it.
  const NEVER_APPLIED = new Set(['2026-08-24_loa_zero_baseline.sql']);
  const src = join(REPO, 'db');
  const files = readdirSync(src)
    .filter((f) => f.endsWith('.sql') && !NEVER_APPLIED.has(f))
    .sort();
  const dest = join(projectDir, 'supabase', 'migrations');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  let seq = 0;
  for (const f of files) {
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})_/);
    // A dated file keeps its date so the migration order is legible; the
    // undated initial schema is stamped before every date in the repo.
    const day = m ? `${m[1]}${m[2]}${m[3]}` : '20260101';
    const version = `${day}${String(seq++).padStart(6, '0')}`;
    const slug = f.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/^0000_/, '').replace(/^a_/, '');
    copyFileSync(join(src, f), join(dest, `${version}_${slug}`));
  }
  return files.length;
}

async function createBuckets(serviceKey) {
  // `db reset` drops storage.buckets with the rest of the database, so both
  // public buckets are re-created on every reset, not just the first.
  for (const b of ['gallery', 'map']) {
    const r = await fetch(`${cfg.supabaseUrl}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: b, name: b, public: true }),
    });
    if (!r.ok && r.status !== 409) {
      const body = await r.text().catch(() => '');
      if (!/already exists/i.test(body)) abort(`could not create the "${b}" bucket: ${r.status} ${body.slice(0, 200)}`);
    }
  }
}

function stackKeys(projectDir) {
  const r = shOrDie('npx', [cfg.cli, 'status', '-o', 'env'], { cwd: projectDir });
  const env = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.ANON_KEY || !env.SERVICE_ROLE_KEY) abort('could not read the local anon/service keys from `supabase status`.');
  if (env.API_URL && !loopbackHost(env.API_URL)) abort(`the running stack reports API_URL ${env.API_URL}, which is not loopback.`);
  return { anon: env.ANON_KEY, service: env.SERVICE_ROLE_KEY };
}

// ── the site copy ────────────────────────────────────────────────────────────

function copyRepo() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  const tarball = join(cfg.dir, 'site.tar');
  // The service .env files hold the live Discord bot token, the production
  // service-role key and the GTX box's SFTP credentials. They are gitignored,
  // so tar takes them unless told not to, and the copy is world-readable.
  // .env.local is the site's own production Supabase key. Nothing local needs
  // any of them; assertNoSecrets() below proves none came along.
  shOrDie('tar', [
    'cf', tarball,
    '--exclude=./node_modules', '--exclude=./.git', '--exclude=./.next', '--exclude=./.vercel',
    '--exclude=./.env', '--exclude=./.env.local', '--exclude=./.env.*.local',
    '--exclude=./services/*/.env', '--exclude=./services/*/state.json',
    '--exclude=./.map-screens', '--exclude=./tsconfig.tsbuildinfo',
    '-C', REPO, '.',
  ]);
  shOrDie('tar', ['xf', tarball, '-C', SITE]);
  rmSync(tarball, { force: true });

  // node_modules has to be a REAL directory inside the copy. Turbopack refuses a
  // symlink that leaves the project root ("Symlink [project]/node_modules is
  // invalid, it points out of the filesystem root") and the build dies before it
  // starts. `cp -al` hardlinks 700 MB of dependencies in about a second and
  // costs no disk; a build only ever writes new files under node_modules, never
  // back into one of these, so the repo's tree is not at risk. If the scratch
  // directory is on another filesystem, fall back to a real copy.
  const dest = join(SITE, 'node_modules');
  if (sh('cp', ['-al', join(REPO, 'node_modules'), dest]).status !== 0) {
    say('scratch is on another filesystem; copying node_modules instead of hardlinking');
    shOrDie('cp', ['-a', join(REPO, 'node_modules'), dest]);
  }
}

function assertNoSecrets() {
  const r = sh('find', [SITE, '-name', '.env*', '-not', '-name', '.env*.example', '-not', '-path', '*/node_modules/*']);
  const hits = (r.stdout || '').trim().split('\n').filter(Boolean);
  if (hits.length) abort(`the site copy carries ${hits.length} .env file(s); they may hold live credentials. Refusing.`);
}

/**
 * The repoint, proved rather than asserted.
 *
 * NEXT_PUBLIC_* is inlined at build time, so a production `.next` keeps writing
 * to production no matter what the environment says at `next start`. The copy is
 * built with the local Supabase in the environment, which is the fix; these two
 * greps are the proof. A hosted project ref is twenty lowercase alphanumerics —
 * the width is what separates a real one from supabase-js's own ten-character
 * `xyzcompany.supabase.co` documentation strings, so the class has to include
 * digits or a ref like `syuw4vxpmtdm8upxjzje` would walk straight through.
 */
function assertRepointed() {
  const hosted = sh('grep', ['-rlE', '[a-z0-9]{20}\\.supabase\\.co', join(SITE, '.next')]);
  const files = (hosted.stdout || '').trim().split('\n').filter(Boolean);
  if (files.length) {
    abort(
      `the built copy still carries a hosted Supabase project ref in ${files.length} file(s) — ` +
        'it would read and write PRODUCTION. Refusing.',
    );
  }
  const local = sh('grep', ['-rl', `127.0.0.1:${cfg.supabasePort}`, join(SITE, '.next', 'server')]);
  const localFiles = (local.stdout || '').trim().split('\n').filter(Boolean);
  if (!localFiles.length) abort('the built copy does not carry the local Supabase URL anywhere; the build did not pick up the environment.');
  return localFiles.length;
}

// ── environments for the children ────────────────────────────────────────────
//
// Built from a copy of the current environment with everything that could reach
// production or Discord removed, then the local values put back. Inheriting
// blindly is how a stray DISCORD_TOKEN or a production SUPABASE_URL ends up
// inside a rehearsal.

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(DISCORD_|CHANNEL_|SFTP_|VERCEL_|CHAT_DISCORD|NEXT_PUBLIC_|SUPABASE_|GS_|OPS_|WEBHOOK_|VOICE_|BOARDS_|TV_)/.test(k)) delete env[k];
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

// ── waiting for the site, and proving the database behind it is empty ────────

async function waitForSite(proc) {
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    // A server that never started, or that died on its own, is worth saying so
    // in one second rather than ninety.
    if (proc?.spawnError) abort(`the site server could not be started: ${proc.spawnError.message}`);
    if (proc?.exited) abort(`the site server exited (code ${proc.code}). See ${join(LOGS, 'site.log')}`);
    try {
      const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const body = await r.json();
        if (body.players === 0 && (body.worldDay ?? 0) === 0 && body.online === false) return body;
        abort(
          `${BASE}/api/status answered players=${body.players} worldDay=${body.worldDay} online=${body.online}. ` +
            'A freshly reset local database answers 0/0/false — this build is reading somewhere else. Refusing.',
        );
      }
      last = `HTTP ${r.status}`;
    } catch (e) {
      if (e instanceof Abort) throw e;
      last = e?.message ?? String(e);
    }
    await sleep(1000);
  }
  abort(`the site never answered on ${BASE} (${last}). See ${join(LOGS, 'site.log')}`);
}

// ── port hygiene ─────────────────────────────────────────────────────────────

function pidsOnPort(port) {
  const r = sh('ss', ['-ltnpH', `sport = :${port}`]);
  return [...new Set([...(r.stdout || '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
}

function clearOwnPort() {
  const pids = pidsOnPort(cfg.port);
  if (!pids.length) return;
  const foreign = [];
  for (const pid of pids) {
    const cwd = sh('readlink', ['-f', `/proc/${pid}/cwd`]).stdout?.trim() ?? '';
    if (cwd.startsWith(cfg.dir)) {
      say(`port ${cfg.port} still held by a previous smoke server (pid ${pid}) — stopping it`);
      sh('kill', ['-9', String(pid)]);
    } else {
      foreign.push(`${pid} (${cwd || 'unknown cwd'})`);
    }
  }
  if (foreign.length) {
    abort(
      `port ${cfg.port} is in use by something that is not this harness: ${foreign.join(', ')}. ` +
        'Stop it, or run with SMOKE_PORT set to a free port.',
    );
  }
}

function stopStrayBots() {
  // A dry-run bot left over from an earlier smoke run announces deeds and sets
  // titles against the same database this run is about to assert on, and two
  // announcers make "one saga row per deed" a coin flip.
  //
  // ONLY the ones pointed at THIS harness's database. A dry-run bot on the
  // stress stack is somebody else's rehearsal in progress and cannot touch
  // anything here — killing it because it shares a filename would be the same
  // mistake as `pkill -f "node src/index.js"` against the bot and the poller.
  const r = sh('pgrep', ['-f', 'scripts/stress/bot-dryrun.mjs']);
  const pids = (r.stdout || '').trim().split('\n').filter(Boolean);
  const ours = pids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`SUPABASE_URL=${cfg.supabaseUrl}`);
    } catch {
      return false;
    }
  });
  if (!ours.length) return;
  say(`stopping ${ours.length} leftover dry-run bot(s) on this database (pid ${ours.join(', ')})`);
  notes.push(`stopped ${ours.length} leftover dry-run bot process(es) before starting`);
  for (const pid of ours) sh('kill', ['-9', pid]);
}

// ── the locks ────────────────────────────────────────────────────────────────
//
// Everything this harness owns, it owns destructively: it deletes $SMOKE_DIR/site,
// kills whatever holds SMOKE_PORT out of that directory, and rebuilds the smoke
// database from empty. A SECOND `npm run smoke` would do all three to the first
// one, and neither of the foreign-thing checks catches it — a peer smoke run has
// a cwd under cfg.dir, so clearOwnPort reads its server as "a previous smoke
// server" and kills it, and its containers carry this project's label, so the
// stack step reads its database as "already up" and resets it underneath.
//
// So: take the two shared things as exclusive locks before touching anything,
// and refuse rather than trample. The workspace lock covers the site copy, the
// logs and results.json; the stack lock covers the database, which a peer can
// reach with a different SMOKE_DIR entirely.

const heldLocks = [];

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // alive, just not ours to signal
  }
};

/** O_EXCL create, or abort naming the holder. A lock whose pid is gone is stale and cleared. */
function takeLock(path, what, hint) {
  const body = JSON.stringify({
    pid: process.pid,
    dir: cfg.dir,
    port: cfg.port,
    supabasePort: cfg.supabasePort,
    started: new Date().toISOString(),
  });
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      heldLocks.push(path);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') abort(`could not take the ${what} lock ${path}: ${e.message}`);
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        holder = null; // unreadable: treat as stale, one small write is atomic enough
      }
      if (holder?.pid && holder.pid !== process.pid && pidAlive(holder.pid)) {
        abort(
          `another smoke run holds the ${what} lock: pid ${holder.pid}, started ${holder.started}, ` +
            `workspace ${holder.dir}, site port ${holder.port}, database port ${holder.supabasePort}. ${hint}`,
        );
      }
      say(`clearing a stale ${what} lock (${path}; pid ${holder?.pid ?? 'unknown'} is gone)`);
      rmSync(path, { force: true });
    }
  }
  abort(`could not take the ${what} lock ${path}; it keeps coming back.`);
}

/** Only ever removes locks THIS process created. */
function releaseLocks() {
  while (heldLocks.length) rmSync(heldLocks.pop(), { force: true });
}

const PARALLEL_HINT =
  'Two runs cannot share one workspace or one database. Wait for it to finish, or re-run with ' +
  'SMOKE_DIR, SMOKE_PORT and SMOKE_SUPABASE_PORT all pointed somewhere else.';

// ── main ─────────────────────────────────────────────────────────────────────

let ownWorkspace = false;
let startedStack = false;
let projectDir = null;
let siteProc = null;
let botProc = null;

async function teardown() {
  await stopChild(botProc);
  await stopChild(siteProc);
  if (startedStack && !cfg.keep) {
    say('stopping the Supabase stack this run started');
    sh('npx', [cfg.cli, 'stop'], { cwd: projectDir });
  }
  // Only ever delete a workspace this run holds the lock on. Aborting BECAUSE a
  // peer holds it must not then delete the peer's build on the way out.
  if (!cfg.keep && ownWorkspace) rmSync(SITE, { recursive: true, force: true });
  releaseLocks();
}

let torn = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (torn) process.exit(130);
    torn = true;
    console.log(`\n[smoke] ${sig} — tearing down`);
    await teardown();
    process.exit(130);
  });
}

let results = null;
let dryTick = null;
let repointedFiles = 0;
let migrationCount = 0;
let reusedStack = false;

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) abort(`Node ${process.versions.node}; this repo needs 20.9+. export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20`);

  // The host is not configurable — only the port is — so these two asserts are
  // the floor rather than the whole guard.
  assertLoopback('the smoke database URL', cfg.supabaseUrl);
  assertLoopback('the smoke site URL', BASE);
  // What IS worth refusing: an inherited variable that names a database this run
  // will then quietly ignore. Silently building against a different Supabase
  // than the one in the operator's environment is how a green run gets read as
  // evidence about the wrong system.
  for (const name of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'DATABASE_URL']) {
    const v = process.env[name];
    if (v && !loopbackHost(v)) {
      abort(
        `${name} is set to ${v}. This harness always builds and runs against ${cfg.supabaseUrl} ` +
          '(set SMOKE_SUPABASE_PORT to move it) and would ignore that value. Unset it and re-run.',
      );
    }
  }
  if (process.env.DISCORD_TOKEN) {
    abort('DISCORD_TOKEN is set. Nothing here logs in, but a rehearsal that inherits a real token is not a rehearsal. Unset it.');
  }

  mkdirSync(LOGS, { recursive: true });
  // Before stopStrayBots(), clearOwnPort(), the site copy or `db reset` — every
  // one of which is destructive to a peer run that got here first.
  takeLock(WORKSPACE_LOCK, 'workspace', PARALLEL_HINT);
  ownWorkspace = true;
  takeLock(STACK_LOCK, `database (port ${cfg.supabasePort})`, PARALLEL_HINT);
  writeFileSync(join(cfg.dir, 'empty.env'), '');
  say(
    `${cfg.players} vikings, ${cfg.simMinutes} simulated minutes at ${cfg.tickMs}ms ` +
      `(~${Math.round((cfg.simMinutes * cfg.tickMs) / 60000)} real minutes of load), seed ${cfg.seed}`,
  );
  say(`workspace ${cfg.dir}, site on ${BASE}, database ${cfg.supabaseUrl}`);

  if (!existsSync(join(REPO, 'services', 'discord-bot', 'node_modules'))) {
    abort('services/discord-bot/node_modules is missing — run `npm install` there first (it is a separate npm project).');
  }
  if (sh('docker', ['info']).status !== 0) abort('docker is not answering; the local Supabase stack needs it.');

  stopStrayBots();
  clearOwnPort();

  // 1 + 2. the stack, and a database rebuilt from db/*.sql
  const keys = await step('supabase stack', async () => {
    projectDir = join(cfg.dir, 'supabase-project');
    ensureProject(projectDir);
    if (await stackAnswering()) {
      if (!smokeContainers().length) {
        abort(
          `something is already serving ${cfg.supabaseUrl} and it is not this harness's stack. ` +
            'Stop it, or run with SMOKE_SUPABASE_PORT set to a free port.',
        );
      }
      // Safe to reuse AND reset: the stack lock above means no other smoke run
      // is using this database. A stack that is up with nobody holding the lock
      // is a leftover (--keep, or a run that was killed), not a run in progress.
      reusedStack = true;
      say(`reusing the ${PROJECT_ID} stack already up — it will be left running`);
    } else {
      say('starting the smoke Supabase stack (the first run creates its containers)');
      // Captured, not inherited: `supabase start` finishes by printing every
      // local key, and a log full of things shaped like credentials is a log
      // nobody can paste into a ticket.
      shOrDie('npx', [cfg.cli, 'start'], { cwd: projectDir });
      startedStack = true;
    }
    return stackKeys(projectDir);
  });

  await step('database reset from db/*.sql', async () => {
    migrationCount = syncMigrations(projectDir);
    say(`${migrationCount} migrations staged; resetting`);
    const r = sh('npx', [cfg.cli, 'db', 'reset'], { cwd: projectDir });
    if (r.status !== 0) {
      const tail = redact(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-15).join('\n');
      abort(`supabase db reset failed:\n${tail}`);
    }
    await createBuckets(keys.service);
  });

  // 3. the build, repointed by construction
  // Decided once, so the step name cannot say "reused" while it builds: after a
  // teardown there is no .next to reuse and --reuse-build builds anyway.
  const reusingBuild = cfg.reuseBuild && existsSync(join(SITE, '.next'));
  await step(reusingBuild ? 'site copy (build reused)' : 'site build', async () => {
    if (reusingBuild) {
      notes.push('BUILD REUSED (--reuse-build): the bytes under test are from an earlier run');
      return;
    }
    copyRepo();
    assertNoSecrets();
    const build = await runToEnd('npm', ['run', 'build'], {
      cwd: SITE,
      env: childEnv({
        NEXT_PUBLIC_SUPABASE_URL: cfg.supabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
        SUPABASE_SERVICE_ROLE_KEY: keys.service,
        ...LOCAL_SECRETS,
      }),
      logFile: join(LOGS, 'build.log'),
      timeoutMs: 15 * 60_000,
    });
    if (build.code !== 0) {
      const tail = redact(build.text).trim().split('\n').slice(-20).join('\n');
      abort(`next build failed (exit ${build.code}):\n${tail}`);
    }
    repointedFiles = assertRepointed();
    assertNoSecrets();
  });
  if (reusingBuild && !repointedFiles) repointedFiles = assertRepointed();

  // 4. serve it, and prove the database behind it is the empty local one
  await step('site up', async () => {
    siteProc = background('site', join(SITE, 'node_modules', '.bin', 'next'), ['start', '-p', String(cfg.port)], {
      cwd: SITE,
      env: childEnv({
        NEXT_PUBLIC_SUPABASE_URL: cfg.supabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon,
        SUPABASE_SERVICE_ROLE_KEY: keys.service,
        ...LOCAL_SECRETS,
      }),
      logFile: join(LOGS, 'site.log'),
    });
    const status = await waitForSite(siteProc);
    say(`site answering from an empty local database (players ${status.players}, world day ${status.worldDay})`);
  });

  // 5. the dry-run bot beside it — the deed, title and voice loops
  await step('dry-run bot up', async () => {
    // The bot's loops are derived from production by BOT_COMPRESSION, which is
    // 60000/TICK_MS: the same ratio between the anti-spam gaps and the
    // simulated clock that production runs at. See docs/STRESS-TEST.md §3.
    const compression = Math.max(1, Math.round(60_000 / cfg.tickMs));
    botProc = background('bot', process.execPath, ['scripts/stress/bot-dryrun.mjs'], {
      cwd: REPO,
      env: childEnv({
        SUPABASE_URL: cfg.supabaseUrl,
        SUPABASE_ANON_KEY: keys.anon,
        SUPABASE_SERVICE_ROLE_KEY: keys.service,
        WEBHOOK_URL: `${BASE}/api/webhook`,
        WEBHOOK_SECRET: LOCAL_SECRETS.WEBHOOK_SECRET,
        TITLES_API: `${BASE}/api/titles`,
        VOICE_ENGINE: '1',
        EVENTS_SYNC: '0',
        GALLERY_INGEST: '0',
        BOT_COMPRESSION: String(compression),
        TZ: process.env.TZ || 'America/Chicago',
      }),
      logFile: join(LOGS, 'bot.log'),
    });
    await sleep(2500);
    if (botProc.spawnError) abort(`the dry-run bot could not be started: ${botProc.spawnError.message}`);
    if (botProc.exited) abort(`the dry-run bot exited immediately (code ${botProc.code}). See ${join(LOGS, 'bot.log')}`);
    say(`bot loops running at BOT_COMPRESSION=${compression}, nothing reaches Discord`);
  });

  // 6. the scenario and the invariants
  // Nothing else deletes results.json — teardown deliberately leaves it, and the
  // summary prints its path. So clear it here: if this run dies before writing
  // one, the summary must say "not reached" rather than quote the last run's
  // "32 passed, 0 failed" next to this run's failure.
  rmSync(RESULTS, { force: true });
  const run = await step('load run + invariants', async () =>
    runToEnd(process.execPath, ['scripts/stress/run.mjs'], {
      cwd: REPO,
      env: childEnv({
        SUPABASE_URL: cfg.supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: keys.service,
        BASE_URL: BASE,
        WEBHOOK_SECRET: LOCAL_SECRETS.WEBHOOK_SECRET,
        GS_EMITTER_TOKEN: LOCAL_SECRETS.GS_EMITTER_TOKEN,
        GS_EXPECTED_WORLD: LOCAL_SECRETS.GS_EXPECTED_WORLD,
        SIM_MINUTES: String(cfg.simMinutes),
        TICK_MS: String(cfg.tickMs),
        SETTLE_MS: String(cfg.settleMs),
        PLAYERS: String(cfg.players),
        SEED: String(cfg.seed),
        OUT: RESULTS,
      }),
      logFile: join(LOGS, 'run.log'),
      onLine: (line) => {
        if (/^\[stress\] (sim minute|minute 0|settling|preflight)/.test(line) || /^\s*(FAIL|SKIP)\s/.test(line)) {
          console.log(`  ${line.trim()}`);
        }
      },
      timeoutMs: 30 * 60_000,
    }));

  if (existsSync(RESULTS)) results = JSON.parse(readFileSync(RESULTS, 'utf8'));
  if (run.code !== 0) fail(`the load run exited ${run.code} — see ${join(LOGS, 'run.log')}`);
  if (!results) fail('the load run wrote no results file');
  else {
    const c = results.counts ?? {};
    if (c.invariantsFailed > 0) fail(`${c.invariantsFailed} invariant(s) failed`);
    // A SKIP checked nothing. In a full run there is nothing for it to skip, so
    // a skip here means the harness lost its own expectations — not a pass.
    if (c.invariantsSkipped > 0) fail(`${c.invariantsSkipped} invariant(s) SKIPPED (a check that compared nothing is not a pass)`);
    const non2xx = (results.latency ?? []).reduce((n, r) => n + (r.non2xx ?? 0), 0);
    if (non2xx > 0) fail(`${non2xx} non-2xx responses during the run`);
  }

  // 7. one tick of the bot's own dry run against what the evening produced
  dryTick = await step('bot dry-run tick', async () => {
    const r = await runToEnd(process.execPath, ['src/index.js'], {
      cwd: join(REPO, 'services', 'discord-bot'),
      env: childEnv({
        DRY_RUN: '1',
        // services/discord-bot/src/index.js does `import 'dotenv/config'`, which
        // would otherwise load services/discord-bot/.env — the live Discord token
        // and the production service-role key. Point dotenv at an empty file.
        DOTENV_CONFIG_PATH: join(cfg.dir, 'empty.env'),
        SUPABASE_URL: cfg.supabaseUrl,
        SUPABASE_ANON_KEY: keys.anon,
        SUPABASE_SERVICE_ROLE_KEY: keys.service,
        TITLES_API: `${BASE}/api/titles`,
        VOICE_ENGINE: '1',
        TZ: process.env.TZ || 'America/Chicago',
      }),
      logFile: join(LOGS, 'dry-tick.log'),
      timeoutMs: 5 * 60_000,
    });
    const brokenLoops = [...r.text.matchAll(/^\s{2}(\S+)\s+FAILED — (.*)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
    if (r.code !== 0) fail(`the bot's dry-run tick exited ${r.code} — see ${join(LOGS, 'dry-tick.log')}`);
    else if (!/DRY RUN complete/.test(r.text)) fail('the bot dry-run tick did not complete a tick of every loop');
    if (brokenLoops.length) fail(`bot loop(s) failed against the stressed database: ${brokenLoops.join('; ')}`);
    if (/DISCORD_TOKEN/.test(r.text) && !/never read/.test(r.text)) fail('the bot dry run mentioned a Discord token it should not have');
    return { code: r.code, brokenLoops };
  });
} catch (e) {
  if (e instanceof Abort) fail(e.message);
  else fail(`${e?.stack ?? e}`);
} finally {
  if (!torn) {
    torn = true;
    await step('teardown', teardown).catch(() => {});
  }
}

// ── the one-screen summary ───────────────────────────────────────────────────

const ok = failures.length === 0;
const c = results?.counts ?? {};
const lat = results?.latency ?? [];
const totalReq = lat.reduce((n, r) => n + (r.n ?? 0), 0);
const non2xx = lat.reduce((n, r) => n + (r.non2xx ?? 0), 0);
const worst = [...lat].sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0];

const row = (k, v) => console.log(`  ${k.padEnd(18)}${v}`);
console.log(`\n${'='.repeat(72)}`);
console.log(`  SMOKE ${ok ? 'PASS' : 'FAIL'}   ${clock(Date.now() - t0)} total`);
console.log('='.repeat(72));
row('scenario', `${cfg.players} vikings, ${cfg.simMinutes} sim minutes @ ${cfg.tickMs}ms, seed ${cfg.seed}`);
row('supabase', `${PROJECT_ID} on ${cfg.supabaseUrl} — ${reusedStack ? 'was already up, left up' : startedStack ? (cfg.keep ? 'started, left up' : 'started and stopped by this run') : 'not reached'}, ${migrationCount} migrations`);
row(
  'site',
  repointedFiles
    ? `${BASE} — built with the local stack inlined, 0 hosted refs in .next, ${repointedFiles} chunks carry 127.0.0.1:${cfg.supabasePort}`
    : `${BASE} — not reached`,
);
row('requests', totalReq ? `${totalReq.toLocaleString()} sent, ${non2xx} non-2xx, worst p95 ${worst?.p95 ?? '-'}ms (${worst?.endpoint ?? '-'})` : 'none recorded');
row('invariants', results ? `${c.invariantsPassed ?? 0} passed, ${c.invariantsFailed ?? 0} failed, ${c.invariantsSkipped ?? 0} skipped` : 'not reached');
row('counts', results ? `${c.events ?? 0} events, ${c.sessions ?? 0} sessions, ${c.players ?? 0} players, ${c.milestonesAchieved ?? 0} deeds, ${c.voiceLines ?? 0} voice lines` : '-');
row('bot dry-run tick', dryTick ? (dryTick.code === 0 && !dryTick.brokenLoops.length ? 'every loop ticked clean' : 'FAILED') : 'not reached');
row('steps', steps.map((s) => `${s.name} ${secs(s.ms)}`).join(' | '));
for (const n of notes) row('note', n);
if (results) row('results', RESULTS);
row('logs', `${LOGS}/{build,site,bot,run,dry-tick}.log`);
if (!ok) {
  console.log(`\n  ${failures.length} failure(s):`);
  for (const f of failures) console.log(`   - ${f}`);
  if (results) {
    for (const chk of results.checks ?? []) {
      if (chk.ok !== 'PASS') console.log(`   ${chk.ok}  ${chk.name}\n         ${chk.evidence}`);
    }
  }
}
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
