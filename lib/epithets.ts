// Auto-title engine — the sagas name every viking, and the vikings get no say.
//
// THE OWNER'S RULE: titles are ALWAYS generated. A viking cannot choose, buy,
// or veto their epithet. Same inputs always yield the same title — the engine
// is pure and deterministic (the only "randomness" is a stable hash of the name).
//
// THE UNIQUENESS RULE: every viking wears a UNIQUE epithet — no two vikings on
// the roster may share a title at the same time. A title is "a specific, unique
// thing for each character." Because of that, assignment is ROSTER-GLOBAL, not
// per-viking-independent: we score every (viking, dimension) pair, then hand each
// title to whoever owns it MOST (highest score), greedily. The runner-up for a
// contested dimension falls to their own next-best dimension — or, failing any
// standout, to a personalized placeholder from a decent-sized pool. So the
// single-viking `epithetFor(...)` is now a thin view over the whole-roster
// `epithetsFor(roster, ...)`; both live here and agree by construction.
//
// Titles are DEED-DRIVEN and RANK-AWARE: they reflect what a viking is actually
// doing against the rest of the warband, and they CHANGE as standings shift.
//
// How the roster is titled:
//   1. Treefoe — if a majority of a viking's deaths are to trees, the forest has
//      clearly marked them. Treefoe is itself unique, so if several vikings qualify
//      the mark goes to the one the forest has felled MOST (most tree-deaths, then
//      highest fraction); the rest fall through to the deed scoring below.
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
//      These per-(viking,dimension) scores become edges; a GREEDY pass assigns the
//      highest-scoring edges first, and a title/viking already claimed is skipped —
//      that is what guarantees uniqueness AND lets each dimension go to its truest
//      owner.
//      HYSTERESIS: when a viking already holds a title (`incumbent` / current_title),
//      that dimension gets a small stickiness bonus, so a challenger must beat it by
//      a genuine margin before the title flips. In a 4-8 player hall this kills the
//      churn from 24-vs-23 kill noise while still yielding to a decisive change.
//      Uniqueness does NOT churn: assignment is deterministic and stable, and an
//      incumbent placeholder is kept as long as it stays free.
//   3. No real standout → a personalized placeholder epithet, chosen from a pool by
//      a stable name-hash and de-duplicated against the rest of the roster, so even
//      a full launch hall of no-standout newcomers stays unique.
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

// Personalized placeholders for vikings with no standout deed. Kept DECENT-SIZED
// (24) so even a full 20-strong launch hall of newcomers stays unique — a name-hash
// picks a starting phrase and we probe forward for the first still-free one. All in
// the same dry Norse hearth-voice as the earned titles; none overlaps a dimension
// epithet, so a placeholder and a deed-title can never collide.
const FLAVOR_POOL = [
  'the Quiet Flame',
  'of the Long Watch',
  'Mead-Tested',
  'the Unhurried',
  'Frost-Patient',
  'the Steady Oar',
  'the Late-Rising',
  'Keeper of Embers',
  'the Soft-Spoken',
  'of the Second Helping',
  'the Well-Rested',
  'Friend to Fog',
  'the Middle Bench',
  'the Cheerful Ballast',
  'the Unbossed',
  'Warden of the Longfire',
  'the Slow Hand',
  'of the Quiet Fjord',
  'the Half-Heard',
  'the Contented',
  'the Bench-Warmer',
  'Last to Leave the Hall',
  'the Amiable',
  'of the Spare Cloak',
];

/** Membership test so an incumbent placeholder can be kept sticky (see below). */
const FLAVOR_SET: ReadonlySet<string> = new Set(FLAVOR_POOL);

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
 * The score a (viking, dimension) pair earns, or null when the pair doesn't clear
 * the gates. Identical scoring to the original engine — ratio-vs-median + z-score
 * gates, then z + crown bonus (rank) + combat nudge + incumbent stickiness — but
 * factored out so the roster-global assignment can rank every pair against each
 * other. `s` is the dimension's roster-wide distribution (computed once, reused).
 */
function scoreDim(
  player: PlayerWithStats,
  dim: Dimension,
  s: DimStats,
  incumbentSource: EpithetSource | undefined,
): number | null {
  const v = dim.value(player);
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  if (s.median <= 0 || s.std <= 0) return null;

  const lead = v / s.median;
  if (lead < MIN_LEAD) return null;

  const z = (v - s.mean) / s.std;
  if (z < MIN_Z) return null;

  // "the Ever-Present" belongs to the one who is there more than anyone.
  if (dim.superlative && v < s.max) return null;

  // A crown: sole roster leader, clearing the runner-up by a real margin
  // (or the only viking doing it at all).
  const soleLeader = v >= s.max && s.leaderCount === 1;
  const crown = soleLeader && (s.secondMax <= 0 || v >= s.secondMax * LEADER_MARGIN);

  let score = z;
  if (crown) score += LEADER_BONUS;
  if (crown && dim.combat) score += COMBAT_BONUS;
  if (incumbentSource && dim.source === incumbentSource) score += HYSTERESIS_BONUS;
  return score;
}

/** Stable alphabetical comparison (deterministic tie-breaks, independent of input order). */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** How many of a viking's death causes were trees (for ranking Treefoe claimants). */
function treeDeathCount(causes: string[]): number {
  return causes.filter((c) => /tree/i.test(c)).length;
}

/** Pick a personalized placeholder for `name` that isn't already `used`. */
function pickPlaceholder(name: string, used: ReadonlySet<string>): string {
  const n = FLAVOR_POOL.length;
  const start = hashName(name) % n;
  for (let i = 0; i < n; i++) {
    const cand = FLAVOR_POOL[(start + i) % n];
    if (!used.has(cand)) return cand;
  }
  // Pool exhausted (more no-standout vikings than placeholders — only in a hall
  // larger than the pool). Compound two phrases for a far larger, still-in-voice
  // space so uniqueness is always guaranteed. Deterministic by the same hash.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const cand = `${FLAVOR_POOL[(start + i) % n]}, ${FLAVOR_POOL[(start + j) % n]}`;
      if (!used.has(cand)) return cand;
    }
  }
  // Unreachable for any realistic roster; keep the return total.
  return `${FLAVOR_POOL[start]} the Nameless`;
}

/** Options for the roster-global assignment. */
export interface EpithetsOptions {
  /** character_name → raw death-cause strings (feeds the Treefoe override). */
  causesByName?: ReadonlyMap<string, string[]>;
  /**
   * character_name → the title the viking currently holds. When omitted, each
   * viking's own `current_title` on the roster row is used. This is the hysteresis
   * incumbent: the held dimension gets a stickiness bonus, and a held placeholder
   * is kept as long as it stays free — so uniqueness never causes churn.
   */
  incumbentByName?: ReadonlyMap<string, string | null>;
}

/**
 * Title the WHOLE warband at once, guaranteeing every viking a UNIQUE epithet.
 *
 * Returns a map keyed by `character_name`. Every surface (site pages, OG images,
 * the /api/titles endpoint the bot polls) computes from this one function, so they
 * can never disagree — and no two vikings ever share a title.
 *
 * The algorithm:
 *   1. Treefoe (unique) to the most tree-felled qualifier; the rest fall through.
 *   2. Score every remaining (viking, dimension) pair, sort the passing pairs by
 *      score (desc; deterministic tie-breaks), and greedily assign — a title or a
 *      viking already taken is skipped, so each deed-title lands on its truest
 *      owner and its runner-up drops to their next-best deed.
 *   3. Anyone still untitled gets a personalized placeholder — their incumbent one
 *      if it's still free (stability), else a name-hash pick de-duplicated against
 *      the roster.
 */
export function epithetsFor(
  roster: PlayerWithStats[],
  options: EpithetsOptions = {},
): Map<string, Epithet> {
  const causesByName = options.causesByName;
  const incumbentByName = options.incumbentByName;
  const incumbentOf = (p: PlayerWithStats): string | null =>
    incumbentByName ? incumbentByName.get(p.character_name) ?? null : p.current_title ?? null;
  const causesOf = (p: PlayerWithStats): string[] =>
    causesByName?.get(p.character_name) ?? [];

  const result = new Map<string, Epithet>();
  const assigned = new Set<string>(); // character_name
  const usedTitles = new Set<string>();

  // Precompute each dimension's roster-wide distribution once.
  const dimStats = new Map<EpithetSource, DimStats>();
  for (const dim of DIMENSIONS) dimStats.set(dim.source, statsFor(roster, dim));

  // ── 1. Treefoe — unique; goes to the viking the forest has felled most. ──
  const treeClaimants = roster
    .map((p) => ({ p, causes: causesOf(p) }))
    .filter((x) => isTreefoe(x.causes))
    .map((x) => ({
      p: x.p,
      count: treeDeathCount(x.causes),
      frac: x.causes.length ? treeDeathCount(x.causes) / x.causes.length : 0,
    }))
    .sort(
      (a, b) => b.count - a.count || b.frac - a.frac || byName(a.p.character_name, b.p.character_name),
    );
  if (treeClaimants.length > 0) {
    const winner = treeClaimants[0].p;
    result.set(winner.character_name, { title: 'Treefoe', source: 'treefoe' });
    assigned.add(winner.character_name);
    usedTitles.add('Treefoe');
  }

  // ── 2. Deed dimensions — score every pair, assign greedily by score. ──
  const dimOrder = new Map(DIMENSIONS.map((d, i) => [d.source, i]));
  interface Edge {
    name: string;
    dim: Dimension;
    score: number;
  }
  const edges: Edge[] = [];
  for (const p of roster) {
    if (assigned.has(p.character_name)) continue;
    const inc = incumbentOf(p);
    const incumbentSource = inc ? SOURCE_BY_TITLE.get(inc) : undefined;
    for (const dim of DIMENSIONS) {
      const score = scoreDim(p, dim, dimStats.get(dim.source)!, incumbentSource);
      if (score != null) edges.push({ name: p.character_name, dim, score });
    }
  }
  edges.sort(
    (a, b) =>
      b.score - a.score ||
      byName(a.name, b.name) ||
      dimOrder.get(a.dim.source)! - dimOrder.get(b.dim.source)!,
  );
  for (const e of edges) {
    if (assigned.has(e.name) || usedTitles.has(e.dim.epithet)) continue;
    result.set(e.name, { title: e.dim.epithet, source: e.dim.source });
    assigned.add(e.name);
    usedTitles.add(e.dim.epithet);
  }

  // ── 3. Personalized placeholders for the rest (stable, unique). ──
  const remaining = roster
    .filter((p) => !assigned.has(p.character_name))
    .sort((a, b) => byName(a.character_name, b.character_name));
  // Pass A: keep an incumbent placeholder that's still free — no needless churn.
  for (const p of remaining) {
    const inc = incumbentOf(p);
    if (inc && FLAVOR_SET.has(inc) && !usedTitles.has(inc)) {
      result.set(p.character_name, { title: inc, source: 'flavor' });
      assigned.add(p.character_name);
      usedTitles.add(inc);
    }
  }
  // Pass B: everyone left gets a de-duplicated name-hash pick.
  for (const p of remaining) {
    if (assigned.has(p.character_name)) continue;
    const title = pickPlaceholder(p.character_name, usedTitles);
    result.set(p.character_name, { title, source: 'flavor' });
    assigned.add(p.character_name);
    usedTitles.add(title);
  }

  return result;
}

/**
 * The generated epithet for one viking, judged against the whole warband.
 *
 * Backward-compatible thin wrapper over {@link epithetsFor}: it runs the full
 * roster-global assignment (so the returned title is UNIQUE and consistent with
 * every other surface) and returns this viking's entry. Prefer `epithetsFor` when
 * titling more than one viking — it does the work once.
 *
 * @param deathCauses raw cause strings from THIS viking's death events — feeds the
 *   Treefoe override for this viking. (Other vikings' Treefoe status is only seen
 *   when you pass full causes via `epithetsFor`.)
 * @param incumbent the title this viking currently holds (players.current_title).
 *   When supplied, hysteresis makes that title sticky: a rival must beat it by a
 *   real margin before it flips. When omitted, each viking's own `current_title`
 *   on the roster row is used, so the API + bot and the site agree.
 */
export function epithetFor(
  player: PlayerWithStats,
  roster: PlayerWithStats[],
  deathCauses: string[] = [],
  incumbent?: string | null,
): Epithet {
  const inRoster = roster.some(
    (r) => r === player || r.character_name === player.character_name,
  );
  const list = inRoster ? roster : [...roster, player];

  const causesByName = new Map<string, string[]>([[player.character_name, deathCauses]]);
  const incumbentByName = new Map<string, string | null>();
  for (const p of list) incumbentByName.set(p.character_name, p.current_title ?? null);
  if (incumbent !== undefined) incumbentByName.set(player.character_name, incumbent);

  const map = epithetsFor(list, { causesByName, incumbentByName });
  return (
    map.get(player.character_name) ?? {
      title: FLAVOR_POOL[hashName(player.character_name) % FLAVOR_POOL.length],
      source: 'flavor',
    }
  );
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
