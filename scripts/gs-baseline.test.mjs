// World-baseline (delta accounting) tests for the GsValheimStatsClient merge.
//
// The bug this guards against: a Valheim character file carries LIFETIME totals
// across every world and server it has ever visited, so an imported veteran used
// to pour thousands of foreign kills / builds / catches into the clan totals the
// moment their mod POSTed. lib/gs-baseline.ts fixes that by making a character's
// FIRST snapshot their zero-point and crediting only what follows.
//
// Run: npx tsx scripts/gs-baseline.test.mjs
import assert from 'node:assert';
import { parseSelfSnapshot, parseSelfDistances } from '../lib/gs-client.ts';
import {
  applyBaseline,
  readBaseline,
  shouldRebaseline,
  captureQualification,
  snapshotHoles,
  mergeIntoRow,
  reconstructRawWeapons,
  needsBaselineMigration,
  isMissingBaselineColumn,
  baseColumnsOnly,
  BASELINE_GROUP_PATHS,
  MIGRATION_REQUIRED,
  POISON_CAPS,
  REBASELINE_CONSECUTIVE,
} from '../lib/gs-baseline.ts';
import { computeAggregates } from '../lib/milestones.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Build a client payload in the exact shape the mod's Emit() produces. */
function payload({
  reporter = 'Chaerlie',
  world = 'Eilif',
  kills = 0,
  deaths = 0,
  bossKills = 0,
  longestLifeSec = 0,
  bestKillsBeforeDeath = 0,
  builds = 0,
  crafts = 0,
  pickups = [],
  weapons = [],
  creatures = [],
  boss = [],
  materials = [],
  skills = [],
  walk = 0,
  run = 0,
  sail = 0,
  air = 0,
} = {}) {
  const total = walk + run + sail + air;
  return {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter,
    world,
    players: [
      {
        name: reporter,
        platformId: 'Steam_76561198000000000',
        kills,
        deaths,
        bossKills,
        longestLifeSec,
        bestKillsBeforeDeath,
        stats: {
          vh_Builds: builds,
          vh_Crafts: crafts,
          vh_DistanceTraveled: total,
          vh_DistanceWalk: walk,
          vh_DistanceRun: run,
          vh_DistanceSail: sail,
          vh_DistanceAir: air,
        },
        weapons,
        creatureKills: creatures,
        boss,
        materials,
        skills,
        pickups,
      },
    ],
  };
}

/** parse + apply a stored baseline, exactly as /api/gs-ingest does. */
function ingest(body, storedBaseline, at = '2026-08-23T12:00:00.000Z') {
  const s = parseSelfSnapshot(body);
  assert.ok(s, 'payload parses');
  return applyBaseline(s, parseSelfDistances(body), storedBaseline, at);
}

/**
 * THE REAL MERGE — the same lib/gs-baseline mergeIntoRow() that /api/gs-ingest
 * upserts with, not a mirror of it.
 *
 * This file used to carry a hand-written re-implementation of the route's merge.
 * Two of the ten defects in the review lived in the parts the copy quietly got
 * right (or quietly got wrong in the same way), which is the whole problem with
 * a mirror: it can only ever prove that the test agrees with itself. Every row
 * assertion below now exercises production code.
 */
function mergeRow(prev, effective, opts = {}) {
  return mergeIntoRow(prev, effective, {
    playerId: 'player-1',
    reporter: 'Chaerlie',
    world: 'Eilif',
    now: '2026-08-23T12:00:00.000Z',
    ...opts,
  }).row;
}

const noSessions = { sessions: [], onlineNames: new Set() };

// ── 1. fresh character: baselines at ~nothing, deltas flow straight through ──

{
  // First post ~2 min into a brand-new character: a couple of kills, a few builds.
  const first = ingest(
    payload({
      reporter: 'Sigrun',
      kills: 2,
      deaths: 1,
      builds: 4,
      crafts: 3,
      pickups: [{ item: 'Wood', count: 20 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 40, kills: 2, hardestHit: 22, biggestSwing: 22 }],
      walk: 300,
    }),
    null,
  );
  assert.equal(first.change, 'capture', 'fresh character captures a zero-point');
  assert.equal(first.effective.kills, 0, 'the baselining post credits nothing');
  assert.equal(first.effective.structuresBuilt, 0);

  const row1 = mergeRow(null, first.effective);
  assert.equal(row1.kills, 0);
  assert.equal(row1.structures_built, 0);

  // An hour later — everything since the zero-point is credited in full.
  const second = ingest(
    payload({
      reporter: 'Sigrun',
      kills: 57,
      deaths: 3,
      builds: 210,
      crafts: 44,
      pickups: [{ item: 'Wood', count: 900 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 5400, kills: 57, hardestHit: 96, biggestSwing: 96 }],
      walk: 12000,
      sail: 4000,
    }),
    first.nextBaseline,
  );
  assert.equal(second.change, null, 'a good baseline is left alone');
  assert.equal(second.effective.kills, 55, '57 − 2 baselined kills');
  assert.equal(second.effective.deaths, 2);
  assert.equal(second.effective.structuresBuilt, 206);
  assert.equal(second.effective.itemsCrafted, 41);
  assert.equal(second.effective.resourcesHarvested, 880);
  assert.equal(second.effective.damageDealt, 5360);
  assert.equal(second.effective.distances.sail, 4000, 'sailing was zero at capture — fully credited');
  assert.equal(second.effective.distances.walk, 11700);
  // A fresh viking loses only the handful of counts in their first ~2 minutes.
  const row2 = mergeRow(row1, second.effective);
  assert.equal(row2.kills, 55);
  assert.equal(row2.gs_stats.records.hardestHit, 96, 'beat the 22 they had at capture');
}

// ── 2. veteran import: the flood is absorbed, then +5 kills means exactly 5 ──

const VETERAN = {
  reporter: 'Chaerlie',
  kills: 1526,
  deaths: 163,
  bossKills: 5,
  longestLifeSec: 54000,
  bestKillsBeforeDeath: 88,
  builds: 27207,
  crafts: 912,
  pickups: [
    { item: 'Wood', count: 40000 },
    { item: 'Fish3', count: 61 },
    { item: 'Fish1', count: 12 },
  ],
  weapons: [
    { weapon: 'Swords', damageDealt: 310000, kills: 1200, hardestHit: 475, biggestSwing: 475 },
    { weapon: 'Bows', damageDealt: 90000, kills: 326, hardestHit: 210, biggestSwing: 240 },
  ],
  creatures: [
    { creature: 'Greydwarf', kills: 900 },
    { creature: 'Draugr', kills: 400 },
  ],
  boss: [{ boss: 'Eikthyr', damageDealt: 24000, fightSec: 900 }],
  materials: [{ material: 'Wood', amount: 40000 }],
  skills: [
    { skill: 'Swords', level: 78 },
    { skill: 'Fishing', level: 62 },
  ],
  walk: 900000,
  run: 240000,
  sail: 410000,
};

const vetFirst = ingest(payload(VETERAN), null);
{
  assert.equal(vetFirst.change, 'capture');
  const e = vetFirst.effective;
  assert.equal(e.kills, 0, '1,526 imported kills contribute nothing');
  assert.equal(e.deaths, 0);
  assert.equal(e.structuresBuilt, 0, '27,207 imported builds contribute nothing');
  assert.equal(e.itemsCrafted, 0);
  assert.equal(e.resourcesHarvested, 0);
  assert.equal(e.damageDealt, 0);
  assert.equal(e.bossKills, 0);
  assert.equal(e.longestLifeSec, 0, 'an imported record is not a record here');
  assert.equal(e.bestKillsBeforeDeath, 0);
  assert.equal(e.distanceTraveled, 0);
  assert.equal(e.distances.sail, 0);
  assert.deepEqual(e.gsStats.fish, [], '73 imported catches contribute nothing');
  assert.deepEqual(e.gsStats.creatureKills, []);
  assert.deepEqual(e.gsStats.bossDamage, []);
  assert.deepEqual(e.gsStats.weapons, []);
  assert.deepEqual(e.gsStats.skills, [], 'imported skill levels stay hidden');
  assert.equal(e.gsStats.records.hardestHit, 0);
  assert.equal(e.gsStats.records.topWeapon, null);
  // Provenance is still captured for ops.
  assert.equal(vetFirst.nextBaseline.counters.kills, 1526);
  assert.equal(vetFirst.nextBaseline.counterMaps.fish.Fish3, 61);
  assert.equal(vetFirst.nextBaseline.recordMaps.weaponHardestHit.Swords, 475);
  assert.equal(vetFirst.nextBaseline.capturedAt, '2026-08-23T12:00:00.000Z');
}

const vetRow1 = mergeRow(null, vetFirst.effective);

const vetSecond = ingest(
  payload({
    ...VETERAN,
    kills: 1531, // +5 kills on Eilif
    weapons: [
      { weapon: 'Swords', damageDealt: 311200, kills: 1205, hardestHit: 475, biggestSwing: 475 },
      { weapon: 'Bows', damageDealt: 90000, kills: 326, hardestHit: 210, biggestSwing: 240 },
    ],
    creatures: [
      { creature: 'Greydwarf', kills: 903 },
      { creature: 'Draugr', kills: 400 },
      { creature: 'Neck', kills: 2 }, // never killed one before -> fully credited
    ],
    pickups: [
      { item: 'Wood', count: 40120 },
      { item: 'Fish3', count: 63 },
      { item: 'Fish1', count: 12 },
      { item: 'Fish9', count: 1 }, // first anglerfish -> fully credited
    ],
    boss: [{ boss: 'Eikthyr', damageDealt: 24000, fightSec: 900 }],
    sail: 412500,
    walk: 900000,
    run: 240000,
  }),
  vetFirst.nextBaseline,
);
{
  const e = vetSecond.effective;
  assert.equal(vetSecond.change, null);
  assert.equal(e.kills, 5, 'exactly the five kills earned here');
  assert.equal(e.deaths, 0);
  assert.equal(e.damageDealt, 1200);
  assert.equal(e.resourcesHarvested, 123, '120 wood + 2 tuna + 1 anglerfish');
  assert.equal(e.distances.sail, 2500);
  assert.equal(e.distances.walk, 0);
  assert.deepEqual(
    e.gsStats.creatureKills,
    [{ creature: 'Greydwarf', kills: 3 }, { creature: 'Neck', kills: 2 }],
    'per-creature deltas; a creature absent from the baseline is fully credited',
  );
  assert.deepEqual(
    e.gsStats.fish,
    [{ item: 'Fish3', count: 2 }, { item: 'Fish9', count: 1 }],
    'per-species catch deltas',
  );
  assert.deepEqual(e.gsStats.weapons, [
    { weapon: 'Swords', damageDealt: 1200, kills: 5, hardestHit: 0, biggestSwing: 0 },
  ]);
  assert.equal(e.gsStats.records.topWeapon, 'Swords');
  assert.equal(e.gsStats.records.topWeaponDamage, 1200);

  const vetRow2 = mergeRow(vetRow1, e);
  assert.equal(vetRow2.kills, 5);
  assert.equal(vetRow2.structures_built, 0);
  assert.equal(vetRow2.gs_stats.distances.sail, 2500);
}

// ── 3. record / max fields: gated on the baseline, never differenced ─────────

{
  const stillShort = ingest(
    payload({ ...VETERAN, longestLifeSec: 54000, bestKillsBeforeDeath: 88 }),
    vetFirst.nextBaseline,
  );
  assert.equal(stillShort.effective.longestLifeSec, 0, 'equalling the imported record is not beating it');
  assert.equal(stillShort.effective.bestKillsBeforeDeath, 0);

  const beaten = ingest(
    payload({
      ...VETERAN,
      longestLifeSec: 54001,
      bestKillsBeforeDeath: 91,
      weapons: [
        { weapon: 'Swords', damageDealt: 320000, kills: 1250, hardestHit: 501, biggestSwing: 475 },
        { weapon: 'Bows', damageDealt: 90000, kills: 326, hardestHit: 210, biggestSwing: 240 },
      ],
      skills: [
        { skill: 'Swords', level: 79 }, // beat 78
        { skill: 'Fishing', level: 62 }, // equal to baseline -> still hidden
      ],
    }),
    vetFirst.nextBaseline,
  );
  assert.equal(beaten.effective.longestLifeSec, 54001, 'a beaten record surfaces at its true value');
  assert.equal(beaten.effective.bestKillsBeforeDeath, 91);
  assert.equal(beaten.effective.gsStats.records.hardestHit, 501, 'hardest hit only once it beats the import');
  assert.equal(beaten.effective.gsStats.records.biggestSwing, 0, 'biggest swing never beaten -> hidden');
  assert.deepEqual(beaten.effective.gsStats.skills, [{ skill: 'Swords', level: 79 }]);

  // And the record columns still GREATEST, so a later worse life can't erase it.
  const row = mergeRow(mergeRow(vetRow1, beaten.effective), stillShort.effective);
  assert.equal(row.longest_life_sec, 54001);
  assert.equal(row.best_kills_before_death, 91);
}

// ── 4. profile reset: re-baseline, keep everything already earned here ───────

{
  // The veteran has earned a real month on Eilif under their baseline.
  let row = mergeRow(vetRow1, vetSecond.effective);
  const earned = ingest(
    payload({
      ...VETERAN,
      kills: 1826,
      deaths: 173,
      builds: 27907,
      crafts: 1012,
      weapons: [
        { weapon: 'Swords', damageDealt: 360000, kills: 1500, hardestHit: 475, biggestSwing: 475 },
        { weapon: 'Bows', damageDealt: 90000, kills: 326, hardestHit: 210, biggestSwing: 240 },
      ],
      pickups: [
        { item: 'Wood', count: 44000 },
        { item: 'Fish3', count: 91 },
        { item: 'Fish1', count: 12 },
      ],
      sail: 460000,
      walk: 900000,
      run: 240000,
    }),
    vetFirst.nextBaseline,
  );
  row = mergeRow(row, earned.effective);
  assert.equal(row.kills, 300, 'earned on Eilif');
  assert.equal(row.structures_built, 700);
  assert.equal(row.gs_stats.distances.sail, 50000);
  assert.equal(row.gs_stats.fish[0].count, 30);

  // Now they delete the character and roll a brand-new one under the same name.
  // A reset is only believed after N CONSECUTIVE low snapshots (see §10) — the
  // first two hold the zero-point and credit nothing.
  const resetPayload = payload({
    reporter: 'Chaerlie',
    kills: 4,
    deaths: 1,
    builds: 6,
    crafts: 2,
    pickups: [{ item: 'Wood', count: 30 }],
    weapons: [{ weapon: 'Clubs', damageDealt: 60, kills: 4, hardestHit: 18, biggestSwing: 18 }],
    walk: 400,
  });
  let stored = vetFirst.nextBaseline;
  let reset;
  for (let i = 1; i <= REBASELINE_CONSECUTIVE; i++) {
    reset = ingest(resetPayload, stored, `2026-09-20T09:0${i}:00.000Z`);
    stored = reset.nextBaseline ?? stored;
    assert.equal(reset.effective.kills, 0, 'no snapshot in a reset streak ever credits anything');
    row = mergeRow(row, reset.effective);
    if (i < REBASELINE_CONSECUTIVE) {
      assert.equal(reset.change, 'reset-pending', `low snapshot ${i} only counts toward the streak`);
      assert.equal(reset.nextBaseline.counters.kills, 1526, 'the zero-point is HELD while the streak builds');
      assert.equal(reset.nextBaseline.pendingReset.count, i, 'the streak counter is persisted in the baseline');
    }
  }
  assert.equal(reset.change, 'rebaseline', 'a collapsed career signature re-zeroes the baseline — after N in a row');
  assert.match(reset.reason, /career signature collapsed/);
  assert.match(reset.reason, /consecutive/);
  assert.equal(reset.nextBaseline.counters.kills, 4, 'new zero-point taken from this snapshot');
  assert.equal(reset.nextBaseline.capturedAt, '2026-09-20T09:03:00.000Z');
  assert.equal(reset.nextBaseline.pendingReset, undefined, 'the streak is consumed by the re-baseline');
  assert.equal(reset.nextBaseline.superseded.counters.kills, 1526, 'the old zero-point is kept as a permanent ceiling');
  assert.equal(reset.effective.kills, 0, 'the re-baselining post credits nothing');

  const after = mergeRow(row, reset.effective);
  assert.equal(after.kills, 300, 'server-earned stats survive a re-baseline');
  assert.equal(after.structures_built, 700);
  assert.equal(after.gs_stats.distances.sail, 50000, 'and so do the deed-feeding distances');
  assert.equal(after.gs_stats.fish[0].count, 30);

  // The new character then plays — and here the PERMANENT CEILING (§12) shows
  // its cost, deliberately. 504 raw kills is still far below the 1,526 the
  // superseded zero-point holds, and from the raw numbers alone that is
  // indistinguishable from the ORIGINAL character's stale save climbing back.
  // So it credits nothing. This is the accepted trade: the columns already hold
  // everything the NAME earned here (300 kills), so nothing visible is lost.
  const afterReset = ingest(
    payload({
      reporter: 'Chaerlie',
      kills: 504,
      deaths: 9,
      builds: 106,
      crafts: 52,
      pickups: [{ item: 'Wood', count: 3030 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 40060, kills: 504, hardestHit: 300, biggestSwing: 300 }],
      walk: 400,
    }),
    reset.nextBaseline,
  );
  assert.equal(afterReset.effective.kills, 0, 'below the superseded ceiling, a "recovery" credits nothing');
  assert.equal(mergeRow(after, afterReset.effective).kills, 300, 'and the columns keep what the name really earned');

  // Past the ceiling, growth is credited from the ceiling — never double-counted.
  const past = ingest(
    payload({
      reporter: 'Chaerlie',
      kills: 1600,
      deaths: 20,
      builds: 27400,
      crafts: 1000,
      pickups: [{ item: 'Wood', count: 41000 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 90000, kills: 1600, hardestHit: 300, biggestSwing: 300 }],
      walk: 400,
    }),
    reset.nextBaseline,
  );
  assert.equal(past.effective.kills, 74, '1,600 − the 1,526 ceiling, not 1,596 from the dip');
  assert.equal(past.effective.structuresBuilt, 193, '27,400 − the 27,207 ceiling');

  // A ceiling only exists for keys the superseded zero-point actually held. The
  // re-rolled character's brand-new weapon has none, so it accrues from its own
  // zero-point immediately — no second lifetime of grinding required.
  assert.equal(
    afterReset.effective.gsStats.weapons.find((w) => w.weapon === 'Clubs')?.damageDealt,
    40000,
    "a key the old career never had is credited normally (Clubs: 40,060 − the re-roll's own 60)",
  );
}

// ── 5. the re-baseline rule itself ──────────────────────────────────────────

{
  const base = vetFirst.nextBaseline;
  const sig = (p) => shouldRebaseline(parseSelfSnapshot(payload(p)), base);

  // Half of the baselined signature is not a reset (a counter can stall, never fall).
  assert.equal(sig({ ...VETERAN }).reset, false, 'unchanged career is not a reset');
  assert.equal(sig({ ...VETERAN, kills: 1526, deaths: 163 }).reset, false);
  // A partial dip stays above the 50% floor -> not a reset.
  assert.equal(
    sig({ ...VETERAN, kills: 1000, pickups: [{ item: 'Wood', count: 39000 }] }).reset,
    false,
    'a dip that leaves the career recognizable is not a reset',
  );
  // A genuine wipe is.
  assert.equal(sig({ reporter: 'Chaerlie', kills: 0, deaths: 0 }).reset, true);

  // Tiny baselines are never tested proportionally (a fresh viking's first
  // minutes must not look like a wipe on the next snapshot).
  const tiny = ingest(payload({ reporter: 'Ulf', kills: 1, deaths: 0, builds: 2 }), null);
  const tinyCheck = shouldRebaseline(parseSelfSnapshot(payload({ reporter: 'Ulf', kills: 0 })), tiny.nextBaseline);
  assert.equal(tinyCheck.reset, false, 'baseline below the floor is never re-baselined');
}

// ── 6. the deed metrics: a veteran's lifetime fish must not count ────────────
//
// fish_total / sail_total / walk_run_total feed the Great Deeds ladder straight
// off these rows (lib/milestones computeAggregates), so verify against the real
// evaluator rather than trusting the shape.

{
  const rookieFirst = ingest(
    payload({ reporter: 'Sigrun', kills: 0, pickups: [{ item: 'Fish1', count: 0 }], walk: 10 }),
    null,
  );
  const rookieRow = mergeRow(null, rookieFirst.effective);
  const rookieSecond = ingest(
    payload({
      reporter: 'Sigrun',
      kills: 3,
      pickups: [{ item: 'Fish1', count: 7 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 300, kills: 3, hardestHit: 40, biggestSwing: 40 }],
      walk: 5010,
      sail: 2000,
    }),
    rookieFirst.nextBaseline,
  );
  const rookie = mergeRow(rookieRow, rookieSecond.effective);

  const veteran = mergeRow(vetRow1, vetSecond.effective);

  const agg = computeAggregates({ stats: [rookie, veteran], ...noSessions });
  assert.equal(agg.fish_total, 10, "7 rookie catches + the veteran's 3 landed here, not their imported 73");
  assert.equal(agg.sail_total, 4500, '2,000 rookie + 2,500 veteran metres sailed here, not 410,000 imported');
  assert.equal(agg.walk_run_total, 5000, 'imported 1.14 Mm on foot excluded');
  assert.equal(agg.kills_total, 8);
  assert.equal(agg.builds_total, 0);
  assert.equal(agg.deaths_total, 0);

  // The un-baselined shape of the same two snapshots is what used to land — the
  // regression this whole feature exists to prevent.
  const flooded = computeAggregates({
    stats: [
      { ...veteran, kills: 1531, gs_stats: { ...veteran.gs_stats, fish: [{ item: 'Fish3', count: 63 }] } },
      rookie,
    ],
    ...noSessions,
  });
  assert.ok(flooded.fish_total > agg.fish_total * 5, 'sanity: the unbaselined numbers really are a flood');
}

// ── 7. legacy row with no baseline yet (today's un-wiped rows) ───────────────

{
  // A row already carrying pre-baseline lifetime values, posting for the first
  // time under the new regime: it gets a baseline, credits nothing, and — this
  // is the part that matters — loses nothing it already had.
  const legacyRow = {
    kills: 1526,
    deaths: 163,
    structures_built: 27207,
    items_crafted: 912,
    resources_harvested: 40073,
    damage_dealt: 400000,
    distance_traveled: 1550000,
    boss_kills: 5,
    longest_life_sec: 54000,
    best_kills_before_death: 88,
    gs_stats: {
      fish: [{ item: 'Fish3', count: 61 }],
      distances: { total: 1550000, walk: 900000, run: 240000, sail: 410000, air: 0 },
      records: { topWeapon: 'Swords', topWeaponDamage: 310000, hardestHit: 475, biggestSwing: 475 },
    },
  };
  const first = ingest(payload(VETERAN), undefined);
  assert.equal(first.change, 'capture', 'a missing baseline is captured on the next post');
  const merged = mergeRow(legacyRow, first.effective);
  assert.equal(merged.kills, 1526, 'legacy values are preserved, not zeroed');
  assert.equal(merged.structures_built, 27207);
  assert.equal(merged.longest_life_sec, 54000);
  assert.deepEqual(merged.gs_stats.fish, [{ item: 'Fish3', count: 61 }], 'the richer blob is kept, not blanked');
  assert.equal(merged.gs_stats.distances.sail, 410000, 'and the distance floor holds');
}

// ── 8. defensive: malformed baselines never throw, never credit lifetimes ────

{
  for (const junk of [
    undefined,
    null,
    'nonsense',
    42,
    [],
    {},
    { v: 99, counters: { kills: 5 } },
    { v: 1 },
    { v: 1, counters: 'nope' },
    { v: 1, counters: null },
  ]) {
    assert.equal(readBaseline(junk), null, `unreadable baseline rejected: ${JSON.stringify(junk)}`);
    const r = ingest(payload(VETERAN), junk);
    assert.equal(r.change, 'capture');
    assert.equal(r.effective.kills, 0, 'an unreadable baseline credits zero, never the lifetime total');
    assert.equal(r.effective.structuresBuilt, 0);
    assert.deepEqual(r.effective.gsStats.fish, []);
  }

  // A readable baseline with holes in it: the missing fields are repaired from
  // this snapshot (crediting zero for them) and the intact ones keep working.
  const holed = {
    v: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    counters: { kills: 1526, deaths: 163, damageDealt: 400000 }, // no builds/crafts/resources/distance
    // counterMaps missing entirely -> must NOT be read as "never caught a fish"
    records: { longestLifeSec: 54000 },
  };
  const r = ingest(payload({ ...VETERAN, kills: 1530 }), holed);
  assert.equal(r.change, 'repair');
  assert.match(r.reason, /counters\.structuresBuilt/);
  assert.equal(r.effective.kills, 4, 'the intact counter still credits its real delta');
  assert.equal(r.effective.structuresBuilt, 0, 'a hole credits zero, not 27,207');
  assert.equal(r.effective.itemsCrafted, 0);
  assert.equal(r.effective.resourcesHarvested, 0);
  assert.equal(r.effective.distanceTraveled, 0);
  assert.deepEqual(r.effective.gsStats.fish, [], 'a missing counterMap credits zero, not 73 catches');
  assert.equal(r.effective.bestKillsBeforeDeath, 0, 'a missing record gate suppresses, not surfaces');
  assert.equal(r.nextBaseline.counters.structuresBuilt, 27207, 'the hole is filled for next time');
  assert.equal(r.nextBaseline.counters.kills, 1526, 'the intact zero-point is untouched');

  // Non-numeric junk inside an otherwise fine baseline. The distinction that
  // matters: a key PRESENT but corrupt credits zero (it is a broken zero-point,
  // not evidence of a fresh start), while a key genuinely ABSENT from a present
  // map is fully credited (the character had none of that thing at capture).
  const dirty = {
    v: 1,
    counters: { kills: 'lots', deaths: 163 },
    counterMaps: { fish: { Fish3: 'many' }, creatureKills: { Greydwarf: 900 } },
    recordMaps: { weaponHardestHit: null },
    records: {},
  };
  const d = ingest(payload(VETERAN), dirty);
  assert.equal(d.change, 'repair');
  assert.equal(d.effective.kills, 0, 'a non-numeric baseline counter credits zero, not 1,526');
  assert.equal(d.effective.deaths, 0);
  assert.equal(d.effective.resourcesHarvested, 0, 'a missing counter credits zero');
  assert.equal(d.effective.longestLifeSec, 0, 'an empty records block suppresses, not surfaces');
  assert.equal(d.effective.gsStats.records.hardestHit, 0, 'a null record map is refilled, not trusted');
  assert.deepEqual(
    d.effective.gsStats.fish,
    [{ item: 'Fish1', count: 12 }],
    'corrupt Fish3 entry credits zero; Fish1 (absent from a present map) is fully credited',
  );
  assert.equal(
    d.effective.gsStats.creatureKills.find((c) => c.creature === 'Draugr')?.kills,
    400,
    'a key genuinely absent from a present map is still fully credited',
  );
  assert.equal(d.nextBaseline.counters.kills, 1526, 'the corrupt entry is rewritten from this snapshot');
  assert.equal(d.nextBaseline.counterMaps.fish.Fish3, 61);
  assert.equal(d.nextBaseline.unusable, undefined, 'in-memory bookkeeping is never persisted');
}

// ── 9. an empty / non-self payload is still refused upstream ────────────────

assert.equal(parseSelfSnapshot({ players: [] }), null);

// ── 10. THE CAPTURE GATE: only a complete OWN snapshot may seed a zero-point ─
//
// The Chærlie flood, reproduced straight THROUGH the fix: baseline a field at 0
// because the payload never carried it, and the next complete snapshot's
// lifetime total is credited in full.

{
  // (a) the reporter's own entry is missing — only a bystander was observed.
  const bystanderOnly = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Chaerlie',
    world: 'Eilif',
    players: [{ name: 'Bjorn', deaths: 2, kills: 7 }],
  };
  const parsed = parseSelfSnapshot(bystanderOnly);
  assert.equal(parsed.reporter, 'Chaerlie', 'the row would be keyed to the reporter…');
  assert.equal(parsed.provenance.ownEntry, false, '…but the numbers came from a bystander');
  const q = captureQualification(parsed);
  assert.equal(q.ok, false);
  assert.match(q.missing.join('; '), /bystander/);

  const cap = applyBaseline(parsed, parseSelfDistances(bystanderOnly), null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'defer', 'a bystander-derived snapshot never becomes a zero-point');
  assert.equal(cap.deferred, true);
  assert.equal(cap.nextBaseline, null, 'and nothing at all is persisted');
  assert.equal(cap.effective.kills, 0, 'nor is anything credited from it');
  assert.deepEqual(cap.effective.gsStats.fish, []);
  assert.equal(cap.effective.distances, null, 'null distances leave the stored per-mode floors untouched');

  // The veteran finally spawns and posts a complete snapshot: THAT is the
  // zero-point, and it credits nothing.
  const first = ingest(payload(VETERAN), cap.nextBaseline);
  assert.equal(first.change, 'capture');
  assert.equal(first.effective.kills, 0, '1,526 imported kills still credit nothing');
  assert.equal(first.effective.structuresBuilt, 0);
  assert.equal(first.effective.distanceTraveled, 0);
  assert.equal(first.effective.distances.sail, 0);
  assert.deepEqual(first.effective.gsStats.fish, []);
}

{
  // (b) an own entry, but the payload carries no vh_Distance* keys at all.
  // Baselining distance at 0 here is what put 410 km sailed on another server
  // onto the Great Deeds ladder.
  const noDistance = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Chaerlie',
    world: 'Eilif',
    players: [
      {
        name: 'Chaerlie',
        kills: 1526,
        deaths: 163,
        stats: { vh_Builds: 27207, vh_Crafts: 912 }, // no vh_Distance*
        pickups: [{ item: 'Wood', count: 40000 }],
        weapons: [],
        creatureKills: [],
        boss: [],
        materials: [],
        skills: [],
      },
    ],
  };
  const s = parseSelfSnapshot(noDistance);
  assert.equal(s.provenance.ownEntry, true);
  assert.equal(s.provenance.hasDistance, false);
  assert.equal(parseSelfDistances(noDistance), null, 'nothing usable to read → the distance presence signal is null');

  // It CAPTURES (the gate no longer demands distance — that muted real players),
  // and distance is recorded as a HOLE instead of being baselined at 0.
  const cap = applyBaseline(s, parseSelfDistances(noDistance), null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'capture');
  for (const path of ['counters.distanceTraveled', 'counterMaps.distances', 'counterMaps.distancesRaw']) {
    assert.ok(cap.nextBaseline.holes.includes(path), `${path} is named as a hole, not zeroed`);
  }
  assert.equal(cap.nextBaseline.counters.distanceTraveled, undefined, 'and no filler 0 is stored for them');
  assert.equal(cap.nextBaseline.counterMaps.distances, undefined);
  assert.equal(cap.nextBaseline.counters.kills, 1526, 'everything the payload DID carry is baselined normally');

  const row1 = mergeRow(null, cap.effective, { nextBaseline: cap.nextBaseline });
  assert.equal(row1.distance_traveled, 0);
  assert.equal(row1.gs_stats.distances, undefined, 'a holed distance writes no per-mode floor at all');

  // The next snapshot DOES carry distance: the hole fills from it, so the 1.55 Mm
  // carried in from elsewhere is the new zero-point and credits nothing.
  const full = ingest(payload(VETERAN), cap.nextBaseline);
  assert.equal(full.change, 'repair');
  assert.match(full.reason, /first sighting of .*counters\.distanceTraveled/);
  assert.equal(full.effective.distanceTraveled, 0, '1.55 Mm carried in from elsewhere credits nothing');
  assert.equal(full.nextBaseline.holes, undefined, 'the hole is gone once filled');
  assert.equal(full.nextBaseline.counters.distanceTraveled, 1550000);
  const row2 = mergeRow(row1, full.effective);
  const agg = computeAggregates({ stats: [row2], sessions: [], onlineNames: new Set() });
  assert.equal(agg.sail_total, 0, '410,000 imported metres stay off the Great Deeds ladder');
  assert.equal(agg.walk_run_total, 0);

  // …and genuine sailing afterwards is credited in full.
  const sailed = ingest(payload({ ...VETERAN, sail: 412500 }), full.nextBaseline);
  const row3 = mergeRow(row2, sailed.effective);
  assert.equal(
    computeAggregates({ stats: [row3], sessions: [], onlineNames: new Set() }).sail_total,
    2500,
    'the 2,500 m actually sailed here still counts',
  );
}

{
  // (c) THE GATE IS SHORT ON PURPOSE. It asks for the reporter's own entry plus
  // kills and deaths, and nothing else — every other absence is a hole, because
  // `defer` writes NOTHING and a hard requirement is therefore a way to mute a
  // real player forever (a fisher has no vh_Builds; the mod's own canonical
  // payload has no vh_Distance*).
  const base = {
    name: 'Chaerlie',
    kills: 10,
    deaths: 1,
    stats: { vh_Builds: 5, vh_Crafts: 3, vh_DistanceTraveled: 100 },
    pickups: [],
    weapons: [],
    creatureKills: [],
    boss: [],
    materials: [],
    skills: [],
  };
  const wrap = (self) => ({ schemaVersion: 1, game: 'valheim', source: 'client', reporter: 'Chaerlie', world: 'Eilif', players: [self] });
  assert.equal(captureQualification(parseSelfSnapshot(wrap(base))).ok, true, 'a complete own snapshot qualifies');

  const drop = (mut) => {
    const self = structuredClone(base);
    mut(self);
    const body = wrap(self);
    const parsed = parseSelfSnapshot(body);
    return {
      qual: captureQualification(parsed),
      holes: snapshotHoles(parsed, parseSelfDistances(body)),
      result: applyBaseline(parsed, parseSelfDistances(body), null, '2026-08-23T12:00:00.000Z'),
    };
  };

  // Only these two defer.
  assert.match(drop((s) => delete s.kills).qual.missing.join(), /kills/);
  assert.match(drop((s) => delete s.deaths).qual.missing.join(), /deaths/);
  // Junk is not presence: a null/string counter is as absent as a missing key.
  assert.match(drop((s) => (s.kills = null)).qual.missing.join(), /kills/);
  assert.equal(drop((s) => (s.kills = null)).result.change, 'defer');

  // Everything else CAPTURES, with the absent group named as a hole.
  const holeCases = [
    [(s) => delete s.stats.vh_Builds, 'counters.structuresBuilt'],
    [(s) => delete s.stats.vh_Crafts, 'counters.itemsCrafted'],
    [(s) => delete s.pickups, 'counters.resourcesHarvested'],
    [(s) => delete s.pickups, 'counterMaps.fish'],
    [(s) => delete s.weapons, 'counters.damageDealt'],
    [(s) => delete s.weapons, 'counterMaps.weaponDamage'],
    [(s) => delete s.weapons, 'recordMaps.weaponHardestHit'],
    [(s) => delete s.creatureKills, 'counterMaps.creatureKills'],
    [(s) => delete s.boss, 'counterMaps.bossDamage'],
    [(s) => delete s.materials, 'counterMaps.materials'],
    [(s) => delete s.skills, 'recordMaps.skills'],
    [(s) => delete s.bossKills, 'counters.bossKills'],
    [(s) => delete s.longestLifeSec, 'records.longestLifeSec'],
    [(s) => delete s.bestKillsBeforeDeath, 'records.bestKillsBeforeDeath'],
    [(s) => delete s.stats, 'counters.structuresBuilt'],
    [(s) => (s.stats.vh_Builds = 'lots'), 'counters.structuresBuilt'],
    [(s) => delete s.stats.vh_DistanceTraveled, 'counters.distanceTraveled'],
  ];
  for (const [mut, path] of holeCases) {
    const { qual, holes, result } = drop(mut);
    assert.equal(qual.ok, true, `${path}: an absent group must not defer the whole snapshot`);
    assert.ok(holes.includes(path), `${path}: recorded as a hole`);
    assert.equal(result.change, 'capture');
    assert.ok(result.nextBaseline.holes.includes(path));
  }
  // Every hole path the module can emit is a recognized group.
  for (const [mut] of holeCases) {
    for (const h of drop(mut).holes) assert.ok(BASELINE_GROUP_PATHS.has(h), `${h} is a known group`);
  }

  // Genuine zeros / empty lists ARE presence — a brand-new viking baselines at
  // zero and is credited from their very first metre, with no holes at all.
  const rookieBody = wrap({
    ...structuredClone(base),
    kills: 0,
    deaths: 0,
    bossKills: 0,
    longestLifeSec: 0,
    bestKillsBeforeDeath: 0,
    stats: { vh_Builds: 0, vh_Crafts: 0, vh_DistanceTraveled: 0, vh_DistanceWalk: 0, vh_DistanceRun: 0, vh_DistanceSail: 0, vh_DistanceAir: 0 },
  });
  const rookie = parseSelfSnapshot(rookieBody);
  assert.equal(captureQualification(rookie).ok, true, 'all-zero but complete is a perfectly good zero-point');
  assert.deepEqual(snapshotHoles(rookie, parseSelfDistances(rookieBody)), [], 'present-and-zero is a reading, never a hole');
}

// ── 11. crafts source: capture and delta must difference like against like ───

{
  const withProfileCounter = payload({ reporter: 'Sigrun', kills: 5, crafts: 400, builds: 10, walk: 50 });
  const s1 = parseSelfSnapshot(withProfileCounter);
  assert.equal(s1.provenance.craftsSource, 'vh_Crafts');
  const cap = applyBaseline(s1, parseSelfDistances(withProfileCounter), null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.nextBaseline.craftsSource, 'vh_Crafts', 'the source is recorded with the zero-point');

  // Same character, next snapshot: vh_Crafts has gone missing and the parser
  // falls back to summing crafts[] — a DIFFERENT quantity that happens to read
  // HIGHER (460), so a naive subtraction would invent 60 crafts out of nothing.
  const summed = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Sigrun',
    world: 'Eilif',
    players: [
      {
        name: 'Sigrun',
        kills: 5,
        deaths: 0,
        // Complete but for vh_Crafts, so this block is about the crafts SOURCE
        // and nothing else (an absent scalar here would only add hole-fills).
        bossKills: 0,
        longestLifeSec: 0,
        bestKillsBeforeDeath: 0,
        stats: {
          vh_Builds: 10,
          vh_DistanceTraveled: 50,
          vh_DistanceWalk: 50,
          vh_DistanceRun: 0,
          vh_DistanceSail: 0,
          vh_DistanceAir: 0,
        }, // no vh_Crafts
        crafts: [{ item: 'ArrowWood', count: 460 }],
        pickups: [],
        weapons: [],
        creatureKills: [],
        boss: [],
        materials: [],
        skills: [],
      },
    ],
  };
  const s2 = parseSelfSnapshot(summed);
  assert.equal(s2.provenance.craftsSource, 'crafts');
  assert.equal(s2.itemsCrafted, 460);
  const next = applyBaseline(s2, parseSelfDistances(summed), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.equal(next.change, null, 'this is not a reset — the career is intact');
  assert.equal(next.effective.itemsCrafted, 0, 'unlike sources credit zero, never a fabricated 60');

  // The reverse direction (crafts[]-baselined, vh_Crafts snapshot) must not
  // invent 440 crafts either.
  const capSummed = applyBaseline(s2, parseSelfDistances(summed), null, '2026-08-23T12:00:00.000Z');
  assert.equal(capSummed.nextBaseline.craftsSource, 'crafts');
  const bigProfile = payload({ reporter: 'Sigrun', kills: 5, crafts: 900, builds: 10, walk: 50 });
  const s3 = parseSelfSnapshot(bigProfile);
  assert.equal(s3.provenance.craftsSource, 'vh_Crafts');
  const back = applyBaseline(s3, parseSelfDistances(bigProfile), capSummed.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(back.change, null);
  assert.equal(back.effective.itemsCrafted, 0, '900 − 460 is not a delta, it is two different quantities');

  // Matching sources still credit normally.
  const grew = payload({ reporter: 'Sigrun', kills: 5, crafts: 460, builds: 10, walk: 50 });
  const ok = applyBaseline(parseSelfSnapshot(grew), parseSelfDistances(grew), cap.nextBaseline, '2026-08-23T12:06:00.000Z');
  assert.equal(ok.effective.itemsCrafted, 60);

  // vh_Crafts present and ZERO is still vh_Crafts (the old `||` fallback made a
  // zero profile counter silently switch source mid-career).
  const zeroCrafts = {
    ...summed,
    players: [{ ...summed.players[0], stats: { vh_Builds: 10, vh_Crafts: 0, vh_DistanceTraveled: 50 } }],
  };
  const zeroed = parseSelfSnapshot(zeroCrafts);
  assert.equal(zeroed.provenance.craftsSource, 'vh_Crafts');
  assert.equal(zeroed.itemsCrafted, 0, 'the authoritative counter wins even when it reads 0');
}

// ── 12. a transient dip must not lower the zero-point (N-in-a-row) ──────────

{
  const cap = ingest(payload(VETERAN), null, '2026-08-23T12:00:00.000Z');
  let row = mergeRow(null, cap.effective);
  assert.equal(row.kills, 0);

  // ONE anomalous snapshot: a stale cloud save / a second PC holding an older
  // copy of the character. This used to re-baseline immediately.
  const stale = ingest(
    payload({ ...VETERAN, kills: 400, deaths: 40, builds: 6000, crafts: 200, pickups: [{ item: 'Wood', count: 9000 }] }),
    cap.nextBaseline,
    '2026-08-23T12:02:00.000Z',
  );
  assert.equal(stale.change, 'reset-pending', 'one low snapshot is a suspicion, not a verdict');
  assert.equal(stale.nextBaseline.counters.kills, 1526, 'the zero-point is NOT lowered');
  assert.equal(stale.nextBaseline.pendingReset.count, 1);
  assert.equal(stale.effective.kills, 0);
  row = mergeRow(row, stale.effective);

  // Two minutes later the real character is back.
  const back = ingest(payload(VETERAN), stale.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(back.change, 'reset-cleared', 'the streak is void once the career returns');
  assert.equal(back.nextBaseline.pendingReset, undefined);
  assert.equal(back.effective.kills, 0, 'the bounce-back is not "1,126 kills earned in two minutes"');
  assert.equal(back.effective.structuresBuilt, 0);
  assert.equal(back.effective.resourcesHarvested, 0);
  row = mergeRow(row, back.effective);
  assert.equal(row.kills, 0, 'nothing foreign reached the columns');
  assert.equal(row.structures_built, 0);
  assert.equal(row.resources_harvested, 0);
}

{
  // A suspected reset must not fill a HOLE in the stored zero-point from its own
  // (possibly foreign) numbers — nor credit that hole in full for lack of a
  // repair. Both roads lead back to crediting a lifetime total, so a snapshot
  // under suspicion is trusted for nothing at all until the verdict.
  const holed = {
    v: 1,
    capturedAt: '2026-08-23T12:00:00.000Z',
    counters: { kills: 1526, deaths: 163, itemsCrafted: 912, structuresBuilt: 27207, resourcesHarvested: 40061 },
    // no counters.distanceTraveled, and counterMaps missing entirely
    records: {},
  };
  const dip = ingest(
    payload({ ...VETERAN, kills: 400, deaths: 40, builds: 6000, crafts: 200, pickups: [{ item: 'Wood', count: 9000 }], walk: 4000 }),
    holed,
    '2026-08-23T12:02:00.000Z',
  );
  assert.equal(dip.change, 'reset-pending');
  assert.equal(dip.effective.distanceTraveled, 0, 'a hole is not credited from a suspect snapshot');
  assert.equal(dip.effective.kills, 0);
  assert.deepEqual(dip.effective.gsStats.fish, []);
  assert.equal(dip.nextBaseline.counters.distanceTraveled, undefined, 'nor is the hole filled from it');
  assert.equal(dip.nextBaseline.counterMaps.distances, undefined);

  // When the real career returns, the hole is repaired from a snapshot that
  // actually belongs to it — costing that field one cycle, not a lifetime.
  const back = ingest(payload(VETERAN), dip.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(back.change, 'repair');
  assert.equal(back.effective.distanceTraveled, 0, 'the repair cycle credits zero, not 1.55 Mm');
  assert.equal(back.nextBaseline.counters.distanceTraveled, 1550000);
  assert.equal(back.nextBaseline.pendingReset, undefined, 'and the streak is cleared alongside');
}

// ── 12b. the superseded zero-point is a PERMANENT PER-COUNTER CEILING ────────
//
// A dip that lasts long enough to re-baseline, then recovers anyway. The old
// guard was a 7-day window on the SUMMED career signature, and both halves
// leaked:
//   • ALL-OR-NOTHING — a recovery one count short of the summed signature
//     re-adopted nothing and credited 1,100 kills / 21,000 builds in full;
//   • EXPIRING — a hobby server's stale save that came back EIGHT days later
//     credited the whole 1,126-kill import straight into the columns.
// The ceiling has no threshold to fall short of and no clock to outlast:
// zero-point_k = max(active_k, min(superseded_k, raw_k)), per counter, forever.

{
  const cap = ingest(payload(VETERAN), null, '2026-08-23T12:00:00.000Z');
  const low = payload({ ...VETERAN, kills: 400, deaths: 40, builds: 6000, crafts: 200, pickups: [{ item: 'Wood', count: 9000 }] });
  let stored = cap.nextBaseline;
  let r;
  for (let i = 1; i <= REBASELINE_CONSECUTIVE; i++) {
    r = ingest(low, stored, `2026-08-23T12:0${i}:00.000Z`);
    stored = r.nextBaseline ?? stored;
  }
  assert.equal(r.change, 'rebaseline');
  assert.equal(stored.counters.kills, 400, 'the zero-point did move, after three straight lows');
  assert.equal(stored.superseded.counters.kills, 1526, 'and the one it replaced is kept as the ceiling');

  // (a) FULL recovery, minutes later.
  const recovered = ingest(payload(VETERAN), stored, '2026-08-23T12:30:00.000Z');
  assert.equal(recovered.effective.kills, 0, '1,126 kills of "recovery" are not credited');
  assert.equal(recovered.effective.structuresBuilt, 0);
  assert.equal(recovered.effective.resourcesHarvested, 0);
  assert.equal(recovered.effective.damageDealt, 0, 'the ceiling is structure-wise, so counter MAPS hold too');
  assert.deepEqual(recovered.effective.gsStats.creatureKills, []);
  assert.deepEqual(recovered.effective.gsStats.fish, []);
  assert.deepEqual(recovered.effective.gsStats.skills, [], 'and record maps: Fishing 62 stays off the Anglers board');
  assert.equal(recovered.effective.longestLifeSec, 0, 'a superseded record is a threshold too');
  assert.equal(mergeRow(null, recovered.effective).kills, 0, 'nothing foreign reaches the columns');

  // Real progress ON TOP of the ceiling still lands, measured from the ceiling.
  const later = ingest(payload({ ...VETERAN, kills: 1600 }), recovered.nextBaseline ?? stored, '2026-08-23T13:00:00.000Z');
  assert.equal(later.effective.kills, 74, '1,600 − 1,526, never 1,600 − 400');

  // (b) PARTIAL recovery — the case the summed-signature guard missed entirely.
  // Raw lands between the dip and the superseded zero-point, so the old rule saw
  // "not a re-adopt" and credited the whole climb.
  const partial = ingest(
    payload({ ...VETERAN, kills: 1500, deaths: 160, builds: 27000, crafts: 900, pickups: [{ item: 'Wood', count: 39000 }] }),
    stored,
    '2026-08-23T12:30:00.000Z',
  );
  assert.equal(partial.effective.kills, 0, 'a partial recovery is still a recovery — 1,100 kills credit nothing');
  assert.equal(partial.effective.structuresBuilt, 0, 'nor do 21,000 builds');
  assert.equal(partial.effective.resourcesHarvested, 0);

  // (c) EIGHT DAYS later — the expiry that made the guard a formality (adv4).
  const eightDays = new Date(Date.parse('2026-08-23T12:00:00.000Z') + 8 * 24 * 60 * 60_000).toISOString();
  const late = ingest(payload(VETERAN), stored, eightDays);
  assert.equal(late.effective.kills, 0, 'no clock to outlast: the ceiling holds at any distance in time');
  assert.equal(late.effective.structuresBuilt, 0);
  assert.equal(late.effective.damageDealt, 0);
  assert.equal(late.effective.distanceTraveled, 0);
  assert.deepEqual(late.effective.gsStats.materials, [], 'and the material blob stays empty too');

  // (d) A SECOND re-baseline merges the ceiling per key rather than keeping one
  // of them — a summed comparison can be higher overall while being lower on the
  // very counter a bounce-back exploits.
  let s2 = stored;
  const lower = payload({ reporter: 'Chaerlie', kills: 2, deaths: 0, builds: 3, crafts: 1, pickups: [{ item: 'Wood', count: 5 }], walk: 10 });
  for (let i = 1; i <= REBASELINE_CONSECUTIVE; i++) {
    // First push the dip zero-point UP on one counter so the merge has something
    // to prefer from each side.
    s2 = ingest(lower, s2, `2026-08-24T09:0${i}:00.000Z`).nextBaseline ?? s2;
  }
  assert.equal(s2.superseded.counters.kills, 1526, 'per-key GREATEST keeps the highest reading ever posted');
  assert.equal(s2.superseded.counters.structuresBuilt, 27207);
  assert.equal(s2.superseded.superseded, undefined, 'and the blob stays exactly one level deep');
  assert.equal(ingest(payload(VETERAN), s2, '2026-08-24T10:00:00.000Z').effective.kills, 0);

  // (e) A genuinely fresh character with NO superseded reading accrues normally —
  // the ceiling only ever binds where a reading actually exists.
  const freshCap = ingest(payload({ reporter: 'Ny', kills: 0, builds: 0, crafts: 0, pickups: [{ item: 'Wood', count: 0 }], walk: 1 }), null);
  assert.equal(freshCap.nextBaseline.superseded, undefined);
  const freshPlay = ingest(
    payload({
      reporter: 'Ny',
      kills: 40,
      builds: 12,
      crafts: 6,
      pickups: [{ item: 'Wood', count: 300 }, { item: 'Fish3', count: 4 }],
      weapons: [{ weapon: 'Knives', damageDealt: 900, kills: 40, hardestHit: 55, biggestSwing: 55 }],
      walk: 4000,
    }),
    freshCap.nextBaseline,
  );
  assert.equal(freshPlay.effective.kills, 40, 'no ceiling, no suppression');
  assert.equal(freshPlay.effective.structuresBuilt, 12);
  assert.equal(freshPlay.effective.distances.walk, 3999);
  assert.deepEqual(freshPlay.effective.gsStats.fish, [{ item: 'Fish3', count: 4 }]);
}

// ── 13. the merge never destroys what was earned here (per-key GREATEST) ─────

{
  // A month on Eilif under a veteran's baseline.
  const cap = ingest(payload(VETERAN), null);
  let row = mergeRow(null, cap.effective);
  const earned = ingest(
    payload({
      ...VETERAN,
      kills: 1826,
      builds: 27907,
      pickups: [{ item: 'Wood', count: 44000 }, { item: 'Fish3', count: 91 }, { item: 'Fish1', count: 12 }],
      materials: [{ material: 'Wood', amount: 44000 }],
      weapons: [{ weapon: 'Swords', damageDealt: 360000, kills: 1500, hardestHit: 475, biggestSwing: 475 }],
      creatures: [{ creature: 'Greydwarf', kills: 1200 }],
      sail: 460000,
      walk: 900000,
      run: 240000,
    }),
    cap.nextBaseline,
  );
  row = mergeRow(row, earned.effective);
  const agg0 = computeAggregates({ stats: [row], sessions: [], onlineNames: new Set() });
  assert.equal(agg0.fish_total, 30, '30 catches landed here');
  assert.equal(row.gs_stats.creatureKills.find((c) => c.creature === 'Greydwarf').kills, 300);

  // Now a real profile reset (N straight lows), then a SMALLER blob from the
  // new character that also out-damages the old stored total — the exact
  // sequence that used to replace the whole blob wholesale (30 fish → 5).
  const resetPayload = payload({
    reporter: 'Chaerlie',
    kills: 4,
    deaths: 1,
    builds: 6,
    crafts: 2,
    pickups: [{ item: 'Wood', count: 30 }],
    weapons: [{ weapon: 'Clubs', damageDealt: 60, kills: 4, hardestHit: 18, biggestSwing: 18 }],
    walk: 400,
  });
  let stored = cap.nextBaseline;
  for (let i = 1; i <= REBASELINE_CONSECUTIVE; i++) {
    const r = ingest(resetPayload, stored, `2026-09-20T09:0${i}:00.000Z`);
    stored = r.nextBaseline ?? stored;
    row = mergeRow(row, r.effective);
  }
  const later = ingest(
    payload({
      reporter: 'Chaerlie',
      // Raw counters deliberately ABOVE the superseded ceiling (§12b), so this
      // block tests the MERGE rather than re-testing the ceiling.
      kills: 2126,
      deaths: 173,
      builds: 27500,
      crafts: 1000,
      pickups: [{ item: 'Wood', count: 45000 }, { item: 'Fish3', count: 5 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 60060, kills: 600, hardestHit: 300, biggestSwing: 300 }],
      creatures: [{ creature: 'Greydwarf', kills: 400 }, { creature: 'Neck', kills: 25 }],
      materials: [{ material: 'Wood', amount: 900 }],
      walk: 40000,
    }),
    stored,
  );
  const clubs = later.effective.gsStats.weapons.find((w) => w.weapon === 'Clubs');
  assert.ok(clubs.damageDealt > row.damage_dealt, 'the new character has out-damaged the old stored total');
  const after = mergeRow(row, later.effective);
  const agg = computeAggregates({ stats: [after], sessions: [], onlineNames: new Set() });
  assert.equal(agg.fish_total, 30, 'fish caught HERE survive a smaller post-reset blob');
  assert.equal(agg.sail_total, 50000, 'and so do the distances');
  assert.equal(
    after.gs_stats.creatureKills.find((c) => c.creature === 'Greydwarf').kills,
    300,
    'per-key max, not replace: the 300 earned here outrank the smaller post-reset entry',
  );
  assert.equal(
    after.gs_stats.creatureKills.find((c) => c.creature === 'Neck').kills,
    25,
    'and a creature neither career had baselined lands in full, alongside it',
  );
  assert.equal(after.gs_stats.materials.find((m) => m.material === 'Wood').amount, 4000);
  assert.equal(after.kills, 600, "the new character's own kills are credited on top");
  assert.equal(after.gs_stats.records.hardestHit, 300, 'a record beaten here is kept');
  assert.equal(after.gs_stats.weapons.length, 2, 'both careers\' weapons are held');
}

{
  // The other half of the old "advancing" verdict: a fresh character's blob used
  // to stay FROZEN until they out-damaged the previous character's lifetime
  // column total — an effective value compared against a cumulative one.
  const cap = ingest(payload({ reporter: 'Sigrun', kills: 2, builds: 4, crafts: 3, pickups: [{ item: 'Wood', count: 20 }], weapons: [{ weapon: 'Clubs', damageDealt: 40, kills: 2, hardestHit: 22, biggestSwing: 22 }], walk: 300 }), null);
  const heavy = { damage_dealt: 900000, kills: 400, gs_stats: { fish: [{ item: 'Fish1', count: 9 }] } };
  const row = mergeRow(heavy, cap.effective);
  assert.equal(row.damage_dealt, 900000, 'the column still holds what was earned here');
  assert.deepEqual(row.gs_stats.fish, [{ item: 'Fish1', count: 9 }], 'and the old blob is not blanked');

  const grind = ingest(
    payload({
      reporter: 'Sigrun',
      kills: 40,
      builds: 4,
      crafts: 3,
      pickups: [{ item: 'Wood', count: 20 }, { item: 'Fish3', count: 6 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 3040, kills: 40, hardestHit: 61, biggestSwing: 61 }],
      walk: 300,
    }),
    cap.nextBaseline,
  );
  const after = mergeRow(row, grind.effective);
  assert.equal(
    computeAggregates({ stats: [after], sessions: [], onlineNames: new Set() }).fish_total,
    15,
    "the new character's 6 catches land immediately — no freeze until they out-damage 900,000",
  );
  assert.equal(after.gs_stats.records.hardestHit, 61, 'and their records surface immediately too');
}

// ── 14. gs_baselined_at is never written blank (Postgres 22007) ──────────────

{
  // The repo's own `dirty` fixture: readable, but with no capturedAt at all.
  const dirty = {
    v: 1,
    counters: { kills: 'lots', deaths: 163 },
    counterMaps: { fish: { Fish3: 'many' }, creatureKills: { Greydwarf: 900 } },
    recordMaps: { weaponHardestHit: null },
    records: {},
  };
  assert.equal(readBaseline(dirty, '2026-08-23T12:00:00.000Z').capturedAt, '2026-08-23T12:00:00.000Z');
  const d = ingest(payload(VETERAN), dirty, '2026-08-23T12:00:00.000Z');
  assert.equal(d.change, 'repair');
  assert.equal(d.nextBaseline.capturedAt, '2026-08-23T12:00:00.000Z', 'the hole heals to the capture time');

  const { row } = mergeIntoRow(null, d.effective, {
    playerId: 'player-1',
    reporter: 'Chaerlie',
    world: 'Eilif',
    now: '2026-08-23T12:00:00.000Z',
    nextBaseline: d.nextBaseline,
  });
  assert.equal(row.gs_baselined_at, '2026-08-23T12:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(row.gs_baselined_at)), 'always a writeable timestamptz');

  // Any junk timestamp is replaced rather than handed to Postgres.
  for (const junk of ['', '   ', 'not-a-date', null, 42, undefined]) {
    const b = readBaseline({ ...dirty, capturedAt: junk }, '2026-08-23T12:00:00.000Z');
    assert.equal(b.capturedAt, '2026-08-23T12:00:00.000Z', `capturedAt ${JSON.stringify(junk)} heals`);
    const merged = mergeIntoRow(null, d.effective, {
      playerId: 'player-1',
      reporter: 'Chaerlie',
      world: 'Eilif',
      now: '2026-08-24T00:00:00.000Z',
      nextBaseline: { ...d.nextBaseline, capturedAt: junk },
    }).row;
    assert.equal(merged.gs_baselined_at, '2026-08-24T00:00:00.000Z', 'falls back to now, never writes ""');
  }
  // A good timestamp is passed through untouched.
  assert.equal(
    mergeIntoRow(null, d.effective, {
      playerId: 'player-1',
      reporter: 'Chaerlie',
      world: 'Eilif',
      now: '2026-08-24T00:00:00.000Z',
      nextBaseline: d.nextBaseline,
    }).row.gs_baselined_at,
    '2026-08-23T12:00:00.000Z',
  );
  // No baseline change → the column isn't written at all.
  assert.equal('gs_baselined_at' in mergeRow(null, d.effective), false);
}

// ── 15. the route's fail-safe paths (migration + degradation + poison) ───────

{
  // Missing COLUMN (not a null value) → the merge is skipped entirely.
  assert.equal(needsBaselineMigration({ kills: 5, gs_stats: {} }), true, 'no gs_baseline key = no column = migration missing');
  assert.equal(needsBaselineMigration({ kills: 5, gs_baseline: null }), false, 'a null value is simply "not baselined yet"');
  assert.equal(needsBaselineMigration({ kills: 5, gs_baseline: { v: 1 } }), false);
  assert.equal(needsBaselineMigration(null), false, 'a brand-new row is not evidence of a missing column');
  assert.match(MIGRATION_REQUIRED, /2026-08-23_gs_baselines\.sql/);

  // PostgREST's complaint about the column, on the write path.
  assert.equal(
    isMissingBaselineColumn({ code: 'PGRST204', message: "Could not find the 'gs_baseline' column of 'player_stats' in the schema cache" }),
    true,
  );
  assert.equal(isMissingBaselineColumn({ code: '42703', message: 'column "gs_baselined_at" of relation "player_stats" does not exist' }), true);
  assert.equal(isMissingBaselineColumn({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);
  assert.equal(isMissingBaselineColumn(null), false);

  // Degradation retry: only the pre-existing columns, values preserved.
  const veteranRow = mergeRow(null, vetSecond.effective, { nextBaseline: vetFirst.nextBaseline });
  const degraded = baseColumnsOnly(veteranRow, '2026-08-24T00:00:00.000Z');
  assert.deepEqual(Object.keys(degraded).sort(), [
    'deaths',
    'distance_traveled',
    'items_crafted',
    'kills',
    'player_id',
    'resources_harvested',
    'structures_built',
    'updated_at',
  ]);
  for (const gone of ['gs_stats', 'gs_baseline', 'gs_baselined_at', 'gs_reporter', 'damage_dealt', 'boss_kills']) {
    assert.equal(gone in degraded, false, `${gone} cannot be sent to a pre-migration table`);
  }
  assert.equal(degraded.kills, veteranRow.kills, 'the headline counters still land');
  assert.equal(degraded.updated_at, '2026-08-24T00:00:00.000Z');
}

{
  // Poison flags: computed on EFFECTIVE values, reported to the caller AND
  // stamped reversibly into the blob. Never blocks the merge.
  const cap = ingest(payload({ reporter: 'Sigrun', kills: 1, builds: 1, crafts: 1, pickups: [{ item: 'Wood', count: 1 }], walk: 10 }), null);
  const spike = ingest(
    payload({
      reporter: 'Sigrun',
      kills: 90000,
      builds: 1,
      crafts: 1,
      pickups: [{ item: 'Wood', count: 1 }],
      weapons: [{ weapon: 'Clubs', damageDealt: 12, kills: 90000, hardestHit: 3, biggestSwing: 3 }],
      walk: 10,
    }),
    cap.nextBaseline,
  );
  const first = mergeIntoRow(null, spike.effective, { playerId: 'p', reporter: 'Sigrun', world: 'Eilif', now: '2026-08-23T12:00:00.000Z' });
  assert.deepEqual(first.flags, [], 'the first snapshot has nothing to jump from');

  const prev = { kills: 0, damage_dealt: 0, gs_stats: { _flags: [{ field: 'deaths', prev: 0, next: 1, at: 'earlier' }] } };
  const flagged = mergeIntoRow(prev, spike.effective, { playerId: 'p', reporter: 'Sigrun', world: 'Eilif', now: '2026-08-23T12:02:00.000Z' });
  assert.equal(flagged.flags.length, 1);
  assert.equal(flagged.flags[0].field, 'kills');
  assert.equal(flagged.flags[0].next, 89999);
  assert.ok(flagged.flags[0].next - flagged.flags[0].prev > POISON_CAPS.kills);
  assert.equal(flagged.row.kills, 89999, 'flagged, NOT blocked');
  assert.equal(flagged.row.gs_stats._flags.length, 2, 'prior flags are preserved, not overwritten');
  assert.equal(flagged.row.gs_stats._flags[0].at, 'earlier');
}

// ── 16. the weapon-collision monitor still sees a leaked cache tuple ─────────
//
// The mod's world-scoped weapons.tsv leaks across a character switch, so two
// characters report a byte-identical weapon entry — in their FIRST snapshot,
// which is exactly the one that becomes their zero-point. Effective damage is
// then 0, the weapon is filtered out of the stored blob, and a stored-only walk
// reconstructs nothing: the monitor was blind to the one incident it exists for.

{
  const leak = { weapon: 'Crossbows', damageDealt: 658, kills: 2, hardestHit: 475, biggestSwing: 475 };
  const a = ingest(payload({ reporter: 'Testman', kills: 2, weapons: [leak] }), null);
  const rowA = mergeRow(null, a.effective);
  assert.deepEqual(rowA.gs_stats.weapons, [], 'a delta-0 weapon is (rightly) not in the stored blob');

  const recon = reconstructRawWeapons(rowA.gs_stats, a.nextBaseline);
  assert.deepEqual(recon, [{ weapon: 'Crossbows', damageDealt: 658, kills: 2, hardestHit: 475, biggestSwing: 475 }]);

  const incoming = parseSelfSnapshot(payload({ reporter: 'Testmantwo', kills: 2, weapons: [leak] })).gsStatsFull.weapons;
  const collision = recon.some((o) =>
    incoming.some(
      (m) =>
        o.weapon === m.weapon &&
        o.kills === m.kills &&
        o.damageDealt === m.damageDealt &&
        o.hardestHit === m.hardestHit &&
        o.biggestSwing === m.biggestSwing,
    ),
  );
  assert.equal(collision, true, 'the leaked tuple is visible again');

  // Still correct for a weapon that HAS been used since the zero-point: effective
  // + baseline reconstructs the raw number, and nothing is double-counted.
  const used = ingest(
    payload({ reporter: 'Testman', kills: 9, weapons: [{ ...leak, damageDealt: 1658, kills: 9, hardestHit: 480, biggestSwing: 475 }] }),
    a.nextBaseline,
  );
  const rowB = mergeRow(rowA, used.effective);
  assert.deepEqual(reconstructRawWeapons(rowB.gs_stats, a.nextBaseline), [
    { weapon: 'Crossbows', damageDealt: 1658, kills: 9, hardestHit: 480, biggestSwing: 475 },
  ]);
  // A weapon known only to the blob (no baseline entry) still reconstructs.
  assert.deepEqual(reconstructRawWeapons({ weapons: [{ weapon: 'Knives', damageDealt: 5, kills: 1, hardestHit: 5, biggestSwing: 5 }] }, null), [
    { weapon: 'Knives', damageDealt: 5, kills: 1, hardestHit: 5, biggestSwing: 5 },
  ]);
  assert.deepEqual(reconstructRawWeapons(null, null), [], 'and junk in still means nothing out');
}

// ── 17. HOLES: the third state, end to end ──────────────────────────────────
//
// D2-remainder. The capture gate covered the core scalars, so these groups were
// baselined as 0/{} whenever the first qualifying post didn't carry them — and
// both of those are UNREPAIRABLE, because a present-and-zero entry is a
// perfectly good zero-point as far as any repair guard can tell. The next post
// then credited the LIFETIME value: Fishing 62 straight onto the Anglers board,
// 900 Greydwarfs, 24,000 damage to Eikthyr, 410 km sailed elsewhere.

{
  // (a) A group absent at capture credits NOTHING when it first appears, then
  //     real growth in full. The fish breakdown rides in pickups[].
  const noPickups = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Chaerlie',
    world: 'Eilif',
    players: [
      {
        name: 'Chaerlie',
        kills: 1526,
        deaths: 163,
        bossKills: 5,
        longestLifeSec: 54000,
        bestKillsBeforeDeath: 88,
        stats: { vh_Builds: 27207, vh_Crafts: 912, vh_DistanceTraveled: 1550000, vh_DistanceWalk: 1550000 },
        weapons: [],
        creatureKills: [],
        boss: [],
        materials: [],
        skills: [],
        // no pickups[]
      },
    ],
  };
  const cap = applyBaseline(parseSelfSnapshot(noPickups), parseSelfDistances(noPickups), null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'capture', 'an absent group does not stop the capture');
  assert.ok(cap.nextBaseline.holes.includes('counterMaps.fish'));
  assert.ok(cap.nextBaseline.holes.includes('counters.resourcesHarvested'));
  assert.equal(cap.nextBaseline.counterMaps.fish, undefined, 'NOT stored as {} — that would be a real zero-point');
  assert.equal(cap.nextBaseline.counters.resourcesHarvested, undefined, 'and NOT stored as 0');

  // Two minutes later the same veteran posts a payload that DOES carry pickups,
  // showing a lifetime 61 tuna caught on some other server.
  const withFish = ingest(payload({ ...VETERAN, kills: 1526 }), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.equal(withFish.change, 'repair');
  assert.match(withFish.reason, /first sighting of/);
  assert.deepEqual(withFish.effective.gsStats.fish, [], '61 lifetime catches credit NOTHING on first sighting');
  assert.equal(withFish.effective.resourcesHarvested, 0, 'nor do 40,073 lifetime pickups');
  assert.equal(withFish.nextBaseline.counterMaps.fish.Fish3, 61, 'the hole took its zero-point from that snapshot');
  assert.equal(withFish.nextBaseline.holes, undefined, 'and closed');

  const row = mergeRow(mergeRow(null, cap.effective, { nextBaseline: cap.nextBaseline }), withFish.effective);
  assert.equal(computeAggregates({ stats: [row], ...noSessions }).fish_total, 0, 'the Anglers ladder sees none of it');

  // …and three real catches afterwards credit exactly three.
  const caught = ingest(
    payload({
      ...VETERAN,
      kills: 1526,
      pickups: [{ item: 'Wood', count: 40000 }, { item: 'Fish3', count: 64 }, { item: 'Fish1', count: 12 }],
    }),
    withFish.nextBaseline,
    '2026-08-23T12:04:00.000Z',
  );
  assert.deepEqual(caught.effective.gsStats.fish, [{ item: 'Fish3', count: 3 }], 'exactly the three caught here');
  assert.equal(caught.effective.resourcesHarvested, 3);
  const row2 = mergeRow(row, caught.effective);
  assert.equal(computeAggregates({ stats: [row2], ...noSessions }).fish_total, 3);
}

{
  // (b) recordMaps.skills — the group that feeds the Anglers board. A veteran
  //     whose first post carries no skills[] used to hand it over on their
  //     second post at Fishing 62.
  const noSkills = structuredClone(payload(VETERAN));
  delete noSkills.players[0].skills;
  const cap = ingest(noSkills, null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'capture');
  assert.ok(cap.nextBaseline.holes.includes('recordMaps.skills'));
  assert.equal(cap.nextBaseline.recordMaps.skills, undefined);

  const withSkills = ingest(payload(VETERAN), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.deepEqual(withSkills.effective.gsStats.skills, [], 'Fishing 62 / Swords 78 surface nowhere');
  assert.equal(withSkills.nextBaseline.recordMaps.skills.Fishing, 62, 'the hole fills at 62');

  // Levelling up here does surface — at its true value, as records do.
  const levelled = ingest(
    payload({ ...VETERAN, skills: [{ skill: 'Swords', level: 78 }, { skill: 'Fishing', level: 63 }] }),
    withSkills.nextBaseline,
    '2026-08-23T12:04:00.000Z',
  );
  assert.deepEqual(levelled.effective.gsStats.skills, [{ skill: 'Fishing', level: 63 }], 'only the level beaten here');
}

{
  // (c) counters.bossKills + the two scalar records, absent at capture. These
  //     land in dedicated columns, so verify through the real merge.
  const bare = structuredClone(payload(VETERAN));
  delete bare.players[0].bossKills;
  delete bare.players[0].longestLifeSec;
  delete bare.players[0].bestKillsBeforeDeath;
  const cap = ingest(bare, null, '2026-08-23T12:00:00.000Z');
  for (const p of ['counters.bossKills', 'records.longestLifeSec', 'records.bestKillsBeforeDeath']) {
    assert.ok(cap.nextBaseline.holes.includes(p), `${p} holed`);
  }
  const full = ingest(payload(VETERAN), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.equal(full.effective.bossKills, 0, '5 imported boss kills credit nothing');
  assert.equal(full.effective.longestLifeSec, 0, 'nor a 15-hour life lived elsewhere');
  assert.equal(full.effective.bestKillsBeforeDeath, 0);
  const row = mergeRow(mergeRow(null, cap.effective, { nextBaseline: cap.nextBaseline }), full.effective);
  assert.equal(row.boss_kills, 0);
  assert.equal(row.longest_life_sec, 0);
  assert.equal(row.best_kills_before_death, 0);

  // A boss actually felled here counts.
  const felled = ingest(payload({ ...VETERAN, bossKills: 6 }), full.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(felled.effective.bossKills, 1);
}

{
  // (d) creatureKills / bossDamage / materials, absent at capture (adv1 A3).
  const noTail = structuredClone(payload(VETERAN));
  delete noTail.players[0].creatureKills;
  delete noTail.players[0].boss;
  delete noTail.players[0].materials;
  const cap = ingest(noTail, null, '2026-08-23T12:00:00.000Z');
  for (const p of ['counterMaps.creatureKills', 'counterMaps.bossDamage', 'counterMaps.bossFightSec', 'counterMaps.materials']) {
    assert.ok(cap.nextBaseline.holes.includes(p), `${p} holed`);
  }
  const full = ingest(payload(VETERAN), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.deepEqual(full.effective.gsStats.creatureKills, [], '900 Greydwarfs + 400 Draugr credit nothing');
  assert.deepEqual(full.effective.gsStats.bossDamage, [], 'nor 24,000 damage to an Eikthyr felled elsewhere');
  assert.deepEqual(full.effective.gsStats.materials, [], 'nor 40,000 imported wood');

  const grind = ingest(
    payload({
      ...VETERAN,
      creatures: [{ creature: 'Greydwarf', kills: 907 }, { creature: 'Draugr', kills: 400 }],
      boss: [{ boss: 'Eikthyr', damageDealt: 24500, fightSec: 940 }],
      materials: [{ material: 'Wood', amount: 40250 }],
    }),
    full.nextBaseline,
    '2026-08-23T12:04:00.000Z',
  );
  assert.deepEqual(grind.effective.gsStats.creatureKills, [{ creature: 'Greydwarf', kills: 7 }]);
  assert.deepEqual(grind.effective.gsStats.bossDamage, [{ boss: 'Eikthyr', damageDealt: 500, fightSec: 40 }]);
  assert.deepEqual(grind.effective.gsStats.materials, [{ material: 'Wood', amount: 250 }]);
}

{
  // (e) PER-MODE distances (adv1 A5). vh_DistanceTraveled alone used to baseline
  //     walk/run/sail/air at 0, so the moment the mode keys appeared, 1,140 km
  //     walked and 410 km sailed on another server were credited in full. The
  //     five modes are a CLOSED key set: an absent one is a per-key hole.
  const totalOnly = structuredClone(payload(VETERAN));
  totalOnly.players[0].stats = { vh_Builds: 27207, vh_Crafts: 912, vh_DistanceTraveled: 1550000 };
  const cap = ingest(totalOnly, null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'capture');
  assert.deepEqual(cap.nextBaseline.counterMaps.distances, { total: 1550000 }, 'only the mode that was reported');
  assert.deepEqual(cap.nextBaseline.counterMaps.distancesRaw, { vh_DistanceTraveled: 1550000 });
  assert.equal(cap.nextBaseline.holes, undefined, 'the distance GROUP was carried — the gaps are per-key');

  const modes = ingest(payload(VETERAN), cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.equal(modes.change, 'repair');
  assert.match(modes.reason, /counterMaps\.distances\.walk/);
  assert.deepEqual(
    modes.effective.distances,
    { total: 0, walk: 0, run: 0, sail: 0, air: 0 },
    '1.14 Mm walked and 410 km sailed elsewhere credit nothing on first sighting',
  );
  assert.equal(modes.effective.distancesRaw.vh_DistanceSail, 0);
  assert.equal(modes.nextBaseline.counterMaps.distances.sail, 410000, 'each mode took its zero-point from that post');
  const row = mergeRow(mergeRow(null, cap.effective, { nextBaseline: cap.nextBaseline }), modes.effective);
  const agg = computeAggregates({ stats: [row], ...noSessions });
  assert.equal(agg.sail_total, 0, 'the Great Deeds ladder sees none of it');
  assert.equal(agg.walk_run_total, 0);

  // Real metres afterwards count in full.
  const sailed = ingest(payload({ ...VETERAN, sail: 412500 }), modes.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(sailed.effective.distances.sail, 2500);
  assert.equal(computeAggregates({ stats: [mergeRow(row, sailed.effective)], ...noSessions }).sail_total, 2500);
}

{
  // (f) A hole must survive a suspected profile reset. A snapshot under
  //     suspicion is trusted for NOTHING — filling a hole from numbers that may
  //     belong to a different character is exactly how the real career's return
  //     would come to look "earned here".
  const noSkills = structuredClone(payload(VETERAN));
  delete noSkills.players[0].skills;
  const cap = ingest(noSkills, null, '2026-08-23T12:00:00.000Z');
  assert.ok(cap.nextBaseline.holes.includes('recordMaps.skills'));

  const low = payload({
    ...VETERAN,
    kills: 400,
    deaths: 40,
    builds: 6000,
    crafts: 200,
    pickups: [{ item: 'Wood', count: 9000 }],
    skills: [{ skill: 'Fishing', level: 62 }], // the "other" character DOES carry skills
  });
  const dip = ingest(low, cap.nextBaseline, '2026-08-23T12:02:00.000Z');
  assert.equal(dip.change, 'reset-pending');
  assert.ok(dip.nextBaseline.holes.includes('recordMaps.skills'), 'the hole is NOT filled from a suspect snapshot');
  assert.equal(dip.nextBaseline.recordMaps.skills, undefined);
  assert.deepEqual(dip.effective.gsStats.skills, [], 'nor is it credited for lack of a fill');

  // When the real career returns, the hole fills from a snapshot that belongs
  // to it — costing that group one cycle, not a lifetime.
  const back = ingest(payload(VETERAN), dip.nextBaseline, '2026-08-23T12:04:00.000Z');
  assert.equal(back.change, 'repair');
  assert.deepEqual(back.effective.gsStats.skills, [], 'the fill cycle credits nothing');
  assert.equal(back.nextBaseline.recordMaps.skills.Fishing, 62);
  assert.equal(back.nextBaseline.holes, undefined);
  assert.equal(back.nextBaseline.pendingReset, undefined, 'and the streak is cleared alongside');
}

// ── 18. NEW-1: nobody is ever muted ─────────────────────────────────────────
//
// `defer` writes NOTHING — no baseline, no row, no gs_updated_at, no milestone
// evaluation. So every field the capture gate hard-required was a way to silence
// a real player for as long as they played.

{
  // (a) The repo's OWN canonical fixture — built to match the decompiled Emit()
  //     output EXACTLY (scripts/gs-client.test.mjs) — carries no vh_Distance*
  //     keys at all. It used to defer on post 1 and still be deferring on post
  //     100: gs_baseline null forever, the route returning before any write.
  const canonical = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Bjorn Ironside',
    world: 'Dedicated',
    players: [
      {
        name: 'Bjorn Ironside',
        platformId: 'Steam_765',
        kills: 342,
        bossKills: 3,
        deaths: 7,
        longestLifeSec: 5400,
        bestKillsBeforeDeath: 88,
        stats: { vh_Deaths: 7, vh_Builds: 214, vh_Crafts: 96, vh_EnemyKills: 342 },
        skills: [{ skill: 'Swords', level: 42 }, { skill: 'Fishing', level: 5 }],
        creatureKills: [{ creature: 'Greydwarf', kills: 140 }],
        crafts: [{ item: 'Wood', count: 40 }],
        materials: [{ material: 'Wood', amount: 1200 }],
        weapons: [{ weapon: 'Swords', damageDealt: 18000, kills: 200, hardestHit: 220, biggestSwing: 260 }],
        pickups: [{ item: 'Wood', count: 800 }, { item: 'Fish3', count: 4 }],
        boss: [{ boss: 'Eikthyr', damageDealt: 2400, fightSec: 120 }],
      },
    ],
  };
  const parsed = parseSelfSnapshot(canonical);
  assert.equal(captureQualification(parsed).ok, true, 'the mod\'s own canonical payload qualifies');
  const cap = applyBaseline(parsed, parseSelfDistances(canonical), null, '2026-08-23T12:00:00.000Z');
  assert.equal(cap.change, 'capture', 'and captures on its FIRST post');
  assert.equal(cap.deferred, false);
  assert.equal(cap.nextBaseline.counters.kills, 342);
  assert.deepEqual(
    cap.nextBaseline.holes,
    ['counters.distanceTraveled', 'counterMaps.distances', 'counterMaps.distancesRaw'],
    'the one thing it cannot speak for is holed — everything else is baselined',
  );
  // A row IS produced, which is the half that was missing: a deferred cycle
  // wrote nothing at all, so gs_reporter / gs_updated_at never advanced and
  // evaluateAndRecord never ran for that player.
  const row = mergeRow(null, cap.effective, { nextBaseline: cap.nextBaseline });
  assert.ok(row.gs_updated_at, 'gs_updated_at advances');
  assert.ok(row.gs_baseline, 'and the zero-point is persisted, so post 2 can credit');

  // Post 2 (a real hour of play on the same, distance-less payload shape) is
  // credited — no amount of repetition can strand this character again.
  const played = structuredClone(canonical);
  played.players[0].kills = 402;
  played.players[0].stats.vh_Builds = 260;
  const next = applyBaseline(parseSelfSnapshot(played), parseSelfDistances(played), cap.nextBaseline, '2026-08-23T13:00:00.000Z');
  assert.equal(next.deferred, false);
  assert.equal(next.effective.kills, 60);
  assert.equal(next.effective.structuresBuilt, 46);
  assert.equal(next.effective.distanceTraveled, 0, 'distance stays holed while the payload never carries it');
}

{
  // (b) A viking who has never placed a build piece: 40 minutes of fishing and
  //     exploring used to be deferred outright, then swallowed by the zero-point
  //     the instant they finally built something (adv3 R4).
  const cycle = (min, { kills, fish, walk, builds }) => {
    const body = payload({
      reporter: 'Freyja',
      kills,
      crafts: 3,
      walk,
      pickups: [{ item: 'Wood', count: 100 }, { item: 'Fish3', count: fish }],
      weapons: [{ weapon: 'Knives', damageDealt: kills * 40, kills, hardestHit: 50, biggestSwing: 50 }],
      skills: [{ skill: 'Fishing', level: Math.floor(fish / 2) }],
    });
    if (builds === undefined) delete body.players[0].stats.vh_Builds;
    else body.players[0].stats.vh_Builds = builds;
    return { body, at: new Date(Date.parse('2026-08-23T12:00:00.000Z') + min * 60_000).toISOString() };
  };

  let stored = null;
  let row = null;
  const seen = [];
  for (const [min, c] of [
    [0, { kills: 0, fish: 0, walk: 500 }],
    [20, { kills: 14, fish: 6, walk: 9000 }],
    [40, { kills: 33, fish: 17, walk: 26000 }],
    [42, { kills: 35, fish: 18, walk: 27000, builds: 1 }], // their first build piece
    [60, { kills: 51, fish: 25, walk: 41000, builds: 40 }],
  ]) {
    const { body, at } = cycle(min, c);
    const res = ingest(body, stored, at);
    assert.equal(res.deferred, false, `t+${min}m must not be deferred`);
    stored = res.nextBaseline ?? stored;
    row = mergeRow(row, res.effective, { nextBaseline: res.nextBaseline, now: at });
    seen.push(res.change);
  }
  assert.equal(seen[0], 'capture', 'they baseline on their very first post, build piece or not');
  assert.equal(seen[3], 'repair', 'and structuresBuilt fills the moment vh_Builds first appears');

  // The 40 minutes before that first build piece are CREDITED, not swallowed.
  assert.equal(row.kills, 51, 'every kill from minute zero');
  assert.equal(computeAggregates({ stats: [row], ...noSessions }).fish_total, 25, 'and every catch');
  assert.equal(row.distance_traveled, 40500, '41,000 m walked − the 500 they had at capture');
  assert.equal(row.structures_built, 39, 'builds credit from their first sighting (40 − the 1 that filled the hole)');
  assert.deepEqual(row.gs_stats.skills, [{ skill: 'Fishing', level: 12 }], 'levels earned here surface');
}

// ── 19. NEW-2: a case-skewed reporter name is not a life sentence ────────────
//
// `reporter` and players[].name come from two different places in the mod. An
// exact-string match meant a skew of case or a stray space found no own entry,
// fell through to the BYSTANDER branch, and deferred that character FOREVER.

{
  for (const [reporterName, entryName, label] of [
    ['chaerlie', 'Chaerlie', 'lower vs upper'],
    ['CHAERLIE', 'Chaerlie', 'upper vs mixed'],
    [' Chaerlie ', 'Chaerlie', 'padded reporter'],
    ['Chaerlie', '  Chaerlie', 'padded entry'],
  ]) {
    const body = structuredClone(payload(VETERAN));
    body.reporter = reporterName;
    body.players[0].name = entryName;
    const s = parseSelfSnapshot(body);
    assert.equal(s.provenance.ownEntry, true, `${label}: matched as the reporter's own entry`);
    assert.equal(s.reporter, reporterName.trim(), 'the row is still keyed to the reporter as given');
    const r = applyBaseline(s, parseSelfDistances(body), null, '2026-08-23T12:00:00.000Z');
    assert.equal(r.change, 'capture', `${label}: captures instead of deferring forever`);
    assert.equal(r.nextBaseline.counters.kills, 1526);
    // …and the lifetime import is still absorbed, exactly as for an exact match.
    assert.equal(r.effective.kills, 0);
  }

  // A genuinely DIFFERENT name is still a bystander, and still never baselines.
  const bystander = structuredClone(payload(VETERAN));
  bystander.reporter = 'Chaerlie';
  bystander.players[0].name = 'Bjorn';
  const s = parseSelfSnapshot(bystander);
  assert.equal(s.provenance.ownEntry, false, 'bystander semantics are unchanged');
  assert.equal(
    applyBaseline(s, parseSelfDistances(bystander), null, '2026-08-23T12:00:00.000Z').change,
    'defer',
  );
}

console.log('OK — all world-baseline assertions passed');
