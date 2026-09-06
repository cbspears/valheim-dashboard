// A tripwire for the failure that actually happened on 2026-09-06: four tables
// (boss_tellings, tales, office_nudges, offices) shipped to production in the
// morning and scripts/launch-wipe.mjs, written weeks earlier, had never heard of
// them. The wipe would have run clean, printed a happy row count, and carried
// the pilot world's chosen Eikthyr telling onto launch night.
//
// WHY A TEST AND NOT A CAREFUL REVIEW. The wipe list is a hand-maintained array
// in one file and the schema is thirty-odd files in another directory. Nothing
// connected them, so "did anyone add the new table to the wipe?" was a question
// only a human could ask, and only if they thought to. This asserts the join:
// EVERY table any db/*.sql creates must be named in exactly one of three places
// in scripts/launch-wipe.mjs -- DELETE_TABLES, UPDATE_TARGETS, or the keep-list
// this file carries with its reason. A new table with no decision fails here.
//
// The keep-list lives in this file rather than the script because it is an
// assertion about intent, not behaviour: the script cannot "keep" a table it
// never mentions, so there is nothing for it to hold.
//
//   npx tsx scripts/launch-wipe-tables.test.mjs

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wipeSrc = readFileSync(path.join(ROOT, 'scripts/launch-wipe.mjs'), 'utf8');

let pass = 0;
const fails = [];
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fails.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

// ── 1. every table the schema creates ───────────────────────────────────────
// Both spellings are in db/: the 0000 baseline uses `CREATE TABLE bosses`, every
// migration since uses `create table if not exists public.x`.
const dbDir = path.join(ROOT, 'db');
const sqlFiles = readdirSync(dbDir).filter((f) => f.endsWith('.sql'));
assert.ok(sqlFiles.length > 10, 'db/*.sql should hold the schema; found almost none');

const created = new Set();
for (const f of sqlFiles) {
  const sql = readFileSync(path.join(dbDir, f), 'utf8');
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)/gi)) {
    created.add(m[1].toLowerCase());
  }
}
check('db/*.sql yields a table list', created.size >= 20, `found ${created.size}`);
// Anchor: if the regex ever stops matching the 0000 baseline's uppercase form,
// the whole tripwire would pass vacuously.
for (const anchor of ['bosses', 'players', 'events', 'boss_tellings', 'offices']) {
  check(`schema scan sees ${anchor}`, created.has(anchor));
}

// ── 2. what the wipe declares ───────────────────────────────────────────────
function tablesInBlock(startMarker) {
  const start = wipeSrc.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `${startMarker} not found in launch-wipe.mjs`);
  const end = wipeSrc.indexOf('\n];', start);
  assert.notStrictEqual(end, -1, `end of ${startMarker} not found`);
  const block = wipeSrc.slice(start, end);
  return [...block.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

const deleted = tablesInBlock('const DELETE_TABLES = [');
const updated = tablesInBlock('const UPDATE_TARGETS = [');
check('DELETE_TABLES parses', deleted.length >= 15, `${deleted.length} entries`);
check('UPDATE_TARGETS parses', updated.length === 3, `${updated.length} entries`);

// ── 3. the keep-list, with its reason ───────────────────────────────────────
// Named here on purpose so that adding a table means writing down why it stays.
const KEEP = {
  discord_events: 'the bot’s own message ledger; not world data, and its ids outlive the world',
  ops_heartbeats: 'ops telemetry about the SERVICES, which are the same services after the wipe',
  ops_heartbeat_log: 'ops telemetry history; keeping it is how the launch-night graph has a before',
  ops_alerts: 'the watchdog’s dedupe memory -- clearing it would re-alert on a state it already announced',
};

// ── 4. the join ─────────────────────────────────────────────────────────────
const declared = new Map();
for (const t of deleted) declared.set(t, 'DELETE_TABLES');
for (const t of updated) {
  check(`${t} is not in both lists`, !declared.has(t), `also in ${declared.get(t)}`);
  declared.set(t, 'UPDATE_TARGETS');
}
for (const t of Object.keys(KEEP)) {
  check(`${t} keep-list entry is not also wiped`, !declared.has(t), `also in ${declared.get(t)}`);
  declared.set(t, 'KEEP');
}

const undecided = [...created].filter((t) => !declared.has(t)).sort();
check(
  'every table in db/*.sql is decided by the wipe (delete, reset, or keep)',
  undecided.length === 0,
  undecided.length
    ? `undecided: ${undecided.join(', ')}. Add each to DELETE_TABLES or UPDATE_TARGETS in ` +
      'scripts/launch-wipe.mjs, or to KEEP in this file with the reason it survives a wipe.'
    : '',
);

// ── 5. the four that were missing, named individually ───────────────────────
// A regression guard rather than a restatement of check 4: if someone drops one
// of these while adding another table, check 4 still passes and this does not.
for (const t of ['boss_tellings', 'tales', 'office_nudges', 'offices']) {
  check(`${t} is deleted by the wipe`, deleted.includes(t));
}

// Children before parents. office_nudges.office_id is `on delete cascade` on
// offices, so deleting offices first would take the nudge rows silently and make
// the printed "deleted N row(s)" line a lie -- the same reasoning already
// written for title_history before players.
check(
  'office_nudges is deleted before offices',
  deleted.indexOf('office_nudges') < deleted.indexOf('offices'),
  `office_nudges at ${deleted.indexOf('office_nudges')}, offices at ${deleted.indexOf('offices')}`,
);
check(
  'title_history is deleted before players',
  deleted.indexOf('title_history') < deleted.indexOf('players'),
);

// office_nudges has a COMPOSITE primary key, so `pk` must name a NOT NULL member
// of it -- deleteAllRows() filters on `<pk>=not.is.null` to match every row.
const nudgeEntry = /\{\s*table:\s*'office_nudges',\s*pk:\s*'([a-z_]+)'/.exec(wipeSrc);
check('office_nudges declares a NOT NULL pk column', nudgeEntry?.[1] === 'boss_id', nudgeEntry?.[1]);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\nlaunch-wipe table coverage: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
