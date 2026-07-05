// Auto-title engine — the sagas name every viking, and the vikings get no say.
//
// THE OWNER'S RULE: titles are ALWAYS generated. A viking cannot choose, buy,
// or veto their epithet. Same inputs always yield the same title — the function
// is pure and deterministic (the only "randomness" is a stable hash of the name).
//
// Titles are DEED-DRIVEN and RANK-AWARE: they reflect what a viking is actually
// doing against the rest of the warband, and they CHANGE as standings shift.
//
// How a title is chosen, in priority order:
//   1. Treefoe override — if a majority of a viking's deaths are to trees, the
//      forest has clearly marked them, and nothing else matters.
//   2. The most DISTINCTIVE stat dimension, scored so RANK counts:
//        • gate on ratio-vs-median (a raw lead over the pack, so a 3-vs-2 nudge
//          never counts) and on z-score (so "high because they simply played a
//          lot" doesn't sneak in).
//        • among the dimensions that clear the bar, score each by z-score, then
//          add a big CROWN bonus when the viking is the *sole* roster leader by a
//          real margin over the runner-up. A clear #1-in-kills therefore reliably
//          out-scores a generic z-score quirk and wears a slayer's title — the
//          leaderboard, not a fluke, decides the epithet. A CROWN in a fighting
//          stat (kills / damage / boss damage) carries an extra nudge, so the #1
//          killer reliably wears a slayer's title even when they also top a
//          non-combat board — unless that other board is dramatically more theirs.
//        • "the Ever-Present" (hours) stays a pure superlative: only the single
//          hours-leader may claim it.
//      HYSTERESIS: when the viking already holds a title (`incumbent`), that
//      dimension gets a small stickiness bonus, so a challenger must beat it by a
//      genuine margin before the title flips. In a 4-8 player hall this kills the
//      churn from 24-vs-23 kill noise while still yielding to a decisive change.
//   3. No real standout → a flavor epithet, chosen by a stable name-hash.
//
// Pure + dependency-free (imports a type only), so it's trivially testable.

import type { PlayerWithStats } from './types';

export type EpithetSource =
  | 'hours'
  | 'kills'
  | 'damage'
  | 'bossdmg'
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
// Rank-awareness: a dimension is a "crown" when the viking is the SOLE roster
// leader in it AND clears the runner-up by at least this factor. A crown adds
// LEADER_BONUS to the dimension's score — enough to outweigh any non-crown
// z-score quirk, so the true #1 reliably wears the fitting title.
const LEADER_MARGIN = 1.15;
const LEADER_BONUS = 2.0;
// The owner's headline rule: the #1 killer should reliably wear a slayer's title.
// A combat CROWN (kills / damage / boss damage) gets this extra nudge, so when a
// viking tops both a combat and a non-combat stat, the sword wins the tie — unless
// the non-combat crown is DRAMATICALLY more distinctive (higher z by > this bonus).
const COMBAT_BONUS = 0.75;
// Hysteresis: the title a viking already holds gets this stickiness bonus, so a
// rival dimension must out-score it by a real margin before the title flips.
const HYSTERESIS_BONUS = 0.6;

interface Dimension {
  source: Exclude<EpithetSource, 'treefoe' | 'flavor'>;
  epithet: string;
  /** pull the raw value off a viking, or null when the stat is absent */
  value: (p: PlayerWithStats) => number | null;
  /** hours is a superlative — only the single roster leader may claim it */
  superlative?: boolean;
  /** a fighting stat — a crown here gets the COMBAT_BONUS priority nudge */
  combat?: boolean;
}

/** Total damage a viking has dealt across bosses (GsValheimStatsClient breakdown). */
function bossDamageValue(p: PlayerWithStats): number | null {
  const bd = p.stats?.gs_stats?.bossDamage;
  if (!Array.isArray(bd) || bd.length === 0) return null;
  const sum = bd.reduce(
    (a, b) => a + (b && Number.isFinite(b.damageDealt) ? b.damageDealt : 0),
    0,
  );
  return sum > 0 ? sum : null;
}

const DIMENSIONS: Dimension[] = [
  { source: 'hours', epithet: 'the Ever-Present', value: (p) => p.total_playtime_minutes ?? null, superlative: true },
  { source: 'kills', epithet: 'Bane of Beasts', value: (p) => p.stats?.kills ?? null, combat: true },
  { source: 'damage', epithet: 'the Heavy-Handed', value: (p) => p.stats?.damage_dealt ?? null, combat: true },
  { source: 'bossdmg', epithet: 'Bane of the Forsaken', value: bossDamageValue, combat: true },
  { source: 'deaths', epithet: 'the Oft-Slain', value: (p) => p.stats?.deaths ?? null },
  { source: 'resources', epithet: 'the Provider', value: (p) => p.stats?.resources_harvested ?? null },
  { source: 'crafts', epithet: 'the Forgehand', value: (p) => p.stats?.items_crafted ?? null },
  { source: 'distance', epithet: 'the Far-Strider', value: (p) => p.stats?.distance_traveled ?? null },
  { source: 'builds', epithet: 'Stonewright', value: (p) => p.stats?.structures_built ?? null },
  { source: 'map', epithet: 'the Far-Seer', value: (p) => p.stats?.map_explored_pct ?? null },
];

// Reverse lookup so an incumbent title string maps back to the dimension it came
// from — that dimension is the one hysteresis makes sticky. Treefoe/flavor titles
// simply aren't here, so they carry no stickiness (a real deed replaces them, and
// that's a genuine promotion worth announcing, not churn).
const SOURCE_BY_TITLE: ReadonlyMap<string, EpithetSource> = new Map(
  DIMENSIONS.map((d) => [d.epithet, d.source as EpithetSource]),
);

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
  /** the second-highest value (0 when only one viking has a positive value) */
  secondMax: number;
  /** how many vikings are tied at the max (a crown needs a SOLE leader) */
  leaderCount: number;
}

/** Roster-wide distribution for a dimension (skips absent values). */
function statsFor(roster: PlayerWithStats[], dim: Dimension): DimStats {
  const values: number[] = [];
  for (const p of roster) {
    const v = dim.value(p);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) {
    return { median: 0, mean: 0, std: 0, max: 0, secondMax: 0, leaderCount: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sorted = [...values].sort((a, b) => b - a);
  const max = sorted[0];
  const leaderCount = sorted.filter((v) => v === max).length;
  const secondMax = sorted.find((v) => v < max) ?? 0;
  return { median: median(values), mean, std: Math.sqrt(variance), max, secondMax, leaderCount };
}

/** True when a majority of a viking's deaths came from trees. */
function isTreefoe(deathCauses: string[]): boolean {
  if (deathCauses.length === 0) return false;
  const trees = deathCauses.filter((c) => /tree/i.test(c)).length;
  return trees / deathCauses.length > TREE_MAJORITY;
}

/**
 * The generated epithet for one viking, judged against the whole warband.
 *
 * @param deathCauses raw cause strings from the viking's death events — feeds
 *   only the Treefoe override.
 * @param incumbent the title the viking currently holds (players.current_title).
 *   When supplied, hysteresis makes that title sticky: a rival must beat it by a
 *   real margin before it flips. Omit it for the pure best (site pages do this,
 *   so every surface renders the same live-standings title by construction; the
 *   API + bot pass it so announcements don't churn on tiny deltas).
 */
export function epithetFor(
  player: PlayerWithStats,
  roster: PlayerWithStats[],
  deathCauses: string[] = [],
  incumbent?: string | null,
): Epithet {
  // 1. The forest's mark trumps all.
  if (isTreefoe(deathCauses)) return { title: 'Treefoe', source: 'treefoe' };

  const incumbentSource = incumbent ? SOURCE_BY_TITLE.get(incumbent) : undefined;

  // 2. Most distinctive dimension: gate on ratio-vs-median + z-score, then score
  //    by z-score plus a crown bonus (rank) plus incumbent stickiness (hysteresis).
  let best: { dim: Dimension; score: number } | null = null;
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

    // A crown: sole roster leader, clearing the runner-up by a real margin
    // (or the only viking doing it at all).
    const soleLeader = v >= s.max && s.leaderCount === 1;
    const crown = soleLeader && (s.secondMax <= 0 || v >= s.secondMax * LEADER_MARGIN);

    let score = z;
    if (crown) score += LEADER_BONUS;
    if (crown && dim.combat) score += COMBAT_BONUS;
    if (incumbentSource && dim.source === incumbentSource) score += HYSTERESIS_BONUS;

    if (!best || score > best.score) best = { dim, score };
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
