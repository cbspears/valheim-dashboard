// Launch-wipe: clear the July-pilot test-world data out of prod Supabase before
// the real 1.0 launch world (~2026-09-09) goes live.
//
// Defaults to --dry-run (READS ONLY — no writes to Supabase, no local file
// deletes). Add --execute to actually wipe, which ALSO requires typing the
// confirmation word WIPE at a prompt. There is no other way to make this
// script write.
//
//   Node 20:  export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//   Preview:  node scripts/launch-wipe.mjs
//   Wipe:     node scripts/launch-wipe.mjs --execute --i-mean-prod
//
// TARGET SELECTION (added 2026-09-06, for the launch-day rehearsal). The target
// still defaults to .env.local, i.e. production. Three flags move it:
//
//   --supabase-url <u>   (or LAUNCH_WIPE_SUPABASE_URL)  where to wipe
//   --service-key <k>    (or LAUNCH_WIPE_SERVICE_KEY)   the key to wipe with
//   --state-dir <dir>    (or LAUNCH_WIPE_STATE_DIR)     root of the three local
//                                                       state files it deletes
//
// and three refusals make the choice impossible to get wrong by accident:
//
//   * --execute against a NON-loopback url is refused unless --i-mean-prod is
//     also passed. A dry run is never blocked — the production preview is a
//     documented launch-day step.
//   * --execute against a loopback url is refused without --state-dir, because
//     the three state files live in this working copy and belong to the LIVE
//     systemd services. A rehearsal that deleted them would break production.
//   * --execute against a NON-loopback url is refused WITH --state-dir, because
//     that combination wipes production while deleting nothing local, which is
//     how the pilot's announcedBosses would survive into launch night.
//
// Rehearsal (docs/LAUNCH-WIPE.md, "Rehearsal 2026-09-06"):
//   scripts/stress/rehearse-launch.sh
//
// Why this exists (not a naive `delete from ...` pass): two services will undo
// the wipe from underneath it, so step 1 below refuses --execute outright while
// EITHER is active (and warns, but doesn't block, on the other two):
//
//   * eilif-discord-bot   -- its voice tick ends in an unconditional saveState()
//     every 60 s, which recreates services/discord-bot/state.json with the SAME
//     announcedBosses array. The wipe flips bosses.is_killed back to false but
//     keeps the row ids, so a resurrected state.json makes bosses.tick() treat
//     launch night's real Eikthyr kill as already announced: no @everyone, no
//     skald retelling, freshKills empty. STOP THE BOT FIRST -- before the wipe,
//     not after (audit discord-1 / launch-16, 2026-09-03).
//   * eilif-stats-parser  -- re-upserts player_stats from the local .fch profiles
//     every ~15 minutes (services/stats-parser), so a wipe while it runs gets
//     repopulated with the same test-world junk on its next sweep. That unit was
//     retired on 2026-08-23; the gate stays because a retired unit someone
//     re-enables is exactly the surprise this script exists to prevent (an
//     inactive/unknown unit is never blocked).
//
// Uses the same plain-PostgREST-over-fetch pattern as scripts/backfill-identity.js
// and scripts/seed-milestones-backfill.mjs (supabase-js is flaky under bare
// Node 20 outside Next — see those files' comments) — no extra dependency.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

// `--name value` and `--name=value` both accepted. A following token that starts
// with `--` is a flag, never this flag's value.
function flagValue(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return null;
}

const EXECUTE = argv.includes('--execute');
const DRY_RUN = !EXECUTE;
// Only meaningful with --execute against a NON-loopback target. See the target
// guard below for why it exists.
const I_MEAN_PROD = argv.includes('--i-mean-prod');

const urlFlag = flagValue('supabase-url');
const keyFlag = flagValue('service-key');
const stateDirFlag = flagValue('state-dir');
const URL_OVERRIDE = urlFlag || process.env.LAUNCH_WIPE_SUPABASE_URL || null;
const KEY_OVERRIDE = keyFlag || process.env.LAUNCH_WIPE_SERVICE_KEY || null;
const STATE_DIR_OVERRIDE = stateDirFlag || process.env.LAUNCH_WIPE_STATE_DIR || null;
const URL_SOURCE = urlFlag ? '--supabase-url' : URL_OVERRIDE ? 'LAUNCH_WIPE_SUPABASE_URL' : '.env.local';
const KEY_SOURCE = keyFlag ? '--service-key' : KEY_OVERRIDE ? 'LAUNCH_WIPE_SERVICE_KEY' : '.env.local';

// ── env (mirrors scripts/backfill-identity.js / seed-milestones-backfill.mjs) ──
// .env.local is the launch-day source and stays the default. It is READ ONLY
// when neither override is supplied, so a rehearsal box without one still runs.
function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = URL_OVERRIDE || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = KEY_OVERRIDE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Missing Supabase target. Supply --supabase-url/--service-key (or\n' +
      'LAUNCH_WIPE_SUPABASE_URL / LAUNCH_WIPE_SERVICE_KEY), or put\n' +
      'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.',
  );
  process.exit(1);
}
const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const AUTH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// ── which stack is this pointed at? ──────────────────────────────────────────
//
// A loopback host is the rehearsal stack (docs/STRESS-TEST.md); anything else is
// treated as production, because in this repo it always has been.
function isLoopbackUrl(u) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}
const TARGET_IS_LOCAL = isLoopbackUrl(SUPABASE_URL);

// ── local state files: whose? ────────────────────────────────────────────────
//
// The three state files this script deletes belong to the LIVE systemd services
// (eilif-discord-bot, eilif-log-poller, eilif-map-snapshot all run out of this
// working copy). A rehearsal against the local stack that deleted them would
// take out production's cursor and announced-boss ledger while the rehearsal
// itself proved nothing. So --state-dir relocates them, and a local --execute
// without one is refused below rather than defaulted.
const STATE_ROOT = STATE_DIR_OVERRIDE ? path.resolve(STATE_DIR_OVERRIDE) : ROOT;

// ── target guards ────────────────────────────────────────────────────────────
//
// Read-only runs are never blocked: the dry run against production IS the
// launch-day preview (docs/LAUNCH-WIPE.md, "Order of operations" step 3).
if (EXECUTE && !TARGET_IS_LOCAL && !I_MEAN_PROD) {
  console.error('====================================================================');
  console.error(' Refusing --execute.');
  console.error('====================================================================');
  console.error(`  Target:      ${SUPABASE_URL}  (from ${URL_SOURCE})`);
  console.error('  That is not a loopback host, so this is a PRODUCTION wipe: real');
  console.error('  DELETEs, no undo, and the Free plan has no backups.');
  console.error('');
  console.error('  Rehearsing?  Point it at the local stack instead:');
  console.error('    node scripts/launch-wipe.mjs --execute \\');
  console.error('      --supabase-url http://127.0.0.1:54321 --service-key <local service key> \\');
  console.error('      --state-dir <scratch copy of the state files>');
  console.error('');
  console.error('  Really wiping production on launch day? Add --i-mean-prod.');
  process.exit(2);
}
if (EXECUTE && TARGET_IS_LOCAL && !STATE_DIR_OVERRIDE) {
  console.error('====================================================================');
  console.error(' Refusing --execute against the local stack without --state-dir.');
  console.error('====================================================================');
  console.error(`  Target: ${SUPABASE_URL}`);
  console.error('  The three state files this wipe deletes belong to the LIVE services,');
  console.error('  which run out of this working copy:');
  console.error('    services/discord-bot/state.json    (announcedBosses)');
  console.error('    services/log-poller/state.json     (byte cursor)');
  console.error('    scripts/.map-snapshot-state.json   (day-frame manifest cursor)');
  console.error('  Deleting them for a rehearsal would break production and prove nothing.');
  console.error('  Copy them into scratch and pass --state-dir <that dir> instead.');
  process.exit(2);
}
// The third combination, and the one that reads harmless. --state-dir is a
// REHEARSAL flag: against production the three state files must be the live
// services' own, at the repo root. A prod wipe carrying a leftover --state-dir
// from a rehearsal command line (they sit a hundred lines apart in
// docs/LAUNCH-WIPE.md, which is where the copy-paste comes from) would clear
// every row and then delete nothing, leaving services/discord-bot/state.json
// holding the pilot's announcedBosses — the exact silence this script's header
// says it exists to prevent. Refuse rather than warn.
if (EXECUTE && !TARGET_IS_LOCAL && STATE_DIR_OVERRIDE) {
  console.error('====================================================================');
  console.error(' Refusing --execute: --state-dir is a rehearsal-only flag.');
  console.error('====================================================================');
  console.error(`  Target:      ${SUPABASE_URL}  (from ${URL_SOURCE})`);
  console.error(`  --state-dir: ${STATE_ROOT}`);
  console.error('');
  console.error('  Against a production target the three state files MUST be the live');
  console.error('  services’ own, at the repo root. Wiping prod with the state files');
  console.error('  pointed at scratch clears every row and deletes nothing, so:');
  console.error('    services/discord-bot/state.json  keeps the pilot announcedBosses');
  console.error('                                     -> launch night’s first boss kill');
  console.error('                                        posts nothing and is never retold');
  console.error('    services/log-poller/state.json   keeps a stale byte cursor');
  console.error('    scripts/.map-snapshot-state.json keeps the day-64 manifest cursor');
  console.error('');
  console.error('  Drop --state-dir (and LAUNCH_WIPE_STATE_DIR) for the launch-day wipe.');
  process.exit(2);
}
if (I_MEAN_PROD && TARGET_IS_LOCAL) {
  console.log('\n  note: --i-mean-prod ignored — the target is loopback, not production.');
}

function banner(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}

// ── PostgREST helpers ───────────────────────────────────────────────────────
// countRows: GET with Prefer: count=exact and no rows of substance actually
// needed — select=* is used (not a specific column) because table PKs differ
// by name (id / player_id / character_name / code) and this must work for all
// of them without per-table special-casing. READ ONLY.
async function countRows(table, filter = '') {
  const qs = filter ? `?${filter}&select=*&limit=1` : '?select=*&limit=1';
  const res = await fetch(`${REST}/${table}${qs}`, {
    method: 'GET',
    headers: { ...AUTH, Prefer: 'count=exact' },
  });
  if (res.status === 404) return { exists: false, count: null };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (/does not exist|PGRST205|schema cache|relation .* does not exist/i.test(body)) {
      return { exists: false, count: null };
    }
    throw new Error(`count ${table} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const cr = res.headers.get('content-range'); // e.g. "0-0/123" or "*/0"
  const total = cr ? Number(cr.split('/').pop()) : null;
  return { exists: true, count: Number.isFinite(total) ? total : 0 };
}

// DELETE all rows in a table. pkColumn must be NOT NULL (true of every PK
// below), so `pk=not.is.null` is a universal "match every row" filter without
// needing a real predicate. Only ever called from an --execute branch.
async function deleteAllRows(table, pkColumn) {
  const res = await fetch(`${REST}/${table}?${pkColumn}=not.is.null`, {
    method: 'DELETE',
    headers: { ...AUTH, Prefer: 'return=minimal' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`delete ${table} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

// PATCH rows matching `filter` with `patch`. Only ever called from an
// --execute branch.
async function patchRows(table, filter, patch) {
  const res = await fetch(`${REST}/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`update ${table} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

// ── Storage helpers (plain REST — same reasoning as scripts/map-snapshot.mjs) ──
async function listBuckets() {
  const res = await fetch(`${STORAGE}/bucket`, { headers: AUTH });
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function listObjectsRecursive(bucket, prefix = '') {
  const out = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const res = await fetch(`${STORAGE}/object/list/${bucket}`, {
      method: 'POST', // Supabase Storage's list endpoint is POST but is a pure read (no mutation).
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (res.status === 404 || res.status === 400) return { exists: false, objects: [] };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`list ${bucket}/${prefix} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const entries = await res.json();
    if (!Array.isArray(entries) || entries.length === 0) break;
    for (const entry of entries) {
      const fullPath = prefix + entry.name;
      if (entry.id === null) {
        // A "folder" pseudo-entry — recurse into it.
        const sub = await listObjectsRecursive(bucket, `${fullPath}/`);
        out.push(...sub.objects);
      } else {
        out.push({ path: fullPath, size: entry.metadata?.size ?? null });
      }
    }
    if (entries.length < limit) break;
    offset += limit;
  }
  return { exists: true, objects: out };
}

// Only ever called from an --execute branch.
async function deleteObjects(bucket, paths) {
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const res = await fetch(`${STORAGE}/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: chunk }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`delete objects in ${bucket} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

// ── systemd pre-flight ───────────────────────────────────────────────────────
// HARD = --execute is refused while any of these is active, because each one
// actively re-creates something the wipe just cleared.
const HARD_GATE_UNITS = [
  // Rewrites services/discord-bot/state.json (announcedBosses) within 60 s of the
  // wipe deleting it -> launch night's first boss kill is silently swallowed.
  'eilif-discord-bot',
  // Re-upserts player_stats from local .fch profiles every ~15 min. Retired
  // 2026-08-23; gate kept deliberately (see the header comment).
  'eilif-stats-parser',
];
const SOFT_GATE_UNITS = ['eilif-log-poller', 'eilif-map-snapshot']; // should be stopped / world already switched

function serviceStatus(unit) {
  try {
    return execSync(`systemctl is-active ${unit}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    // `systemctl is-active` exits non-zero for inactive/failed/unknown, but
    // still prints the status word to stdout.
    return (e.stdout ? e.stdout.toString().trim() : '') || 'unknown';
  }
}

// The local rehearsal's own announcer. Matched the way scripts/smoke/run.mjs
// matches it: pgrep by script path, then narrowed to the processes whose OWN
// environment names THIS database. A dry-run bot on another stack is somebody
// else's rehearsal in progress, and killing or gating on it because it shares a
// filename is the same mistake as `pkill -f "node src/index.js"` against the
// bot and the poller.
function dryRunBotsOnThisDatabase() {
  let pids = [];
  try {
    pids = execSync('pgrep -f "scripts/stress/bot[-]dryrun.mjs" || true', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return pids.filter((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`SUPABASE_URL=${SUPABASE_URL}`);
    } catch {
      return false;
    }
  });
}

function preflightServices() {
  banner('Pre-flight: service liveness');
  if (TARGET_IS_LOCAL) {
    // These three units write to PRODUCTION Supabase, so nothing they do can
    // undo a wipe of the loopback stack: report them, gate on none of them.
    // The producer that CAN undo this wipe is the local rehearsal's own
    // announcer (scripts/stress/bot-dryrun.mjs), which is gated below.
    for (const u of [...HARD_GATE_UNITS, ...SOFT_GATE_UNITS]) {
      console.log(`  ${u.padEnd(24)} ${serviceStatus(u)}   (writes to prod — not a gate for a loopback target)`);
    }
    const bots = dryRunBotsOnThisDatabase();
    console.log(
      `  ${'stress bot-dryrun'.padEnd(24)} ${bots.length ? `running (pid ${bots.join(', ')})` : 'none on this database'}   (the local rehearsal's own announcer)`,
    );
    // A running announcer is a WRITER, which is the whole reason the production
    // branch below hard-gates on eilif-discord-bot. On a loopback target it is
    // the same hazard in miniature: it re-creates the state files it owns and
    // announces off a half-wiped database, so anything that verifies the wipe
    // straight afterwards is racing it. Same terms, then -- gated below, not
    // warned about.
    return { hardActive: [], softActive: [], localBots: bots };
  }
  const hardStatuses = HARD_GATE_UNITS.map((u) => [u, serviceStatus(u)]);
  for (const [u, st] of hardStatuses) console.log(`  ${u.padEnd(24)} ${st}   (hard gate)`);
  const softStatuses = SOFT_GATE_UNITS.map((u) => [u, serviceStatus(u)]);
  for (const [u, st] of softStatuses) console.log(`  ${u.padEnd(24)} ${st}`);

  const hardActive = hardStatuses.filter(([, st]) => st === 'active').map(([u]) => u);
  const softActive = softStatuses.filter(([, st]) => st === 'active').map(([u]) => u);

  for (const unit of hardActive) {
    console.log(`\n  ⛔ ${unit} is ACTIVE.`);
    if (unit === 'eilif-discord-bot') {
      console.log('     Its voice tick calls saveState() unconditionally every 60 s, so it will');
      console.log('     re-create services/discord-bot/state.json with the SAME announcedBosses ids');
      console.log('     this wipe is trying to clear. Result: launch night\u2019s first boss kill posts');
      console.log('     nothing to Discord and the skald never retells it.');
    } else {
      console.log('     It re-upserts player_stats from the local .fch profiles on its own cadence');
      console.log('     (services/stats-parser) — wiping now just gets repopulated with the same');
      console.log('     test-world junk within ~15 minutes.');
    }
    console.log(`     Stop it first: sudo systemctl stop ${unit}`);
  }
  if (softActive.length) {
    console.log(`\n  ⚠️  still running: ${softActive.join(', ')}.`);
    console.log('     These should be stopped (or the world already switched over) before wiping —');
    console.log('     otherwise they keep writing chat/position/map data against the OLD world.');
  }
  if (!hardActive.length && !softActive.length) {
    console.log('\n  ✓ every producer service is stopped (bot, stats-parser, poller, map-snapshot).');
  }
  return { hardActive, softActive };
}

// ── target definitions ──────────────────────────────────────────────────────
// Plain delete-all-rows tables. pk must be a NOT NULL primary key column.
const DELETE_TABLES = [
  // title_history BEFORE players on purpose. Its player_id FK is `on delete
  // cascade`, so deleting players would take these rows with it — but only
  // silently, and only if the FK is still in place. Deleting it explicitly and
  // first makes the "deleted N row(s)" line below honest and the Crowning Log's
  // reset independent of the FK (audit launch-8: 10 pilot rows were still live
  // in prod on 2026-09-03 while players.current_title was gone).
  { table: 'title_history', pk: 'id' },
  { table: 'players', pk: 'id' },
  { table: 'sessions', pk: 'id' },
  { table: 'events', pk: 'id' },
  { table: 'chat_lines', pk: 'id' },
  { table: 'oaths', pk: 'id' },
  { table: 'pins', pk: 'id' },
  { table: 'gallery_photos', pk: 'id' },
  { table: 'player_stats', pk: 'player_id' },
  { table: 'voice_lines', pk: 'id' },
  { table: 'poty_history', pk: 'id' },
  { table: 'identity_claims', pk: 'code' },
  { table: 'player_positions', pk: 'character_name' },
  { table: 'map_markers', pk: 'id' }, // not confirmed to exist in this project — handled gracefully
  // ORPHANED TABLE (audit site-16): nothing reads `roadmap` any more — its
  // getRoadmap()/RoadmapItem code was deleted on 2026-09-04 — but the pilot's
  // seed rows are still in the database claiming The Elder is completed and
  // Bonemass is in progress with a June target date. Wiped here so a future
  // page (or a curious SQL editor) can never resurrect that false progress.
  { table: 'roadmap', pk: 'id' },
];

// State-only resets: definitions/rows stay, only the "has this happened" state
// is zeroed. Schema verified against db/2026-07-05_milestones.sql,
// db/2026-07-06_milestones_rebalance.sql, db/2026-07-04_boss_kills_and_distance.sql,
// db/2026-07-05_boss_retelling.sql and lib/types.ts.
const UPDATE_TARGETS = [
  {
    table: 'milestones',
    // Count/target: rows currently marked achieved (the pilot's Great Deeds).
    filter: 'achieved_at=not.is.null',
    // NOTE: milestones.meta is `jsonb NOT NULL DEFAULT '{}'::jsonb` (see
    // db/2026-07-05_milestones.sql) — NULLing it would violate the NOT NULL
    // constraint and fail the PATCH. The migration's own documented reset
    // uses meta = '{}'::jsonb, which this follows.
    patch: { achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    label: 'achieved milestones (Great Deeds) to reset',
  },
  {
    table: 'bosses',
    // EVERY boss row, not just the killed ones (`is_killed=eq.true`, which this
    // was until the 2026-09-06 rehearsal). A boss that the pilot world FOUGHT
    // and never killed still carries `players_present` and `fight_stats` from
    // that fight: app/api/gs-ingest/route.ts folds client damage into both on
    // every snapshot, with no kill required. The old filter skipped those rows
    // entirely, and both folds are grow-only unions ("union — grow only, never
    // shrink" in that file), so launch night's first kill of that boss INHERITS
    // the pilot's war party and damage numbers. Reproduced on the rehearsal
    // stack: Bonemass left at is_killed=false with two pilot names survived the
    // wipe untouched, and in the full run Eikthyr's war party came out as 16
    // vikings — the eight who actually swung plus eight from the wiped world,
    // with a pilot name topping the damage board. Resetting all eight rows is
    // idempotent and costs one PATCH.
    filter: 'id=not.is.null',
    // NOTE: players_present is read as `boss.players_present.length` with no
    // null-guard in app/boss/[slug]/page.tsx — it must reset to [] (empty
    // array), never null, or that page throws.
    // NOTE: players_present is a `text[]` column, but the PATCH body below
    // sends it as a JSON array ([]), not a SQL array literal. That is
    // correct and must stay that way — PostgREST (via json_to_recordset)
    // converts a JSON array body value into a text[] column fine (verified
    // against PostgREST 14.5 / PostgreSQL 17). Do NOT change this to a
    // string like '{}' or a SQL literal like '{}'::text[] — those are SQL
    // syntax and are wrong here; PostgREST expects JSON in the body.
    patch: {
      is_killed: false,
      killed_at: null,
      players_present: [],
      fight_stats: null,
      retelling: null,
      retelling_generated_at: null,
    },
    label: 'boss rows to clear (kill flag, war party, fight stats, retelling)',
  },
  {
    table: 'server_status',
    // Singleton row (id = 1). Not `not.is.null` like the others — this is the
    // one table where the row itself must survive.
    filter: 'id=eq.1',
    // Why this is no longer "refreshes itself" (audit launch-8, proven on prod):
    // scripts/map-snapshot.mjs reads the in-game day from /api/status, i.e. from
    // this row. After the 2026-08-23 rehearsal wipe the row still held the OLD
    // world's day 64, so the snapshotter framed `frames-by-day/day-0064.webp`
    // four minutes after the wipe and the public timelapse manifest ends on a
    // pre-wipe frame to this day. Zeroing it makes currentWorldDay() return null
    // (map-snapshot.mjs guards on `worldDay > 0`), so no frame can be written
    // until the Emitter reports the NEW world's day.
    // world_day is 0 rather than null deliberately: 0 is valid for the column
    // either way, every reader is `?? 0`, and the > 0 guard treats it as "no day
    // yet". current_players must be [] (JSON array in the body — PostgREST
    // converts it to text[]), never null.
    patch: { world_day: 0, player_count: 0, current_players: [], is_online: false },
    label: 'server_status singleton to zero (world_day/player_count/current_players/is_online)',
  },
];

// Buckets: 'gallery' is confirmed (db/2026-06-25_gallery_photos.sql). The map
// snapshotter uses a bucket literally named 'map' (scripts/map-snapshot.mjs,
// NOT "map-frames") — discovered dynamically below along with anything else
// map-ish, so a renamed/second bucket is still caught.
async function discoverTargetBuckets() {
  const all = await listBuckets();
  const ids = new Set(['gallery']);
  for (const b of all) {
    if (b?.id && /map/i.test(b.id)) ids.add(b.id);
  }
  return [...ids];
}

// ── local state files (checklist in dry-run, deleted on --execute) ─────────
function localStateFiles() {
  return [
    {
      label: 'log-poller cursor/dedupe state (offset, online roster, connection dedupe)',
      file: path.join(STATE_ROOT, 'services/log-poller/state.json'),
    },
    {
      label: 'discord-bot state (announcedBosses, voice ambient/discovery dedupe, POTY recap streaks)',
      file: path.join(STATE_ROOT, 'services/discord-bot/state.json'),
    },
    {
      label: 'map-snapshot day-frame manifest cursor',
      file: path.join(STATE_ROOT, 'scripts/.map-snapshot-state.json'),
    },
    {
      // Confirmed by reading services/stats-parser/src — it re-reads *.fch
      // profiles from CHARACTERS_PATH every sweep and keeps no local state
      // file of its own, so there is nothing to delete here.
      label: 'stats-parser local state — NONE (stateless: re-reads *.fch from CHARACTERS_PATH every sweep)',
      file: null,
    },
  ];
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('====================================================================');
  console.log(` Eilif launch-wipe — ${EXECUTE ? 'EXECUTE (live wipe)' : 'DRY RUN (read-only)'}`);
  console.log('====================================================================');
  // Which stack, said out loud, before a single row is counted. A wipe whose
  // target the operator has not read is the accident this whole script exists
  // to prevent.
  console.log(`  target      ${SUPABASE_URL}`);
  console.log(`              ${TARGET_IS_LOCAL ? 'LOOPBACK — rehearsal stack' : 'REMOTE — treated as PRODUCTION'} (url from ${URL_SOURCE}, key from ${KEY_SOURCE})`);
  console.log(`  state files ${STATE_ROOT}${STATE_DIR_OVERRIDE ? '   (--state-dir)' : '   (repo root — the LIVE services\u2019 own files)'}`);

  const { hardActive, localBots } = preflightServices();

  banner('Row counts — target tables (BEFORE)');
  const deleteCounts = [];
  for (const { table } of DELETE_TABLES) {
    const { exists, count } = await countRows(table);
    deleteCounts.push({ table, exists, count });
    console.log(`  ${table.padEnd(20)} ${exists ? `${count} row(s)` : '(table not found — skipping)'}`);
  }

  banner('State to reset — milestones / bosses / server_status (BEFORE)');
  const updateCounts = [];
  for (const t of UPDATE_TARGETS) {
    const { exists, count } = await countRows(t.table, t.filter);
    updateCounts.push({ ...t, exists, count });
    console.log(`  ${t.table.padEnd(20)} ${exists ? `${count} ${t.label}` : '(table not found — skipping)'}`);
  }

  banner('Storage buckets (BEFORE)');
  const buckets = await discoverTargetBuckets();
  const bucketObjects = [];
  for (const bucket of buckets) {
    const { exists, objects } = await listObjectsRecursive(bucket);
    bucketObjects.push({ bucket, exists, objects });
    console.log(`  ${bucket.padEnd(20)} ${exists ? `${objects.length} object(s)` : '(bucket not found — skipping)'}`);
  }

  banner('Local state files');
  const stateFiles = localStateFiles();
  for (const s of stateFiles) {
    if (!s.file) {
      console.log(`  ${s.label}`);
      continue;
    }
    const exists = fs.existsSync(s.file);
    console.log(`  ${exists ? '[present]' : '[absent] '} ${s.file}`);
    console.log(`             ${s.label}`);
  }

  // Hard refusal — only blocks an actual --execute run.
  if (EXECUTE && hardActive.length) {
    console.error(`\nRefusing --execute: ${hardActive.join(', ')} active. Stop and re-run:`);
    console.error(`  sudo systemctl stop ${hardActive.join(' ')}`);
    process.exit(1);
  }
  // The loopback equivalent, on the same terms. The dry-run bot is the local
  // stack's announcer: it writes titles, saga rows and its own state file, so a
  // wipe underneath it leaves the announcedBosses/title state disagreeing with
  // the database, and anything verifying the wipe right afterwards is racing a
  // writer. Same order as launch day, then: stop the announcer FIRST, wipe,
  // start it again. Killed by pid, never by pattern.
  if (EXECUTE && localBots?.length) {
    console.error(`\nRefusing --execute: ${localBots.length} dry-run bot(s) are writing to ${SUPABASE_URL}.`);
    console.error('  This is the loopback version of the eilif-discord-bot gate: it re-creates');
    console.error('  the state files it owns and announces off a half-wiped database.');
    console.error(`  Stop them by pid (a pkill pattern would match other stacks' bots too):`);
    console.error(`    kill ${localBots.join(' ')}`);
    console.error('  then re-run the wipe, and start the announcer again afterwards.');
    process.exit(1);
  }

  if (DRY_RUN) {
    banner('DRY RUN — nothing was written');
    console.log('  No DELETE, PATCH, storage-delete, or file-delete calls were made above.');
    console.log('  Re-run with --execute (and type WIPE when prompted) to actually wipe.');
    printPostWipeChecklist();
    return;
  }

  // --execute past this point.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const totalRows = deleteCounts.filter((d) => d.exists).reduce((a, d) => a + d.count, 0);
  const totalObjects = bucketObjects.filter((b) => b.exists).reduce((a, b) => a + b.objects.length, 0);
  console.log(`\nThis will permanently delete ${totalRows} row(s) across ${deleteCounts.filter((d) => d.exists).length} table(s),`);
  console.log(`reset ${updateCounts.reduce((a, u) => a + (u.exists ? u.count : 0), 0)} milestone/boss/status row(s), delete ${totalObjects}`);
  console.log('storage object(s), and remove local service state files.');
  const answer = await rl.question('\nType WIPE to confirm (anything else aborts): ');
  rl.close();
  if (answer.trim() !== 'WIPE') {
    console.log('Aborted — confirmation phrase did not match. Nothing was touched.');
    process.exit(1);
  }

  banner('WIPE — deleting rows');
  for (const { table, pk } of DELETE_TABLES) {
    const before = deleteCounts.find((d) => d.table === table);
    if (!before?.exists) {
      console.log(`  ${table.padEnd(20)} skipped (table not found)`);
      continue;
    }
    await deleteAllRows(table, pk);
    console.log(`  ${table.padEnd(20)} deleted ${before.count} row(s)`);
  }

  banner('RESET — milestones / bosses / server_status');
  // Iterate updateCounts (not UPDATE_TARGETS) — exists/count only ever get
  // attached to the copies pushed into updateCounts above, never back onto
  // UPDATE_TARGETS itself. Iterating UPDATE_TARGETS here previously left
  // t.exists permanently undefined, so every target printed "skipped (table
  // not found)" and this reset silently never ran.
  for (const t of updateCounts) {
    if (!t.exists) {
      console.log(`  ${t.table.padEnd(20)} skipped (table not found)`);
      continue;
    }
    await patchRows(t.table, t.filter, t.patch);
    console.log(`  ${t.table.padEnd(20)} reset ${t.count} row(s)`);
  }

  banner('STORAGE — deleting objects');
  for (const { bucket, exists, objects } of bucketObjects) {
    if (!exists) {
      console.log(`  ${bucket.padEnd(20)} skipped (bucket not found)`);
      continue;
    }
    if (objects.length === 0) {
      console.log(`  ${bucket.padEnd(20)} already empty`);
      continue;
    }
    await deleteObjects(bucket, objects.map((o) => o.path));
    console.log(`  ${bucket.padEnd(20)} deleted ${objects.length} object(s)`);
  }

  banner('LOCAL STATE — deleting files');
  for (const s of stateFiles) {
    if (!s.file) {
      console.log(`  (skip) ${s.label}`);
      continue;
    }
    if (fs.existsSync(s.file)) {
      fs.unlinkSync(s.file);
      console.log(`  deleted ${s.file}`);
    } else {
      console.log(`  already absent ${s.file}`);
    }
  }

  banner('DONE');
  console.log('  Wipe complete. Restart the services once the post-wipe checklist below is done.');
  printPostWipeChecklist();
}

function printPostWipeChecklist() {
  banner('POST-WIPE CHECKLIST (manual — not automated by this script)');
  console.log(`
  Reconciled 2026-09-06 with docs/LAUNCH-DAY.md, which is the SEQUENCE OF RECORD
  for 2026-09-09 and owns the step numbers, the owners, the "if it fails"
  branches and the rollbacks. This block is only the wipe's own neighbours, and
  it is written for an ordinary wipe day. Order matters — every constraint below
  was learned the hard way in the 2026-08-23 rehearsal.

  ON 2026-09-09, READ docs/LAUNCH-DAY.md AND NOT THIS. Launch day front-loads all
  the panel work (steps 12 to 14) so the stopped window is short, so by the time
  this prints — at step 6 as a preview, and again after --execute at step 20a —
  the panel half below has already been done, hours earlier and in a different
  order.

  BEFORE the wipe
  ---------------
  0. Stop eilif-discord-bot FIRST, then the poller and map-snapshot:
       sudo systemctl stop eilif-discord-bot eilif-log-poller eilif-map-snapshot
     The bot is a HARD gate now: while it runs it re-creates its state.json
     (announcedBosses) within 60 s and the first launch-night boss kill would
     post nothing. eilif-stats-parser was retired 2026-08-23 — it should read
     'inactive' or 'unknown' above; if it reads 'active', someone re-enabled it.

  1. Backups, and they are the ONLY copies:
       bash scripts/pull-world.sh              <- NO argument. It defaults to the
                                                  world that is on the box RIGHT
                                                  NOW, which is the one worth
                                                  copying. Naming the world you
                                                  are about to create fetches
                                                  nothing at all.
       + a full Supabase dump (project is on the Free plan — no backups at all)
     There is no undo once rows and storage objects are gone.

  THE PANEL WORK
  (ordinary wipe day: after the wipe. 2026-09-09: steps 12 to 14, BEFORE the
   wipe at step 20, so it is already done by the time you read this.)
  ----------------------------------------------------------------------------
  2. GTX panel, while STOPPED (loaded DLLs are file-locked on Windows):
     - Sweep worlds_local of the old world's leftovers — Dedicated.*, *.old,
       *_backup_auto-* (ALL worlds), map_data/<old world>/,
       vplus-data/<old>_mapSync.dat, and <world>.json. Valheim auto-restores
       from a leftover .old / backup_auto pair and resurrects the old world.
       <world>.json also carries the SEED in plaintext.
     - Upload the launch world's .fwl and .db TOGETHER; set Start.bat World=.
     - Death penalty = Casual (the tier that actually grants deathkeepequip;
       'easy' and 'veryeasy' do not). The live panel tier has read 'casual' since
       2026-09-05, so keep-gear is granted by the game and no longer depends on
       the Companion injecting it after every boot — but the tier is a property
       of the world, so SET IT AGAIN on the new world's Start form.
     - Combat = per the launch decision. Leave the V+ cfg [Chat] section ENABLED:
       it is what carries server-wide /s shouts, and the oath and pin capture
       rides on those. (The Companion 0.3.x hook no longer depends on [Chat]
       itself, but the shouts it reads do.) WebMap always_map=false unless the
       GTX firewall ticket for TCP 3000 has closed — it has not; see item 11.
     - Only now swap any rebuilt plugin DLLs. Then Stop -> Start (never Restart).

  3. Plugin configs on the box (SFTP): the Emitter cfg
     (net.cproudlock.gsvalheimstats.cfg) and media.blockspace.eilif.companion.cfg
     must not still name the old world. Rotate GS_EMITTER_TOKEN and
     VOICE_API_TOKEN to fresh values in the cfgs + Vercel + .voice-token.

  4. Vercel production env — GS_EXPECTED_WORLD = the new world's name (it lives
     in Vercel only, not .env.local). Unset means /api/gs-ingest accepts any
     world. Env edits need a deploy to take effect.

  5. services/log-poller/.env — MAP_REMOTE_DIR -> .../WebMap/map_data/<World>.
     (This is where map-snapshot sources it from too; there is no separate
     stats-parser env any more — that service was retired 2026-08-23.)

  6. services/discord-bot/.env — revert the pilot overrides:
     - RECAPS_START      -> 2026-09-09 (and DELETE the unit file's own
                            RECAPS_START line so .env actually owns it)
     - RECAP_CHANNEL     -> remove the 'server' override (back to 'valheim')
     - MILESTONE_CHANNEL -> remove the 'server' override
     - OATH_CHANNEL / BOSS_CHANNEL / any other *_CHANNEL=server -> remove
     - TITLE_CHANNEL     -> SET it to 'valheim'. Do NOT remove this one.
                            services/discord-bot/src/index.js reads
                            TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server',
                            so an ABSENT TITLE_CHANNEL sends launch night's
                            crownings to #server — the opposite of the intent.
     then 'sudo systemctl daemon-reload'.

     All of the above is exactly what this does, daemon-reload included:
       bash scripts/cutover-env.sh <World>            # dry run, read the diff
       bash scripts/cutover-env.sh <World> --apply
     Run it rather than hand-editing; hand-editing is how TITLE_CHANNEL got
     written down wrong here in the first place.

  7. Re-mint the modpack and verify the round trip before posting the code. The
     pin set is not guessable from here and changes with every plugin rebuild:
     docs/LAUNCH-DAY.md step 16 defines $M and step 18 reuses it on all three of
     its lines. (EilifCompanionClient 0.3.2 is published; 0.3.3 is staged in
     plugins/thunderstore/ and needs uploading before it can be pinned.)

  RESTART ORDER (this is the part that bites)
  -------------------------------------------
  8. eilif-log-poller first — confirm a join line in its journal.
  9. eilif-discord-bot second, and ONLY after:
       - 'select name, is_killed from bosses' is all false, and
       - services/discord-bot/state.json is ABSENT.
     Read its startup log: it must not list any announced boss, and must show the
     new RECAPS_START, no *_CHANNEL=server override left, and titles routed to
     #valheim (not #server). Manual boss marking, if ever
     needed, is:  cd services/discord-bot && node scripts/mark-boss.js "<Boss>"
     (that file lives under services/discord-bot/scripts/, NOT repo-root scripts/).
  10. eilif-map-snapshot LAST, and only after all three are true:
       - map_data/<World>/ exists on the host (scripts/verify-restart.sh <W> lists it),
       - MAP_REMOTE_DIR points at it,
       - /api/status reports the NEW world's day (this wipe zeroed world_day, and
         map-snapshot skips any day <= 0, so it cannot frame a stale day again).
      Then watch the journal for 'day 1 framed' within 5 minutes and eyeball
      current.webp against a spawn pin for the 10,000 m radius calibration.

  VERIFY
  ------
  11. bash scripts/verify-restart.sh <World> — Valheim version unchanged, the
      plugin count you WROTE DOWN before the restart (8 through the rehearsal;
      fewer on 2026-09-09 if ValheimPlus or a third-party mod comes off), panel
      tier Casual, Emitter ingest 200, Boards scan, [EILIF_KEY].
      Port 3000 will read OPEN. The GTX firewall ticket was skipped by decision:
      it is a known exposure (WebMap serves the un-fogged map, /config and live
      player positions to anyone), NOT a hold.
  12. /admin/ops cockpit shows fresh heartbeats; milestones unachieved; bosses
      not killed; the Crowning Log (title_history) is empty; players list starts
      empty and repopulates from real joins.

  Adjacent tables intentionally NOT touched by this script: discord_events,
  ops_heartbeats, ops_alerts (the watchdog's dedupe memory -- it keeps its
  alerting state and its 'since' across the wipe, and the GitHub pinger keeps
  running through the stopped-service window; see docs/LAUNCH-WIPE.md). (server_status IS reset now — see the note on that target
  above for why "it refreshes itself" was wrong. The roadmap table IS cleared now
  too — it is orphaned code-side, but its stale pilot rows contradicted the
  bosses table, so the wipe empties it.)
`);
}

main().catch((e) => {
  console.error('\nlaunch-wipe failed:', e.message);
  process.exit(1);
});
