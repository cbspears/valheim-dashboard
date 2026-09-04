// Unit test for the GsValheimStats boss-detection + distance parsers, using
// payloads built to match the DECOMPILED Emitter/Client Emit() output exactly.
//   npx tsx scripts/gs-boss.test.mjs
import {
  parseBossMilestones,
  parseBossKillEvents,
  parseBossFighters,
  parseSelfDistances,
  BOSS_MILESTONE_KEY_TO_NAME,
  BOSS_OBJECT_TO_NAME,
} from '../lib/gs-client.ts';
import { planBossKillUpdate } from '../lib/boss-damage.ts';
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
// Forsaken VIII / Deep North has NO defeat key — never auto-fires.
assert.ok(!Object.values(BOSS_MILESTONE_KEY_TO_NAME).includes('Forsaken VIII'));

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

// ── 4. parseBossFighters: TRUE fighters (damage>0) ∪ bossKillEvents MVPs ──────
// Mirrors the real Emitter server payload: players[].boss[] carries per-player
// cumulative { boss:<gameObject>, kills, damageDealt }; only damage>0 counts, and
// the online roster (which may include non-combatants) is NOT a fighter source.
const fightersPayload = {
  onlinePlayers: ['Steve', 'Testmantwo', 'Ivar Hollowleg'], // Ivar was online but idle
  players: [
    { name: 'Steve', boss: [{ boss: 'Eikthyr', kills: 1, damageDealt: 277 }], weapons: [] },
    { name: 'Testmantwo', boss: [{ boss: 'Eikthyr', kills: 0, damageDealt: 140 }], weapons: [] },
    { name: 'Ivar Hollowleg', boss: [{ boss: 'Eikthyr', kills: 0, damageDealt: 0 }], weapons: [] },
    { name: 'Runa', boss: [{ boss: 'gd_king', kills: 0, damageDealt: 55 }], weapons: [] },
  ],
  bossKillEvents: [
    { boss: 'Eikthyr', fightSec: 82, firstBlood: 'Steve', topDamagePlayer: 'Steve', topDamage: 277, participants: 2, tsUtc: ts },
  ],
};
const fighters = parseBossFighters(fightersPayload);
assert.deepEqual([...fighters.Eikthyr].sort(), ['Steve', 'Testmantwo'], 'Eikthyr fighters = damage-dealers only, Ivar (0 dmg / idle) excluded');
assert.deepEqual(fighters['The Elder'], ['Runa'], 'gd_king maps to The Elder via its lone damage-dealer');
// bossKillEvents MVPs are unioned in even if a player somehow lacked a players[] damage row.
const mvpOnly = parseBossFighters({
  players: [],
  bossKillEvents: [{ boss: 'Bonemass', firstBlood: 'Ulf', topDamagePlayer: 'Sigrid', topDamage: 10, participants: 2, tsUtc: ts }],
});
assert.deepEqual(mvpOnly.Bonemass.sort(), ['Sigrid', 'Ulf'], 'MVPs union in for a boss with no players[] damage rows');
// No fighters derivable → empty map (caller degrades to the online roster).
assert.deepEqual(parseBossFighters({ onlinePlayers: ['A', 'B'] }), {}, 'roster alone yields no fighters');


// ── 4. What an UNAUTHENTICATED client bossKillEvents report may do ──────────
//
// /api/gs-ingest accepts `source:'client'` with NO token (the mod runs on
// players' PCs and cannot hold a secret) and the POST URL ships in the public
// Thunderstore pack. Before 2026-09-04 a single curl — no token, no reporter —
// could name any string as firstBlood/topDamagePlayer and it went straight into
// bosses.fight_stats.fighters and players_present: the war room renders those
// verbatim and the Discord bot's Player-of-the-Day "boss-slayer" scorer reads
// them. Worse, unfelled bosses were included in the read, so a ghost could be
// pre-seeded and then promoted into the real war party at the kill flip.
//
// planBossKillUpdate is where every rule now lives, so each one is asserted here
// rather than only in the route. (The reporter-required and reporter-must-resolve
// gates live in the route itself — they decide whether we get this far at all.)
const roster = new Map([
  ['bren', 'Bren'],
  ['chærleif', 'ChÆrleif'],
  ['lóa', 'Lóa'],
]);
const kill = {
  firstBlood: 'Bren',
  topDamagePlayer: 'Lóa',
  fightSec: 240,
  topDamage: 201,
  participants: 3,
  tsUtc: '2026-09-01T20:00:00Z',
};

// (a) A SERVER report is trusted exactly as before — no roster needed, and it
//     may describe a boss however it likes.
{
  const plan = planBossKillUpdate({
    source: 'server',
    isKilled: true,
    existing: null,
    priorPresent: [],
    report: kill,
    canonical: null,
  });
  assert.ok(plan.fightStats, 'a server report always lands');
  assert.equal(plan.fightStats.source, 'server');
  assert.equal(plan.fightStats.topDamagePlayer, 'Lóa');
  assert.deepEqual(plan.playersPresent.sort(), ['Bren', 'Lóa'], 'MVPs union into players_present');
}

// (b) RULE 1 — a client may not touch a boss that is not felled yet. This is the
//     pre-seeding hole: all 7 unfelled bosses have fight_stats null and
//     players_present [], and the milestone flip later promotes whatever it finds.
{
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: false,
    existing: null,
    priorPresent: [],
    report: kill,
    canonical: roster,
  });
  assert.equal(plan.fightStats, null, 'client report on an unfelled boss is dropped');
  assert.match(plan.note, /not felled/);
}

// (c) RULE 2 — a client may not rewrite the SERVER's record, however many
//     participants it claims. The live Eikthyr row is source 'gs-milestone' with
//     tsUtc null, so the old keepExisting test was false for ANY incoming report:
//     one unauthenticated POST could have rewritten the only real fight record on
//     the server.
for (const priorSource of ['server', 'gs-milestone']) {
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: { source: priorSource, topDamagePlayer: 'Lóa', fighters: ['Lóa'], tsUtc: null, participants: null },
    priorPresent: ['Lóa'],
    report: { ...kill, topDamagePlayer: 'Bren', participants: 99 },
    canonical: roster,
  });
  assert.equal(plan.fightStats, null, `client report cannot overwrite a ${priorSource} record`);
  assert.match(plan.note, /may not rewrite/);
}

// (d) …but it MAY fill a felled boss that has no server record (that is the
//     whole point of accepting client reports).
{
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: null,
    priorPresent: [],
    report: kill,
    canonical: roster,
  });
  assert.ok(plan.fightStats, 'a felled boss with no server record is fillable');
  assert.equal(plan.fightStats.source, 'client');
  assert.equal(plan.fightStats.firstBlood, 'Bren');
}
// A client's own earlier report is not a server record, so it may be refined.
{
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: { source: 'client', fighters: ['Bren'], tsUtc: '2026-09-01T19:00:00Z', participants: 1 },
    priorPresent: ['Bren'],
    report: kill,
    canonical: roster,
  });
  assert.ok(plan.fightStats, 'a prior CLIENT record is still refinable');
  assert.equal(plan.fightStats.participants, 3);
}

// (e) RULE 3 — names must canonicalize against the players roster. An unknown
//     name is dropped and reported; a case-skewed one collapses onto the roster's
//     own spelling instead of minting a second viking.
{
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: null,
    priorPresent: [],
    report: { ...kill, firstBlood: 'Ghost', topDamagePlayer: 'chærleif' },
    canonical: roster,
  });
  assert.equal(plan.fightStats.firstBlood, null, 'a name the roster has never seen is dropped');
  assert.equal(plan.fightStats.topDamagePlayer, 'ChÆrleif', 'a case skew collapses onto the roster spelling');
  assert.deepEqual(plan.fightStats.fighters, ['ChÆrleif'], 'no phantom viking in the war party');
  assert.deepEqual(plan.playersPresent, ['ChÆrleif']);
  assert.match(plan.note, /Ghost/);
}
{
  // Both names unknown → nothing is added at all (and players_present is left
  // untouched, so the caller skips that write).
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: { source: 'client', fighters: ['Bren'] },
    priorPresent: ['Bren'],
    report: { ...kill, firstBlood: 'Ghost', topDamagePlayer: 'Phantom' },
    canonical: roster,
  });
  assert.deepEqual(plan.fightStats.fighters, ['Bren'], 'the honest war party is unchanged');
  assert.equal(plan.playersPresent, undefined, 'players_present is not rewritten when nothing grew');
}

// (f) RULE 4 (the cap) is enforced at parse time, before any of this: a 500-char
//     MVP name is truncated to 32 and rich-text markup is stripped, so nothing
//     oversized or styled can reach a sign, an embed or the war room.
{
  const [parsed] = parseBossKillEvents([
    {
      boss: 'Eikthyr(Clone)',
      tsUtc: ts,
      firstBlood: 'X'.repeat(500),
      topDamagePlayer: '<color=red>Bren</color>',
      topDamage: 10,
      participants: 2,
      fightSec: 60,
    },
  ]);
  assert.equal(parsed.firstBlood.length, 32, 'MVP names capped at 32 chars');
  assert.equal(parsed.topDamagePlayer, 'Bren', 'rich-text markup stripped from MVP names');
}

// (g) The ledgers a report must never clobber: the client-damage map and the
//     observed-damage high-water marks (dropping the latter would re-credit every
//     observed blow on the next ~120s post), plus the kill-time online roster.
{
  const plan = planBossKillUpdate({
    source: 'client',
    isKilled: true,
    existing: {
      source: 'client',
      fighters: ['Bren'],
      damage: { Bren: 120 },
      observed: { 'ChÆrleif': { Bren: 120 } },
      onlineAtKill: ['Bren', 'Lóa'],
      topDamageFrom: 'gs-client-damage',
    },
    priorPresent: ['Bren'],
    report: kill,
    canonical: roster,
  });
  assert.deepEqual(plan.fightStats.damage, { Bren: 120 }, 'the per-fighter damage map survives');
  assert.deepEqual(plan.fightStats.observed, { 'ChÆrleif': { Bren: 120 } }, 'the observed ledger survives');
  assert.deepEqual(plan.fightStats.onlineAtKill, ['Bren', 'Lóa'], 'the kill-time roster survives');
  assert.equal(plan.fightStats.topDamageFrom, undefined, 'the fallback marker retires with the real verdict');
}

console.log('OK — all boss + distance parser assertions passed, and every client bossKillEvents rule holds');
