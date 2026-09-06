// A tripwire for the one class of bug TypeScript cannot see: a PostgREST select
// string that stops asking for a column the code still reads.
//
// WHY THIS FILE EXISTS. `.select('a, b, c')` is a STRING. The rows come back
// typed as the full row regardless, so dropping a column from that string is
// invisible to `tsc`, invisible to `next build`, and invisible at runtime: the
// field is simply `undefined`, and the page renders a blank, a 0, an "unknown"
// or a NaN. The 2026-09-06 perf pass narrowed several of these on purpose (see
// lib/milestones AGGREGATE_STAT_COLUMNS and the comments in lib/data), which is
// exactly when that hazard stops being theoretical.
//
// The rule each check follows: derive the REQUIRED columns from the consuming
// code (or from the interface the rows are cast to), never from a hand-copied
// list — a hand-copied list only asserts that somebody typed the same thing
// twice. If a check below cannot find what it is looking for it FAILS rather
// than passing vacuously, so a refactor that moves the code cannot silently
// disarm the tripwire.
//
//   npx tsx scripts/narrow-selects.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let checks = 0;
function ok(cond, msg) {
  checks++;
  assert.ok(cond, msg);
  console.log(`  ok   ${msg}`);
}

/** The column list of a `.select('…')` literal, as a Set of bare column names. */
function selectColumns(literal) {
  return new Set(
    literal
      .split(',')
      .map((c) => c.trim())
      // strip a PostgREST alias (`alias:col`) and an embed (`pin:pins(...)`)
      .map((c) => (c.includes(':') ? c.slice(c.indexOf(':') + 1) : c))
      .map((c) => c.replace(/\(.*$/, '').trim())
      .filter(Boolean),
  );
}

/** Pull the first `.select('…')` string literal that follows `anchor`. */
function selectAfter(text, anchor, label) {
  const at = text.indexOf(anchor);
  assert.notStrictEqual(at, -1, `${label}: could not find the anchor ${JSON.stringify(anchor)} — this check is disarmed, fix it`);
  const m = /\.select\(\s*'([^']*)'/.exec(text.slice(at));
  assert.ok(m, `${label}: no .select('…') literal after ${JSON.stringify(anchor)} — this check is disarmed, fix it`);
  return { columns: selectColumns(m[1]), literal: m[1] };
}

/** The body of a named function/const, from its declaration to the next top-level `}`. */
function block(text, start, end, label) {
  const a = text.indexOf(start);
  assert.notStrictEqual(a, -1, `${label}: could not find ${JSON.stringify(start)} — this check is disarmed, fix it`);
  const b = text.indexOf(end, a + start.length);
  assert.notStrictEqual(b, -1, `${label}: could not find ${JSON.stringify(end)} after it — this check is disarmed, fix it`);
  return text.slice(a, b);
}

// ── 1. lib/milestones evaluateAndRecord: the `sessions` select ───────────────
//
// Narrowed from `select('*')` to three columns on 2026-09-06. The only consumer
// of those rows is playtimeMinutes(), so the fields it reads off a session are
// the required list. Drop one and playtime_total_hours quietly aggregates a
// wrong number — the Great Deed bar moves, so nothing looks broken.
console.log('\nnarrow-selects — lib/milestones sessions');
{
  const text = src('lib/milestones.ts');
  const { columns, literal } = selectAfter(text, "client.from('sessions')", 'milestones sessions');
  const fn = block(text, 'function playtimeMinutes(', '\n}\n', 'playtimeMinutes');
  const read = new Set([...fn.matchAll(/\bs\.([a-z_]+)/g)].map((m) => m[1]));
  ok(read.size >= 3, `playtimeMinutes reads ${read.size} session fields (${[...read].sort().join(', ')})`);
  for (const col of read) {
    ok(columns.has(col), `sessions select carries "${col}" (list: ${literal})`);
  }
}

// ── 2. lib/milestones evaluateAndRecord: the `players` select ────────────────
//
// Narrowed the same day. Its rows feed the onlineNames Set, and that set decides
// which OPEN session counts live time — so a missing column here makes every
// currently-playing viking's evening vanish from playtime_total_hours.
console.log('\nnarrow-selects — lib/milestones players');
{
  const text = src('lib/milestones.ts');
  const { columns, literal } = selectAfter(text, "client.from('players')", 'milestones players');
  const scope = block(text, 'const onlineNames = new Set(', 'const bossesKilled', 'onlineNames derivation');
  const read = new Set([...scope.matchAll(/\bp\.([a-z_]+)/g)].map((m) => m[1]));
  ok(read.size >= 2, `the onlineNames derivation reads ${read.size} player fields (${[...read].sort().join(', ')})`);
  for (const col of read) {
    ok(columns.has(col), `players select carries "${col}" (list: ${literal})`);
  }
}

// ── 3. lib/fight-stats-cas: the boss read behind every compare-and-swap ──────
//
// Four writers fold onto this row. A column missing from the select does not
// error — `raw.is_killed` reads undefined (so the kill flip thinks the beast is
// standing), `raw.fight_stats` reads undefined (so every fold starts from an
// empty blob and the accrued damage map is overwritten with a fresh one).
console.log('\nnarrow-selects — lib/fight-stats-cas bosses');
{
  const text = src('lib/fight-stats-cas.ts');
  const { columns, literal } = selectAfter(text, "for (let attempt =", 'fight-stats-cas bosses');
  const scope = block(text, 'const row: FightStatsRow = {', 'const existing = row.fight_stats', 'FightStatsRow build');
  const read = new Set([...scope.matchAll(/\braw\.([a-z_]+)/g)].map((m) => m[1]));
  ok(read.size >= 4, `the row builder reads ${read.size} boss columns (${[...read].sort().join(', ')})`);
  for (const col of read) {
    ok(columns.has(col), `the CAS read carries "${col}" (list: ${literal})`);
  }
}

// ── 4. lib/data getPins: the select vs the LivePin shape it casts to ─────────
//
// The rows are cast `as LivePin[]`, which is an assertion, not a check: a column
// left out of the select is `undefined` on a field typed `number`. x/y are the
// marker coordinates, so losing one silently stacks every pin at the origin.
console.log('\nnarrow-selects — lib/data getPins');
{
  const text = src('lib/data.ts');
  const { columns, literal } = selectAfter(text, "export const getPins = cache(", 'getPins');
  const iface = block(text, 'export interface LivePin {', '\n}', 'LivePin');
  const fields = new Set([...iface.matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1]));
  ok(fields.size >= 6, `LivePin declares ${fields.size} fields (${[...fields].sort().join(', ')})`);
  for (const f of fields) {
    ok(columns.has(f), `getPins select carries "${f}" (list: ${literal})`);
  }
}

// ── 5. lib/data getPhotosByPin: the select vs PinPhoto, plus the grouping key ─
console.log('\nnarrow-selects — lib/data getPhotosByPin');
{
  const text = src('lib/data.ts');
  const { columns, literal } = selectAfter(text, "export const getPhotosByPin = cache(", 'getPhotosByPin');
  const iface = block(text, 'export interface PinPhoto {', '\n}', 'PinPhoto');
  const fields = new Set([...iface.matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1]));
  ok(fields.size >= 4, `PinPhoto declares ${fields.size} fields (${[...fields].sort().join(', ')})`);
  for (const f of fields) {
    ok(columns.has(f), `getPhotosByPin select carries "${f}" (list: ${literal})`);
  }
  ok(columns.has('pin_id'), 'and pin_id, the key it groups by (absent = every photo grouped under "undefined")');
}

// ── 6. lib/data PLAYERS_PUBLIC_COLS vs what /api/titles now derives from it ──
//
// /api/titles stopped issuing its own `is_online = true` read on 2026-09-06 and
// filters the roster instead. That only works while the roster select carries
// is_online — and PLAYERS_PUBLIC_COLS is also what getOnlinePlayers() filters,
// so losing it takes "who is sailing" off the Hall, the Vikings page and the
// titles engine at once, all showing an empty hall rather than an error.
console.log('\nnarrow-selects — PLAYERS_PUBLIC_COLS');
{
  const text = src('lib/data.ts');
  const m = /const PLAYERS_PUBLIC_COLS\s*=\s*\n?\s*'([^']*)'/.exec(text);
  assert.ok(m, 'could not find PLAYERS_PUBLIC_COLS — this check is disarmed, fix it');
  const columns = selectColumns(m[1]);
  for (const col of ['is_online', 'character_name', 'id']) {
    ok(columns.has(col), `PLAYERS_PUBLIC_COLS carries "${col}"`);
  }
  const titles = src('app/api/titles/route.ts');
  ok(
    /withStats\.filter\(\(p\) => p\.is_online\)/.test(titles),
    '/api/titles still derives its online set from the roster (if this moved, re-point the check above)',
  );
  const data = src('lib/data.ts');
  ok(
    /getOnlinePlayers = cache\([\s\S]{0,600}?\.filter\(\(p\) => p\.is_online\)/.test(data),
    'getOnlinePlayers still derives from getAllPlayers()',
  );
}

console.log(`\nnarrow-selects: ${checks} assertions passed`);
