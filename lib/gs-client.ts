// Pure parsing for the GsValheimStatsClient (0.2.9) per-player snapshot.
//
// Kept free of any Supabase / runtime imports so it can be unit-tested in
// isolation and imported by the /api/gs-ingest route without side effects.
//
// Shape derived from a decompile of the real mod DLL (Emit() StringBuilder):
//   { schemaVersion:1, game:'valheim', source:'client', reporter, world,
//     emittedAtUtc, snapshotIdLocal,
//     players:[ SELF, ...observedOthers ],
//     deathEvents:[…], bossKillEvents:[…], bossSelfDamage:[…] }
// where players[0] (name === reporter) is the ONLY authoritative cumulative
// source — it carries `stats` (raw .fch profile counters keyed "vh_<StatType>"),
// kills/deaths/bossKills, plus weapon/creature/craft/pickup/boss breakdowns.
// Further players[] entries are others the reporter merely observed (partial
// combat only) and are ignored here.

import type { GsClientStats } from './types';

type Obj = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Obj[]) : [];
}
function sumBy(rows: Obj[], key: string): number {
  return rows.reduce((acc, r) => acc + num(r[key]), 0);
}

export interface ParsedSelf {
  reporter: string;
  world: string | null;
  kills: number;
  deaths: number;
  bossKills: number;
  longestLifeSec: number;
  bestKillsBeforeDeath: number;
  resourcesHarvested: number;
  itemsCrafted: number;
  structuresBuilt: number;
  damageDealt: number;
  gsStats: GsClientStats;
}

/** Parse the reporter's authoritative per-player snapshot; null if malformed. */
export function parseSelfSnapshot(body: Obj): ParsedSelf | null {
  const reporter = str(body.reporter);
  if (!reporter) return null;
  const players = arr(body.players);
  const self =
    players.find(
      (p) => str(p.name) === reporter && (p.stats !== undefined || p.deaths !== undefined),
    ) ?? players.find((p) => p.stats !== undefined || p.deaths !== undefined);
  if (!self) return null;

  const stats = (self.stats && typeof self.stats === 'object' ? self.stats : {}) as Obj;
  const statNum = (k: string): number => num(stats[k]);

  const weapons = arr(self.weapons)
    .map((w) => ({
      weapon: str(w.weapon) ?? 'Unarmed',
      damageDealt: Math.round(num(w.damageDealt)),
      kills: num(w.kills),
      hardestHit: Math.round(num(w.hardestHit)),
      biggestSwing: Math.round(num(w.biggestSwing)),
    }))
    .sort((a, b) => b.damageDealt - a.damageDealt);

  const creatureKills = arr(self.creatureKills)
    .map((c) => ({ creature: str(c.creature) ?? '?', kills: num(c.kills) }))
    .filter((c) => c.kills > 0)
    .sort((a, b) => b.kills - a.kills);

  const bossDamage = arr(self.boss)
    .map((b) => ({
      boss: str(b.boss) ?? '?',
      damageDealt: Math.round(num(b.damageDealt)),
      fightSec: num(b.fightSec),
    }))
    .filter((b) => b.damageDealt > 0)
    .sort((a, b) => b.damageDealt - a.damageDealt);

  const skills = arr(self.skills)
    .map((s) => ({ skill: str(s.skill) ?? '?', level: Math.floor(num(s.level)) }))
    .filter((s) => s.level > 0)
    .sort((a, b) => b.level - a.level);

  const materials = arr(self.materials)
    .map((m) => ({ material: str(m.material) ?? '?', amount: num(m.amount) }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const damageDealt = Math.round(sumBy(weapons, 'damageDealt'));
  const resourcesHarvested = sumBy(arr(self.pickups), 'count');
  // Prefer the authoritative profile counter; fall back to the per-item breakdown.
  const itemsCrafted = statNum('vh_Crafts') || sumBy(arr(self.crafts), 'count');
  const structuresBuilt = statNum('vh_Builds');

  const top = weapons[0];
  const gsStats: GsClientStats = {
    weapons: weapons.slice(0, 12),
    creatureKills: creatureKills.slice(0, 15),
    bossDamage,
    skills: skills.slice(0, 12),
    materials: materials.slice(0, 12),
    records: {
      topWeapon: top?.weapon ?? null,
      topWeaponDamage: top?.damageDealt ?? 0,
      hardestHit: weapons.reduce((m, w) => Math.max(m, w.hardestHit), 0),
      biggestSwing: weapons.reduce((m, w) => Math.max(m, w.biggestSwing), 0),
    },
    currentLifeStartedUtc: str(self.currentLifeStartedUtc),
    platformId: str(self.platformId),
  };

  return {
    reporter,
    world: str(body.world),
    kills: num(self.kills),
    deaths: num(self.deaths),
    bossKills: num(self.bossKills),
    longestLifeSec: num(self.longestLifeSec),
    bestKillsBeforeDeath: num(self.bestKillsBeforeDeath),
    resourcesHarvested,
    itemsCrafted,
    structuresBuilt,
    damageDealt,
    gsStats,
  };
}
