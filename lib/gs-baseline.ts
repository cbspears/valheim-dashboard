// World baselines for the GsValheimStatsClient snapshot — delta accounting.
//
// THE PROBLEM. A Valheim character file carries LIFETIME totals: kills, deaths,
// builds, crafts, distance, every vh_* profile counter, accumulated across every
// world and every server that character has ever visited. The client mod reads
// those numbers straight out of the local .fch profile and POSTs them to
// /api/gs-ingest, which GREATEST-merges them into player_stats. So a veteran
// character imported from somewhere else arrives pre-loaded and floods the clan
// totals (real incident: "Chærlie" showed up with 1,526 kills / 163 deaths /
// 27,207 builds, none of it earned on Eilif). Leaderboards, Living Titles and
// the Great Deeds ladder all read those columns, so one import distorts
// everything.
//
// THE FIX. The FIRST client snapshot a character posts becomes their zero-point
// (their "world baseline"), stored verbatim in player_stats.gs_baseline. From
// then on the server credits only what has been earned SINCE:
//
//     effective = clamp0(raw − baseline)          per counter
//     effective = raw > baseline ? raw : 0        per record/max field
//
// A fresh character baselines at ~0, so nothing changes for them. A veteran
// baselines at their lifetime totals and starts from zero like everyone else.
// Because the baseline is fixed, `effective` is monotonically non-decreasing —
// which is exactly what the existing GREATEST merge in /api/gs-ingest needs to
// stay a safe out-of-order guard.
//
// FIELD KINDS. Three of them, and the distinction is the whole design:
//   • counters  — kills, deaths, builds, crafts, resources, damage, distance,
//     per-creature kills, per-species catches, per-weapon damage/kills, boss
//     damage, materials. Cumulative, only ever grow → subtract the baseline.
//   • records   — longest life, best kills in a life, per-weapon hardest hit /
//     biggest swing, skill levels. A max, not a total: subtracting is
//     meaningless, so instead we SUPPRESS the value until it EXCEEDS the
//     baselined record. A veteran's 475-damage hit from another server stays
//     hidden until they beat it here; skill levels work the same way, which
//     keeps the Anglers board (ranked on Fishing level) honest rather than
//     handing it to whoever imported the most-levelled character.
//   • pass-through — platformId, currentLifeStartedUtc, weapon/creature/boss
//     names. Not quantities; carried across untouched.
//
// PURE MODULE — no Supabase, no I/O, so scripts/gs-baseline.test.mjs can drive
// every rule directly. The route owns persistence and the GREATEST merge.

// ─────────────────────────────────────────────────────────────────────────────
// FIVE RULES THIS MODULE ENFORCES (each one is a bug that got through review):
//
//  1. A zero-point is captured ONLY from the reporter's OWN players[] entry, and
//     ONLY for the groups that entry actually CARRIED. Every group the payload
//     did not carry is recorded as an explicit HOLE — a third state, distinct
//     from both 0 and {} — which credits nothing until it first appears and then
//     takes its zero-point from THAT snapshot. A field baselined at 0 merely
//     because the payload didn't carry it turns the next snapshot's lifetime
//     total into "earned here". See BASELINE_GROUPS / snapshotHoles / holes.
//  2. A reset is only believed after N CONSECUTIVE qualifying low snapshots, and
//     the superseded zero-point is kept FOREVER as a PER-COUNTER CEILING: no
//     amount of "recovery" back toward it is ever credited, with no expiry. A
//     stale cloud save must not be able to permanently lower the zero-point.
//  3. Nothing that was earned here is ever destroyed. Every counter — column,
//     map, and every list inside gs_stats — merges per key with GREATEST
//     (mergeIntoRow), so a later, smaller, or partial snapshot can only ever
//     add. There is no wholesale blob replacement and no freeze.
//  4. Capture and delta always difference LIKE against LIKE: the baseline records
//     which parse source itemsCrafted came from, and a source change credits zero
//     rather than a spurious jump.
//  5. Anything unreadable, incomplete or malformed fails toward crediting ZERO,
//     never toward crediting a lifetime total.
//
// …and one rule about the OTHER failure direction, which is just as real:
//
//  6. A viking is NEVER muted. The capture gate asks for the reporter's own
//     entry plus kills/deaths and NOTHING else, because every extra hard
//     requirement was a way to defer a real player forever: a fisher who never
//     builds has no vh_Builds, and the mod's own canonical payload carries no
//     vh_Distance* keys at all. Both used to defer on every single post — no
//     baseline, no write, no gs_updated_at, no Great Deeds — for as long as they
//     played. Holes are what make that unnecessary: capture what is there, hole
//     what is not.
// ─────────────────────────────────────────────────────────────────────────────

import type { GsClientStats } from './types';
import {
  capGsStats,
  DISTANCE_MODE_KEYS,
  type DistanceMode,
  type ParsedSelf,
  type ParsedDistances,
  type SelfProvenance,
} from './gs-client';

export const GS_BASELINE_VERSION = 1;

// ── the GROUP table: every baselinable thing, and what carries it ────────────
//
// A GROUP is the unit of holing. It is deliberately coarse — one group per
// source list/key in the payload — because presence is a property of the SOURCE,
// not of an individual entry: if `weapons[]` is absent then every per-weapon
// counter AND record is unknown together, and if `pickups[]` is absent then both
// resourcesHarvested and the whole fish breakdown are unknown together.
//
// `carries` answers one question: did THIS snapshot carry the group at all?
// Presence, never truthiness — an empty weapons[] means "no weapon combat yet"
// (a real zero-point); an absent weapons[] means "no idea" (a hole).

export type BaselineSection = 'counters' | 'records' | 'counterMaps' | 'recordMaps';

export interface BaselineGroup {
  /** `${section}.${key}` — the identifier stored in `holes` and logged. */
  path: string;
  section: BaselineSection;
  key: string;
  /**
   * Did this snapshot carry the group? `hasDistances` is
   * `parseSelfDistances(body) !== null` — ANY usable distance reading, never one
   * named key (a payload with only vh_DistanceWalk still counts).
   */
  carries: (p: SelfProvenance, hasDistances: boolean) => boolean;
  /**
   * CLOSED KEY SET: for this map, a key ABSENT from the stored zero-point is a
   * per-key HOLE (credits 0, fills on first sighting), NOT "the character had
   * none of that at capture".
   *
   * The default is the opposite, and rightly so: a creature/fish/weapon/material
   * the payload doesn't list is one this character has genuinely never
   * killed/caught/used, so the day it appears it is fully credited (rule 3).
   * Distances are the exception because their keys are a FIXED set the game
   * always conceptually has — `parseSelfDistances` synthesizes the five modes,
   * and an absent vh_DistanceSail reads 0 exactly like a real zero. Treating
   * that as "has never sailed" is what let a payload carrying only
   * vh_DistanceTraveled baseline walk/run/sail at 0 and then credit 1,140 km
   * walked and 410 km sailed on another server the moment the mode keys showed
   * up. No viking ever "discovers" a new distance mode, so nothing is lost.
   */
  closedKeys?: boolean;
}

const g = (
  section: BaselineSection,
  key: string,
  carries: BaselineGroup['carries'],
  closedKeys = false,
): BaselineGroup => ({ path: `${section}.${key}`, section, key, carries, closedKeys });

/** Always true: kills/deaths are the capture gate's own precondition. */
const ALWAYS = () => true;

export const BASELINE_GROUPS: readonly BaselineGroup[] = [
  // scalar cumulative counters mirrored into player_stats columns
  g('counters', 'kills', ALWAYS),
  g('counters', 'deaths', ALWAYS),
  g('counters', 'bossKills', (p) => p.hasBossKills),
  g('counters', 'resourcesHarvested', (p) => p.hasPickups),
  g('counters', 'itemsCrafted', (p) => p.craftsSource !== 'none'),
  g('counters', 'structuresBuilt', (p) => p.hasBuilds),
  g('counters', 'damageDealt', (p) => p.hasWeapons),
  g('counters', 'distanceTraveled', (_p, hasDistances) => hasDistances),
  // scalar record/max fields — gated, never differenced
  g('records', 'longestLifeSec', (p) => p.hasLongestLifeSec),
  g('records', 'bestKillsBeforeDeath', (p) => p.hasBestKillsBeforeDeath),
  // per-key counter maps inside gs_stats (structure-wise deltas)
  g('counterMaps', 'weaponDamage', (p) => p.hasWeapons),
  g('counterMaps', 'weaponKills', (p) => p.hasWeapons),
  g('counterMaps', 'creatureKills', (p) => p.hasCreatureKills),
  g('counterMaps', 'bossDamage', (p) => p.hasBoss),
  g('counterMaps', 'bossFightSec', (p) => p.hasBoss),
  g('counterMaps', 'materials', (p) => p.hasMaterials),
  g('counterMaps', 'fish', (p) => p.hasPickups),
  g('counterMaps', 'distances', (_p, hasDistances) => hasDistances, true),
  g('counterMaps', 'distancesRaw', (_p, hasDistances) => hasDistances, true),
  // per-key record maps inside gs_stats (gated, never differenced)
  g('recordMaps', 'weaponHardestHit', (p) => p.hasWeapons),
  g('recordMaps', 'weaponBiggestSwing', (p) => p.hasWeapons),
  g('recordMaps', 'skills', (p) => p.hasSkills),
];

/** Every legal `holes` entry — anything else in stored jsonb is ignored. */
export const BASELINE_GROUP_PATHS: ReadonlySet<string> = new Set(BASELINE_GROUPS.map((x) => x.path));

/** counterMaps whose keys are a fixed set, so an absent key is a per-key hole. */
const CLOSED_KEY_MAPS: ReadonlySet<string> = new Set(
  BASELINE_GROUPS.filter((x) => x.closedKeys && x.section === 'counterMaps').map((x) => x.key),
);

const groupsOf = (section: BaselineSection) => BASELINE_GROUPS.filter((x) => x.section === section);

/** Scalar cumulative counters mirrored into player_stats columns. */
export const BASELINE_COUNTER_KEYS = groupsOf('counters').map((x) => x.key);
/** Scalar record/max fields — gated, never differenced. */
export const BASELINE_RECORD_KEYS = groupsOf('records').map((x) => x.key);
/** Per-key counter maps inside gs_stats (structure-wise deltas). */
export const BASELINE_COUNTER_MAP_KEYS = groupsOf('counterMaps').map((x) => x.key);
/** Per-key record maps inside gs_stats (gated, never differenced). */
export const BASELINE_RECORD_MAP_KEYS = groupsOf('recordMaps').map((x) => x.key);

/**
 * Which groups THIS snapshot cannot speak for — the holes a capture must record
 * and the fills a stored baseline is allowed to take from it.
 */
export function snapshotHoles(s: ParsedSelf, dist: ParsedDistances | null): string[] {
  const hasDistances = dist !== null;
  return BASELINE_GROUPS.filter((x) => !x.carries(s.provenance, hasDistances)).map((x) => x.path);
}

/**
 * The stored zero-point (player_stats.gs_baseline jsonb). Deliberately
 * string-keyed maps rather than tight tuples: this round-trips through jsonb
 * written by a third-party mod's payload, so every reader treats a missing or
 * non-numeric entry as "no baseline for that key" instead of trusting a shape.
 */
export interface GsBaseline {
  v: number;
  /**
   * ISO timestamp of capture — mirrored into player_stats.gs_baselined_at.
   * NEVER an empty string: readBaseline falls back to the caller's `at`, because
   * a '' here used to be written straight into a timestamptz column (Postgres
   * 22007) which silently demoted that player to the base-columns path forever.
   */
  capturedAt: string;
  /** Which character/world the zero-point was taken from (provenance only). */
  reporter: string | null;
  world: string | null;
  counters: Record<string, number>;
  counterMaps: Record<string, Record<string, number>>;
  records: Record<string, number>;
  recordMaps: Record<string, Record<string, number>>;
  /**
   * Groups this zero-point has NO reading for — the payload it was captured from
   * did not carry them (paths from BASELINE_GROUPS, e.g. 'counterMaps.fish',
   * 'recordMaps.skills', 'counters.bossKills').
   *
   * A THIRD STATE, and the whole point of it: `0` and `{}` both mean "this
   * character had none of that at capture" and are fully trusted, so a group
   * stored that way is UNREPAIRABLE — it looks like a perfectly good zero-point
   * forever. Listing it here instead means the group credits NOTHING until it
   * first appears, at which moment the hole FILLS from that snapshot (that post
   * credits 0; everything after it is real growth measured from there).
   *
   * Absent/empty = a complete zero-point, which is the normal case.
   */
  holes?: string[];
  /**
   * Which parse source `counters.itemsCrafted` was read from at capture
   * (rule 4). A snapshot parsed from the OTHER source is not comparable with
   * this zero-point, so itemsCrafted credits zero until the source matches again.
   */
  craftsSource?: 'vh_Crafts' | 'crafts';
  /**
   * Consecutive-low streak toward a re-baseline (rule 2). Persisted here rather
   * than in a column so the whole reset decision lives in one jsonb value.
   */
  pendingReset?: GsPendingReset;
  /**
   * The zero-point(s) this one REPLACED at a re-baseline, kept as a PERMANENT
   * PER-COUNTER CEILING (rule 2). Never nested more than one deep, and on a
   * second re-baseline it is per-key GREATEST-merged with the outgoing one, so
   * it is always the highest reading this character has ever posted.
   *
   * WHAT IT DOES. For every counter k the zero-point actually used is
   *   max(active_k, min(superseded_k, raw_k))
   * — so a career climbing back UP toward a superseded value credits exactly
   * nothing, and only genuine growth PAST it is credited. Records use the same
   * idea in max form: the gate threshold is max(active_k, superseded_k).
   *
   * WHY IT IS PERMANENT. This used to be a 7-day window on the SUMMED career
   * signature, and both halves leaked. All-or-nothing: a recovery that landed
   * one count short of the summed signature re-adopted nothing and credited
   * 1,100 kills / 21,000 builds in full. And expiring: a hobby server's stale
   * save that came back EIGHT days later credited the whole 1,126-kill import.
   * A ceiling has no threshold to fall short of and no clock to outlast. It
   * costs a genuinely re-rolled character credit for re-grinding ground the NAME
   * already covered — which the columns hold anyway (GREATEST), so it is not
   * visible — and that is the cheaper of the two mistakes by a wide margin.
   * To forgive it deliberately, clear gs_baseline (see the migration file).
   */
  superseded?: GsBaseline;
  /**
   * IN-MEMORY ONLY, never persisted: entries that were present in the stored
   * jsonb but unusable (non-numeric), as path -> keys, e.g.
   * `{ counters: ['kills'], 'counterMaps.fish': ['Fish3'] }`. reconcileBaseline
   * refills exactly those from the current snapshot so a corrupt entry credits
   * ZERO rather than being mistaken for "this player never had one" — or, when
   * the snapshot can't speak for that group at all, holes the group instead.
   */
  unusable?: Record<string, string[]>;
}

/** A run of consecutive qualifying snapshots whose career signature has collapsed. */
export interface GsPendingReset {
  /** How many consecutive qualifying low snapshots have been seen (1-based). */
  count: number;
  /** When the streak started (ISO). */
  since: string;
  /** Raw career signature of the most recent low snapshot (diagnostics). */
  signature: number;
}

/** Server-earned values for one snapshot: what the columns/blob should hold. */
export interface EffectiveStats {
  kills: number;
  deaths: number;
  bossKills: number;
  resourcesHarvested: number;
  itemsCrafted: number;
  structuresBuilt: number;
  damageDealt: number;
  distanceTraveled: number;
  longestLifeSec: number;
  bestKillsBeforeDeath: number;
  /** Effective long-tail blob, capped exactly like the parser caps the raw one. */
  gsStats: GsClientStats;
  /** Effective per-mode distances, or null when the snapshot carried none. */
  distances: { total: number; walk: number; run: number; sail: number; air: number } | null;
  /** Effective raw vh_Distance* subset, or null when the snapshot carried none. */
  distancesRaw: Record<string, number> | null;
}

export type BaselineChange =
  /** first (qualifying) snapshot for this character — zero-point taken. */
  | 'capture'
  /** N consecutive low snapshots: zero-point re-taken, old one kept as superseded. */
  | 'rebaseline'
  /** holes filled / malformed groups repaired from this snapshot. */
  | 'repair'
  /** a collapsed career seen, but not yet N times in a row — streak counter persisted. */
  | 'reset-pending'
  /** the career came back before the streak completed — streak cleared. */
  | 'reset-cleared'
  /** snapshot too incomplete to capture from / credit from — nothing written. */
  | 'defer';

export interface BaselineResult {
  effective: EffectiveStats;
  /** Baseline to persist, or null when the stored one is still good as-is. */
  nextBaseline: GsBaseline | null;
  change: BaselineChange | null;
  /** Human-readable why, for the ingest log. */
  reason: string | null;
  /**
   * True when this snapshot was not trusted at all (rule 1/5): `effective` is
   * all-zero, nothing is persisted, and the caller should skip the write.
   */
  deferred: boolean;
}

// ── small defensive readers ──────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function clamp0(n: number): number {
  return n > 0 ? n : 0;
}
function plainObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
/**
 * A jsonb object narrowed to its finite-numeric entries; null if not an object.
 * `dropped` lists keys that WERE there but weren't numbers — the caller must
 * treat those as corrupt (refill from the live snapshot), never as absent,
 * because absent means "credit it all" and corrupt must mean "credit nothing".
 */
function readNumMap(v: unknown): { map: Record<string, number>; dropped: string[] } | null {
  const o = plainObj(v);
  if (!o) return null;
  const map: Record<string, number> = {};
  const dropped: string[] = [];
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === 'number' && Number.isFinite(val)) map[k] = val;
    else dropped.push(k);
  }
  return { map, dropped };
}
/**
 * The per-mode distance readings this payload genuinely carried, keyed as the
 * baseline stores them. `dist.raw` is the presence record: `parseSelfDistances`
 * synthesizes all five modes (absent → 0), so only `raw` can tell an unreported
 * mode from a real zero.
 */
function presentDistanceModes(dist: ParsedDistances): Record<string, number> {
  const value: Record<DistanceMode, number> = {
    total: dist.distanceTraveled,
    walk: dist.walk,
    run: dist.run,
    sail: dist.sail,
    air: dist.air,
  };
  const out: Record<string, number> = {};
  for (const [mode, statKey] of Object.entries(DISTANCE_MODE_KEYS) as [DistanceMode, string][]) {
    if (statKey in dist.raw) out[mode] = value[mode];
  }
  return out;
}

/** Fold a `[{ key, value }]` breakdown into a `{ key: value }` map (max on dupes). */
function toMap<T>(rows: readonly T[], key: (r: T) => string, value: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const v = num(value(r));
    out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/**
 * record gate: a max-type value only counts once it EXCEEDS the baselined one.
 * Equal is NOT enough — a veteran's imported record must actually be beaten here
 * before it surfaces (requirement: "suppress values that do not EXCEED").
 */
function gate(raw: number, base: number | undefined): number {
  const r = num(raw);
  return r > num(base) ? r : 0;
}

// ── capture gate (rule 1) ────────────────────────────────────────────────────

export interface CaptureQualification {
  ok: boolean;
  /** What the payload didn't carry, for the log line. */
  missing: string[];
}

/**
 * Is this snapshot fit to become a zero-point — and, since the same trust
 * question applies, fit to be credited from at all?
 *
 * THE INCIDENT THIS PREVENTS. `parseSelfSnapshot` turns "key absent" and "key
 * junk" alike into 0, and it will fall back to a BYSTANDER players[] entry when
 * the reporter's own entry is missing (they hadn't spawned yet). Baselining a
 * bystander's numbers as this character's career is meaningless in both
 * directions, so an entry that is not demonstrably the reporter's own is refused
 * outright.
 *
 * THE INCIDENT THE *SHORT* LIST PREVENTS — and this is the half that got added
 * second. The gate used to demand vh_Builds, vh_DistanceTraveled, pickups[] and
 * weapons[] as well, on the reasoning that a field absent from the payload must
 * never be baselined at 0. The reasoning was right; the remedy was not. Because
 * `defer` writes NOTHING — no baseline, no row, no gs_updated_at, no milestone
 * evaluation — every one of those extra requirements was a way to mute a real
 * player permanently:
 *   • the mod's OWN canonical Emit() payload (scripts/gs-client.test.mjs) carries
 *     no vh_Distance* keys at all, so it deferred on post 1 and on post 100;
 *   • a viking who has never placed a build piece has no vh_Builds, so a fisher
 *     or an explorer stayed invisible until the moment they built something —
 *     and then lost their whole session to the zero-point.
 * Absence is now answered where it belongs: the group is captured as a HOLE
 * (rule 1) and credits nothing until it first appears. So the gate asks only for
 * what the mod always emits and what a hole cannot substitute for: the
 * reporter's OWN entry, plus kills and deaths.
 *
 * Anything less is deferred — it credits nothing and writes nothing, and the
 * next ~120s snapshot heals it.
 */
export function captureQualification(s: ParsedSelf): CaptureQualification {
  const p = s.provenance;
  const missing: string[] = [];
  if (!p.ownEntry) missing.push(`players[] entry for "${s.reporter}" (only a bystander entry was present)`);
  if (!p.hasKills) missing.push('kills');
  if (!p.hasDeaths) missing.push('deaths');
  return { ok: missing.length === 0, missing };
}

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * Snapshot the RAW cumulative numbers as this character's zero-point. Built from
 * the UNCAPPED parse (`gsStatsFull`) so a weapon/creature/material that only
 * ranks inside the top-N later still has a baseline to be measured against.
 *
 * Groups this snapshot did not carry are OMITTED from the blob and listed in
 * `holes` (rule 1) — never written as 0/{}, which would be indistinguishable
 * from a real zero-point and would credit the next snapshot's lifetime total.
 *
 * Also the "difference this against itself" source used to FILL holes and repair
 * malformed blobs: both make that cycle credit exactly 0 for the fields touched.
 */
export function captureBaseline(s: ParsedSelf, dist: ParsedDistances | null, at: string): GsBaseline {
  const gs = s.gsStatsFull;
  const full: GsBaseline = {
    v: GS_BASELINE_VERSION,
    capturedAt: at,
    reporter: s.reporter,
    world: s.world,
    // Which side of the vh_Crafts / crafts[] fork this zero-point was read from
    // (rule 4). 'none' means neither was carried — itemsCrafted is a hole, and
    // craftsSource is then meaningless, so it is dropped below with the group.
    craftsSource: s.provenance.craftsSource === 'crafts' ? 'crafts' : 'vh_Crafts',
    counters: {
      kills: num(s.kills),
      deaths: num(s.deaths),
      bossKills: num(s.bossKills),
      resourcesHarvested: num(s.resourcesHarvested),
      itemsCrafted: num(s.itemsCrafted),
      structuresBuilt: num(s.structuresBuilt),
      damageDealt: num(s.damageDealt),
      distanceTraveled: num(dist?.distanceTraveled),
    },
    counterMaps: {
      weaponDamage: toMap(gs.weapons, (w) => w.weapon, (w) => w.damageDealt),
      weaponKills: toMap(gs.weapons, (w) => w.weapon, (w) => w.kills),
      creatureKills: toMap(gs.creatureKills, (c) => c.creature, (c) => c.kills),
      bossDamage: toMap(gs.bossDamage, (b) => b.boss, (b) => b.damageDealt),
      bossFightSec: toMap(gs.bossDamage, (b) => b.boss, (b) => b.fightSec),
      materials: toMap(gs.materials, (m) => m.material, (m) => m.amount),
      fish: toMap(gs.fish, (f) => f.item, (f) => f.count),
      // Only the modes this payload actually carried (closed key set — see
      // BaselineGroup.closedKeys). A mode absent here is a per-key hole, not a
      // zero, so 1,140 km walked elsewhere can't arrive as "earned on Eilif"
      // the first time vh_DistanceWalk shows up.
      distances: dist ? presentDistanceModes(dist) : {},
      distancesRaw: dist ? { ...dist.raw } : {},
    },
    records: {
      longestLifeSec: num(s.longestLifeSec),
      bestKillsBeforeDeath: num(s.bestKillsBeforeDeath),
    },
    recordMaps: {
      weaponHardestHit: toMap(gs.weapons, (w) => w.weapon, (w) => w.hardestHit),
      weaponBiggestSwing: toMap(gs.weapons, (w) => w.weapon, (w) => w.biggestSwing),
      skills: toMap(gs.skills, (sk) => sk.skill, (sk) => sk.level),
    },
  };

  // Punch the holes: whatever this payload did not carry is REMOVED from the
  // blob (so no reader can mistake a filler 0/{} for a reading) and named in
  // `holes` instead.
  const holes = snapshotHoles(s, dist);
  for (const path of holes) {
    const grp = BASELINE_GROUPS.find((x) => x.path === path)!;
    delete (full[grp.section] as Record<string, unknown>)[grp.key];
  }
  if (holes.length > 0) full.holes = holes;
  if (s.provenance.craftsSource === 'none') delete full.craftsSource;
  return full;
}

// ── read / repair ────────────────────────────────────────────────────────────

/** An ISO timestamp string we would be willing to hand to Postgres, or null. */
function readTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || Number.isNaN(Date.parse(t))) return null;
  return t;
}

/**
 * Coerce whatever sits in the gs_baseline column into a usable baseline.
 * Returns null for anything we can't trust (missing, wrong version, not an
 * object, no counters block) — the caller then captures a fresh one, which
 * credits ZERO for that cycle. Never throws: this is third-party-derived jsonb.
 *
 * `fallbackAt` stands in for a missing/blank/unparseable capturedAt. A stored
 * baseline written before capturedAt existed (or by hand) used to round-trip as
 * capturedAt:'' and the route wrote that '' into the gs_baselined_at
 * timestamptz — Postgres 22007, the whole upsert rejected, and that player
 * silently fell through to the base-columns path FOREVER (their gs_stats, boss
 * kills and records stopped updating for good). A baseline is never allowed to
 * carry a timestamp that can't be written back.
 */
export function readBaseline(raw: unknown, fallbackAt: string = new Date().toISOString()): GsBaseline | null {
  const o = plainObj(raw);
  if (!o) return null;
  if (num(o.v) !== GS_BASELINE_VERSION) return null;
  const counters = readNumMap(o.counters);
  if (!counters) return null;

  const unusable: Record<string, string[]> = {};
  const note = (path: string, dropped: string[]) => {
    if (dropped.length > 0) unusable[path] = dropped;
  };
  note('counters', counters.dropped);

  const readMapSection = (path: string, v: unknown): Record<string, Record<string, number>> => {
    const section = plainObj(v);
    const out: Record<string, Record<string, number>> = {};
    if (!section) return out;
    for (const [k, val] of Object.entries(section)) {
      const m = readNumMap(val);
      if (!m) continue; // not an object at all -> treated as a missing map (repaired whole)
      out[k] = m.map;
      note(`${path}.${k}`, m.dropped);
    }
    return out;
  };

  const records = readNumMap(o.records);
  note('records', records?.dropped ?? []);

  const baseline: GsBaseline = {
    v: GS_BASELINE_VERSION,
    // Never '' — see the doc comment (Postgres 22007 / permanent degradation).
    capturedAt: readTimestamp(o.capturedAt) ?? fallbackAt,
    reporter: typeof o.reporter === 'string' ? o.reporter : null,
    world: typeof o.world === 'string' ? o.world : null,
    counters: counters.map,
    counterMaps: readMapSection('counterMaps', o.counterMaps),
    records: records?.map ?? {},
    recordMaps: readMapSection('recordMaps', o.recordMaps),
  };
  if (o.craftsSource === 'vh_Crafts' || o.craftsSource === 'crafts') baseline.craftsSource = o.craftsSource;

  // Holes: only recognized group paths survive, so a hand-edited or future
  // `holes` entry can never freeze a group that this build doesn't know about.
  const holes = Array.isArray(o.holes)
    ? [...new Set(o.holes.filter((h): h is string => typeof h === 'string' && BASELINE_GROUP_PATHS.has(h)))]
    : [];
  if (holes.length > 0) baseline.holes = holes;

  const pending = plainObj(o.pendingReset);
  const pendingCount = pending ? Math.floor(num(pending.count)) : 0;
  if (pending && pendingCount > 0) {
    baseline.pendingReset = {
      count: pendingCount,
      since: readTimestamp(pending.since) ?? fallbackAt,
      signature: num(pending.signature),
    };
  }

  // One level only: a superseded ceiling never carries its own superseded /
  // streak / in-memory bookkeeping, so the blob can't grow without bound. It
  // carries no `holes` either — a ceiling is read purely per key, and a key it
  // simply doesn't have is "no ceiling for that key", which is already the right
  // answer (we never saw a higher reading for it).
  const superseded = plainObj(o.superseded) ? readBaseline(o.superseded, fallbackAt) : null;
  if (superseded) {
    delete superseded.superseded;
    delete superseded.pendingReset;
    delete superseded.unusable;
    delete superseded.holes;
    baseline.superseded = superseded;
  }

  if (Object.keys(unusable).length > 0) baseline.unusable = unusable;
  return baseline;
}

/** A copy fit to be STORED as someone else's `superseded` ceiling (rule 2). */
function asSuperseded(b: GsBaseline): GsBaseline {
  const copy: GsBaseline = { ...b };
  delete copy.superseded;
  delete copy.pendingReset;
  delete copy.unusable;
  delete copy.holes; // a ceiling is read per key; an absent key IS "no ceiling"
  return copy;
}

/** Per-key GREATEST over two `{ key: { key: number } }` sections. */
function maxSection(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = maxByKey(a[k] ?? {}, b[k] ?? {});
  }
  return out;
}

/**
 * The permanent ceiling after a re-baseline: per-key GREATEST of the ceiling we
 * already held and the zero-point now being replaced.
 *
 * Per-key rather than "keep the oldest, it was the highest": the OLD rule
 * compared summed career signatures, and a summed comparison can be higher
 * overall while being lower on the very counter a bounce-back exploits. A max
 * per key is the only shape that can't be gamed by that, and it keeps the blob
 * exactly one level deep no matter how many resets a character goes through.
 */
function mergeCeiling(prev: GsBaseline | undefined, replaced: GsBaseline): GsBaseline {
  const out = asSuperseded(replaced);
  if (!prev) return out;
  return {
    ...out,
    // Provenance of the ceiling stays with the OLDEST zero-point it covers.
    capturedAt: prev.capturedAt,
    reporter: prev.reporter ?? out.reporter,
    world: prev.world ?? out.world,
    counters: maxByKey(out.counters, prev.counters),
    records: maxByKey(out.records, prev.records),
    counterMaps: maxSection(out.counterMaps, prev.counterMaps),
    recordMaps: maxSection(out.recordMaps, prev.recordMaps),
  };
}

/** Is a group readable in this stored baseline (present AND the right shape)? */
function groupPresent(base: GsBaseline, grp: BaselineGroup): boolean {
  const section = base[grp.section] as Record<string, unknown>;
  const v = section?.[grp.key];
  return grp.section === 'counters' || grp.section === 'records'
    ? typeof v === 'number' && Number.isFinite(v)
    : !!plainObj(v);
}

export interface Reconciliation {
  baseline: GsBaseline;
  /** Holes that this snapshot could FILL (they credit 0 now, then real growth). */
  filled: string[];
  /** Malformed groups refilled from this snapshot (same effect, different cause). */
  repaired: string[];
  /** Groups newly recorded as holes because neither side could speak for them. */
  holed: string[];
}

/**
 * Bring a stored zero-point and the current snapshot into agreement.
 *
 * Three states go in and two come out. For every group:
 *   • HOLED and the snapshot CARRIES it   → FILL from the snapshot. That is the
 *     whole hole lifecycle: the group has credited nothing up to now, this post
 *     credits nothing (raw − raw), and everything after it is real growth.
 *   • HOLED and the snapshot does not     → stay holed, credit nothing.
 *   • intact                              → left alone.
 *   • MALFORMED (absent from the blob, or the wrong shape) and the snapshot
 *     carries it                          → repaired from the snapshot.
 *   • MALFORMED and the snapshot does not → becomes a hole. Never a 0/{}: a
 *     filler zero-point is unrepairable and would credit a lifetime total.
 *
 * A key MISSING FROM A MAP THAT IS PRESENT is not a gap and is deliberately left
 * alone — it means the character had never killed that creature / caught that
 * species when the zero-point was taken, so it is fully credited (rule 3).
 */
function reconcileBaseline(base: GsBaseline, fresh: GsBaseline, carried: (path: string) => boolean): Reconciliation {
  const filled: string[] = [];
  const repaired: string[] = [];
  const holed: string[] = [];
  const holes = new Set(base.holes ?? []);

  const counters = { ...base.counters };
  const records = { ...base.records };
  const counterMaps = { ...base.counterMaps };
  const recordMaps = { ...base.recordMaps };
  const next: GsBaseline = { ...base, counters, records, counterMaps, recordMaps };
  const sectionOf = (s: BaselineSection): Record<string, unknown> =>
    ({ counters, records, counterMaps, recordMaps })[s] as Record<string, unknown>;

  const fill = (grp: BaselineGroup) => {
    const v = (fresh[grp.section] as Record<string, unknown>)[grp.key];
    sectionOf(grp.section)[grp.key] = v;
    holes.delete(grp.path);
    // itemsCrafted is only comparable against a zero-point read from the SAME
    // source (rule 4), so a fill has to bring the source across with the number.
    if (grp.path === 'counters.itemsCrafted') {
      if (fresh.craftsSource) next.craftsSource = fresh.craftsSource;
      else delete next.craftsSource;
    }
  };
  const punch = (grp: BaselineGroup) => {
    delete sectionOf(grp.section)[grp.key];
    if (!holes.has(grp.path)) holed.push(grp.path);
    holes.add(grp.path);
  };

  for (const grp of BASELINE_GROUPS) {
    const isHoled = holes.has(grp.path);
    const present = groupPresent(base, grp);
    if (isHoled) {
      if (carried(grp.path)) {
        fill(grp);
        filled.push(grp.path);
      } else if (present) {
        // A blob that lists a hole AND stores a value for it (hand-edited, or a
        // half-applied write): the hole wins — it is the claim that the value is
        // not a reading.
        delete sectionOf(grp.section)[grp.key];
      }
    } else if (!present) {
      if (carried(grp.path)) {
        fill(grp);
        repaired.push(grp.path);
      } else {
        punch(grp);
      }
    } else if (grp.closedKeys && carried(grp.path)) {
      // A CLOSED-key map that IS present but is missing individual keys: those
      // keys are per-key holes, so fill each one the moment this snapshot first
      // reports it (that cycle credits 0, growth after it is credited in full).
      const stored = { ...((base[grp.section] as Record<string, Record<string, number>>)[grp.key] ?? {}) };
      const from = (fresh[grp.section] as Record<string, Record<string, number>>)[grp.key] ?? {};
      let added = false;
      for (const [k, v] of Object.entries(from)) {
        if (typeof stored[k] !== 'number') {
          stored[k] = v;
          filled.push(`${grp.path}.${k}`);
          added = true;
        }
      }
      if (added) sectionOf(grp.section)[grp.key] = stored;
    }
  }

  // Entries that were present but corrupt (non-numeric) INSIDE an otherwise fine
  // map/section. Refill from the snapshot so they credit zero this cycle, or drop
  // them when the character no longer carries that weapon/creature/species at all.
  //
  // Only when this snapshot CARRIES the group: dropping a corrupt key on the word
  // of a payload that never mentioned the group would persist it as "absent from
  // a present map", i.e. fully creditable next time — the corruption laundered
  // into credit. With the group uncarried we hole the whole group instead, which
  // costs its other keys one cycle and is the safe direction.
  for (const [path, keys] of Object.entries(base.unusable ?? {})) {
    const [section, mapKey] = path.split('.');
    const groupPath = section === 'counterMaps' || section === 'recordMaps' ? path : null;
    if (groupPath) {
      const grp = BASELINE_GROUPS.find((x) => x.path === groupPath);
      if (grp && !carried(grp.path)) {
        punch(grp);
        continue;
      }
    }
    let target: Record<string, number> | null = null;
    let source: Record<string, number> | undefined;
    if (section === 'counters') {
      target = counters;
      source = fresh.counters;
    } else if (section === 'records') {
      target = records;
      source = fresh.records;
    } else if (section === 'counterMaps' && mapKey) {
      target = counterMaps[mapKey] = { ...counterMaps[mapKey] };
      source = fresh.counterMaps[mapKey];
    } else if (section === 'recordMaps' && mapKey) {
      target = recordMaps[mapKey] = { ...recordMaps[mapKey] };
      source = fresh.recordMaps[mapKey];
    }
    if (!target) continue;
    for (const key of keys) {
      // A corrupt SCALAR counter/record is its own group: if this snapshot can't
      // speak for it, hole it rather than guess.
      const scalarGroup =
        section === 'counters' || section === 'records'
          ? BASELINE_GROUPS.find((x) => x.path === `${section}.${key}`)
          : undefined;
      if (scalarGroup && !carried(scalarGroup.path)) {
        punch(scalarGroup);
        continue;
      }
      const v = source?.[key];
      if (typeof v === 'number') target[key] = v;
      else delete target[key];
      repaired.push(`${path}.${key}`);
    }
  }

  // Stored in BASELINE_GROUPS order, same as a fresh capture, so two blobs for
  // the same set of holes always compare equal.
  if (holes.size > 0) next.holes = BASELINE_GROUPS.filter((x) => holes.has(x.path)).map((x) => x.path);
  else delete next.holes;
  delete next.unusable; // in-memory bookkeeping — never persisted
  return { baseline: next, filled, repaired, holed };
}

// ── profile-reset detection (re-baseline) ────────────────────────────────────

/**
 * Counters that a live Valheim profile can only ever grow. Distance is left out
 * on purpose — metres dwarf every other counter and would dominate the ratio.
 */
const SIGNATURE_KEYS = ['kills', 'deaths', 'itemsCrafted', 'structuresBuilt', 'resourcesHarvested'] as const;

/**
 * Below this the baseline is too small for a proportional test to mean anything
 * (a brand-new character baselines at a handful of counts; a single skipped
 * cycle shouldn't look like a wipe).
 */
export const REBASELINE_MIN_SIGNATURE = 50;
/** A career that collapses below half its zero-point is a different career. */
export const REBASELINE_RATIO = 0.5;
/**
 * …but only once it has said so N TIMES IN A ROW (rule 2).
 *
 * THE INCIDENT THIS PREVENTS. A re-baseline used to fire off a SINGLE low
 * snapshot. One transient dip — a stale cloud save, a second PC with an older
 * copy of the character, a half-written .fch — permanently lowered the
 * zero-point, and when the real character came back two minutes later the entire
 * bounce-back was differenced against that dip and credited as earned here:
 * 1,126 kills and 21,207 builds landed in the columns FOUR MINUTES after the
 * baseline was captured to prevent exactly that. A genuine deletion-and-reroll
 * keeps reporting low forever, so it still re-baselines — six minutes later.
 */
export const REBASELINE_CONSECUTIVE = 3;

function signature(counters: Record<string, number>): number {
  let total = 0;
  for (const k of SIGNATURE_KEYS) total += num(counters[k]);
  return total;
}

/** The same career signature, taken from a live snapshot (raw, pre-baseline). */
export function rawCareerSignature(s: ParsedSelf): number {
  return signature({
    kills: s.kills,
    deaths: s.deaths,
    itemsCrafted: s.itemsCrafted,
    structuresBuilt: s.structuresBuilt,
    resourcesHarvested: s.resourcesHarvested,
  });
}

export interface RebaselineCheck {
  reset: boolean;
  rawSignature: number;
  baseSignature: number;
  reason: string;
}

/**
 * Detect a profile reset — a deleted/rebuilt character reusing the same name,
 * or a restored-from-backup save. Because a real profile's counters never fall,
 * a large collapse means the numbers we are subtracting no longer belong to the
 * character posting them; keeping the old zero-point would silence that player
 * forever. So we re-zero on the current snapshot — and the caller KEEPS every
 * column already earned here (the GREATEST merge does that for free).
 *
 * The rule is proportional and multi-counter (not "kills went down") so that a
 * single flaky counter can't trigger it: the summed career signature must fall
 * below half of the baselined signature, and the baseline must be large enough
 * for that ratio to mean something.
 */
export function shouldRebaseline(s: ParsedSelf, base: GsBaseline): RebaselineCheck {
  const rawSignature = rawCareerSignature(s);
  const baseSignature = signature(base.counters);
  if (baseSignature < REBASELINE_MIN_SIGNATURE) {
    return { reset: false, rawSignature, baseSignature, reason: 'baseline too small to test proportionally' };
  }
  if (rawSignature >= baseSignature * REBASELINE_RATIO) {
    return { reset: false, rawSignature, baseSignature, reason: 'career signature intact' };
  }
  return {
    reset: true,
    rawSignature,
    baseSignature,
    reason:
      `career signature collapsed ${Math.round(baseSignature)} → ${Math.round(rawSignature)} ` +
      `(< ${Math.round(REBASELINE_RATIO * 100)}% of the baselined career)`,
  };
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * An all-zero result: this snapshot moves nothing. Every field a merge reads is
 * present and zero/empty, so `mergeIntoRow` leaves the stored row exactly as it
 * found it (distances stay null so the per-mode floors aren't touched either).
 */
function zeroEffective(s: ParsedSelf): EffectiveStats {
  return {
    kills: 0,
    deaths: 0,
    bossKills: 0,
    resourcesHarvested: 0,
    itemsCrafted: 0,
    structuresBuilt: 0,
    damageDealt: 0,
    distanceTraveled: 0,
    longestLifeSec: 0,
    bestKillsBeforeDeath: 0,
    gsStats: capGsStats({
      weapons: [],
      creatureKills: [],
      bossDamage: [],
      skills: [],
      materials: [],
      fish: [],
      records: { topWeapon: null, topWeaponDamage: 0, hardestHit: 0, biggestSwing: 0 },
      currentLifeStartedUtc: s.gsStatsFull.currentLifeStartedUtc,
      platformId: s.gsStatsFull.platformId,
    }),
    distances: null,
    distancesRaw: null,
  };
}

/**
 * Turn one raw cumulative snapshot into the server-earned values to store.
 *
 * `stored` is the raw player_stats.gs_baseline jsonb (undefined/null = never
 * baselined). Whatever happens the result is safe to merge: the first post under
 * a new or repaired baseline contributes exactly zero, and a snapshot we don't
 * fully trust contributes exactly zero.
 *
 * The decision tree, in order:
 *   0. UNQUALIFIED snapshot (rule 1)  → defer: credit nothing, write nothing.
 *   1. No readable stored baseline    → capture (credits nothing).
 *   2. Career collapsed               → count it; re-baseline only at N in a row.
 *   3. Career intact                  → clear any streak, fill/repair, credit.
 *
 * There is no "re-adopt" step any more: a superseded zero-point is a PERMANENT
 * per-counter ceiling applied inside computeEffective (rule 2), so a career
 * climbing back toward it is un-credited automatically, in whole or in part, at
 * any distance in time.
 */
export function applyBaseline(
  s: ParsedSelf,
  dist: ParsedDistances | null,
  stored: unknown,
  at: string = new Date().toISOString(),
): BaselineResult {
  const qual = captureQualification(s);
  const existing = readBaseline(stored, at);

  // ── 0. Not a snapshot we trust: credit nothing, persist nothing ────────────
  //
  // Deliberately covers the credit path too, not just capture. These numbers
  // aren't this character's at all — a bystander entry holds the reporter's
  // observations OF SOMEONE ELSE, so differencing it against this character's
  // zero-point is meaningless in both directions, and there is no hole that
  // could stand in for "whose career is this". Nothing is written, so the next
  // own-entry snapshot (~120s) heals it. The list is SHORT on purpose: every
  // other absence is a hole, because deferring writes nothing and would mute the
  // player entirely (see captureQualification).
  if (!qual.ok) {
    return {
      effective: zeroEffective(s),
      nextBaseline: null,
      change: 'defer',
      reason: `snapshot is not a usable own-character report — missing ${qual.missing.join(', ')}; credited nothing and wrote nothing (the next own-entry snapshot heals it)`,
      deferred: true,
    };
  }

  const fresh = captureBaseline(s, dist, at);
  const snapshotHoleSet = new Set(snapshotHoles(s, dist));
  const carried = (path: string) => !snapshotHoleSet.has(path);

  let base: GsBaseline;
  let nextBaseline: GsBaseline | null = null;
  let change: BaselineChange | null = null;
  let reason: string | null = null;
  /** Set while a snapshot is under suspicion: hold the zero-point, credit zero. */
  let creditNothing = false;

  if (!existing) {
    // ── 1. first zero-point ──────────────────────────────────────────────────
    base = fresh;
    nextBaseline = fresh;
    change = 'capture';
    const holesNote =
      fresh.holes && fresh.holes.length > 0
        ? `. This payload carried no reading for ${fresh.holes.join(', ')} — recorded as HOLES: they credit ` +
          `nothing until they first appear, and take their zero-point from that snapshot`
        : '';
    reason =
      (stored === null || stored === undefined
        ? 'first client snapshot for this character — zero-point captured, this post credits nothing'
        : 'stored baseline was unreadable — re-captured from this snapshot (credits nothing)') + holesNote;
  } else {
    const reset = shouldRebaseline(s, existing);
    if (reset.reset) {
      // ── 2. collapsed career: believed only at N consecutive ────────────────
      const streak = (existing.pendingReset?.count ?? 0) + 1;
      if (streak >= REBASELINE_CONSECUTIVE) {
        base = fresh;
        nextBaseline = {
          ...fresh,
          // The permanent ceiling: per-key GREATEST of the ceiling we already
          // held and the zero-point being replaced (rule 2). No recovery toward
          // any reading this character has ever posted is credited, ever.
          superseded: mergeCeiling(existing.superseded, existing),
        };
        change = 'rebaseline';
        reason = `${reset.reason}, confirmed by ${streak} consecutive qualifying snapshots`;
      } else {
        // Under suspicion, so: hold the zero-point, credit NOTHING, and
        // deliberately do NOT repair from this snapshot. Both halves matter —
        // a hole in the stored baseline would otherwise be filled from numbers
        // that may belong to a different character (making the real career's
        // return look earned), and an unrepaired hole would credit this
        // snapshot's raw value in full. Nothing is trusted until the verdict.
        base = existing;
        creditNothing = true;
        nextBaseline = {
          ...existing,
          pendingReset: {
            count: streak,
            since: existing.pendingReset?.since ?? at,
            signature: reset.rawSignature,
          },
        };
        delete nextBaseline.unusable; // in-memory bookkeeping is never persisted
        change = 'reset-pending';
        reason =
          `${reset.reason} — ${streak}/${REBASELINE_CONSECUTIVE} consecutive low snapshots. ` +
          `Holding the existing zero-point (a transient dip must not lower it); this post credits nothing`;
      }
    } else {
      // ── 3. healthy career: clear any streak, fill holes, repair damage ─────
      const { baseline, filled, repaired, holed } = reconcileBaseline(existing, fresh, carried);
      delete baseline.pendingReset; // the career is back — the streak is void
      base = baseline;
      if (filled.length > 0 || repaired.length > 0 || holed.length > 0) {
        nextBaseline = baseline;
        change = 'repair';
        reason =
          [
            filled.length > 0
              ? `first sighting of ${filled.join(', ')} — the hole is filled from this snapshot (it credits ` +
                `nothing now; growth from here is credited in full)`
              : null,
            repaired.length > 0 ? `filled missing/corrupt baseline fields from this snapshot: ${repaired.join(', ')}` : null,
            holed.length > 0
              ? `no reading for ${holed.join(', ')} on either side — recorded as holes rather than baselined at zero`
              : null,
          ]
            .filter(Boolean)
            .join('; ') + (existing.pendingReset ? ' (and cleared a pending profile-reset streak)' : '');
      } else if (existing.pendingReset) {
        nextBaseline = baseline;
        change = 'reset-cleared';
        reason =
          `career signature is back to ${Math.round(rawCareerSignature(s))} — the ` +
          `${existing.pendingReset.count}/${REBASELINE_CONSECUTIVE} profile-reset streak was a transient dip and is cleared`;
      }
    }
  }

  return {
    effective: creditNothing ? zeroEffective(s) : computeEffective(s, dist, base),
    nextBaseline,
    change,
    reason,
    deferred: false,
  };
}

/**
 * Was this snapshot's itemsCrafted read from the same source as the zero-point's?
 *
 * `vh_Crafts` (the authoritative .fch profile counter) and the summed `crafts[]`
 * breakdown are different quantities. Baselining one and differencing the other
 * invents a delta out of nothing — in either direction. A baseline written
 * before this was recorded has no `craftsSource`; treat it as comparable rather
 * than freezing crafts for every existing row (both sides were overwhelmingly
 * vh_Crafts, and the alternative under-credits everyone forever).
 */
function craftsComparable(s: ParsedSelf, base: GsBaseline): boolean {
  // This snapshot carries neither source: nothing to compare, credit 0 quietly
  // (the itemsCrafted group is already holed or simply has no reading to grow).
  if (s.provenance.craftsSource === 'none') return false;
  if (!base.craftsSource) return true;
  if (base.craftsSource === s.provenance.craftsSource) return true;
  console.warn(
    `[gs-baseline] crafts source changed for "${s.reporter}": zero-point was taken from ` +
      `${base.craftsSource}, this snapshot parses ${s.provenance.craftsSource}. The two are not ` +
      `comparable, so itemsCrafted credits 0 this cycle rather than a fabricated delta.`,
  );
  return false;
}

/**
 * The zero-point actually used for one counter: the stored one, RAISED by the
 * permanent superseded ceiling (rule 2).
 *
 *   floor = max(active, min(superseded, raw))
 *
 * Read it as: never credit a climb back toward a value this character has
 * already posted. Below the ceiling the floor tracks `raw`, so the delta is 0;
 * above it the floor pins at the ceiling, so only the genuine excess is
 * credited. Monotonic in `raw`, which is what keeps `effective` safe to GREATEST.
 * No superseded reading for this key → no ceiling → the stored zero-point stands.
 */
function zeroFloor(active: number | undefined, superseded: number | undefined, raw: number): number {
  const a = num(active);
  if (typeof superseded !== 'number' || !Number.isFinite(superseded)) return a;
  return Math.max(a, Math.min(superseded, num(raw)));
}

/** raw − baseline across every field kind, then cap exactly like the parser does. */
function computeEffective(s: ParsedSelf, dist: ParsedDistances | null, base: GsBaseline): EffectiveStats {
  const c = base.counters;
  const cm = base.counterMaps;
  const rm = base.recordMaps;
  const gs = s.gsStatsFull;

  const holed = new Set(base.holes ?? []);
  const sup = base.superseded;
  const supC = sup?.counters ?? {};
  const supCm = sup?.counterMaps ?? {};
  const supR = sup?.records ?? {};
  const supRm = sup?.recordMaps ?? {};

  /** A scalar counter: 0 while holed, else raw − (ceilinged) zero-point. */
  const counter = (key: string, raw: number): number =>
    holed.has(`counters.${key}`) ? 0 : clamp0(num(raw) - zeroFloor(c[key], supC[key], raw));
  /** A scalar record: 0 while holed, else surfaced only above BOTH thresholds. */
  const record = (key: string, raw: number): number =>
    holed.has(`records.${key}`) ? 0 : gate(raw, Math.max(num(base.records[key]), num(supR[key])));
  /**
   * One key inside a counter map: 0 while the group is holed, 0 while a
   * CLOSED-key group has no reading for this key (a per-key hole — see
   * BaselineGroup.closedKeys), else raw − (ceilinged) zero-point. On an OPEN key
   * set an unknown key is fully credited: the character had none of that thing
   * when the zero-point was taken (rule 3).
   */
  const mapCounter = (map: string, entry: string, raw: number): number => {
    if (holed.has(`counterMaps.${map}`)) return 0;
    const stored = cm[map]?.[entry];
    if (stored === undefined && CLOSED_KEY_MAPS.has(map)) return 0;
    return clamp0(num(raw) - zeroFloor(stored, supCm[map]?.[entry], raw));
  };
  /** One key inside a record map. */
  const mapRecord = (map: string, entry: string, raw: number): number =>
    holed.has(`recordMaps.${map}`) ? 0 : gate(raw, Math.max(num(rm[map]?.[entry]), num(supRm[map]?.[entry])));

  const weapons = gs.weapons
    .map((w) => ({
      weapon: w.weapon,
      damageDealt: mapCounter('weaponDamage', w.weapon, w.damageDealt),
      kills: mapCounter('weaponKills', w.weapon, w.kills),
      hardestHit: mapRecord('weaponHardestHit', w.weapon, w.hardestHit),
      biggestSwing: mapRecord('weaponBiggestSwing', w.weapon, w.biggestSwing),
    }))
    .filter((w) => w.damageDealt > 0 || w.kills > 0 || w.hardestHit > 0 || w.biggestSwing > 0)
    .sort((a, b) => b.damageDealt - a.damageDealt);

  const creatureKills = gs.creatureKills
    .map((x) => ({ creature: x.creature, kills: mapCounter('creatureKills', x.creature, x.kills) }))
    .filter((x) => x.kills > 0)
    .sort((a, b) => b.kills - a.kills);

  const bossDamage = gs.bossDamage
    .map((b) => ({
      boss: b.boss,
      damageDealt: mapCounter('bossDamage', b.boss, b.damageDealt),
      fightSec: mapCounter('bossFightSec', b.boss, b.fightSec),
    }))
    .filter((b) => b.damageDealt > 0)
    .sort((a, b) => b.damageDealt - a.damageDealt);

  const materials = gs.materials
    .map((m) => ({ material: m.material, amount: mapCounter('materials', m.material, m.amount) }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const fish = gs.fish
    .map((f) => ({ item: f.item, count: mapCounter('fish', f.item, f.count) }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  // Skill LEVELS are a max, not a total (see the field-kinds note at the top):
  // gated, so an imported level stays hidden until it is beaten on this world.
  // Holed until the payload first carries skills[] — otherwise a veteran's
  // Fishing 62 would hand them the Anglers board on their second post.
  const skills = gs.skills
    .map((sk) => ({ skill: sk.skill, level: mapRecord('skills', sk.skill, sk.level) }))
    .filter((sk) => sk.level > 0)
    .sort((a, b) => b.level - a.level);

  const top = weapons[0];
  const effectiveGs: GsClientStats = {
    weapons,
    creatureKills,
    bossDamage,
    skills,
    materials,
    fish,
    records: {
      // Derived from the EFFECTIVE weapons, so "Favored Weapon" is the one swung
      // hardest here, and the two records are only what was actually beaten here.
      topWeapon: top?.weapon ?? null,
      topWeaponDamage: top?.damageDealt ?? 0,
      hardestHit: weapons.reduce((m, w) => Math.max(m, w.hardestHit), 0),
      biggestSwing: weapons.reduce((m, w) => Math.max(m, w.biggestSwing), 0),
    },
    currentLifeStartedUtc: gs.currentLifeStartedUtc,
    platformId: gs.platformId,
  };

  // A holed distance group leaves the stored per-mode floors untouched (null),
  // exactly as a snapshot that carried no distances at all does.
  const distancesUsable = dist && !holed.has('counterMaps.distances');
  const distances = distancesUsable
    ? {
        total: mapCounter('distances', 'total', dist.distanceTraveled),
        walk: mapCounter('distances', 'walk', dist.walk),
        run: mapCounter('distances', 'run', dist.run),
        sail: mapCounter('distances', 'sail', dist.sail),
        air: mapCounter('distances', 'air', dist.air),
      }
    : null;
  const distancesRaw =
    dist && !holed.has('counterMaps.distancesRaw')
      ? Object.fromEntries(Object.entries(dist.raw).map(([k, v]) => [k, mapCounter('distancesRaw', k, v)]))
      : null;

  return {
    kills: counter('kills', s.kills),
    deaths: counter('deaths', s.deaths),
    bossKills: counter('bossKills', s.bossKills),
    resourcesHarvested: counter('resourcesHarvested', s.resourcesHarvested),
    // Like against like (rule 4): only difference itemsCrafted when this
    // snapshot was parsed from the same source the zero-point was.
    itemsCrafted: craftsComparable(s, base) ? counter('itemsCrafted', s.itemsCrafted) : 0,
    structuresBuilt: counter('structuresBuilt', s.structuresBuilt),
    damageDealt: counter('damageDealt', s.damageDealt),
    // R1: value the scalar from the closed-key-protected per-mode map, never the
    // raw parse — a payload gated in by e.g. vh_DistanceWalk alone must not later
    // credit a lifetime vh_DistanceTraveled against a synthesized-zero baseline.
    distanceTraveled: distances ? distances.total : 0,
    longestLifeSec: record('longestLifeSec', s.longestLifeSec),
    bestKillsBeforeDeath: record('bestKillsBeforeDeath', s.bestKillsBeforeDeath),
    gsStats: capGsStats(effectiveGs),
    distances,
    distancesRaw,
  };
}

// ── stored-row helpers ───────────────────────────────────────────────────────

/**
 * Rebuild the RAW per-weapon tuple a stored row was derived from
 * (effective + baseline). The weapon-collision monitor in /api/gs-ingest hunts
 * for byte-identical raw tuples across two characters — the tell that the mod's
 * world-scoped weapons.tsv cache leaked across a character switch on one PC.
 * Once rows hold effective values that comparison would only match by accident,
 * so the monitor re-derives the raw side from each row's own baseline.
 *
 * ⚠️ ITERATES THE UNION of the stored blob's weapons and the baseline's weapon
 * keys — not just the stored ones. The leaked-cache incident this monitor exists
 * for (Testman/Testmantwo, an identical Crossbows tuple) shows up in the very
 * FIRST snapshot of both characters, which is precisely the snapshot that gets
 * captured as their zero-point: effective damage is 0, the weapon is filtered
 * out of the stored blob for being all-zero, and a stored-only walk therefore
 * reconstructs NOTHING. The monitor was blind to the exact case it was written
 * to catch. Every weapon the baseline knows about is a weapon this character
 * really reported, so the baseline is the authoritative name list.
 */
export function reconstructRawWeapons(gsStats: unknown, storedBaseline: unknown): GsClientStats['weapons'] {
  const gs = plainObj(gsStats);
  const stored = Array.isArray(gs?.weapons) ? (gs.weapons as unknown[]) : [];
  const base = readBaseline(storedBaseline);
  const dmg = base?.counterMaps.weaponDamage ?? {};
  const kills = base?.counterMaps.weaponKills ?? {};
  const hardest = base?.recordMaps.weaponHardestHit ?? {};
  const swing = base?.recordMaps.weaponBiggestSwing ?? {};

  // name -> the effective (stored) entry, when there is one.
  const effective = new Map<string, Record<string, unknown>>();
  for (const raw of stored) {
    const w = plainObj(raw);
    if (!w || typeof w.weapon !== 'string' || !w.weapon) continue;
    effective.set(w.weapon, w);
  }

  const names = new Set<string>([
    ...effective.keys(),
    ...Object.keys(dmg),
    ...Object.keys(kills),
    ...Object.keys(hardest),
    ...Object.keys(swing),
  ]);

  const out: GsClientStats['weapons'] = [];
  for (const name of names) {
    const w = effective.get(name) ?? {};
    // Counters add back; records are either the (gated) value earned here or,
    // when suppressed, whatever the baseline held.
    out.push({
      weapon: name,
      damageDealt: num(w.damageDealt) + num(dmg[name]),
      kills: num(w.kills) + num(kills[name]),
      hardestHit: num(w.hardestHit) > 0 ? num(w.hardestHit) : num(hardest[name]),
      biggestSwing: num(w.biggestSwing) > 0 ? num(w.biggestSwing) : num(swing[name]),
    });
  }
  return out;
}

// ── the row merge (rule 3) ───────────────────────────────────────────────────
//
// THIS IS THE ONLY MERGE. /api/gs-ingest calls it and so do the tests, because a
// hand-written copy of it in the test file is how a merge bug survives a green
// suite: the tests were asserting against a re-implementation, not against the
// code that writes the database.

/** Per-key GREATEST for a `{ key: number }` map (never regress a counter). */
export function maxByKey(next: Record<string, number>, prev: unknown): Record<string, number> {
  const before = plainObj(prev) ?? {};
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(next), ...Object.keys(before)])) {
    out[k] = Math.max(num(next[k]), num(before[k]));
  }
  return out;
}

/**
 * Per-key GREATEST for a `[{ <keyField>: name, …numeric fields }]` list — the
 * shape every breakdown inside gs_stats uses. Union of both sides' names, max
 * per field.
 */
function mergeRows<T extends Record<string, unknown>>(
  prev: unknown,
  next: readonly T[],
  keyField: string,
  numFields: readonly string[],
): T[] {
  const out = new Map<string, Record<string, unknown>>();
  const take = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const o = plainObj(row);
      if (!o) continue;
      const name = o[keyField];
      if (typeof name !== 'string' || !name) continue;
      const cur = out.get(name) ?? { [keyField]: name };
      for (const f of numFields) cur[f] = Math.max(num(cur[f]), num(o[f]));
      out.set(name, cur);
    }
  };
  take(prev);
  take(next);
  return [...out.values()] as T[];
}

function desc<T extends Record<string, unknown>>(field: string) {
  return (a: T, b: T) => num(b[field]) - num(a[field]);
}

/**
 * Merge this cycle's EFFECTIVE long-tail blob into the stored one, per key.
 *
 * THE INCIDENT THIS PREVENTS. The old route kept a single "advancing" verdict —
 * `effective.damageDealt >= player_stats.damage_dealt` — and on the strength of
 * it either replaced the WHOLE blob or froze the WHOLE blob. Both halves were
 * wrong under baselining:
 *   • replace: after a re-baseline the new character's smaller blob overwrote
 *     the old one wholesale, and 30 fish caught on this server became 5.
 *   • freeze: that same comparison puts an EFFECTIVE value (which restarts near
 *     zero after a capture or re-baseline) against a CUMULATIVE column (which
 *     holds everything the name ever earned here), so a fresh character's blob
 *     stayed frozen until they out-damaged their predecessor's lifetime total.
 * Per-key GREATEST removes the question entirely: the merge is monotonic by
 * construction, so a stale, partial, out-of-order or post-reset snapshot can
 * only ever add — no verdict to get wrong, and like is only ever compared with
 * like (each key against its own stored value).
 */
export function mergeGsStats(prevGsStats: unknown, effective: EffectiveStats): Record<string, unknown> {
  const prev = plainObj(prevGsStats);
  const eff = effective.gsStats;

  const weapons = mergeRows(prev?.weapons, eff.weapons, 'weapon', [
    'damageDealt',
    'kills',
    'hardestHit',
    'biggestSwing',
  ]).sort(desc('damageDealt'));
  const creatureKills = mergeRows(prev?.creatureKills, eff.creatureKills, 'creature', ['kills']).sort(desc('kills'));
  const bossDamage = mergeRows(prev?.bossDamage, eff.bossDamage, 'boss', ['damageDealt', 'fightSec']).sort(
    desc('damageDealt'),
  );
  const materials = mergeRows(prev?.materials, eff.materials, 'material', ['amount']).sort(desc('amount'));
  const fish = mergeRows(prev?.fish, eff.fish, 'item', ['count']).sort(desc('count'));
  // Skill LEVELS are a max, so GREATEST is their natural merge too.
  const skills = mergeRows(prev?.skills, eff.skills, 'skill', ['level']).sort(desc('level'));

  const prevRecords = plainObj(prev?.records) ?? {};
  const top = weapons[0];
  const merged: Record<string, unknown> = {
    // Preserve anything a future writer put here that we don't model.
    ...(prev ?? {}),
    ...capGsStats({
      weapons: weapons as GsClientStats['weapons'],
      creatureKills: creatureKills as GsClientStats['creatureKills'],
      bossDamage: bossDamage as GsClientStats['bossDamage'],
      skills: skills as GsClientStats['skills'],
      materials: materials as GsClientStats['materials'],
      fish: fish as GsClientStats['fish'],
      records: {
        // Derived from the MERGED weapons so "Favored Weapon" is whoever holds
        // the most damage earned here, and the two records only ever climb.
        topWeapon: (top?.weapon as string | undefined) ?? null,
        topWeaponDamage: num(top?.damageDealt),
        hardestHit: Math.max(
          num(prevRecords.hardestHit),
          num(eff.records.hardestHit),
          weapons.reduce((m, w) => Math.max(m, num(w.hardestHit)), 0),
        ),
        biggestSwing: Math.max(
          num(prevRecords.biggestSwing),
          num(eff.records.biggestSwing),
          weapons.reduce((m, w) => Math.max(m, num(w.biggestSwing)), 0),
        ),
      },
      // Pass-through identity: prefer what this snapshot said, keep the last
      // known value when it said nothing.
      currentLifeStartedUtc: eff.currentLifeStartedUtc ?? (prev?.currentLifeStartedUtc as string | null) ?? null,
      platformId: eff.platformId ?? (prev?.platformId as string | null) ?? null,
    }),
  };

  // Per-mode distances: same per-key floor. Untouched when this snapshot carried
  // no distances at all (rather than blanked to zero).
  if (effective.distances) {
    merged.distances = maxByKey(effective.distances, prev?.distances);
    merged.distancesRaw = maxByKey(effective.distancesRaw ?? {}, prev?.distancesRaw);
  }
  return merged;
}

/** A counter that leapt implausibly in one cycle — recorded, never blocked. */
export interface PoisonFlag {
  field: string;
  prev: number;
  next: number;
  at: string;
}

/**
 * Sanity caps for a single ~120s cycle. Applied to EFFECTIVE values (what
 * actually lands in the columns), so an imported veteran's huge first snapshot
 * no longer trips them — that leap is absorbed by the zero-point, not merged.
 */
export const POISON_CAPS: Record<string, number> = {
  kills: 5000,
  deaths: 5000,
  damage_dealt: 5_000_000,
  distance_traveled: 2_000_000,
  structures_built: 20_000,
};

export interface MergeContext {
  playerId: string;
  reporter: string;
  world: string | null;
  /** ISO 'now' for the *_at columns. */
  now: string;
  /** Baseline to persist this cycle, or null/undefined to leave the stored one. */
  nextBaseline?: GsBaseline | null;
}

export interface MergeResult {
  /** The full player_stats row to upsert. */
  row: Record<string, unknown>;
  /** Implausible one-cycle jumps, for the caller to log. */
  flags: PoisonFlag[];
}

/**
 * Build the player_stats row for one snapshot: GREATEST over every column, a
 * per-key merge of the long-tail blob, the poison markers, and the zero-point
 * itself when it changed.
 *
 * GREATEST is still the right guard for the columns: with the zero-point held
 * fixed, `effective` only ever grows, so a stale or out-of-order snapshot can
 * never roll a column back — and after a re-baseline it is what preserves
 * everything already earned on this server.
 */
export function mergeIntoRow(
  prev: Record<string, unknown> | null,
  effective: EffectiveStats,
  ctx: MergeContext,
): MergeResult {
  const prevNum = (k: string): number => num(prev?.[k]);
  const gsStats = mergeGsStats(prev?.gs_stats, effective);

  // Stat-poison detector (DETECT, DON'T BLOCK). The FIRST snapshot (no prev row)
  // is never flagged — there is no baseline to jump from.
  const flags: PoisonFlag[] = [];
  if (prev) {
    const incoming: Array<[string, number]> = [
      ['kills', effective.kills],
      ['deaths', effective.deaths],
      ['damage_dealt', effective.damageDealt],
      ['distance_traveled', effective.distanceTraveled],
      ['structures_built', effective.structuresBuilt],
    ];
    for (const [field, nextVal] of incoming) {
      const prevVal = prevNum(field);
      if (nextVal - prevVal > POISON_CAPS[field]) {
        flags.push({ field, prev: prevVal, next: nextVal, at: ctx.now });
      }
    }
    if (flags.length > 0) {
      const priorFlags = Array.isArray(gsStats._flags) ? (gsStats._flags as unknown[]) : [];
      gsStats._flags = [...priorFlags, ...flags];
    }
  }

  const row: Record<string, unknown> = {
    player_id: ctx.playerId,
    kills: Math.max(effective.kills, prevNum('kills')),
    deaths: Math.max(effective.deaths, prevNum('deaths')),
    resources_harvested: Math.max(effective.resourcesHarvested, prevNum('resources_harvested')),
    items_crafted: Math.max(effective.itemsCrafted, prevNum('items_crafted')),
    structures_built: Math.max(effective.structuresBuilt, prevNum('structures_built')),
    distance_traveled: Math.max(effective.distanceTraveled, prevNum('distance_traveled')),
    damage_dealt: Math.max(effective.damageDealt, prevNum('damage_dealt')),
    boss_kills: Math.max(effective.bossKills, prevNum('boss_kills')),
    longest_life_sec: Math.max(effective.longestLifeSec, prevNum('longest_life_sec')),
    best_kills_before_death: Math.max(effective.bestKillsBeforeDeath, prevNum('best_kills_before_death')),
    gs_stats: gsStats,
    gs_reporter: ctx.reporter,
    gs_world: ctx.world,
    gs_updated_at: ctx.now,
    updated_at: ctx.now,
  };

  // Only written when it actually changed (capture / reset streak / re-baseline
  // / hole fill / repair). gs_baselined_at is a timestamptz: never hand it a
  // blank or unparseable string (Postgres 22007 kills the whole upsert).
  if (ctx.nextBaseline) {
    row.gs_baseline = ctx.nextBaseline;
    row.gs_baselined_at = readTimestamp(ctx.nextBaseline.capturedAt) ?? ctx.now;
  }
  return { row, flags };
}

// ── migration guards (the route's fail-safe paths, kept testable) ────────────

export const MIGRATION_REQUIRED =
  '[gs-ingest] BASELINE MIGRATION MISSING: player_stats.gs_baseline / gs_baselined_at do not exist. ' +
  'Apply db/2026-08-23_gs_baselines.sql, then this deploy resumes. SKIPPING the stats merge — without a ' +
  'stored zero-point the only alternatives are freezing every counter at zero or crediting imported ' +
  'lifetime totals, and neither belongs in the table. Nothing was written; the next snapshot self-heals.';

/**
 * An EXISTING row without a gs_baseline KEY (rather than a null value) means the
 * migration hasn't run. `select('*')` returns every column there is, so the
 * key's absence is proof of the column's absence.
 */
export function needsBaselineMigration(prev: Record<string, unknown> | null): boolean {
  return !!prev && !('gs_baseline' in prev);
}

/** PostgREST/Postgres complaint that the gs_baseline column isn't there yet. */
export function isMissingBaselineColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return /gs_baseline/i.test(`${error.message || ''}`);
}

/**
 * The pre-migration subset of the row — the graceful-degradation retry. Safe
 * under baselining: with nowhere to store a zero-point every snapshot computes
 * an all-zero delta and Math.max leaves the existing values untouched, so
 * counters stall rather than inflate.
 */
export function baseColumnsOnly(row: Record<string, unknown>, now: string): Record<string, unknown> {
  return {
    player_id: row.player_id,
    kills: row.kills,
    deaths: row.deaths,
    resources_harvested: row.resources_harvested,
    items_crafted: row.items_crafted,
    structures_built: row.structures_built,
    distance_traveled: row.distance_traveled,
    updated_at: now,
  };
}
