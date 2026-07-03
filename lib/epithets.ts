// Auto-title engine — the sagas name every viking, and the vikings get no say.
//
// THE OWNER'S RULE: titles are ALWAYS generated. A viking cannot choose, buy,
// or veto their epithet. Same inputs always yield the same title — the function
// is pure and deterministic (the only "randomness" is a stable hash of the name).
//
// How a title is chosen, in priority order:
//   1. Treefoe override — if a majority of a viking's deaths are to trees, the
//      forest has clearly marked them, and nothing else matters.
//   2. The most DISTINCTIVE stat dimension. "Distinctive" = the viking stands
//      out from the warband. We gate on ratio-vs-median (a raw lead over the
//      pack, so a 3-vs-2 nudge never counts) and then, among the dimensions
//      that clear the bar, pick the one with the highest z-score. The z-score
//      step matters because dimensions live on wildly different scales — crafts
//      routinely run 2-3x the median while hours rarely do — so a bare ratio
//      would hand "the Forgehand" to half the hall. Standardizing makes the
//      comparison fair. "the Ever-Present" is treated as a superlative: only the
//      single hours-leader can claim it, since being *there more than anyone* is
//      the whole point.
//   3. No real standout → a flavor epithet, chosen by a stable name-hash.
//
// Pure + dependency-free (imports a type only), so it's trivially testable.

import type { PlayerWithStats } from './types';

export type EpithetSource =
  | 'hours'
  | 'kills'
  | 'deaths'
  | 'resources'
  | 'crafts'
  | 'distance'
  | 'builds'
  | 'map'
  | 'treefoe'
  | 'flavor';

export interface Epithet {
  /** the phrase itself, already carrying its "the"/"of the" — e.g. "the Ever-Present" */
  title: string;
  /** which dimension (or override/flavor) earned it — handy for tinting / debugging */
  source: EpithetSource;
}

// ── tuning ────────────────────────────────────────────────────────────
// A dimension only counts as a "lead" if the viking sits at least this far
// above the warband median (kills off tiny 3-vs-2 leads) AND is this many
// standard deviations out (kills off "high because they simply played a lot").
const MIN_LEAD = 1.4;
const MIN_Z = 0.5;
// A viking is Treefoe when strictly more than this fraction of their deaths are trees.
const TREE_MAJORITY = 0.5;

interface Dimension {
  source: Exclude<EpithetSource, 'treefoe' | 'flavor'>;
  epithet: string;
  /** pull the raw value off a viking, or null when the stat is absent */
  value: (p: PlayerWithStats) => number | null;
  /** hours is a superlative — only the single roster leader may claim it */
  superlative?: boolean;
}

const DIMENSIONS: Dimension[] = [
  { source: 'hours', epithet: 'the Ever-Present', value: (p) => p.total_playtime_minutes ?? null, superlative: true },
  { source: 'kills', epithet: 'Bane of Beasts', value: (p) => p.stats?.kills ?? null },
  { source: 'deaths', epithet: 'the Oft-Slain', value: (p) => p.stats?.deaths ?? null },
  { source: 'resources', epithet: 'the Provider', value: (p) => p.stats?.resources_harvested ?? null },
  { source: 'crafts', epithet: 'the Forgehand', value: (p) => p.stats?.items_crafted ?? null },
  { source: 'distance', epithet: 'the Far-Strider', value: (p) => p.stats?.distance_traveled ?? null },
  { source: 'builds', epithet: 'Stonewright', value: (p) => p.stats?.structures_built ?? null },
  { source: 'map', epithet: 'the Far-Seer', value: (p) => p.stats?.map_explored_pct ?? null },
];

const FLAVOR_POOL = [
  'the Quiet Flame',
  'of the Long Watch',
  'Mead-Tested',
  'the Unhurried',
  'Frost-Patient',
  'the Steady Oar',
];

/** FNV-1a — a stable, well-spread string hash so name → flavor never drifts. */
function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

interface DimStats {
  median: number;
  mean: number;
  std: number;
  max: number;
}

/** Roster-wide median / mean / std / max for a dimension (skips absent values). */
function statsFor(roster: PlayerWithStats[], dim: Dimension): DimStats {
  const values: number[] = [];
  for (const p of roster) {
    const v = dim.value(p);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return { median: 0, mean: 0, std: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { median: median(values), mean, std: Math.sqrt(variance), max: Math.max(...values) };
}

/** True when a majority of a viking's deaths came from trees. */
function isTreefoe(deathCauses: string[]): boolean {
  if (deathCauses.length === 0) return false;
  const trees = deathCauses.filter((c) => /tree/i.test(c)).length;
  return trees / deathCauses.length > TREE_MAJORITY;
}

/**
 * The generated epithet for one viking, judged against the whole warband.
 * `deathCauses` (raw cause strings from death events) is optional and only
 * feeds the Treefoe override.
 */
export function epithetFor(
  player: PlayerWithStats,
  roster: PlayerWithStats[],
  deathCauses: string[] = []
): Epithet {
  // 1. The forest's mark trumps all.
  if (isTreefoe(deathCauses)) return { title: 'Treefoe', source: 'treefoe' };

  // 2. Most distinctive dimension: gate on ratio-vs-median, choose by z-score.
  let best: { dim: Dimension; z: number } | null = null;
  for (const dim of DIMENSIONS) {
    const v = dim.value(player);
    if (v == null || !Number.isFinite(v) || v <= 0) continue;

    const s = statsFor(roster, dim);
    if (s.median <= 0 || s.std <= 0) continue;

    const lead = v / s.median;
    if (lead < MIN_LEAD) continue;

    const z = (v - s.mean) / s.std;
    if (z < MIN_Z) continue;

    // "the Ever-Present" belongs to the one who is there more than anyone.
    if (dim.superlative && v < s.max) continue;

    if (!best || z > best.z) best = { dim, z };
  }

  if (best) return { title: best.dim.epithet, source: best.dim.source };

  // 3. No standout — a flavor title, stable by name.
  const flavor = FLAVOR_POOL[hashName(player.character_name) % FLAVOR_POOL.length];
  return { title: flavor, source: 'flavor' };
}

const BIO_LINES: ((first: string, title: string) => string)[] = [
  (first) =>
    `The sagas record little of ${first} — only that the hearth was warmer when they were in the hall.`,
  (first, title) =>
    `Some called ${first} ${title}; the skalds wrote no more than that, and needed no more.`,
  (first) =>
    `Of ${first} few verses survive — yet every longhouse remembers the work of their hands.`,
  (first) =>
    `${first} left scarce a word behind, and needed none; the North knew them by their deeds.`,
  (first, title) =>
    `No saga names ${first} at length — but the fires burned longer on the nights ${title} sailed.`,
];

/**
 * A fallback bio line for vikings who never wrote their own. Deterministic by
 * name-hash so a given viking always gets the same sentence; a couple of the
 * variants weave in the generated epithet.
 */
export function generatedBioLine(player: PlayerWithStats, epithet: Epithet): string {
  const first = firstName(player.character_name);
  const pick = BIO_LINES[hashName(player.character_name) % BIO_LINES.length];
  return pick(first, epithet.title);
}
