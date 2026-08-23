// Ad-hoc unit test for the GsValheimStatsClient parser, exercising a payload
// built to match the decompiled Emit() output EXACTLY (players[0]=self + one
// observed other; deathEvents; bossKillEvents; bossSelfDamage). Run:
//   npx tsx scripts/gs-client.test.mjs
import { parseSelfSnapshot, parseSelfDistances, capGsStats } from '../lib/gs-client.ts';
import assert from 'node:assert';

const payload = {
  schemaVersion: 1,
  game: 'valheim',
  source: 'client',
  reporter: 'Bjorn Ironside',
  world: 'Dedicated',
  emittedAtUtc: '2026-07-04T18:00:00.0000000Z',
  snapshotIdLocal: 'abc123def456',
  players: [
    {
      name: 'Bjorn Ironside',
      platformId: 'Steam_76561198000000000',
      kills: 342,
      bossKills: 3,
      deaths: 7,
      longestLifeSec: 5400,
      bestKillsBeforeDeath: 88,
      currentLifeStartedUtc: '2026-07-04T16:30:00.0000000Z',
      stats: { vh_Deaths: 7, vh_Builds: 214, vh_Crafts: 96, vh_EnemyKills: 342 },
      // 13 skills, ranked by level — Fishing sits at rank 13 (just outside the
      // top-12 cap), proving the parser retains it explicitly rather than
      // dropping it silently.
      skills: [
        { skill: 'Swords', level: 42 },
        { skill: 'Run', level: 30 },
        { skill: 'Bows', level: 28 },
        { skill: 'Axes', level: 27 },
        { skill: 'Blocking', level: 26 },
        { skill: 'Jump', level: 25 },
        { skill: 'Sneak', level: 24 },
        { skill: 'Swim', level: 23 },
        { skill: 'Knives', level: 22 },
        { skill: 'Pickaxes', level: 21 },
        { skill: 'Polearms', level: 20 },
        { skill: 'Spears', level: 19 },
        { skill: 'Fishing', level: 5 },
        { skill: 'None', level: 0 },
      ],
      creatureKills: [
        { creature: 'Greydwarf', kills: 140 },
        { creature: '$enemy_neck', kills: 60 },
        { creature: 'Boar', kills: 0 },
      ],
      crafts: [ { item: 'Wood', count: 40 }, { item: 'ArrowWood', count: 56 } ],
      materials: [ { material: 'Wood', amount: 1200 }, { material: 'Stone', amount: 640 } ],
      weapons: [
        { weapon: 'Swords', damageDealt: 18000, kills: 200, hardestHit: 220, biggestSwing: 260 },
        { weapon: 'Bows', damageDealt: 6000, kills: 90, hardestHit: 140, biggestSwing: 140 },
      ],
      weaponItems: [ { item: 'Iron sword', damageDealt: 18000, kills: 200, hardestHit: 220 } ],
      // Fish3 (Tuna) rides along in pickups like any other resource — the parser
      // must both surface it in gsStats.fish AND keep it inside resourcesHarvested.
      pickups: [ { item: 'Wood', count: 800 }, { item: 'Stone', count: 420 }, { item: 'Fish3', count: 4 } ],
      boss: [ { boss: 'Eikthyr', damageDealt: 2400, fightSec: 120 } ],
    },
    // An OBSERVED other (partial, no cumulative counters) — must be ignored.
    {
      name: 'Freya',
      weapons: [ { weapon: 'Clubs', damageDealt: 999999, kills: 999, hardestHit: 9999, biggestSwing: 9999 } ],
      weaponItems: [],
      boss: [ { boss: 'Eikthyr', damageDealt: 500000, fightSec: 99 } ],
    },
  ],
  deathEvents: [
    { playerName: 'Bjorn Ironside', killer: 'Greydwarf', biome: 'BlackForest', posX: 1, posY: 2, posZ: 3, lifeSec: 900, killsThisLife: 12, tsUtc: '2026-07-04T17:55:00.0000000Z' },
  ],
  bossKillEvents: [
    { boss: 'Eikthyr', fightSec: 120, firstBlood: 'Bjorn Ironside', topDamagePlayer: 'Bjorn Ironside', topDamage: 2400, participants: 2, tsUtc: '2026-07-04T17:00:00.0000000Z' },
  ],
  bossSelfDamage: [ { boss: 'Eikthyr', damage: 300 } ],
};

const s = parseSelfSnapshot(payload);
assert.ok(s, 'parsed');
assert.equal(s.reporter, 'Bjorn Ironside');
assert.equal(s.world, 'Dedicated');
assert.equal(s.kills, 342);
assert.equal(s.deaths, 7);
assert.equal(s.bossKills, 3);
assert.equal(s.longestLifeSec, 5400);
assert.equal(s.bestKillsBeforeDeath, 88);
// resources = sum(pickups.count) = 800 + 420 + 4 (Fish3 rides along, no double-subtract)
assert.equal(s.resourcesHarvested, 1224);
// crafted prefers vh_Crafts (96) over crafts[] sum (96 too, but proves precedence)
assert.equal(s.itemsCrafted, 96);
// structures = vh_Builds
assert.equal(s.structuresBuilt, 214);
// damage = sum(weapons.damageDealt) = 18000 + 6000 — NOT the observed other
assert.equal(s.damageDealt, 24000);
assert.equal(s.gsStats.records.topWeapon, 'Swords');
assert.equal(s.gsStats.records.hardestHit, 220);
assert.equal(s.gsStats.records.biggestSwing, 260);
// zero-kill creatures + level-0 skills dropped
assert.equal(s.gsStats.creatureKills.length, 2);
assert.equal(s.gsStats.bossDamage[0].boss, 'Eikthyr');
assert.equal(s.gsStats.platformId, 'Steam_76561198000000000');

// Skills: 13 have level > 0 (None/level-0 dropped). Fishing (level 5) ranks
// 13th by level — outside the top-12 cap — but must be retained explicitly,
// not silently dropped.
assert.equal(s.gsStats.skills.length, 13);
assert.ok(
  s.gsStats.skills.some((sk) => sk.skill === 'Fishing' && sk.level === 5),
  'Fishing retained even when ranked outside top-12'
);

// Fish: Fish3 (Tuna) surfaces in gsStats.fish with its pickup count.
assert.equal(s.gsStats.fish.length, 1);
assert.equal(s.gsStats.fish[0].item, 'Fish3');
assert.equal(s.gsStats.fish[0].count, 4);

// Bystander-only payload (no self entry with stats/deaths) -> null.
const noSelf = parseSelfSnapshot({ reporter: 'Ghost', players: [{ name: 'Other', weapons: [] }] });
assert.equal(noSelf, null, 'no authoritative self -> null');

// Missing reporter -> null.
assert.equal(parseSelfSnapshot({ players: [] }), null);

// ── gsStatsFull is genuinely UNCAPPED ────────────────────────────────────────
//
// gsStats is the display blob (top-12 weapons / top-15 creatures / top-12
// materials / top-12 skills + Fishing). gsStatsFull is the SAME data before any
// of those slices, and lib/gs-baseline differences against it — a weapon,
// creature or material that only breaks into the top-N after it has been used
// HERE must still have a zero-point to be measured against, or the day it
// finally ranks it arrives with its whole imported lifetime total attached.
// Nothing asserted that gsStatsFull was actually uncapped, so a stray slice in
// the parser would have been invisible.

{
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const big = parseSelfSnapshot({
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Hoarder',
    world: 'Dedicated',
    players: [
      {
        name: 'Hoarder',
        kills: 500,
        deaths: 3,
        stats: { vh_Builds: 10, vh_Crafts: 5, vh_DistanceTraveled: 900 },
        // 20 weapons, 25 creatures, 18 materials, 20 skills — all above their caps.
        weapons: many(20, (i) => ({ weapon: `W${i}`, damageDealt: 2000 - i, kills: 20 - i, hardestHit: 100 - i, biggestSwing: 100 - i })),
        creatureKills: many(25, (i) => ({ creature: `C${i}`, kills: 100 - i })),
        materials: many(18, (i) => ({ material: `M${i}`, amount: 500 - i })),
        skills: many(20, (i) => ({ skill: `S${i}`, level: 50 - i })),
        pickups: [{ item: 'Fish3', count: 2 }],
        boss: [],
      },
    ],
  });

  assert.equal(big.gsStatsFull.weapons.length, 20, 'gsStatsFull keeps every weapon');
  assert.equal(big.gsStatsFull.creatureKills.length, 25, 'gsStatsFull keeps every creature');
  assert.equal(big.gsStatsFull.materials.length, 18, 'gsStatsFull keeps every material');
  assert.equal(big.gsStatsFull.skills.length, 20, 'gsStatsFull keeps every skill');
  // The rank-13th weapon / rank-16th creature — invisible in the display blob,
  // and precisely the entries the baseline must still be able to zero.
  assert.ok(big.gsStatsFull.weapons.some((w) => w.weapon === 'W19'));
  assert.ok(big.gsStatsFull.creatureKills.some((c) => c.creature === 'C24'));
  assert.ok(big.gsStatsFull.materials.some((m) => m.material === 'M17'));

  // …while the STORED blob is capped exactly as before.
  assert.equal(big.gsStats.weapons.length, 12);
  assert.equal(big.gsStats.creatureKills.length, 15);
  assert.equal(big.gsStats.materials.length, 12);
  assert.equal(big.gsStats.skills.length, 12);
  assert.equal(big.gsStats.fish.length, 1, 'fish are never capped (bounded by the game)');

  // Capping is a pure view of the full list — same order, no mutation of it.
  assert.deepEqual(capGsStats(big.gsStatsFull).weapons, big.gsStats.weapons);
  assert.equal(big.gsStatsFull.weapons.length, 20, 'capGsStats does not mutate its input');
  assert.equal(big.gsStatsFull.records.hardestHit, 100, 'records are derived from ALL weapons');
}

// ── provenance: what the payload actually carried ───────────────────────────
//
// The world-baseline capture gate (lib/gs-baseline captureQualification) runs on
// these flags — every number above is 0 when absent, so "absent" and "zero" must
// stay distinguishable here or a zero-point gets seeded from a payload that
// never carried the field.

{
  assert.equal(s.provenance.ownEntry, true, 'players[0].name === reporter');
  assert.equal(s.provenance.hasStats, true);
  assert.equal(s.provenance.hasKills, true);
  assert.equal(s.provenance.hasDeaths, true);
  assert.equal(s.provenance.hasBossKills, true);
  assert.equal(s.provenance.hasLongestLifeSec, true);
  assert.equal(s.provenance.hasBestKillsBeforeDeath, true);
  assert.equal(s.provenance.hasBuilds, true);
  assert.equal(s.provenance.hasPickups, true);
  assert.equal(s.provenance.hasWeapons, true);
  assert.equal(s.provenance.hasCreatureKills, true);
  assert.equal(s.provenance.hasBoss, true);
  assert.equal(s.provenance.hasMaterials, true);
  assert.equal(s.provenance.hasSkills, true);
  assert.equal(s.provenance.craftsSource, 'vh_Crafts');
  assert.equal(s.provenance.hasDistance, false, 'this fixture carries no vh_Distance* keys');
  // …and that must NOT stop it being baselined — see scripts/gs-baseline.test.mjs
  // §18(a): the mod's own canonical payload used to defer forever on this alone.

  // Every list flag is PRESENCE, not length: an empty list is a real "none yet"
  // (a good zero-point), an ABSENT list is no information (a baseline hole).
  const wrapSelf = (self) => ({ reporter: 'Solo', players: [{ name: 'Solo', kills: 0, deaths: 0, stats: {}, ...self }] });
  const empties = parseSelfSnapshot(
    wrapSelf({ pickups: [], weapons: [], creatureKills: [], boss: [], materials: [], skills: [] }),
  );
  for (const f of ['hasPickups', 'hasWeapons', 'hasCreatureKills', 'hasBoss', 'hasMaterials', 'hasSkills']) {
    assert.equal(empties.provenance[f], true, `${f}: an empty list is present`);
  }
  const absent = parseSelfSnapshot(wrapSelf({}));
  for (const f of ['hasPickups', 'hasWeapons', 'hasCreatureKills', 'hasBoss', 'hasMaterials', 'hasSkills']) {
    assert.equal(absent.provenance[f], false, `${f}: an absent list is not present`);
  }
  for (const f of ['hasBossKills', 'hasLongestLifeSec', 'hasBestKillsBeforeDeath']) {
    assert.equal(absent.provenance[f], false, `${f}: an absent scalar is not present`);
  }
  const zeroed = parseSelfSnapshot(wrapSelf({ bossKills: 0, longestLifeSec: 0, bestKillsBeforeDeath: 0 }));
  for (const f of ['hasBossKills', 'hasLongestLifeSec', 'hasBestKillsBeforeDeath']) {
    assert.equal(zeroed.provenance[f], true, `${f}: a genuine 0 is present`);
  }

  // The bystander fallback still parses (deaths etc. keep flowing) but is
  // flagged as NOT the reporter's own entry.
  const fallback = parseSelfSnapshot({
    reporter: 'Chaerlie',
    players: [{ name: 'Bjorn', kills: 7, deaths: 2 }],
  });
  assert.equal(fallback.reporter, 'Chaerlie');
  assert.equal(fallback.provenance.ownEntry, false, 'a bystander entry is never the reporter’s career');
  assert.equal(fallback.provenance.hasStats, false);
  assert.equal(fallback.provenance.craftsSource, 'none');

  // vh_Crafts present but ZERO is still the authoritative source (the old
  // `vh_Crafts || sumBy(crafts)` silently switched source whenever it read 0).
  const zeroCrafts = parseSelfSnapshot({
    reporter: 'Rookie',
    players: [{ name: 'Rookie', kills: 0, deaths: 0, stats: { vh_Crafts: 0, vh_Builds: 0 }, crafts: [{ item: 'ArrowWood', count: 12 }] }],
  });
  assert.equal(zeroCrafts.provenance.craftsSource, 'vh_Crafts');
  assert.equal(zeroCrafts.itemsCrafted, 0);
  // With the key genuinely absent, the crafts[] breakdown is used — and said so.
  const summed = parseSelfSnapshot({
    reporter: 'Rookie',
    players: [{ name: 'Rookie', kills: 0, deaths: 0, stats: { vh_Builds: 0 }, crafts: [{ item: 'ArrowWood', count: 12 }] }],
  });
  assert.equal(summed.provenance.craftsSource, 'crafts');
  assert.equal(summed.itemsCrafted, 12);
}

// ── own-entry matching is case- and whitespace-insensitive ──────────────────
//
// `reporter` and players[].name come from two different places in the mod, and
// an exact-string match made a skew of case (or a stray space) fatal rather than
// cosmetic: no own entry was found, the parse fell through to the BYSTANDER
// branch, and lib/gs-baseline — which will never seed a zero-point from a
// bystander — deferred that character on every post, forever.

{
  const self = {
    name: 'Chaerlie',
    kills: 1526,
    deaths: 163,
    stats: { vh_Builds: 27207, vh_Crafts: 912, vh_DistanceTraveled: 1550000 },
    weapons: [{ weapon: 'Swords', damageDealt: 310000, kills: 1200, hardestHit: 475, biggestSwing: 475 }],
    pickups: [{ item: 'Wood', count: 40000 }],
  };
  const build = (reporter, name) => ({ reporter, players: [{ ...structuredClone(self), name }] });

  for (const [reporter, name, label] of [
    ['Chaerlie', 'Chaerlie', 'exact'],
    ['chaerlie', 'Chaerlie', 'lower vs upper'],
    ['CHAERLIE', 'Chaerlie', 'upper vs mixed'],
    [' Chaerlie ', 'Chaerlie', 'padded reporter'],
    ['Chaerlie', '  Chaerlie  ', 'padded entry'],
  ]) {
    const parsed = parseSelfSnapshot(build(reporter, name));
    assert.equal(parsed.provenance.ownEntry, true, `${label}: own entry found`);
    assert.equal(parsed.reporter, reporter.trim(), `${label}: the reporter name itself is untouched`);
    assert.equal(parsed.kills, 1526, `${label}: their own counters are read`);
    // parseSelfDistances resolves the self entry the same way, or the two would
    // disagree about whose metres they are.
    assert.equal(parseSelfDistances(build(reporter, name)).distanceTraveled, 1550000, `${label}: distances too`);
  }

  // A genuinely different name is still a bystander — the fold must not merge
  // two vikings.
  const other = parseSelfSnapshot(build('Chaerlie', 'Bjorn'));
  assert.equal(other.provenance.ownEntry, false, 'a different name is still a bystander');
  assert.equal(other.reporter, 'Chaerlie', 'and the payload is still filed under the reporter');
}

// ── parseSelfDistances: presence, not value ─────────────────────────────────
//
// NULL is the signal lib/gs-baseline holes on, so it must mean "said nothing
// usable about distance" — never "every reading is zero", which is a real
// zero-point a brand-new viking is entitled to.

{
  const wrap = (stats) => ({ reporter: 'Solo', players: [{ name: 'Solo', kills: 0, deaths: 0, stats }] });

  assert.equal(parseSelfDistances(wrap({})), null, 'no vh_Distance* key at all → null');
  assert.equal(parseSelfDistances(wrap({ vh_Builds: 10 })), null, 'other stats do not count');
  assert.equal(parseSelfDistances(wrap({ vh_DistanceTraveled: 'lots' })), null, 'junk is as absent as missing');
  assert.equal(parseSelfDistances({ reporter: 'Solo', players: [] }), null, 'no self entry → null');

  const zeroes = parseSelfDistances(wrap({ vh_DistanceTraveled: 0, vh_DistanceWalk: 0 }));
  assert.ok(zeroes, 'present-and-zero is a READING, not silence');
  assert.equal(zeroes.distanceTraveled, 0);
  assert.deepEqual(zeroes.raw, { vh_DistanceTraveled: 0, vh_DistanceWalk: 0 });

  // `raw` is the per-mode presence record — the only thing that can tell an
  // unreported mode from a real zero, since the five modes are synthesized.
  const totalOnly = parseSelfDistances(wrap({ vh_DistanceTraveled: 1550000 }));
  assert.equal(totalOnly.sail, 0, 'sail reads 0…');
  assert.equal('vh_DistanceSail' in totalOnly.raw, false, '…but was never reported, and raw says so');
  assert.deepEqual(totalOnly.raw, { vh_DistanceTraveled: 1550000 });

  // Only finite numbers make it into raw; a partial payload still parses.
  const partial = parseSelfDistances(wrap({ vh_DistanceWalk: 4000.6, vh_DistanceSail: null, vh_DistanceAir: 'x' }));
  assert.deepEqual(partial.raw, { vh_DistanceWalk: 4001 }, 'rounded, and junk modes dropped');
  assert.equal(partial.walk, 4001);
  assert.equal(partial.distanceTraveled, 0, 'no total reported — 0 here, and holed by the baseline layer');
}

console.log('OK — all parser assertions passed');
