#!/usr/bin/env node
// scripts/db-snapshot.mjs — nightly logical snapshot of the Supabase project.
//
// WHY (audit backend-2, 2026-09-04): the project is on the Supabase FREE plan, which
// has no automated daily backups and no PITR. Until 2026-09-04 the only copies of the
// community record (oaths, pins, saga events, titles, POTY, gallery rows) were the live
// rows themselves, and the base schema existed only inside the database. `db/*.sql`
// now carries the schema; this script carries the DATA.
//
// What it does, with nothing but `fetch` (no new dependencies, no pg_dump — the box has
// no PG 17 client and the DB password is not available here):
//   1. asks PostgREST for the table list + primary keys  (GET /rest/v1/, OpenAPI)
//   2. pages every table with Range headers (1000 rows/page, ordered by PK)
//   3. writes ~/valheim-db-backups/<YYYYmmdd-HHMM>/<table>.json
//   4. lists (does NOT download) the `gallery` and `map` storage buckets
//   5. writes manifest.json with row counts + byte sizes
//   6. prunes to the newest KEEP (default 30) snapshot dirs
// Exits non-zero if ANY table fails, so the systemd unit shows `failed` and the ops
// watchdog can see it.
//
// Run:   /opt/eilif/node scripts/db-snapshot.mjs
// Env:   DEST=<dir>  (default ~/valheim-db-backups)   KEEP=<n> (default 30)
//
// The service-role key is read out of .env.local INSIDE this script and is never
// printed, logged, or passed on a command line.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = process.env.DEST || path.join(os.homedir(), 'valheim-db-backups');
const KEEP = Number(process.env.KEEP || 30);
const PAGE = 1000;

// ── env ──────────────────────────────────────────────────────────────────────
// Same loader as scripts/launch-wipe.mjs / backfill-identity.js.
function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[db-snapshot] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(2);
}
const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const AUTH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// Fallback table list + primary keys, used only if the OpenAPI root is not exposed.
// Mirrors scripts/launch-wipe.mjs DELETE_TABLES/UPDATE_TARGETS plus the tables it
// deliberately leaves alone (ops_*, discord_events, server_status, milestones).
const FALLBACK_TABLES = {
  players: 'id',
  sessions: 'id',
  events: 'id',
  chat_lines: 'id',
  oaths: 'id',
  pins: 'id',
  gallery_photos: 'id',
  player_stats: 'player_id',
  voice_lines: 'id',
  poty_history: 'id',
  identity_claims: 'code',
  player_positions: 'character_name',
  title_history: 'id',
  milestones: 'id',
  bosses: 'id',
  roadmap: 'id',
  server_status: 'id',
  discord_events: 'id',
  ops_heartbeats: 'component',
  ops_alerts: 'key',
};

const BUCKETS = ['gallery', 'map'];

// ── helpers ──────────────────────────────────────────────────────────────────
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Never let a thrown fetch error carry credentials: we only ever interpolate
// table/bucket names and the public project URL into messages.
async function req(url, init = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...AUTH, ...(init.headers || {}) } });
      if (res.status >= 500 && i < tries - 1) {
        last = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

// ── 1. table list ────────────────────────────────────────────────────────────
// PostgREST's OpenAPI marks primary keys with "<pk/>" in the column description.
async function discoverTables() {
  try {
    const res = await req(`${REST}/`, { headers: { Accept: 'application/openapi+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const spec = await res.json();
    const defs = spec.definitions || {};
    const tables = {};
    const skipped = [];
    for (const [name, def] of Object.entries(defs)) {
      const pk = Object.entries(def.properties || {})
        .filter(([, p]) => /<pk\/>/.test(p.description || ''))
        .map(([c]) => c)[0];
      if (pk) tables[name] = pk;
      else skipped.push(name); // views / PK-less relations: no stable paging order
    }
    if (!Object.keys(tables).length) throw new Error('OpenAPI returned no keyed tables');
    return { tables, skipped, source: 'openapi' };
  } catch (e) {
    console.warn(`[db-snapshot] OpenAPI table list unavailable (${e.message}); using the built-in list`);
    return { tables: { ...FALLBACK_TABLES }, skipped: [], source: 'fallback' };
  }
}

// ── 2. dump one table ────────────────────────────────────────────────────────
async function dumpTable(table, pk, dir) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${REST}/${encodeURIComponent(table)}?select=*&order=${encodeURIComponent(pk)}.asc`;
    const res = await req(url, {
      headers: { Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`${table}: HTTP ${res.status} ${body}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  // One row per line: readable diffs without the bulk of full pretty-printing.
  const body = rows.length ? `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n';
  const file = path.join(dir, `${table}.json`);
  fs.writeFileSync(file, body);
  return { rows: rows.length, bytes: Buffer.byteLength(body) };
}

// ── 3. storage listing (metadata only — objects are NOT downloaded) ──────────
async function listBucket(bucket) {
  const objects = [];
  async function walk(prefix) {
    for (let offset = 0; ; offset += PAGE) {
      const res = await req(`${STORAGE}/object/list/${encodeURIComponent(bucket)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix,
          limit: PAGE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`bucket ${bucket}: HTTP ${res.status} ${body}`);
      }
      const page = await res.json();
      for (const o of page) {
        const full = prefix ? `${prefix}${o.name}` : o.name;
        if (o.id === null || o.id === undefined) {
          await walk(`${full}/`); // folder placeholder
        } else {
          objects.push({
            name: full,
            id: o.id,
            size: o.metadata?.size ?? null,
            mimetype: o.metadata?.mimetype ?? null,
            created_at: o.created_at ?? null,
            updated_at: o.updated_at ?? null,
          });
        }
      }
      if (page.length < PAGE) break;
    }
  }
  await walk('');
  return objects;
}

// ── 4. retention ─────────────────────────────────────────────────────────────
function prune() {
  const dirs = fs
    .readdirSync(DEST, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{4}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const drop = dirs.slice(0, Math.max(0, dirs.length - KEEP));
  for (const d of drop) fs.rmSync(path.join(DEST, d), { recursive: true, force: true });
  return { kept: dirs.length - drop.length, removed: drop };
}

// ── main ─────────────────────────────────────────────────────────────────────
const started = new Date();
const dir = path.join(DEST, stamp(started));
// 0700: the dumps carry player names, Steam/Discord ids and chat lines.
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(DEST, 0o700);
fs.chmodSync(dir, 0o700);

const { tables, skipped, source } = await discoverTables();
const names = Object.keys(tables).sort();
console.log(`[db-snapshot] ${names.length} table(s) from ${source} -> ${dir}`);

const manifest = {
  taken_at: started.toISOString(),
  supabase_url: SUPABASE_URL, // public project URL; the key is never recorded
  node: process.version,
  table_source: source,
  tables: [],
  skipped_relations: skipped, // views / PK-less relations, not dumped
  storage: [],
  errors: [],
};

let failed = 0;
for (const table of names) {
  const pk = tables[table];
  try {
    const { rows, bytes } = await dumpTable(table, pk, dir);
    manifest.tables.push({ table, pk, rows, bytes, file: `${table}.json` });
    console.log(`  ${table.padEnd(20)} ${String(rows).padStart(7)} rows  ${String(bytes).padStart(9)} B`);
  } catch (e) {
    failed++;
    manifest.errors.push({ table, error: String(e.message || e) });
    console.error(`  ${table.padEnd(20)} FAILED: ${e.message || e}`);
  }
}

// Storage: metadata only. Objects live only in the bucket — see docs/OPS-COCKPIT.md.
const storageOut = {};
for (const bucket of BUCKETS) {
  try {
    const objects = await listBucket(bucket);
    storageOut[bucket] = objects;
    const bytes = objects.reduce((n, o) => n + (o.size || 0), 0);
    manifest.storage.push({ bucket, objects: objects.length, bytes, downloaded: false });
    console.log(`  storage:${bucket.padEnd(12)} ${String(objects.length).padStart(7)} obj   ${String(bytes).padStart(9)} B (listed, not downloaded)`);
  } catch (e) {
    failed++;
    storageOut[bucket] = { error: String(e.message || e) };
    manifest.errors.push({ bucket, error: String(e.message || e) });
    console.error(`  storage:${bucket.padEnd(12)} FAILED: ${e.message || e}`);
  }
}
const storageBody = `${JSON.stringify(storageOut, null, 2)}\n`;
fs.writeFileSync(path.join(dir, 'storage-objects.json'), storageBody);
manifest.storage_objects_bytes = Buffer.byteLength(storageBody);

manifest.total_rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
manifest.total_bytes = manifest.tables.reduce((n, t) => n + t.bytes, 0) + manifest.storage_objects_bytes;
manifest.duration_ms = Date.now() - started.getTime();
manifest.ok = failed === 0;

const { kept, removed } = prune();
manifest.retention = { keep: KEEP, kept, removed };

fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[db-snapshot] ${manifest.tables.length}/${names.length} tables, ${manifest.total_rows} rows, ` +
    `${manifest.total_bytes} B in ${manifest.duration_ms} ms; kept ${kept} snapshot(s)` +
    (removed.length ? `, pruned ${removed.join(', ')}` : '')
);
if (failed) {
  console.error(`[db-snapshot] ${failed} failure(s) — snapshot is INCOMPLETE`);
  process.exit(1);
}
