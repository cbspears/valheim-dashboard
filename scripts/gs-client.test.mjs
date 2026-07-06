// Ad-hoc unit test for the GsValheimStatsClient parser, exercising a payload
// built to match the decompiled Emit() output EXACTLY (players[0]=self + one
// observed other; deathEvents; bossKillEvents; bossSelfDamage). Run:
//   npx tsx scripts/gs-client.test.mjs
import { parseSelfSnapshot } from '../lib/gs-client.ts';
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

console.log('OK — all parser assertions passed');
