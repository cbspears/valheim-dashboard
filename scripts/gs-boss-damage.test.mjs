// Unit test for the CLIENT-DAMAGE FALLBACK (lib/boss-damage.ts) — the path that
// derives bosses.fight_stats.fighters / topDamagePlayer from what the vikings
// actually hit the beast for, used when no bossKillEvents MVP summary ever
// arrives (the real 2026-08-28 Eikthyr kill).
//
// Drives the SAME functions /api/gs-ingest and scripts/backfill-eikthyr-fight.mjs
// call — no re-implementation of the fold here, because a hand-written copy in a
// test file is how a merge bug survives a green suite.
//
//   npx tsx scripts/gs-boss-damage.test.mjs
import assert from 'node:assert';
import {
  bossDamageMap,
  bossDamageDeltas,
  foldClientDamage,
  CLIENT_DAMAGE_SOURCE,
} from '../lib/boss-damage.ts';
import { applyBaseline, mergeIntoRow } from '../lib/gs-baseline.ts';
import { parseSelfSnapshot, parseSelfDistances } from '../lib/gs-client.ts';

/** gs_stats blob holding just the bossDamage breakdown. */
const gs = (entries) => ({
  bossDamage: entries.map(([boss, damageDealt, fightSec = 0]) => ({ boss, damageDealt, fightSec })),
});

// ── 1. bossDamageMap: defensive read of third-party-derived jsonb ─────────────
assert.deepEqual(bossDamageMap(gs([['Eikthyr', 201]])), { Eikthyr: 201 });
assert.deepEqual(bossDamageMap(null), {}, 'null blob → no damage');
assert.deepEqual(bossDamageMap({}), {}, 'no bossDamage key → no damage');
assert.deepEqual(bossDamageMap({ bossDamage: 'nope' }), {}, 'non-array → no damage');
assert.deepEqual(
  bossDamageMap({ bossDamage: [null, 7, { boss: '', damageDealt: 5 }, { boss: 'Eikthyr' }, { boss: 'Eikthyr', damageDealt: '9' }] }),
  {},
  'malformed rows are dropped, never thrown on',
);
assert.deepEqual(bossDamageMap(gs([['Eikthyr', 0], ['Bonemass', -4]])), {}, 'zero/negative damage is not damage');

// ── 2. bossDamageDeltas: only real growth, mapped to bosses.name ──────────────
// New fighter: a boss key that wasn't there before is credited in full.
assert.deepEqual(
  [...bossDamageDeltas(gs([]), gs([['Eikthyr', 201]]))],
  [['Eikthyr', 201]],
  'first damage on a boss = full delta',
);
// Growth across posts is the DIFFERENCE, never the cumulative total.
assert.deepEqual([...bossDamageDeltas(gs([['Eikthyr', 201]]), gs([['Eikthyr', 350]]))], [['Eikthyr', 149]]);
// Idempotent re-post of the same cumulative snapshot: nothing moved.
assert.deepEqual([...bossDamageDeltas(gs([['Eikthyr', 201]]), gs([['Eikthyr', 201]]))], [], 'unchanged → no-op');
// A stale/smaller reading (the GREATEST merge already refused it) credits nothing.
assert.deepEqual([...bossDamageDeltas(gs([['Eikthyr', 201]]), gs([['Eikthyr', 5]]))], [], 'negative delta → no-op');
// A boss that vanishes from the blob is not a subtraction.
assert.deepEqual([...bossDamageDeltas(gs([['Eikthyr', 201]]), gs([]))], [], 'absent from the new blob → no-op');
// gameObject names map to bosses.name; unmapped creatures are ignored outright.
assert.deepEqual(
  [...bossDamageDeltas(gs([]), gs([['gd_king', 55], ['Dragon', 10], ['Serpent', 900], ['Troll', 400], ['Wolf', 12]]))].sort(),
  [['Moder', 10], ['The Elder', 55]],
  'mini-bosses and ordinary creatures are not bosses rows',
);
// A "(Clone)" variant lands on the same row, summed rather than racing it.
assert.deepEqual(
  [...bossDamageDeltas(gs([]), gs([['Eikthyr', 100], ['Eikthyr(Clone)', 25]]))],
  [['Eikthyr', 125]],
  'raw keys that resolve to one bosses.name are summed',
);

// ── 3. foldClientDamage: the monotonic union + accumulation ──────────────────
// 3a. A new fighter is added to an empty-fighters row (the Eikthyr incident).
const incident = { fighters: [], onlineAtKill: ['Bren', 'ChÆrleif', 'Lóa'], source: 'gs-milestone' };
const f1 = foldClientDamage(incident, 'ChÆrleif', 201);
assert.deepEqual(f1.fighters, ['ChÆrleif'], 'the damage-dealer becomes a fighter');
assert.deepEqual(f1.damage, { 'ChÆrleif': 201 });
assert.equal(f1.topDamagePlayer, 'ChÆrleif', 'empty verdict slot → we fill it');
assert.equal(f1.topDamage, 201);
assert.equal(f1.topDamageFrom, CLIENT_DAMAGE_SOURCE, 'our verdict is stamped as ours');
assert.equal(f1.source, 'gs-milestone', "an existing row's provenance is never rewritten");
assert.deepEqual(f1.onlineAtKill, ['Bren', 'ChÆrleif', 'Lóa'], 'roster-at-kill preserved');

// 3b. Damage ACCUMULATES across posts and the fighter is not duplicated.
const f2 = foldClientDamage(f1, 'ChÆrleif', 149);
assert.deepEqual(f2.fighters, ['ChÆrleif'], 'union — no duplicate fighter');
assert.deepEqual(f2.damage, { 'ChÆrleif': 350 }, 'deltas accumulate');
assert.equal(f2.topDamage, 350);

// 3c. A second fighter joins; the verdict follows the damage.
const f3 = foldClientDamage(f2, 'Lóa', 800);
assert.deepEqual(f3.fighters, ['ChÆrleif', 'Lóa'], 'fighters grow, order preserved');
assert.deepEqual(f3.damage, { 'ChÆrleif': 350, 'Lóa': 800 });
assert.equal(f3.topDamagePlayer, 'Lóa', 'the harder hitter takes the verdict');
assert.equal(f3.topDamage, 800);

// 3d. Ties break deterministically on name, so a re-post is a genuine no-op.
const tieA = foldClientDamage({ fighters: [] }, 'Bren', 100);
const tieB = foldClientDamage(tieA, 'Astrid', 100);
assert.equal(tieB.topDamagePlayer, 'Astrid', 'equal damage → lowest name, deterministically');

// 3e. AN MVP SUMMARY'S VERDICT IS NEVER OVERWRITTEN — the whole contract.
const mvp = {
  fighters: ['Bjorn Ironside'],
  firstBlood: 'Bjorn Ironside',
  topDamagePlayer: 'Bjorn Ironside',
  topDamage: 3120,
  participants: 2,
  tsUtc: '2026-07-04T18:00:00.0000000Z',
  fightSec: 118,
  source: 'server',
};
const overMvp = foldClientDamage(mvp, 'ChÆrleif', 99_999);
assert.equal(overMvp.topDamagePlayer, 'Bjorn Ironside', 'MVP verdict survives a bigger career delta');
assert.equal(overMvp.topDamage, 3120, "and so does the MVP's number");
assert.equal(overMvp.topDamageFrom, undefined, 'we do not claim a verdict we did not make');
assert.deepEqual(overMvp.fighters, ['Bjorn Ironside', 'ChÆrleif'], 'but the real fighter is still added');
assert.deepEqual(overMvp.damage, { 'ChÆrleif': 99_999 }, 'and the damage is still banked');
// Every MVP scalar is carried through untouched.
for (const k of ['firstBlood', 'participants', 'tsUtc', 'fightSec', 'source']) {
  assert.deepEqual(overMvp[k], mvp[k], `${k} preserved`);
}
// Once an MVP verdict stands, later folds keep standing down.
assert.equal(foldClientDamage(overMvp, 'Lóa', 500_000).topDamagePlayer, 'Bjorn Ironside');

// 3f. Zero / negative / non-finite / nameless → no fold at all (caller skips the write).
for (const bad of [0, -1, NaN, Infinity, undefined, null, '200']) {
  assert.equal(foldClientDamage(incident, 'ChÆrleif', bad), null, `delta ${String(bad)} folds nothing`);
}
assert.equal(foldClientDamage(incident, '   ', 100), null, 'a blank reporter folds nothing');

// 3g. A row with no fight_stats at all gets one, stamped with our provenance.
const fresh = foldClientDamage(null, 'Steve', 277);
assert.equal(fresh.source, CLIENT_DAMAGE_SOURCE, 'a row born of the fallback says so');
assert.deepEqual(fresh.fighters, ['Steve']);

// 3h. Corrupt stored jsonb never poisons the fold (names, damage values).
const corrupt = foldClientDamage(
  { fighters: ['Steve', null, 7, '  ', 'Steve'], damage: { Steve: 'lots', Runa: -5, '': 9, Ulf: 40 } },
  'Steve',
  10,
);
assert.deepEqual(corrupt.fighters, ['Steve'], 'junk fighter entries are dropped, the real one kept once');
assert.deepEqual(corrupt.damage, { Ulf: 40, Steve: 10 }, 'unusable damage entries credit nothing');

// ── 4. Baseline holes: a veteran's lifetime boss damage is NEVER this fight ───
//
// Driven through the REAL ingest pipeline (parse → applyBaseline → mergeIntoRow →
// bossDamageDeltas), i.e. exactly what /api/gs-ingest does, so the claim is about
// the shipped semantics and not about a story told in a test.
const post = (kills, deaths, boss, extra = {}) => ({
  schemaVersion: 1,
  game: 'valheim',
  source: 'client',
  world: 'Eilif',
  reporter: 'Veteran',
  players: [
    {
      name: 'Veteran',
      kills,
      deaths,
      weapons: [],
      creatureKills: [],
      pickups: [],
      materials: [],
      skills: [],
      stats: { vh_Builds: 10, vh_Crafts: 10 },
      ...(boss ? { boss } : {}),
      ...extra,
    },
  ],
});

/** One ingest cycle: returns { row, deltas } exactly as the route computes them. */
function cycle(prevRow, prevBaseline, body, now) {
  const s = parseSelfSnapshot(body);
  const { effective, nextBaseline, deferred } = applyBaseline(s, parseSelfDistances(body), prevBaseline, now);
  if (deferred) return { row: prevRow, baseline: prevBaseline, deltas: new Map(), deferred: true };
  const { row } = mergeIntoRow(prevRow, effective, {
    playerId: 'p1',
    reporter: s.reporter,
    world: s.world,
    now,
    nextBaseline,
  });
  return {
    row,
    baseline: nextBaseline ?? prevBaseline,
    deltas: bossDamageDeltas(prevRow?.gs_stats, row.gs_stats),
    deferred: false,
  };
}

// A veteran arrives carrying 9,000 lifetime damage on Eikthyr from another world.
const c1 = cycle(null, null, post(1526, 163, [{ boss: 'Eikthyr', kills: 1, damageDealt: 9000 }]), '2026-08-28T00:00:00Z');
assert.deepEqual([...c1.deltas], [], 'the zero-point post credits ZERO — a lifetime import is not tonight’s fight');
// …then genuinely fights it here for 201 more.
const c2 = cycle(c1.row, c1.baseline, post(1530, 163, [{ boss: 'Eikthyr', kills: 1, damageDealt: 9201 }]), '2026-08-28T00:02:00Z');
assert.deepEqual([...c2.deltas], [['Eikthyr', 201]], 'only what was earned HERE is credited');
// A re-post of the identical snapshot moves nothing.
const c3 = cycle(c2.row, c2.baseline, post(1530, 163, [{ boss: 'Eikthyr', kills: 1, damageDealt: 9201 }]), '2026-08-28T00:04:00Z');
assert.deepEqual([...c3.deltas], [], 're-posted cumulative snapshot is idempotent');

// BASELINE HOLE: the first payloads carry no boss[] at all, so the group is a
// HOLE — it credits nothing until it first appears, and THAT snapshot is its
// zero-point. A veteran's 9,000 must not land the day boss[] shows up.
const h1 = cycle(null, null, post(1526, 163, null), '2026-08-28T01:00:00Z');
assert.ok((h1.baseline.holes ?? []).includes('counterMaps.bossDamage'), 'absent boss[] is holed, not baselined at 0');
assert.deepEqual([...h1.deltas], [], 'holed group credits nothing');
const h2 = cycle(h1.row, h1.baseline, post(1527, 163, [{ boss: 'Eikthyr', kills: 1, damageDealt: 9000 }]), '2026-08-28T01:02:00Z');
assert.deepEqual([...h2.deltas], [], 'the hole FILLS on first appearance and credits 0 (raw − raw)');
const h3 = cycle(h2.row, h2.baseline, post(1528, 163, [{ boss: 'Eikthyr', kills: 1, damageDealt: 9040 }]), '2026-08-28T01:04:00Z');
assert.deepEqual([...h3.deltas], [['Eikthyr', 40]], 'growth after the fill is credited in full');

// A bystander-derived snapshot is deferred upstream, so it can never fold either.
const bystander = cycle(h3.row, h3.baseline, {
  schemaVersion: 1, game: 'valheim', source: 'client', world: 'Eilif', reporter: 'Veteran',
  players: [{ name: 'Someone Else', kills: 5, deaths: 0, boss: [{ boss: 'Eikthyr', damageDealt: 500 }] }],
}, '2026-08-28T01:06:00Z');
assert.ok(bystander.deferred, 'a snapshot that is not the reporter’s own entry is deferred');
assert.deepEqual([...bystander.deltas], [], 'and therefore credits no boss damage');

console.log('OK — all client-damage fallback assertions passed');
