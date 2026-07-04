// Unit test for the GsValheimStats boss-detection + distance parsers, using
// payloads built to match the DECOMPILED Emitter/Client Emit() output exactly.
//   npx tsx scripts/gs-boss.test.mjs
import {
  parseBossMilestones,
  parseBossKillEvents,
  parseSelfDistances,
  BOSS_MILESTONE_KEY_TO_NAME,
  BOSS_OBJECT_TO_NAME,
} from '../lib/gs-client.ts';
import assert from 'node:assert';

// ── 1. Milestone → bosses.name mapping (the seven real defeat keys) ──────────
const ts = '2026-07-04T18:00:00.0000000Z';
const serverPayload = {
  schemaVersion: 1,
  game: 'valheim',
  source: 'server',
  world: 'Dedicated',
  onlinePlayers: ['Bjorn Ironside', 'Astrid Shieldmaiden'],
  worldDay: 42,
  milestones: [
    { key: 'defeated_eikthyr', label: 'Eikthyr defeated', kind: 'boss', tsUtc: ts },
    // progression / bounty / mini-boss keys must NOT map to a boss:
    { key: 'KilledTroll', label: 'First troll slain', kind: 'progression', tsUtc: ts },
    { key: 'killed_surtling', label: 'First surtling slain', kind: 'progression', tsUtc: ts },
    { key: 'defeated_serpent', label: 'Serpent', kind: 'boss', tsUtc: ts }, // mini-boss, not in map
    { key: 'Hildir1', label: "Hildir's bounty", kind: 'bounty', tsUtc: ts },
  ],
  bossKillEvents: [
    { boss: 'Eikthyr', fightSec: 118, firstBlood: 'Bjorn Ironside', topDamagePlayer: 'Astrid Shieldmaiden', topDamage: 3120, participants: 2, tsUtc: ts },
  ],
};

const ms = parseBossMilestones(serverPayload);
assert.equal(ms.length, 1, 'only the one real boss key maps');
assert.equal(ms[0].key, 'defeated_eikthyr');
assert.equal(ms[0].bossName, 'Eikthyr');

// Full explicit-list mapping sanity (all seven, no defeated_ prefix generics).
assert.deepEqual(Object.keys(BOSS_MILESTONE_KEY_TO_NAME).sort(), [
  'defeated_bonemass', 'defeated_dragon', 'defeated_eikthyr', 'defeated_fader',
  'defeated_gdking', 'defeated_goblinking', 'defeated_queen',
]);
assert.equal(BOSS_MILESTONE_KEY_TO_NAME['defeated_gdking'], 'The Elder');
assert.equal(BOSS_MILESTONE_KEY_TO_NAME['defeated_dragon'], 'Moder');
assert.equal(BOSS_MILESTONE_KEY_TO_NAME['defeated_goblinking'], 'Yagluth');
assert.equal(BOSS_MILESTONE_KEY_TO_NAME['defeated_queen'], 'The Queen');
// The Bog Witch / Deep North has NO defeat key — never auto-fires.
assert.ok(!Object.values(BOSS_MILESTONE_KEY_TO_NAME).includes('The Bog Witch'));

// Idempotency: dedupe within a payload (same key twice → one entry).
const dupe = parseBossMilestones({ milestones: [
  { key: 'defeated_bonemass', tsUtc: ts }, { key: 'defeated_bonemass', tsUtc: ts },
] });
assert.equal(dupe.length, 1, 'duplicate milestone keys collapse');

// ── 2. bossKillEvents: gameObject name → bosses.name ─────────────────────────
const bk = parseBossKillEvents(serverPayload.bossKillEvents);
assert.equal(bk.length, 1);
assert.equal(bk[0].bossName, 'Eikthyr');
assert.equal(bk[0].firstBlood, 'Bjorn Ironside');
assert.equal(bk[0].topDamagePlayer, 'Astrid Shieldmaiden');
assert.equal(bk[0].participants, 2);

// gd_king / Dragon / SeekerQueen resolve to display names; mini-bosses drop.
const bk2 = parseBossKillEvents([
  { boss: 'gd_king', fightSec: 200, participants: 3, tsUtc: ts },
  { boss: 'SeekerQueen', fightSec: 400, participants: 4, tsUtc: ts },
  { boss: 'Serpent', fightSec: 60, participants: 1, tsUtc: ts }, // not a mapped boss
  { boss: 'Eikthyr', participants: 1 }, // no tsUtc → dropped (dedupe key)
]);
assert.deepEqual(bk2.map((b) => b.bossName), ['The Elder', 'The Queen']);
assert.equal(BOSS_OBJECT_TO_NAME['SeekerQueen'], 'The Queen');

// ── 3. Distances from the reporter's stats map (metres) ──────────────────────
const clientPayload = {
  reporter: 'Bjorn Ironside',
  players: [{
    name: 'Bjorn Ironside',
    deaths: 3,
    stats: {
      vh_DistanceTraveled: 84210, vh_DistanceWalk: 40000, vh_DistanceRun: 30000,
      vh_DistanceSail: 14000, vh_DistanceAir: 210, vh_Builds: 100,
    },
  }],
};
const d = parseSelfDistances(clientPayload);
assert.ok(d, 'distances parsed');
assert.equal(d.distanceTraveled, 84210);
assert.equal(d.walk, 40000);
assert.equal(d.sail, 14000);
assert.equal(d.air, 210);
assert.deepEqual(Object.keys(d.raw).sort(), [
  'vh_DistanceAir', 'vh_DistanceRun', 'vh_DistanceSail', 'vh_DistanceTraveled', 'vh_DistanceWalk',
]);
// No distance counters → null (don't clobber with zeros).
assert.equal(parseSelfDistances({ reporter: 'X', players: [{ name: 'X', stats: { vh_Builds: 5 } }] }), null);

console.log('OK — all boss + distance parser assertions passed');
