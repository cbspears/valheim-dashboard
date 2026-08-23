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
import { FISH } from '../config/fish';

type Obj = Record<string, unknown>;

// Fish are ordinary pickup items — their per-species counts ride along in the
// same `pickups[]` breakdown as wood/stone/etc. `config/fish.ts` is the single
// source of truth for known ids; ⚠️ re-verify against a live payload the first
// time someone fishes on the test world (expected shape: `Fish1`…`Fish12`).
const FISH_ITEM_IDS = new Set(Object.keys(FISH));
/** Any pickup id shaped like a fish prefab, known or not — used to self-report gaps. */
const FISH_SHAPED = /^Fish\d/i;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** Is this key GENUINELY present as a usable number (vs absent / null / junk)? */
function isNum(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
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

/**
 * WHERE THIS PARSE CAME FROM — the completeness/provenance record that the
 * world-baseline layer's capture gate runs on (lib/gs-baseline
 * captureQualification).
 *
 * Every number below is derived with `num()`, which turns "absent" and "junk"
 * alike into 0. That is right for a merge (GREATEST ignores a 0) but CATASTROPHIC
 * for a capture: baselining a field at 0 because the payload simply didn't carry
 * it makes the next complete snapshot's LIFETIME total look like it was all
 * earned here (the Chærlie incident, reproduced straight through the baseline
 * fix). So the parser records what it actually SAW, and the baseline layer
 * captures a zero-point ONLY for the groups these flags say were really there,
 * recording every other group as an explicit HOLE that credits nothing until it
 * first appears (lib/gs-baseline BASELINE_GROUPS / snapshotHoles).
 *
 * Every flag is PRESENCE, never truthiness: a genuine 0 (or an empty list) is a
 * real zero-point — a brand-new viking must be able to baseline — while absent
 * or junk is no information at all.
 */
export interface SelfProvenance {
  /**
   * The players[] entry used was the reporter's OWN (name === reporter), not the
   * "first entry carrying stats/deaths" fallback. A bystander entry carries only
   * what the reporter observed of someone else — never a zero-point.
   */
  ownEntry: boolean;
  /** `stats` (the raw .fch profile counter map) was present as an object. */
  hasStats: boolean;
  /** kills / deaths present as real numbers on the entry. */
  hasKills: boolean;
  hasDeaths: boolean;
  /** bossKills present as a real number on the entry. */
  hasBossKills: boolean;
  /** longestLifeSec / bestKillsBeforeDeath present as real numbers. */
  hasLongestLifeSec: boolean;
  hasBestKillsBeforeDeath: boolean;
  /** vh_Builds present as a real number in `stats`. */
  hasBuilds: boolean;
  /**
   * vh_DistanceTraveled present as a real number in `stats`. Diagnostic only —
   * the baseline layer gates distance on `parseSelfDistances(body) !== null`
   * (any usable vh_Distance* reading), never on this one key.
   */
  hasDistance: boolean;
  /** pickups[] present (resourcesHarvested + the fish breakdown come from it). */
  hasPickups: boolean;
  /** weapons[] present (damageDealt + every per-weapon counter/record). */
  hasWeapons: boolean;
  /** creatureKills[] present (the per-creature kill breakdown). */
  hasCreatureKills: boolean;
  /** boss[] present (per-boss damage + fight seconds). */
  hasBoss: boolean;
  /** materials[] present (the per-material harvest breakdown). */
  hasMaterials: boolean;
  /** skills[] present (per-skill LEVELS — the Anglers board reads Fishing). */
  hasSkills: boolean;
  /**
   * Which source itemsCrafted was read from. The two sources are NOT
   * interchangeable — differencing a vh_Crafts baseline against a crafts[]-summed
   * snapshot (or vice versa) compares unlike against unlike, so the baseline
   * records this and refuses to credit across a source change.
   */
  craftsSource: 'vh_Crafts' | 'crafts' | 'none';
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
  /** The long-tail blob as stored: top-N capped (see capGsStats). */
  gsStats: GsClientStats;
  /**
   * The SAME blob before the top-N caps. World-baseline accounting
   * (lib/gs-baseline) must difference the uncapped lists: a weapon or creature
   * that only ranks inside the top-N once it has been used HERE would otherwise
   * be dropped before it could ever be measured against its zero-point.
   */
  gsStatsFull: GsClientStats;
  /** What this payload actually carried — the baseline capture gate reads it. */
  provenance: SelfProvenance;
}

/**
 * Apply the display caps to a long-tail blob: top-12 weapons / materials,
 * top-15 creatures, top-12 skills — but never silently drop Fishing (a viking
 * with 12 better skills would otherwise lose their Angler entry). Boss damage
 * and fish are uncapped (bounded by the game). Split out of parseSelfSnapshot
 * so the baseline layer can cap AFTER differencing, on the same rules.
 */
export function capGsStats(gs: GsClientStats): GsClientStats {
  const top12Skills = gs.skills.slice(0, 12);
  const fishingSkill = gs.skills.find((sk) => sk.skill === 'Fishing');
  return {
    ...gs,
    weapons: gs.weapons.slice(0, 12),
    creatureKills: gs.creatureKills.slice(0, 15),
    materials: gs.materials.slice(0, 12),
    skills:
      fishingSkill && !top12Skills.some((sk) => sk.skill === 'Fishing')
        ? [...top12Skills, fishingSkill]
        : top12Skills,
  };
}

/**
 * Identity key for matching a players[] entry against `reporter`.
 *
 * CASE- AND WHITESPACE-INSENSITIVE ON PURPOSE. The two strings come from two
 * different places in the mod — `reporter` from its config/profile name, each
 * players[] `name` from the live Player object — and a skew of case or a stray
 * space between them used to be fatal, not cosmetic: no own entry was found, the
 * parse silently fell through to the BYSTANDER branch, and the baseline layer
 * (which will never seed a zero-point from a bystander) deferred that character
 * FOREVER. They would post every ~120s and never appear on the dashboard at all.
 * Matching on the folded key costs nothing — two DIFFERENT vikings can't share a
 * name modulo case, because Valheim character names are what the roster keys on —
 * and bystander semantics are otherwise unchanged.
 */
function identityKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * The reporter's OWN players[] entry, or the bystander fallback (first entry
 * carrying stats/deaths) when they hadn't spawned yet. Shared by
 * parseSelfSnapshot and parseSelfDistances so the two can never disagree about
 * WHOSE numbers they are reading.
 */
function findSelfEntry(body: Obj): { self: Obj | undefined; own: Obj | undefined } {
  const key = identityKey(body.reporter);
  const players = arr(body.players);
  const own = key
    ? players.find((p) => identityKey(p.name) === key && (p.stats !== undefined || p.deaths !== undefined))
    : undefined;
  // The fallback (first entry carrying stats/deaths) keeps deaths/observed data
  // flowing when the reporter's own entry is missing — but it is NOT the
  // reporter's career, so it is marked as such and can never seed a zero-point.
  const self = own ?? players.find((p) => p.stats !== undefined || p.deaths !== undefined);
  return { self, own };
}

/** Parse the reporter's authoritative per-player snapshot; null if malformed. */
export function parseSelfSnapshot(body: Obj): ParsedSelf | null {
  const reporter = str(body.reporter);
  if (!reporter) return null;
  const { self, own } = findSelfEntry(body);
  if (!self) return null;

  const hasStats = !!self.stats && typeof self.stats === 'object' && !Array.isArray(self.stats);
  const stats = (hasStats ? self.stats : {}) as Obj;
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

  // Fish are items — species counts ride along in the same pickups[] breakdown
  // as every other resource. No cap (≤12 known species); unknown Fish*-shaped
  // ids are logged so the config/fish.ts map self-reports gaps.
  const pickups = arr(self.pickups);
  const fish = pickups
    .map((p) => ({ item: str(p.item) ?? '?', count: num(p.count) }))
    .filter((p) => FISH_ITEM_IDS.has(p.item) && p.count > 0)
    .sort((a, b) => b.count - a.count);
  for (const p of pickups) {
    const item = str(p.item);
    if (item && FISH_SHAPED.test(item) && !FISH_ITEM_IDS.has(item)) {
      console.info(`[gs-client] unrecognized fish-shaped pickup id: ${item} (add to config/fish.ts)`);
    }
  }

  const materials = arr(self.materials)
    .map((m) => ({ material: str(m.material) ?? '?', amount: num(m.amount) }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const damageDealt = Math.round(sumBy(weapons, 'damageDealt'));
  // Fish are pickups too — counted here same as every other resource, no
  // double-subtract; the fish[] breakdown above is purely additive detail.
  const resourcesHarvested = sumBy(pickups, 'count');
  // Prefer the authoritative profile counter; fall back to the per-item breakdown.
  // Chosen by PRESENCE, not by truthiness: `vh_Crafts || sumBy(crafts)` silently
  // switched source whenever the profile counter read 0, so a baseline captured
  // from one source could later be differenced against the other (unlike against
  // unlike). The source is recorded in provenance and the baseline layer refuses
  // to credit itemsCrafted across a source change.
  const craftsSource: SelfProvenance['craftsSource'] = isNum(stats.vh_Crafts)
    ? 'vh_Crafts'
    : Array.isArray(self.crafts)
      ? 'crafts'
      : 'none';
  const itemsCrafted = craftsSource === 'vh_Crafts' ? statNum('vh_Crafts') : sumBy(arr(self.crafts), 'count');
  const structuresBuilt = statNum('vh_Builds');

  // Built UNCAPPED first (records are derived from every weapon), then capped for
  // storage by capGsStats — the baseline layer needs the uncapped lists.
  const top = weapons[0];
  const gsStatsFull: GsClientStats = {
    weapons,
    creatureKills,
    bossDamage,
    skills,
    materials,
    fish,
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
    gsStats: capGsStats(gsStatsFull),
    gsStatsFull,
    provenance: {
      ownEntry: self === own,
      hasStats,
      hasKills: isNum(self.kills),
      hasDeaths: isNum(self.deaths),
      hasBossKills: isNum(self.bossKills),
      hasLongestLifeSec: isNum(self.longestLifeSec),
      hasBestKillsBeforeDeath: isNum(self.bestKillsBeforeDeath),
      hasBuilds: isNum(stats.vh_Builds),
      hasDistance: isNum(stats.vh_DistanceTraveled),
      // Array PRESENCE, not length: an empty list is a real "this character has
      // none of that yet" (a perfectly good zero-point), while an ABSENT list is
      // no information at all and must become a baseline hole instead of a 0.
      hasPickups: Array.isArray(self.pickups),
      hasWeapons: Array.isArray(self.weapons),
      hasCreatureKills: Array.isArray(self.creatureKills),
      hasBoss: Array.isArray(self.boss),
      hasMaterials: Array.isArray(self.materials),
      hasSkills: Array.isArray(self.skills),
      craftsSource,
    },
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
  /**
   * The raw vh_Distance* subset, verbatim — and the PRESENCE RECORD for the five
   * modes above. Only keys the payload genuinely carried as finite numbers are
   * in here, so `'vh_DistanceSail' in raw` is the honest answer to "did this
   * snapshot say anything about sailing?", where `sail === 0` cannot be
   * (absent and zero both read 0). lib/gs-baseline baselines only the modes
   * present here and holes the rest.
   */
  raw: Record<string, number>;
}

/** Per-mode distance → the raw `stats` key that carries it. */
export const DISTANCE_MODE_KEYS = {
  total: 'vh_DistanceTraveled',
  walk: 'vh_DistanceWalk',
  run: 'vh_DistanceRun',
  sail: 'vh_DistanceSail',
  air: 'vh_DistanceAir',
} as const;

export type DistanceMode = keyof typeof DISTANCE_MODE_KEYS;

/**
 * Pull the raw distance counters out of the reporter's `stats` map
 * (keys "vh_<PlayerStatType>": DistanceTraveled/Walk/Run/Sail/Air, metres —
 * enum names verified against services/stats-parser/src/fch.js). Returns null
 * when the self entry / stats map is absent, or when every distance is zero.
 *
 * NULL IS THE DISTANCE PRESENCE SIGNAL the baseline layer gates on — deliberately
 * "any usable reading", never one named key. A payload carrying only
 * `vh_DistanceWalk` (no total) still yields a snapshot; a payload carrying
 * nothing usable yields null, and lib/gs-baseline records distance as a HOLE
 * rather than baselining it at 0 (a 0 there is what put 410 km sailed on another
 * server onto the Great Deeds ladder).
 */
export function parseSelfDistances(body: Obj): ParsedDistances | null {
  const { self } = findSelfEntry(body);
  const stats = (self?.stats && typeof self.stats === 'object' && !Array.isArray(self.stats) ? self.stats : {}) as Obj;

  // PRESENCE, not value. Only vh_Distance* keys that are genuinely finite
  // numbers go in — junk is as absent as missing (rule 5: fail toward zero).
  const raw: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (/^vh_Distance/.test(k) && isNum(v)) raw[k] = Math.round(v as number);
  }
  // NULL means "this payload said NOTHING usable about distance" — the signal
  // lib/gs-baseline holes on. It deliberately does NOT mean "every distance
  // reads zero": a viking who genuinely hasn't moved yet has a perfectly good
  // zero-point, and treating that as unknown would cost them their first leg.
  if (Object.keys(raw).length === 0) return null;

  const g = (k: string): number => raw[k] ?? 0;
  return {
    distanceTraveled: g(DISTANCE_MODE_KEYS.total),
    walk: g(DISTANCE_MODE_KEYS.walk),
    run: g(DISTANCE_MODE_KEYS.run),
    sail: g(DISTANCE_MODE_KEYS.sail),
    air: g(DISTANCE_MODE_KEYS.air),
    raw,
  };
}
