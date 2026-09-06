// The bosses.fight_stats compare-and-swap under MALFORMED and HOSTILE input.
//
// scripts/fight-stats-cas.test.mjs covers the race the CAS was written for: two
// overlapping folds, the kill flip, the observed ledger, the two filter shapes.
// This file covers what happens when the row itself, or the fold handed to the
// helper, is not what the happy path assumes — the cases that produce NO error
// anywhere and just quietly stop a boss's fight record from ever advancing
// again.
//
// The filter semantics asserted here were verified against the real thing on
// 2026-09-06 (local PostgREST + Postgres 17, `PATCH /bosses?id=eq.<id>&…`):
//
//   fight_stats value              ->>rev=is.null   ->>rev=eq.3
//   NULL (SQL null)                     1 row          0 rows
//   {}                                  1 row          0 rows
//   {"fighters":[...]} (no rev)         1 row          0 rows
//   {"rev":3}                           0 rows         1 row
//   "a bare string" (jsonb scalar)      1 row          0 rows
//   {"rev":"3"}  (STRING rev)           0 rows         1 row   <- the trap
//   {"rev":0}                           0 rows         0 rows  (eq.0 matches)
//
// The last three are the reason this file exists. The fake client below
// implements exactly that table.
//
// AND THE SHAPES NO FILTER CAN MATCH (re-measured 2026-09-06, same stack, with
// `select v ->> 'rev'` over each). These are why section 8 exists:
//
//   stored rev     ->>rev renders in Postgres    JS String(v)
//   1.0            '1.0'                         '1'
//   1e21           '1000000000000000000000'      '1e+21'
//   true           'true'                        'true'
//   "abc"          'abc'                         'abc'
//   {"a":1}        '{"a": 1}'                    '[object Object]'
//   [1]            '[1]'                         '1'
//
// The first two and the last two cannot be reproduced in JS at all; the middle
// two could be, but only as a bare word in a PostgREST query string. revOf
// refuses all six rather than guessing, so they end in ONE read with an error
// line naming the boss, not six silent misses and a fight record that quietly
// stops advancing. The fake client's jsonPath() below does NOT model them (it
// uses String(v)) and does not need to: nothing here ever builds a filter from
// one, which is the property under test.
//
//   npx tsx scripts/fight-stats-cas-degrade.test.mjs

import assert from 'node:assert';
import { foldFightStats, FIGHT_STATS_CAS_ATTEMPTS } from '../lib/fight-stats-cas.ts';
import { foldClientDamage } from '../lib/boss-damage.ts';

const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));
const noSleep = async () => {};

/** `fight_stats->>rev` exactly as Postgres computes it (see the table above). */
function jsonPath(row, column) {
  const [col, key] = column.split('->>');
  const blob = row[col];
  // `->>` on a NULL column, a scalar, or an array yields SQL NULL.
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  const v = blob[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

const cellValue = (row, column) => (column.includes('->>') ? jsonPath(row, column) : row[column]);

const matches = (row, filters) =>
  filters.every(([op, column, value]) => {
    const got = cellValue(row, column);
    if (op === 'is') return value === null ? got === null : got === value;
    return got !== null && got !== undefined && got === value; // PostgREST eq never matches NULL
  });

function fakeDb(seedRows, { concurrent = null } = {}) {
  const table = new Map(seedRows.map((r) => [r.id, clone(r)]));
  const stats = { reads: 0, writes: 0, filters: [] };

  const run = (state) => {
    if (state.op === 'select') {
      stats.reads++;
      let out = [...table.values()].filter((r) => matches(r, state.filters));
      if (typeof state.limit === 'number') out = out.slice(0, state.limit);
      return { data: out.map(clone), error: null };
    }
    stats.writes++;
    stats.filters.push(state.filters.map(([op, c, v]) => `${op}:${c}=${JSON.stringify(v)}`));
    if (concurrent) concurrent(stats.writes, table);
    const hit = [...table.values()].filter((r) => matches(r, state.filters));
    for (const r of hit) Object.assign(r, clone(state.patch));
    return { data: hit.map((r) => ({ id: r.id })), error: null };
  };

  const builder = (state) => ({
    select() {
      return builder(state);
    },
    eq(column, value) {
      state.filters.push(['eq', column, value]);
      return builder(state);
    },
    is(column, value) {
      state.filters.push(['is', column, value]);
      return builder(state);
    },
    limit(n) {
      state.limit = n;
      return builder(state);
    },
    then(resolve, reject) {
      return Promise.resolve().then(() => run(state)).then(resolve, reject);
    },
  });

  return {
    client: {
      from() {
        return {
          select: () => builder({ op: 'select', filters: [] }),
          update: (patch) => builder({ op: 'update', filters: [], patch }),
        };
      },
    },
    table,
    stats,
    row: (id) => clone(table.get(id)),
  };
}

const boss = (over = {}) => ({ id: 'eik', is_killed: false, fight_stats: null, players_present: [], ...over });

let checks = 0;
const ok = (cond, msg) => {
  checks++;
  assert.ok(cond, msg);
  console.log(`  ok   ${msg}`);
};

// ── 1. A REV STORED AS A STRING must not deadlock the boss ───────────────────
//
// The failure this closes: `{"rev":"7"}` used to read as "no rev", so the helper
// sent `fight_stats->>rev=is.null`, Postgres answered zero rows (the projection
// is the TEXT '7'), and the writer missed six times and dropped its fact. Every
// later writer did the same, forever — one boss's fight record frozen with
// nothing but a log line to say so. Nothing in the repo writes a string rev
// today; a hand-edit in the SQL editor or a restore is all it would take.
console.log('\nfight_stats-cas-degrade — a rev stored as a string');
{
  const db = fakeDb([boss({ fight_stats: { rev: '7', fighters: ['Astrid'], damage: { Astrid: 100 } } })]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => foldClientDamage(existing, 'Bren', 50, { cap: 2000, isKilled: true }),
    { sleep: noSleep },
  );
  const fs = db.row('eik').fight_stats;
  ok(outcome === 'written', `the fold lands on the first attempt (got "${outcome}")`);
  ok(db.stats.writes === 1, `exactly one write, no retry storm (got ${db.stats.writes})`);
  ok(
    db.stats.filters[0].includes('eq:fight_stats->>rev="7"'),
    'the filter carries the stored text verbatim, which is what ->> will return',
  );
  ok(fs.rev === 8, `and the row is re-stamped with a real NUMBER (got ${JSON.stringify(fs.rev)})`);
  ok(fs.damage.Bren === 50 && fs.damage.Astrid === 100, 'the accrued damage map survives the repair');
}

// ── 2. fight_stats that is not an object at all ──────────────────────────────
//
// A jsonb scalar (`"gs-milestone"` written where the blob belonged, a restore
// gone sideways). `->>rev` is SQL NULL for it, so `is.null` matches and the CAS
// overwrites the junk with a proper object rather than looping.
console.log('\nfight_stats-cas-degrade — fight_stats is a bare jsonb string');
{
  const db = fakeDb([boss({ fight_stats: 'gs-milestone' })]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => foldClientDamage(existing, 'Astrid', 120, { cap: 2000, isKilled: true }),
    { sleep: noSleep },
  );
  const fs = db.row('eik').fight_stats;
  ok(outcome === 'written', `the junk row is repaired, not retried (got "${outcome}")`);
  ok(db.stats.writes === 1, `one write (got ${db.stats.writes})`);
  ok(fs.rev === 1, 'stamped rev 1, as an unstamped row would be');
  ok(fs.damage.Astrid === 120 && fs.fighters.includes('Astrid'), 'the fold landed on it');
}

// ── 3. A rev of ZERO is a real rev, not "unstamped" ──────────────────────────
//
// `priorRev === null` is the unstamped test, and it has to stay an identity
// check: a falsy test would send `is.null` against a row whose ->>rev is '0',
// match nothing, and give up.
console.log('\nfight_stats-cas-degrade — rev 0');
{
  const db = fakeDb([boss({ fight_stats: { rev: 0, fighters: [] } })]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => foldClientDamage(existing, 'Astrid', 10, { cap: 2000, isKilled: true }),
    { sleep: noSleep },
  );
  ok(outcome === 'written', `rev 0 is matched, not treated as absent (got "${outcome}")`);
  ok(db.stats.filters[0].includes('eq:fight_stats->>rev="0"'), 'and the filter says eq.0, never is.null');
  ok(db.row('eik').fight_stats.rev === 1, 'it advances to 1');
}

// ── 4. A FOLD THAT MUTATES the row it was given ──────────────────────────────
//
// None of the four production folds does this (lib/boss-damage rebuilds through
// readFighters / readDamage / readObserved, each of which returns a fresh
// object), but the helper hands caller-supplied code the object its own
// precondition is derived from. Reading the rev BEFORE the fold is what keeps a
// mutating fold from moving the compare-and-swap out from under itself — without
// it the filter names a rev the row does not carry, every attempt matches zero
// rows, and the fact is dropped with no error anywhere.
console.log('\nfight_stats-cas-degrade — a fold that mutates existing');
{
  const db = fakeDb([boss({ fight_stats: { rev: 4, fighters: ['Astrid'] } })]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => {
      existing.rev = 999; // the trap: the precondition must already be captured
      existing.fighters.push('Bren');
      return existing;
    },
    { sleep: noSleep },
  );
  ok(outcome === 'written', `a mutating fold still lands (got "${outcome}")`);
  ok(db.stats.writes === 1, `on the first attempt (got ${db.stats.writes})`);
  ok(
    db.stats.filters[0].includes('eq:fight_stats->>rev="4"'),
    'the filter is the rev as READ (4), not the one the fold scribbled (999)',
  );
  ok(db.row('eik').fight_stats.rev === 5, 'and the helper re-stamps 5 over the scribble');
}

// ── 5. A FOLD THAT THROWS propagates; it must not be swallowed as a miss ─────
//
// The helper must not swallow it: catching a fold's exception and retrying five
// more times against a database that is perfectly healthy would turn one bug
// into six writes' worth of load and hide the stack trace. It propagates.
//
// Where it lands differs by caller, and that asymmetry is worth knowing:
// ingestBossDamageDeltas and ingestObservedBossDamage are each wrapped in
// /api/gs-ingest's best-effort try/catch (route.ts §"boss-damage fallback" and
// §"observed boss damage"), so a throw there costs one boss's enrichment.
// ingestBossMilestones and ingestBossKillEvents are NOT wrapped and there is no
// outer catch in POST, so a throw there is a 500 and the producer re-POSTs.
// Neither is reachable today — none of the four folds throws — which is exactly
// why it is pinned here rather than left to be discovered on launch night.
console.log('\nfight_stats-cas-degrade — a fold that throws');
{
  const db = fakeDb([boss()]);
  let threw = null;
  try {
    await foldFightStats(db.client, 'eik', () => {
      throw new Error('fold blew up');
    }, { sleep: noSleep });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof Error && threw.message === 'fold blew up', 'the error reaches the caller unchanged');
  ok(db.stats.reads === 1, `read once, not ${FIGHT_STATS_CAS_ATTEMPTS} times (got ${db.stats.reads})`);
  ok(db.stats.writes === 0, 'and nothing was written');
  ok(db.row('eik').fight_stats === null, 'the row is untouched');
}

// ── 6. An extraPatch that throws is the same story ───────────────────────────
console.log('\nfight_stats-cas-degrade — an extraPatch that throws');
{
  const db = fakeDb([boss()]);
  let threw = null;
  try {
    await foldFightStats(db.client, 'eik', () => ({ fighters: ['Astrid'] }), {
      sleep: noSleep,
      extraPatch: () => {
        throw new Error('patch blew up');
      },
    });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof Error && threw.message === 'patch blew up', 'it reaches the caller unchanged');
  ok(db.stats.writes === 0, 'no half-written row');
  ok(db.row('eik').fight_stats === null, 'the row is untouched');
}

// ── 7. A CONTENDED string rev still converges ────────────────────────────────
//
// The repair has to survive the thing the CAS exists for: another writer landing
// between our read and our write. First attempt misses because the concurrent
// writer moved the rev; the retry re-reads, re-folds onto what is ACTUALLY
// stored, and both deltas end up in the map.
console.log('\nfight_stats-cas-degrade — a string rev under contention');
{
  const db = fakeDb([boss({ fight_stats: { rev: '2', damage: { Astrid: 100 } } })], {
    concurrent: (writeNo, table) => {
      if (writeNo !== 1) return;
      const r = table.get('eik');
      r.fight_stats = { rev: 3, damage: { Astrid: 100, Cnut: 70 } };
    },
  });
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => foldClientDamage(existing, 'Bren', 55, { cap: 2000, isKilled: true }),
    { sleep: noSleep },
  );
  const fs = db.row('eik').fight_stats;
  ok(outcome === 'written', `it converges (got "${outcome}")`);
  ok(db.stats.writes === 2, `after exactly one miss and one retry (got ${db.stats.writes})`);
  ok(fs.damage.Cnut === 70, "the concurrent writer's fold is NOT discarded");
  ok(fs.damage.Bren === 55, 'and ours is credited on top of it');
  ok(fs.rev === 4, `rev advances from the fresh 3 to 4 (got ${fs.rev})`);
}

// ── 8. A REV NO FILTER CAN MATCH refuses loudly instead of missing six times ──
//
// Before this, `{"rev":true}` / `{"rev":"abc"}` / `{"rev":{...}}` / `{"rev":[1]}`
// / `{"rev":1.0}` each read as "no rev", sent `is.null`, matched zero rows, and
// burned all six attempts — and every writer after did the same, forever, with
// nothing in the log but the generic "another writer won every attempt" line for
// a row nobody was contending. The outcome is still 'gave-up' (there is no
// filter that could have landed), but it is reached in ONE read, with a message
// that names the boss and the stored value, and the fold has been run so a
// caller with a degraded path still has its product.
console.log('\nfight_stats-cas-degrade — a rev no filter can match');
for (const [what, rev] of [
  ['a boolean', true],
  ['a non-numeric string', 'abc'],
  ['an object', { a: 1 }],
  ['an array', [1]],
  ['a float Postgres prints differently', 1e21],
]) {
  const db = fakeDb([boss({ fight_stats: { rev, damage: { Astrid: 100 } } })]);
  let foldRuns = 0;
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => {
      foldRuns++;
      return foldClientDamage(existing, 'Bren', 50, { cap: 2000, isKilled: true });
    },
    { sleep: noSleep },
  );
  ok(outcome === 'gave-up', `${what}: gives up (got "${outcome}")`);
  ok(db.stats.reads === 1, `${what}: after ONE read, not ${FIGHT_STATS_CAS_ATTEMPTS} (got ${db.stats.reads})`);
  ok(db.stats.writes === 0, `${what}: and never writes a filter that cannot match (got ${db.stats.writes})`);
  ok(foldRuns === 1, `${what}: the fold still ran once, for the caller's degraded path (got ${foldRuns})`);
  ok(
    JSON.stringify(db.row('eik').fight_stats.rev) === JSON.stringify(rev),
    `${what}: the row is left exactly as found`,
  );
}

// A rev of 1.0 is a JS integer (1) once it has been through JSON.parse, so it is
// matchable and must NOT be caught by the refusal above. Postgres only prints
// '1.0' for a literal typed into the SQL editor, which arrives here as 1.
console.log('\nfight_stats-cas-degrade — 1.0 round-trips through JSON as the integer 1');
{
  const db = fakeDb([boss({ fight_stats: JSON.parse('{"rev":1.0,"damage":{"Astrid":100}}') })]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing) => foldClientDamage(existing, 'Bren', 50, { cap: 2000, isKilled: true }),
    { sleep: noSleep },
  );
  ok(outcome === 'written', `it lands (got "${outcome}")`);
  ok(db.stats.filters[0].includes('eq:fight_stats->>rev="1"'), 'with the filter eq.1');
  ok(db.row('eik').fight_stats.rev === 2, 'and advances to 2');
}

console.log(`\nfight-stats-cas-degrade: ${checks} assertions passed`);
