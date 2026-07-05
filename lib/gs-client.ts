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

// ─── Boss detection (server milestones + client/server bossKillEvents) ────────
//
// Ground truth from the GsValheimStatsEmitter 0.2.x decompile:
//   • milestones[] = [{ key, label, kind, tsUtc }] where kind ∈
//     'boss'|'bounty'|'progression'. Boss milestones are exactly the seven
//     `defeated_*` Valheim global keys below (the Emitter tags kind='boss' via
//     key.StartsWith("defeated_")). NEW-only per emitter process, but its
//     knownKeys set is persisted in state.tsv — so on a fresh deploy / lost
//     state file EVERY existing global key re-fires as a milestone at once.
//     => the DB write MUST be idempotent (only flip a bosses row still
//        is_killed=false). Mini-boss defeats (defeated_serpent, …) are NOT in
//        this map and are deliberately not matched.
//   • bossKillEvents[] (both source:'server' and source:'client') =
//     [{ boss, fightSec, firstBlood, topDamagePlayer, topDamage, participants,
//        tsUtc }] where `boss` is the creature gameObject name (Eikthyr, gd_king,
//        Dragon, …) — NOT the global key. Mapped via BOSS_OBJECT_TO_NAME.
//
// Both maps resolve to the exact `bosses.name` values seeded in Supabase.
// The Bog Witch (bosses row, biome "Deep North") has NO entry in either map:
// Valheim ships no Deep North boss / global key yet, so it can never auto-fire
// — it stays manual (scripts/mark-boss.js) until the update lands.

/** Valheim boss-defeat global key (milestone `key`) → `bosses.name`. */
export const BOSS_MILESTONE_KEY_TO_NAME: Record<string, string> = {
  defeated_eikthyr: 'Eikthyr',
  defeated_gdking: 'The Elder',
  defeated_bonemass: 'Bonemass',
  defeated_dragon: 'Moder',
  defeated_goblinking: 'Yagluth',
  defeated_queen: 'The Queen',
  defeated_fader: 'Fader',
};

/** Boss creature gameObject name (bossKillEvents `boss`) → `bosses.name`. */
export const BOSS_OBJECT_TO_NAME: Record<string, string> = {
  Eikthyr: 'Eikthyr',
  gd_king: 'The Elder',
  Bonemass: 'Bonemass',
  Dragon: 'Moder',
  GoblinKing: 'Yagluth',
  SeekerQueen: 'The Queen',
  Fader: 'Fader',
};

export interface ParsedBossMilestone {
  key: string;
  bossName: string;
  tsUtc: string | null;
}

/**
 * Extract boss-defeat milestones from a server payload. Returns one entry per
 * recognized `defeated_*` global key (deduped within the payload). Ignores
 * bounty/progression milestones and any unmapped/mini-boss keys.
 */
export function parseBossMilestones(body: Obj): ParsedBossMilestone[] {
  const out: ParsedBossMilestone[] = [];
  const seen = new Set<string>();
  for (const m of arr(body.milestones)) {
    const key = str(m.key);
    if (!key || seen.has(key)) continue;
    const bossName = BOSS_MILESTONE_KEY_TO_NAME[key];
    if (!bossName) continue;
    seen.add(key);
    out.push({ key, bossName, tsUtc: str(m.tsUtc) });
  }
  return out;
}

/** Map a raw boss gameObject name (tolerating a "(Clone)" suffix) → bosses.name. */
function mapBossObject(raw: string): string | null {
  return BOSS_OBJECT_TO_NAME[raw] ?? BOSS_OBJECT_TO_NAME[raw.replace(/\(Clone\)$/i, '').trim()] ?? null;
}

/**
 * Derive the TRUE fighters per boss from a snapshot — the honest "who actually
 * swung at this beast", not the online roster at kill time.
 *
 * Two grounded sources, unioned:
 *   1. players[].boss[] — the Emitter's server-wide observed combat. Each player
 *      entry lists { boss: <gameObject>, kills, damageDealt }; a player who dealt
 *      damageDealt > 0 (or landed a kill) on that boss demonstrably fought it.
 *      (Emitter decompile: players[] iterates Bosses.Values, emitting an entry
 *      only when damageDealt > 0 || kills > 0.)
 *   2. bossKillEvents[].{firstBlood, topDamagePlayer} — the MVP/first-strike from
 *      the fight record (present on both server- and client-emitted payloads).
 *
 * Returns bosses.name → deduped fighter names. Empty map when nothing is derivable
 * (the caller degrades to the online roster rather than blanking the war party).
 */
export function parseBossFighters(body: Obj): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {};
  const add = (bossName: string, name: string | null) => {
    if (!name) return;
    (acc[bossName] ??= new Set()).add(name);
  };

  // 1. Per-player observed damage/kills on each boss.
  for (const p of arr(body.players)) {
    const name = str(p.name);
    if (!name) continue;
    for (const b of arr(p.boss)) {
      if (num(b.damageDealt) <= 0 && num(b.kills) <= 0) continue;
      const raw = str(b.boss);
      const bossName = raw ? mapBossObject(raw) : null;
      if (bossName) add(bossName, name);
    }
  }

  // 2. First-blood + top-damage heroes from the fight record.
  for (const e of parseBossKillEvents(body.bossKillEvents)) {
    add(e.bossName, e.firstBlood);
    add(e.bossName, e.topDamagePlayer);
  }

  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(acc)) out[k] = [...v];
  return out;
}

export interface ParsedBossKill {
  bossName: string;
  boss: string;
  fightSec: number;
  firstBlood: string | null;
  topDamagePlayer: string | null;
  topDamage: number;
  participants: number;
  tsUtc: string;
}

/**
 * Parse bossKillEvents[] (server- or client-emitted) into fight-detail rows,
 * mapping the raw creature name to `bosses.name` and dropping anything without
 * a mappable boss + a valid tsUtc (the dedupe key, mirroring deathEvents).
 */
export function parseBossKillEvents(raw: unknown): ParsedBossKill[] {
  return arr(raw)
    .map((e): ParsedBossKill | null => {
      const boss = str(e.boss);
      const tsUtc = str(e.tsUtc);
      if (!boss || !tsUtc || Number.isNaN(Date.parse(tsUtc))) return null;
      const bossName = BOSS_OBJECT_TO_NAME[boss] ?? BOSS_OBJECT_TO_NAME[boss.replace(/\(Clone\)$/i, '').trim()];
      if (!bossName) return null;
      return {
        bossName,
        boss,
        fightSec: Math.round(num(e.fightSec)),
        firstBlood: str(e.firstBlood),
        topDamagePlayer: str(e.topDamagePlayer),
        topDamage: Math.round(num(e.topDamage)),
        participants: Math.round(num(e.participants)),
        tsUtc,
      };
    })
    .filter((x): x is ParsedBossKill => x !== null);
}

export interface ParsedDistances {
  /** DistanceTraveled — the total the .fch profile tracks (metres). */
  distanceTraveled: number;
  walk: number;
  run: number;
  sail: number;
  air: number;
  /** The raw vh_Distance* subset, verbatim, for future leaderboards. */
  raw: Record<string, number>;
}

/**
 * Pull the raw distance counters out of the reporter's `stats` map
 * (keys "vh_<PlayerStatType>": DistanceTraveled/Walk/Run/Sail/Air, metres —
 * enum names verified against services/stats-parser/src/fch.js). Returns null
 * when the self entry / stats map is absent, or when every distance is zero.
 */
export function parseSelfDistances(body: Obj): ParsedDistances | null {
  const reporter = str(body.reporter);
  const players = arr(body.players);
  const self =
    (reporter ? players.find((p) => str(p.name) === reporter && (p.stats !== undefined || p.deaths !== undefined)) : undefined) ??
    players.find((p) => p.stats !== undefined || p.deaths !== undefined);
  const stats = (self?.stats && typeof self.stats === 'object' ? self.stats : {}) as Obj;
  const g = (k: string): number => Math.round(num(stats[k]));

  const distanceTraveled = g('vh_DistanceTraveled');
  const walk = g('vh_DistanceWalk');
  const run = g('vh_DistanceRun');
  const sail = g('vh_DistanceSail');
  const air = g('vh_DistanceAir');

  const raw: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (/^vh_Distance/.test(k)) raw[k] = Math.round(num(v));
  }
  if (distanceTraveled <= 0 && walk <= 0 && run <= 0 && sail <= 0 && air <= 0) return null;
  return { distanceTraveled, walk, run, sail, air, raw };
}
