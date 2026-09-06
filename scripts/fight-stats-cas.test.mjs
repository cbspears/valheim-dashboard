// Unit test for the bosses.fight_stats COMPARE-AND-SWAP (lib/fight-stats-cas.ts).
//
// WHAT IT IS PROVING. Every writer of fight_stats does read → fold → write, and
// the ingest is not serial: twenty clients re-POST a cumulative snapshot every
// ~120s (plus duplicate re-POSTs, plus the server Emitter). Before the CAS, two
// overlapping writers interleaved as A-reads / B-reads / A-writes / B-writes and
// B silently discarded A's fold — the smoke run caught it as Astrid credited
// +82, +114 and +135 on Eikthyr (331) with 196 actually stored.
//
// A unit test cannot run two serverless requests at once, so the fake client
// below does the thing that makes the race deterministic instead: a hook that
// fires BETWEEN our read and our write and mutates the row exactly as a
// concurrent writer would. The assertions are then about behaviour, not timing —
// the helper must notice, re-read, re-run the fold on the FRESH row, and end up
// with both deltas in the stored damage map.
//
// The folds themselves are the real ones (lib/boss-damage.ts). A hand-written
// copy of a fold in a test file is how a merge bug survives a green suite.
//
//   npx tsx scripts/fight-stats-cas.test.mjs
import assert from 'node:assert';
import { foldFightStats, FIGHT_STATS_CAS_ATTEMPTS } from '../lib/fight-stats-cas.ts';
import {
  foldClientDamage,
  foldObservedDamage,
  sealClientDamageVerdict,
  planBossKillUpdate,
} from '../lib/boss-damage.ts';

const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));
const noSleep = async () => {};

/**
 * `fight_stats->>rev` as Postgres computes it: SQL NULL both when the column is
 * NULL and when the key is absent, otherwise the number rendered as text. This is
 * the single rule the whole CAS rests on, so the fake implements it literally
 * rather than special-casing the helper's two call shapes.
 */
function jsonPath(row, column) {
  const [col, key] = column.split('->>');
  const blob = row[col];
  if (!blob || typeof blob !== 'object') return null;
  const v = blob[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

function cellValue(row, column) {
  return column.includes('->>') ? jsonPath(row, column) : row[column];
}

function matches(row, filters) {
  return filters.every(([op, column, value]) => {
    const got = cellValue(row, column);
    if (op === 'is') return value === null ? got === null : got === value;
    // PostgREST `eq` never matches SQL NULL.
    return got !== null && got !== undefined && got === value;
  });
}

/**
 * A fake PostgREST client over one in-memory `bosses` table.
 *
 * `concurrent(writeAttemptNumber, rows)` is called immediately before each UPDATE
 * is evaluated — i.e. after this writer has read and folded, before its write is
 * matched. Returning without touching anything means no contention.
 */
function fakeDb(seedRows, { concurrent = null, readError = null, writeError = null } = {}) {
  const table = new Map(seedRows.map((r) => [r.id, clone(r)]));
  const stats = { reads: 0, writes: 0 };

  const run = (state) => {
    if (state.op === 'select') {
      stats.reads++;
      if (readError) return { data: null, error: { message: readError } };
      let out = [...table.values()].filter((r) => matches(r, state.filters));
      if (typeof state.limit === 'number') out = out.slice(0, state.limit);
      return { data: out.map(clone), error: null };
    }
    stats.writes++;
    if (concurrent) concurrent(stats.writes, table);
    if (writeError) return { data: null, error: { message: writeError } };
    const hit = [...table.values()].filter((r) => matches(r, state.filters));
    for (const r of hit) Object.assign(r, clone(state.patch));
    return { data: hit.map((r) => ({ id: r.id })), error: null };
  };

  const builder = (state) => ({
    select(cols) {
      if (state.op === 'select') state.cols = cols;
      else state.returning = cols;
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

  const client = {
    from(name) {
      assert.equal(name, 'bosses', 'the CAS helper only ever touches bosses');
      return {
        select: (cols) => builder({ op: 'select', filters: [], cols }),
        update: (patch) => builder({ op: 'update', filters: [], patch }),
      };
    },
  };
  return { client, table, stats, row: (id) => clone(table.get(id)) };
}

const boss = (over = {}) => ({
  id: 'eik',
  is_killed: false,
  fight_stats: null,
  players_present: [],
  ...over,
});

const CAP = 2000;

// ── 1. THE RACE, exactly as the smoke run produced it ────────────────────────
//
// We read a row with nothing on it and fold Astrid's +135. Between that read and
// our write, another request lands Astrid's earlier +196 and stamps rev=1. Our
// write carries `fight_stats->>rev=is.null`, which no longer matches, so it must
// re-read and re-fold — and the stored damage must end at 331, not 135 and not
// 196. This is the assertion the old unconditional update failed.
{
  const db = fakeDb([boss()], {
    concurrent: (attempt, table) => {
      if (attempt !== 1) return;
      table.get('eik').fight_stats = { fighters: ['Astrid'], damage: { Astrid: 196 }, rev: 1 };
    },
  });

  let folds = 0;
  const seen = [];
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => {
      folds++;
      seen.push(existing?.damage?.Astrid ?? null);
      return foldClientDamage(existing, 'Astrid', 135, { cap: CAP, isKilled: fresh.is_killed });
    },
    {
      sleep: noSleep,
      extraPatch: (fresh) => {
        const set = new Set(fresh.players_present);
        set.add('Astrid');
        return set.size > fresh.players_present.length ? { players_present: [...set] } : null;
      },
    },
  );

  assert.equal(outcome, 'written', 'the retry lands');
  assert.equal(folds, 2, 'the fold re-ran on the fresh row rather than the write being re-issued');
  assert.deepEqual(seen, [null, 196], 'the second run saw the CONCURRENT writer’s row, not our stale one');
  const after = db.row('eik');
  assert.equal(after.fight_stats.damage.Astrid, 331, 'both deltas survived — 196 + 135');
  assert.equal(after.fight_stats.rev, 2, 'rev advanced from the value we actually folded onto');
  assert.deepEqual(after.players_present, ['Astrid'], 'the extraPatch union rode along in the same write');
  assert.equal(db.stats.writes, 2, 'one losing write, one winning write');
}

// ── 1b. The uncontended path still writes once, and stamps rev=1 ─────────────
{
  const db = fakeDb([boss()]);
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => foldClientDamage(existing, 'Astrid', 82, { cap: CAP, isKilled: fresh.is_killed }),
    { sleep: noSleep },
  );
  assert.equal(outcome, 'written');
  assert.equal(db.stats.writes, 1, 'no contention, no retry');
  assert.equal(db.row('eik').fight_stats.rev, 1, 'a row with no rev is stamped 1');
  assert.equal(db.row('eik').fight_stats.damage.Astrid, 82);
}

// ── 1c. A rev that is already set advances by exactly one ────────────────────
{
  const db = fakeDb([boss({ fight_stats: { damage: { Astrid: 10 }, fighters: ['Astrid'], rev: 7 } })]);
  await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => foldClientDamage(existing, 'Bjorn', 5, { cap: CAP, isKilled: fresh.is_killed }),
    { sleep: noSleep },
  );
  assert.equal(db.row('eik').fight_stats.rev, 8, 'rev = existing.rev + 1');
  assert.deepEqual(db.row('eik').fight_stats.fighters, ['Astrid', 'Bjorn'], 'the union still grows');
}

// ── 2. 'noop' — the fold declines, and nothing is written at all ─────────────
{
  const db = fakeDb([boss({ fight_stats: { damage: { Astrid: 196 }, rev: 3 } })]);
  // foldClientDamage returns null for a non-positive delta: the real "nothing to
  // credit" case, which must not churn the row (or bump rev, which would make
  // every other in-flight writer miss for no reason).
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => foldClientDamage(existing, 'Astrid', 0, { cap: CAP, isKilled: fresh.is_killed }),
    { sleep: noSleep },
  );
  assert.equal(outcome, 'noop');
  assert.equal(db.stats.writes, 0, 'a declined fold never reaches the database');
  assert.equal(db.row('eik').fight_stats.rev, 3, 'and never moves the rev');
}

// ── 2b. 'noop' when the row is gone (a wipe mid-flight) ──────────────────────
{
  const db = fakeDb([]);
  const outcome = await foldFightStats(db.client, 'eik', () => ({ fighters: ['Astrid'] }), { sleep: noSleep });
  assert.equal(outcome, 'noop', 'no row to fold onto');
  assert.equal(db.stats.writes, 0);
}

// ── 3. 'gave-up' after FIGHT_STATS_CAS_ATTEMPTS forced misses ────────────────
//
// A writer that loses every attempt must DROP its fact, not force it: forcing it
// is the original bug. The producer re-posts its cumulative snapshot within
// ~120s, so the delta is recomputed from the row as it then stands.
{
  const db = fakeDb([boss()], {
    // Somebody else bumps the rev before every one of our writes.
    concurrent: (attempt, table) => {
      const r = table.get('eik');
      r.fight_stats = { damage: { Bjorn: attempt * 10 }, rev: attempt };
    },
  });

  let folds = 0;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let outcome;
  try {
    outcome = await foldFightStats(
      db.client,
      'eik',
      (existing, fresh) => {
        folds++;
        return foldClientDamage(existing, 'Astrid', 135, { cap: CAP, isKilled: fresh.is_killed });
      },
      { sleep: noSleep, label: 'boss-damage fallback (Eikthyr)' },
    );
  } finally {
    console.error = realError;
  }

  assert.equal(outcome, 'gave-up');
  assert.equal(folds, FIGHT_STATS_CAS_ATTEMPTS, `${FIGHT_STATS_CAS_ATTEMPTS} attempts, then it stops`);
  assert.equal(db.stats.writes, FIGHT_STATS_CAS_ATTEMPTS, 'and it never writes a seventh time');
  assert.equal(errors.length, 1, 'exactly ONE error line, not one per attempt');
  assert.match(errors[0], /gave up on boss eik after 6 compare-and-swap misses/);
  assert.match(errors[0], /boss-damage fallback \(Eikthyr\)/, 'the label names the writer that lost');
  assert.equal(db.row('eik').fight_stats.damage.Astrid, undefined, 'our fact was dropped, not forced');
}

// ── 3b. A read error and a write error both give up immediately ──────────────
{
  const quiet = console.error;
  console.error = () => {};
  try {
    const readBad = fakeDb([boss()], { readError: 'column bosses.fight_stats does not exist' });
    assert.equal(
      await foldFightStats(readBad.client, 'eik', () => ({ fighters: ['Astrid'] }), { sleep: noSleep }),
      'gave-up',
      'an unreadable row is not retried six times',
    );
    assert.equal(readBad.stats.reads, 1);

    const writeBad = fakeDb([boss()], { writeError: 'column bosses.fight_stats does not exist' });
    assert.equal(
      await foldFightStats(writeBad.client, 'eik', () => ({ fighters: ['Astrid'] }), { sleep: noSleep }),
      'gave-up',
      'a hard write failure is not a CAS miss',
    );
    assert.equal(writeBad.stats.writes, 1);
  } finally {
    console.error = quiet;
  }
}

// ── 4. THE KILL FLIP — 'we flipped it' vs 'already flipped' ──────────────────
//
// ingestBossMilestones counts `felled` off this outcome and only emits the boss
// event when it flipped the row itself, and the Great Deeds evaluator runs off
// that same counter. So the two answers have to stay distinguishable under the
// CAS exactly as they were under the bare `.eq('is_killed', false)` guard.

/** The milestone flip, shaped as ingestBossMilestones drives it. */
function killFlip(db, { roster, payloadFighters = [], killedAt = '2026-09-09T20:00:00.000Z' }) {
  let presentAtFlip = payloadFighters.length ? [...new Set(payloadFighters)] : roster;
  return foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => {
      if (fresh.is_killed) return null; // already felled — not ours to flip
      const prior = Array.isArray(existing?.fighters) ? existing.fighters.filter((n) => typeof n === 'string' && n.trim()) : [];
      const fought = [...new Set([...prior, ...payloadFighters])];
      presentAtFlip = fought.length > 0 ? fought : roster;
      const sealed = sealClientDamageVerdict(existing) ?? existing;
      return { ...(sealed ?? {}), fighters: fought, onlineAtKill: roster, source: 'gs-milestone' };
    },
    {
      sleep: noSleep,
      label: 'boss milestone flip (Eikthyr)',
      extraPatch: () => ({ is_killed: true, killed_at: killedAt, players_present: presentAtFlip }),
      extraFilter: { is_killed: false },
    },
  ).then((outcome) => ({ outcome, presentAtFlip }));
}

// 4a. Already felled → 'already flipped'. No event, no felled++, no write.
{
  const db = fakeDb([
    boss({ is_killed: true, killed_at: '2026-09-09T19:00:00.000Z', fight_stats: { fighters: ['Astrid'], rev: 4 } }),
  ]);
  const { outcome } = await killFlip(db, { roster: ['Astrid', 'Bjorn'] });
  assert.equal(outcome, 'noop', "an already-felled boss reads as 'already flipped', never 'written'");
  assert.equal(db.stats.writes, 0, 'and the re-POST does not touch the row');
  assert.equal(db.row('eik').fight_stats.rev, 4);
}

// 4b. Not yet felled → 'written', and everything lands in ONE statement.
{
  const db = fakeDb([boss({ fight_stats: { fighters: ['Astrid'], damage: { Astrid: 331 }, rev: 2 } })]);
  const { outcome, presentAtFlip } = await killFlip(db, { roster: ['Astrid', 'Cnut'], payloadFighters: ['Bjorn'] });
  const after = db.row('eik');
  assert.equal(outcome, 'written', 'we felled it');
  assert.equal(db.stats.writes, 1, 'the flip and the fight_stats seed are one write, not two');
  assert.equal(after.is_killed, true);
  assert.equal(after.killed_at, '2026-09-09T20:00:00.000Z');
  assert.deepEqual(after.fight_stats.fighters, ['Astrid', 'Bjorn'], 'the accrued war party survives the seed');
  assert.equal(after.fight_stats.damage.Astrid, 331, 'and so does the damage map');
  assert.equal(after.fight_stats.topDamagePlayer, 'Astrid', 'the fallback verdict is sealed at the kill');
  assert.equal(after.fight_stats.source, 'gs-milestone');
  assert.equal(after.fight_stats.rev, 3);
  assert.deepEqual(presentAtFlip, ['Astrid', 'Bjorn']);
  assert.deepEqual(after.players_present, ['Astrid', 'Bjorn']);
}

// 4c. A duplicate re-POST that flips the row between our read and our write.
//     The extraFilter misses, the retry re-reads is_killed=true, and the fold
//     declines — so the loser reports 'already flipped', NOT 'gave-up'.
{
  const db = fakeDb([boss()], {
    concurrent: (attempt, table) => {
      if (attempt !== 1) return;
      const r = table.get('eik');
      r.is_killed = true;
      r.killed_at = '2026-09-09T19:59:59.000Z';
      r.fight_stats = { fighters: ['Astrid'], source: 'gs-milestone', rev: 1 };
    },
  });
  const { outcome } = await killFlip(db, { roster: ['Astrid'], payloadFighters: ['Astrid'] });
  assert.equal(outcome, 'noop', 'losing the flip race is "already flipped", not a give-up');
  assert.equal(db.stats.writes, 1, 'it does not burn six attempts on a race it has already lost');
  assert.equal(db.row('eik').killed_at, '2026-09-09T19:59:59.000Z', 'the winner’s kill time stands');
}

// ── 5. The OBSERVED ledger re-differences against the fresh row ──────────────
//
// The bystander fold reads a HIGH-WATER MARK out of the row it is folding onto,
// so a stale `existing` was doubly wrong: the losing write both discarded the
// winner's damage and rewound the ledger, and the next ~120s re-post re-credited
// blows already banked. Re-running the fold on the fresh row is what keeps the
// differencing honest.
{
  const db = fakeDb([boss()], {
    concurrent: (attempt, table) => {
      if (attempt !== 1) return;
      // Another observer's post lands first, crediting Bjorn's own blows.
      table.get('eik').fight_stats = {
        fighters: ['Bjorn'],
        damage: { Bjorn: 40 },
        observed: { Cnut: { Bjorn: 40 } },
        rev: 1,
      };
    },
  });

  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) =>
      foldObservedDamage(existing, 'Dagny', { Astrid: 90 }, { cap: CAP, isKilled: fresh.is_killed }),
    { sleep: noSleep },
  );
  const fs = db.row('eik').fight_stats;
  assert.equal(outcome, 'written');
  assert.equal(fs.damage.Bjorn, 40, "the other observer's credit is intact");
  assert.equal(fs.damage.Astrid, 90, 'and ours landed on top of it');
  assert.deepEqual(fs.observed, { Cnut: { Bjorn: 40 }, Dagny: { Astrid: 90 } }, 'both ledgers survive');
  assert.equal(fs.rev, 2);

  // The re-post of the identical cumulative is still a true no-op down to the DB.
  const writesBefore = db.stats.writes;
  const again = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) =>
      foldObservedDamage(existing, 'Dagny', { Astrid: 90 }, { cap: CAP, isKilled: fresh.is_killed }),
    { sleep: noSleep },
  );
  assert.equal(again, 'noop', 'a repeated cumulative reading credits nothing');
  assert.equal(db.stats.writes, writesBefore, 'and writes nothing');
}

// ── 6. planBossKillUpdate drops rev on its whitelist — the helper re-stamps ──
//
// The MVP planner rebuilds fight_stats from a fixed key list, so `rev` never
// survives the fold. That is fine BY CONSTRUCTION only because foldFightStats
// stamps the counter after the fold returns; if that ever moved into the folds,
// this is the assertion that breaks.
{
  const db = fakeDb([
    boss({
      is_killed: true,
      fight_stats: { fighters: ['Astrid'], damage: { Astrid: 331 }, observed: { Cnut: { Astrid: 331 } }, rev: 5 },
      players_present: ['Astrid'],
    }),
  ]);
  const report = {
    firstBlood: 'Astrid',
    topDamagePlayer: 'Gunnar',
    fightSec: 92,
    topDamage: 450,
    participants: 8,
    tsUtc: '2026-09-09T20:00:00.000Z',
  };
  let planned = null;
  const outcome = await foldFightStats(
    db.client,
    'eik',
    (existing, fresh) => {
      const plan = planBossKillUpdate({
        source: 'server',
        isKilled: fresh.is_killed,
        existing,
        priorPresent: fresh.players_present,
        report,
        canonical: null,
      });
      planned = plan.playersPresent ?? null;
      assert.equal(plan.fightStats.rev, undefined, 'the planner really does drop rev');
      return plan.fightStats;
    },
    { sleep: noSleep, extraPatch: () => (planned ? { players_present: planned } : null) },
  );
  const fs = db.row('eik').fight_stats;
  assert.equal(outcome, 'written');
  assert.equal(fs.rev, 6, 'the helper re-stamps the counter the whitelist dropped');
  assert.equal(fs.topDamagePlayer, 'Gunnar', 'the MVP summary owns the verdict');
  assert.equal(fs.damage.Astrid, 331, 'and the accrued damage map is preserved');
  assert.deepEqual(fs.observed, { Cnut: { Astrid: 331 } }, 'as is the observed high-water ledger');
  assert.deepEqual(db.row('eik').players_present.sort(), ['Astrid', 'Gunnar']);
}

// ── 7. The two CAS filter shapes are exactly what PostgREST is asked for ─────
//
// If either operator is ever wrong the folds simply stop landing (the smoke run
// shows it as a silent no-write), so pin them here in the shape the helper emits.
{
  const emitted = [];
  const spy = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            limit: () => ({
              then: (r) => Promise.resolve({ data: [{ id: 'eik', is_killed: false, fight_stats: null, players_present: [] }], error: null }).then(r),
            }),
          }),
        }),
        update: () => {
          const b = {
            eq: (c, v) => (emitted.push(['eq', c, v]), b),
            is: (c, v) => (emitted.push(['is', c, v]), b),
            select: () => b,
            then: (r) => Promise.resolve({ data: [{ id: 'eik' }], error: null }).then(r),
          };
          return b;
        },
      };
    },
  };
  await foldFightStats(spy, 'eik', () => ({ fighters: ['Astrid'] }), { sleep: noSleep });
  assert.deepEqual(
    emitted,
    [['eq', 'id', 'eik'], ['is', 'fight_stats->>rev', null]],
    'no stored rev → fight_stats->>rev=is.null',
  );
}
{
  const emitted = [];
  const spy = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            limit: () => ({
              then: (r) => Promise.resolve({ data: [{ id: 'eik', is_killed: false, fight_stats: { rev: 11 }, players_present: [] }], error: null }).then(r),
            }),
          }),
        }),
        update: () => {
          const b = {
            eq: (c, v) => (emitted.push(['eq', c, v]), b),
            is: (c, v) => (emitted.push(['is', c, v]), b),
            select: () => b,
            then: (r) => Promise.resolve({ data: [{ id: 'eik' }], error: null }).then(r),
          };
          return b;
        },
      };
    },
  };
  await foldFightStats(spy, 'eik', () => ({ fighters: ['Astrid'] }), {
    sleep: noSleep,
    extraFilter: { is_killed: false },
  });
  assert.deepEqual(
    emitted,
    [['eq', 'id', 'eik'], ['eq', 'is_killed', false], ['eq', 'fight_stats->>rev', '11']],
    'a stored rev → fight_stats->>rev=eq.<rev as TEXT>, with extraFilter ANDed in front',
  );
}

console.log('OK — all fight_stats compare-and-swap assertions passed');
