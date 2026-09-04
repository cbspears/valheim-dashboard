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
//   Wipe:     node scripts/launch-wipe.mjs --execute
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
const EXECUTE = argv.includes('--execute');
const DRY_RUN = !EXECUTE;

// ── env (mirrors scripts/backfill-identity.js / seed-milestones-backfill.mjs) ──
function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const AUTH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

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

function preflightServices() {
  banner('Pre-flight: service liveness');
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
    filter: 'is_killed=eq.true',
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
    label: 'killed bosses to reset',
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
      file: path.join(ROOT, 'services/log-poller/state.json'),
    },
    {
      label: 'discord-bot state (announcedBosses, voice ambient/discovery dedupe, POTY recap streaks)',
      file: path.join(ROOT, 'services/discord-bot/state.json'),
    },
    {
      label: 'map-snapshot day-frame manifest cursor',
      file: path.join(ROOT, 'scripts/.map-snapshot-state.json'),
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

  const { hardActive } = preflightServices();

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
  Rewritten 2026-09-04 from the T-6 launch audit. Full cutover sequence with
  owners: docs/LAUNCH-WIPE.md. Order matters — every constraint below was
  learned the hard way in the 2026-08-23 rehearsal.

  BEFORE the wipe
  ---------------
  0. Stop eilif-discord-bot FIRST, then the poller and map-snapshot:
       sudo systemctl stop eilif-discord-bot eilif-log-poller eilif-map-snapshot
     The bot is a HARD gate now: while it runs it re-creates its state.json
     (announcedBosses) within 60 s and the first launch-night boss kill would
     post nothing. eilif-stats-parser was retired 2026-08-23 — it should read
     'inactive' or 'unknown' above; if it reads 'active', someone re-enabled it.

  1. Backups, and they are the ONLY copies:
       bash scripts/pull-world.sh <World>     (off-box world pair, keeps 14)
       + a full Supabase dump (project is on the Free plan — no backups at all)
     There is no undo once rows and storage objects are gone.

  AFTER the wipe, before any service is restarted
  ----------------------------------------------
  2. GTX panel, while STOPPED (loaded DLLs are file-locked on Windows):
     - Sweep worlds_local of the old world's leftovers — Dedicated.*, *.old,
       *_backup_auto-* (ALL worlds), map_data/<old world>/,
       vplus-data/<old>_mapSync.dat, and <world>.json. Valheim auto-restores
       from a leftover .old / backup_auto pair and resurrects the old world.
       <world>.json also carries the SEED in plaintext.
     - Upload the launch world's .fwl and .db TOGETHER; set Start.bat World=.
     - Death penalty = Casual (the tier that actually grants deathkeepequip —
       'easy'/'veryeasy' do not; today only the Companion plugin injects it).
     - Combat = per the launch decision. V+ cfg [Chat] enabled=false (its NRE
       is what kills the [EILIF_CHAT] hook). WebMap always_map=false unless the
       GTX firewall ticket for TCP 3000 has closed.
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
     - TITLE_CHANNEL / any other *_CHANNEL=server line -> remove
     then 'sudo systemctl daemon-reload'.

  7. Re-mint the modpack (World=<W>, Companion Client 0.3.0 if it shipped) and
     verify the round trip before posting the code.

  RESTART ORDER (this is the part that bites)
  -------------------------------------------
  8. eilif-log-poller first — confirm a join line in its journal.
  9. eilif-discord-bot second, and ONLY after:
       - 'select name, is_killed from bosses' is all false, and
       - services/discord-bot/state.json is ABSENT.
     Read its startup log: it must not list any announced boss and must show the
     new RECAPS_START with no channel overrides. Manual boss marking, if ever
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
  11. bash scripts/verify-restart.sh <World> — Valheim version unchanged, all 8
      plugins loaded, panel tier Casual, Emitter ingest 200, Boards scan,
      [EILIF_KEY], port 3000 closed.
  12. /admin/ops cockpit shows fresh heartbeats; milestones unachieved; bosses
      not killed; the Crowning Log (title_history) is empty; players list starts
      empty and repopulates from real joins.

  Adjacent tables intentionally NOT touched by this script: discord_events,
  roadmap, ops_heartbeats. (server_status IS reset now — see the note on that
  target above for why "it refreshes itself" was wrong.)
`);
}

main().catch((e) => {
  console.error('\nlaunch-wipe failed:', e.message);
  process.exit(1);
});
