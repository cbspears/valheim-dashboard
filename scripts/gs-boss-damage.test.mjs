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
  foldObservedDamage,
  CLIENT_DAMAGE_SOURCE,
} from '../lib/boss-damage.ts';
import { applyBaseline, mergeIntoRow } from '../lib/gs-baseline.ts';
import { parseSelfSnapshot, parseSelfDistances, parseObservedBossDamage } from '../lib/gs-client.ts';

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

// ── 5. parseObservedBossDamage: the BYSTANDER half of players[] ──────────────
//
// Valheim computes damage on whichever client OWNS the creature's ZDO, so the
// owner's payload carries EVERY player's blows on that beast — its own in
// players[0] and everyone else's as bystander entries. These are the entries
// ingestPlayerStats deliberately ignores for cumulative columns; their per-boss
// damage is the only record that exists of what the rest of the war party did.
const payload = (reporter, players) => ({
  schemaVersion: 1,
  game: 'valheim',
  source: 'client',
  world: 'Eilif',
  reporter,
  players,
});
const bossRows = (...rows) => rows.map(([boss, damageDealt]) => ({ boss, damageDealt, fightSec: 60 }));

// 5a. The reporter's OWN entry is skipped — case- and whitespace-insensitively,
// the same identity rule findSelfEntry uses. A case skew must not turn the
// reporter into their own bystander and book their damage down BOTH paths.
assert.deepEqual(
  parseObservedBossDamage(
    payload('ChÆrleif', [
      { name: '  chærleif ', boss: bossRows(['Eikthyr', 201]) },
      { name: 'Bren', boss: bossRows(['Eikthyr', 180]) },
      { name: 'Lóa', boss: bossRows(['Eikthyr', 120]) },
    ]),
  ),
  { Eikthyr: { Bren: 180, 'Lóa': 120 } },
  "the reporter's own entry is excluded modulo case/whitespace; the bystanders are read",
);

// 5b. Raw gameObject names map to bosses.name; unmapped creatures are dropped.
assert.deepEqual(
  parseObservedBossDamage(
    payload('ChÆrleif', [
      { name: 'Bren', boss: bossRows(['gd_king', 55], ['Dragon', 10], ['Serpent', 900], ['Troll', 400]) },
    ]),
  ),
  { 'The Elder': { Bren: 55 }, Moder: { Bren: 10 } },
  'mini-bosses and ordinary creatures have no bosses row to fold into',
);

// 5c. Two raw keys resolving to one bosses.name are SUMMED, exactly as the
// reporter-own path collapses them (bossDamageDeltas): the mod keeps a separate
// cumulative bucket per gameObject, so a boss reinstantiated mid-fight leaves two
// independently-growing totals whose sum is the real damage — MAX would silently
// drop the smaller bucket forever.
assert.deepEqual(
  parseObservedBossDamage(payload('ChÆrleif', [{ name: 'Bren', boss: bossRows(['Eikthyr', 100], ['Eikthyr(Clone)', 250]) }])),
  { Eikthyr: { Bren: 350 } },
  '"(Clone)" buckets of one boss are summed, matching the reporter-own path',
);

// 5c-ii. An object-key-poisoning observed name (__proto__ / constructor /
// prototype) is dropped before it can index the accumulator — a hostile client
// must not reparent or shadow the plain-object map, and a real payload never
// carries these anyway.
assert.deepEqual(
  parseObservedBossDamage(
    payload('ChÆrleif', [
      { name: '__proto__', boss: bossRows(['Eikthyr', 500]) },
      { name: 'constructor', boss: bossRows(['Eikthyr', 500]) },
      { name: 'Bren', boss: bossRows(['Eikthyr', 180]) },
    ]),
  ),
  { Eikthyr: { Bren: 180 } },
  'prototype-polluting observed names are dropped, the real bystander survives',
);
assert.equal(({}).Eikthyr, undefined, 'no Object.prototype pollution from the parse');

// 5d. Junk shapes yield {} and never throw — this crosses the wire from a
// closed-source third-party mod.
for (const junk of [null, undefined, {}, 'nope', 42, { players: 'nope' }, { reporter: 'X', players: [null, 7] }]) {
  assert.deepEqual(parseObservedBossDamage(junk), {}, `junk payload ${JSON.stringify(junk) ?? 'undefined'} → {}`);
}
assert.deepEqual(
  parseObservedBossDamage(
    payload('ChÆrleif', [
      { name: '   ', boss: bossRows(['Eikthyr', 500]) },
      { name: 'Bren', boss: 'nope' },
      { name: 'Bren', boss: [null, 7, { boss: 'Eikthyr' }, { boss: 'Eikthyr', damageDealt: '9' }, { boss: '', damageDealt: 5 }] },
      { name: 'Runa', boss: bossRows(['Eikthyr', 0], ['Bonemass', -4]) },
    ]),
  ),
  {},
  'nameless entries, non-array boss[], malformed rows and non-positive damage all credit nothing',
);

// 5e. NO OWN ENTRY AT ALL is not a reason to lose three real fighters — every
// remaining entry is still a genuine observation of someone else.
assert.deepEqual(
  parseObservedBossDamage(
    payload('ChÆrleif', [
      { name: 'Bren', boss: bossRows(['Eikthyr', 180]) },
      { name: 'Lóa', boss: bossRows(['Eikthyr', 120]) },
    ]),
  ),
  { Eikthyr: { Bren: 180, 'Lóa': 120 } },
  "a payload missing the reporter's own entry still yields the bystanders",
);

// ── 6. foldObservedDamage: the per-observer high-water ledger ─────────────────
// 6a. A first observation credits the FULL cumulative — nobody has ever filed a
// reading for these vikings on this boss, so all of it is new.
const seed = { fighters: [], onlineAtKill: ['Bren', 'ChÆrleif', 'Lóa'], source: 'gs-milestone' };
const o1 = foldObservedDamage(seed, 'ChÆrleif', { Bren: 180, 'Lóa': 120 });
assert.deepEqual(o1.fighters, ['Bren', 'Lóa'], 'observed damage-dealers become fighters');
assert.deepEqual(o1.damage, { Bren: 180, 'Lóa': 120 }, 'the full cumulative is credited once');
assert.deepEqual(o1.observed, { 'ChÆrleif': { Bren: 180, 'Lóa': 120 } }, "the observer's ledger records what was seen");
assert.equal(o1.topDamagePlayer, 'Bren', 'empty verdict slot → we fill it');
assert.equal(o1.topDamage, 180);
assert.equal(o1.topDamageFrom, CLIENT_DAMAGE_SOURCE, 'our verdict is stamped as ours');
assert.equal(o1.source, 'gs-milestone', "an existing row's provenance is never rewritten");
assert.deepEqual(o1.onlineAtKill, ['Bren', 'ChÆrleif', 'Lóa'], 'roster-at-kill preserved');

// 6b. The IDENTICAL re-post (every ~120s, forever) folds nothing — null, so the
// route skips the write entirely rather than churning the row.
assert.equal(foldObservedDamage(o1, 'ChÆrleif', { Bren: 180, 'Lóa': 120 }), null, 'a re-posted reading is a true no-op');

// 6c. Growth credits only the DELTA, never the cumulative total again.
const o2 = foldObservedDamage(o1, 'ChÆrleif', { Bren: 250, 'Lóa': 120 });
assert.deepEqual(o2.damage, { Bren: 250, 'Lóa': 120 }, 'only the +70 lands; Lóa is unchanged');
assert.deepEqual(o2.observed['ChÆrleif'], { Bren: 250, 'Lóa': 120 }, 'the high-water mark advances');
assert.deepEqual(o2.fighters, ['Bren', 'Lóa'], 'union — no duplicate fighter');

// 6d. A SMALLER cumulative (a restarted mod, a stale post) folds nothing AND
// must not lower the ledger — lowering it would let the blows between the two
// readings be credited all over again. Proof: the previous max still folds nothing.
assert.equal(foldObservedDamage(o2, 'ChÆrleif', { Bren: 100 }), null, 'a shrunken reading credits nothing');
assert.equal(foldObservedDamage(o2, 'ChÆrleif', { Bren: 250 }), null, 'and the ledger was NOT lowered by it');
assert.deepEqual(
  foldObservedDamage(o2, 'ChÆrleif', { Bren: 251 }).damage,
  { Bren: 251, 'Lóa': 120 },
  'growth past the high-water mark credits exactly the +1 above it',
);

// 6e. TWO observers each report their own share (each blow is recorded by exactly
// one client — the ZDO owner), so their credits SUM per player and their ledgers
// stay separate.
const o3 = foldObservedDamage(o2, 'Lóa', { Bren: 90 });
assert.deepEqual(o3.damage, { Bren: 340, 'Lóa': 120 }, "a second observer's share adds to the first's");
assert.deepEqual(o3.observed, { 'ChÆrleif': { Bren: 250, 'Lóa': 120 }, 'Lóa': { Bren: 90 } }, 'per-observer ledgers');
assert.equal(foldObservedDamage(o3, 'Lóa', { Bren: 90 }), null, "and the second observer's re-post is idempotent too");

// 6f. AN MVP SUMMARY'S VERDICT IS NEVER OVERWRITTEN — the same contract
// foldClientDamage keeps, because this fold goes through it.
const mvpRow = {
  fighters: ['Bjorn Ironside'],
  firstBlood: 'Bjorn Ironside',
  topDamagePlayer: 'Bjorn Ironside',
  topDamage: 3120,
  participants: 2,
  tsUtc: '2026-07-04T18:00:00.0000000Z',
  fightSec: 118,
  source: 'server',
  onlineAtKill: ['Bjorn Ironside', 'Bren'],
};
const overMvpObs = foldObservedDamage(mvpRow, 'ChÆrleif', { Bren: 99_999 });
assert.equal(overMvpObs.topDamagePlayer, 'Bjorn Ironside', 'MVP verdict survives a bigger observed cumulative');
assert.equal(overMvpObs.topDamage, 3120, "and so does the MVP's number");
assert.equal(overMvpObs.topDamageFrom, undefined, 'we do not claim a verdict we did not make');
assert.deepEqual(overMvpObs.fighters, ['Bjorn Ironside', 'Bren'], 'but the observed fighter is still added');
assert.deepEqual(overMvpObs.damage, { Bren: 99_999 }, 'and the damage is still banked');
for (const k of ['firstBlood', 'participants', 'tsUtc', 'fightSec', 'source', 'onlineAtKill']) {
  assert.deepEqual(overMvpObs[k], mvpRow[k], `${k} preserved`);
}

// 6g. Nameless observers and junk readings fold nothing at all.
assert.equal(foldObservedDamage(seed, '   ', { Bren: 100 }), null, 'a blank observer folds nothing');
assert.equal(foldObservedDamage(seed, null, { Bren: 100 }), null, 'a non-string observer folds nothing');
for (const bad of [null, undefined, 'nope', 42, ['Bren', 100]]) {
  assert.equal(foldObservedDamage(seed, 'ChÆrleif', bad), null, `readings ${JSON.stringify(bad) ?? 'undefined'} fold nothing`);
}
assert.equal(foldObservedDamage(seed, 'ChÆrleif', {}), null, 'an empty reading folds nothing');
assert.equal(
  foldObservedDamage(seed, 'ChÆrleif', { '  ': 500, Bren: 0, 'Lóa': -20, Runa: NaN, Ulf: '40' }),
  null,
  'nameless / zero / negative / non-finite / non-numeric readings all credit nothing',
);

// 6g-ii. Object-key-poisoning names — as the OBSERVER or as an observed player —
// fold nothing and, above all, never write onto Object.prototype. This is the
// unauthenticated prototype-pollution vector the security review found: an
// attacker POSTing reporter:'__proto__' reaching `ledger[who] ??= {}`. The shared
// name() gate rejects __proto__ / constructor / prototype for both fold paths.
for (const evil of ['__proto__', 'constructor', 'prototype']) {
  assert.equal(foldObservedDamage(seed, evil, { Bren: 100 }), null, `observer "${evil}" folds nothing`);
  assert.equal(foldObservedDamage(seed, 'ChÆrleif', { [evil]: 500 }), null, `observed player "${evil}" folds nothing`);
  assert.equal(foldClientDamage(seed, evil, 100), null, `foldClientDamage rejects "${evil}" as a fighter`);
}
assert.equal(({}).Bren, undefined, 'no Object.prototype pollution survived the evil-name folds');
assert.equal(({}).polluted, undefined, 'Object.prototype is intact');

// 6h. Corrupt stored ledger jsonb reads as "never seen" rather than poisoning the
// arithmetic — the full cumulative is credited once, and the ledger is rewritten clean.
const corruptLedger = foldObservedDamage(
  { fighters: [], observed: { 'ChÆrleif': { Bren: 'lots', 'Lóa': -5, '': 9 }, '   ': { Bren: 999 }, Runa: 'nope' } },
  'ChÆrleif',
  { Bren: 180 },
);
assert.deepEqual(corruptLedger.damage, { Bren: 180 }, 'an unusable prior reading credits the full cumulative once');
assert.deepEqual(corruptLedger.observed, { 'ChÆrleif': { Bren: 180 } }, 'and the ledger is narrowed to what is usable');

// 6i. WHY THE bossKillEvents WHITELIST MUST CARRY `observed` (route.ts change 4).
// Strip the ledger — as a whitelist rebuild would — and the very same reading is
// credited a second time. This is the one way this feature can inflate a fight.
const stripped = { ...o1, observed: undefined };
assert.deepEqual(
  foldObservedDamage(stripped, 'ChÆrleif', { Bren: 180, 'Lóa': 120 }).damage,
  { Bren: 360, 'Lóa': 240 },
  'a dropped ledger double-credits every observed blow — hence the explicit carry in ingestBossKillEvents',
);

// ── 7. The Eikthyr replay: one payload, both halves of the war party ──────────
//
// The real 2026-08-28 shape. ChÆrleif's client owned Eikthyr, so his single
// payload carried his own 201 points (players[0] → the reporter-own fallback,
// via the baselined gs_stats delta) AND Bren's 180 / Lóa's 120 as bystander
// entries (→ this fold). Before the fix the row ended with fighters:[] and ~300
// of the beast's 500 HP unattributed.
const eikthyrPayload = payload('ChÆrleif', [
  { name: 'ChÆrleif', kills: 40, deaths: 2, boss: bossRows(['Eikthyr', 201]) },
  { name: 'Bren', boss: bossRows(['Eikthyr', 180]) },
  { name: 'Lóa', boss: bossRows(['Eikthyr', 120]) },
]);
const milestoneRow = { fighters: [], onlineAtKill: ['Bren', 'ChÆrleif', 'Lóa'], source: 'gs-milestone' };
// The reporter-own path first (ingestBossDamageDeltas → foldClientDamage), then
// the observed path (ingestObservedBossDamage → foldObservedDamage), exactly as
// /api/gs-ingest runs them for one client post.
const replayOwn = foldClientDamage(milestoneRow, 'ChÆrleif', 201);
const replay = foldObservedDamage(replayOwn, 'ChÆrleif', parseObservedBossDamage(eikthyrPayload).Eikthyr);
assert.deepEqual(replay.fighters, ['ChÆrleif', 'Bren', 'Lóa'], 'the whole war party, not just the reporter');
assert.deepEqual(replay.damage, { 'ChÆrleif': 201, Bren: 180, 'Lóa': 120 }, 'all 501 points attributed');
assert.equal(replay.topDamagePlayer, 'ChÆrleif', 'the hardest hitter takes the verdict');
assert.equal(replay.topDamage, 201);
assert.equal(replay.topDamageFrom, CLIENT_DAMAGE_SOURCE, 'a verdict of ours, still ours to revise');
assert.deepEqual(replay.onlineAtKill, ['Bren', 'ChÆrleif', 'Lóa'], 'roster-at-kill untouched');
assert.equal(replay.source, 'gs-milestone', "and the row's real provenance survives");
// The next ~120s re-post of the identical payload moves nothing on either path.
assert.deepEqual([...bossDamageDeltas(gs([['Eikthyr', 201]]), gs([['Eikthyr', 201]]))], [], 'own path: idempotent');
assert.equal(
  foldObservedDamage(replay, 'ChÆrleif', parseObservedBossDamage(eikthyrPayload).Eikthyr),
  null,
  'observed path: idempotent',
);

console.log('OK — all client-damage fallback assertions passed');
