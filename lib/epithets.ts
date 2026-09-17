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
// THE LADDER (2026-09-16): every stat dimension now carries TWO titles — the
// rank-1 crown it always had, and a rank-2 title for the clear runner-up — and
// the board list gained fishing and sailing. With the death-cause overrides and
// "the Unslain" alongside them that is 30 earned titles, enough for a hall of
// thirty to be mostly earned rather than mostly hall-named. A rank-2 title is
// only offered when the rank-1 of the SAME dimension is already worn by someone
// else, and only to a viking who owns second place outright (see
// `ownsSecondPlace`); nobody ever wears both rungs of one ladder.
//
// How the roster is titled, in strict priority order — rank-1 crowns, then the
// crowns they vacate, then the overrides, then rank 2, then a hall-name:
//   1. The most DISTINCTIVE stat dimension, scored so RANK counts:
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
//        • "the Ever-Present" (hours) is a superlative — only the hours-leader may
//          claim it — but a RANK-AWARE one: it is claimed anew only by a decisive
//          leader (clearing the runner-up by LEADER_MARGIN) and, once held, kept by
//          its incumbent through any near-tie, so a one-minute swing never flips it.
//          It also rides a DURABLE hours value (closed-session minutes), not the
//          live-elapsed counter that jumps while a viking is online, so the crown
//          doesn't churn as people come and go. (See lib/data.durablePlaytime…)
//      These per-(viking,dimension) scores become edges; a GREEDY pass assigns the
//      highest-scoring edges first, and a title/viking already claimed is skipped —
//      that is what guarantees uniqueness AND lets each dimension go to its truest
//      owner.
//      INHERITANCE: one power player often tops half the boards, and the greedy pass
//      can only give them ONE title — so their other crowns go begging, and land on a
//      runner-up only if that runner-up independently clears the gates (which, next to
//      a runaway leader, they rarely do). A FALLBACK pass therefore hands each VACATED
//      crown (a dimension whose roster leader is already titled elsewhere) down to the
//      best still-untitled viking, provided they own it clearly: a LEADER_MARGIN lead
//      over the next untitled viking, or being the only one on the board at all. The
//      superlative ("the Ever-Present") never falls back — being there most is the
//      whole meaning of it, and second place is simply not it.
//   2. (see INHERITANCE below)
//   3. THE OVERRIDES — a viking whose deaths tell a louder story than any board.
//      Treefoe came first and sets the rule the rest follow: strictly more than
//      half of a viking's deaths to one cause, at least three of them, and the
//      title is unique (several qualifiers -> the one that cause has taken MOST;
//      the rest fall through). The causes are trees, falls, drowning, fire and
//      the deathsquito, and they are disjoint, so no viking is ever in the
//      running for two. Alongside them sits "the Unslain": ten hours in the hall
//      and not one death, to the longest-serving survivor. An override never
//      outranks a crown — a qualifier who is already crowned keeps the crown and
//      the override passes down the list.
//   4. RANK 2, then 5. a personalized hall-name (below).
//
//      HYSTERESIS: when a viking already holds a title (`incumbent` / current_title),
//      that dimension gets a small stickiness bonus, so a challenger must beat it by
//      a genuine margin before the title flips. In a 4-8 player hall this kills the
//      churn from 24-vs-23 kill noise while still yielding to a decisive change.
//      Uniqueness does NOT churn: assignment is deterministic and stable, and an
//      incumbent placeholder is kept as long as it stays free.
//      No real standout → a personalized placeholder epithet, chosen from a pool by
//      a stable name-hash and de-duplicated against the rest of the roster, so even
//      a full launch hall of no-standout newcomers stays unique.
//
// ABSOLUTE FLOORS (the "week one" rule):
//   Every gate above is RELATIVE, so on a fresh world the best of four beginners is
//   still crowned even at absurd numbers (49 structures made a "Stonewright"; 16
//   resources made "the Provider"). A crown must therefore also be EARNED in raw
//   terms: a viking may take a dimension's title, in the greedy pass and in the
//   crown-spread fallback alike, only once their raw value meets that dimension's
//   floor. Below it the crown simply goes unclaimed and the viking falls to a
//   hall-name placeholder, exactly as when nothing qualifies. The floors, tuned for
//   a 4-8 player cozy server so first crowns land around week one:
//     hours     "the Ever-Present"       10 hours (600 minutes)
//     kills     "Bane of Beasts"         50 kills
//     damage    "the Heavy-Handed"       2,500 damage
//     bossdmg   "Bane of the Forsaken"   500 boss damage
//     deaths    "the Oft-Slain"          10 deaths
//     resources "the Provider"           500 resources
//     crafts    "the Forgehand"          100 crafts
//     distance  "the Far-Strider"        20,000 meters
//     builds    "Stonewright"            250 structures
//     map       "the Far-Seer"           5 percent explored
//     fish      "the Angler"             5 catches
//     sail      "the Sea-Wolf"           5,000 metres under sail
//   The RANK-2 rung of each ladder ("the Hearth-Bound", "Beast-Hewer", "the
//   Bone-Breaker", "Thorn of the Forsaken", "the Twice-Buried", "the Gatherer",
//   "the Anvil-Sworn", "the Road-Worn", "the Timber-Wise", "the Horizon-Chaser",
//   "the Line-Caster", "the Salt-Sworn") meets the SAME floor as its crown, so a
//   runner-up who has not done the work in raw terms stays hall-named.
//   The overrides carry their own floors:
//     every death cause         3 deaths to it (the majority rule still applies)
//     "the Unslain"            10 hours played and zero deaths
//   Floors change WHO may be crowned, never the distribution: roster medians, means
//   and z-scores are still computed over everyone, so the relative gates behave the
//   same and the engine stays deterministic.
//
// Pure + dependency-free (imports a type only), so it's trivially testable.

import type { PlayerWithStats } from './types';

export type EpithetSource =
  // stat dimensions — each one carries a LADDER: a rank-1 crown and a rank-2
  // title for the clear runner-up. Both report the dimension as their source,
  // so every surface that tints or ranks by source keeps working unchanged.
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
  | 'fish'
  | 'sail'
  // overrides — a majority death cause, or surviving everything
  | 'treefoe'
  | 'cliff'
  | 'drowning'
  | 'fire'
  | 'deathsquito'
  | 'unslain'
  | 'flavor';

export interface Epithet {
  /** the phrase itself, already carrying its "the"/"of the" — e.g. "the Ever-Present" */
  title: string;
  /** which dimension (or override/flavor) earned it — handy for tinting / debugging */
  source: EpithetSource;
  /**
   * The hall-name this viking would wear if they earned NOTHING: their
   * FLAVOR_POOL pick, de-duplicated across the whole roster exactly like a real
   * title. For a viking who IS hall-named this is the title itself, so the two
   * can never disagree.
   *
   * It exists for the announcer (services/discord-bot/src/titles.js): when a
   * title is taken off its wearer, the wearer has to land on something NOBODY
   * else wears, and the engine's own offer for them may already be worn by a
   * third viking. This is the guaranteed-free landing spot, computed by the one
   * engine that knows the whole roster. Carried on every entry of GET
   * /api/titles.
   */
  placeholder: string;
}

// ── tuning ────────────────────────────────────────────────────────────
// A dimension only counts as a "lead" if the viking sits at least this far
// above the warband median (kills off tiny 3-vs-2 leads) AND is this many
// standard deviations out (kills off "high because they simply played a lot").
const MIN_LEAD = 1.4;
const MIN_Z = 0.5;
// A death-cause override fires when strictly more than this fraction of a
// viking's deaths came from one cause (trees, falls, drowning, fire, a
// deathsquito). A majority is strict, and the causes below are disjoint, so a
// viking can qualify for at most one of them.
const CAUSE_MAJORITY = 0.5;
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

type DimensionSource =
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
  | 'fish'
  | 'sail';

interface Dimension {
  source: DimensionSource;
  /** RANK 1 — the crown, worn by the board's owner. */
  epithet: string;
  /**
   * RANK 2 — the runner-up's own title, so a hall of thirty is mostly earned
   * rather than mostly hall-named. It is offered only when the rank-1 crown of
   * this same dimension is already worn by somebody else, and only to a viking
   * who is the SOLE second place, clears third by LEADER_MARGIN, and meets the
   * dimension's absolute floor. Never both rungs to the same viking.
   */
  second: string;
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

/**
 * Fish landed, read the way /players reads it: the GREATER of the per-species
 * breakdown (`gs_stats.fish[]`, empty for everyone on Valheim 1.0) and the
 * profile's own catch total (`gs_stats.fishCaught`, EilifCompanionClient
 * >=0.4.4). Neither source is the whole story on its own, so whichever is
 * richer wins and nothing is lost if the other comes back. See `totalCatches`
 * in app/players/page.tsx — the two must not drift apart, or the Anglers board
 * and the Angler's title would rank different numbers.
 */
function fishValue(p: PlayerWithStats): number | null {
  const gs = p.stats?.gs_stats;
  if (!gs) return null;
  const list = Array.isArray(gs.fish) ? gs.fish : [];
  const bySpecies = list.reduce(
    (a, f) => a + (f && Number.isFinite(f.count) ? f.count : 0),
    0,
  );
  const total = Number.isFinite(gs.fishCaught as number) ? (gs.fishCaught as number) : 0;
  const best = Math.max(bySpecies, total);
  return best > 0 ? best : null;
}

/** Metres sailed, from the .fch profile's per-mode distance counters. */
function sailValue(p: PlayerWithStats): number | null {
  const v = p.stats?.gs_stats?.distances?.sail;
  return Number.isFinite(v as number) && (v as number) > 0 ? (v as number) : null;
}

const DIMENSIONS: Dimension[] = [
  { source: 'hours', epithet: 'the Ever-Present', second: 'the Hearth-Bound', value: (p) => p.total_playtime_minutes ?? null, superlative: true },
  { source: 'kills', epithet: 'Bane of Beasts', second: 'Beast-Hewer', value: (p) => p.stats?.kills ?? null, combat: true },
  { source: 'damage', epithet: 'the Heavy-Handed', second: 'the Bone-Breaker', value: (p) => p.stats?.damage_dealt ?? null, combat: true },
  { source: 'bossdmg', epithet: 'Bane of the Forsaken', second: 'Thorn of the Forsaken', value: bossDamageValue, combat: true },
  { source: 'deaths', epithet: 'the Oft-Slain', second: 'the Twice-Buried', value: (p) => p.stats?.deaths ?? null },
  { source: 'resources', epithet: 'the Provider', second: 'the Gatherer', value: (p) => p.stats?.resources_harvested ?? null },
  { source: 'crafts', epithet: 'the Forgehand', second: 'the Anvil-Sworn', value: (p) => p.stats?.items_crafted ?? null },
  { source: 'distance', epithet: 'the Far-Strider', second: 'the Road-Worn', value: (p) => p.stats?.distance_traveled ?? null },
  { source: 'builds', epithet: 'Stonewright', second: 'the Timber-Wise', value: (p) => p.stats?.structures_built ?? null },
  { source: 'map', epithet: 'the Far-Seer', second: 'the Horizon-Chaser', value: (p) => p.stats?.map_explored_pct ?? null },
  { source: 'fish', epithet: 'the Angler', second: 'the Line-Caster', value: fishValue },
  { source: 'sail', epithet: 'the Sea-Wolf', second: 'the Salt-Sworn', value: sailValue },
];

/**
 * THE OVERRIDES — a viking whose deaths (or lack of them) tell a louder story
 * than any leaderboard. Modelled on Treefoe, which came first and keeps its
 * exact rule: strictly more than half of this viking's deaths came from that
 * cause, at least CAUSE_FLOOR of them, and the title is UNIQUE — if several
 * qualify it goes to whoever the cause has taken MOST, and the rest fall
 * through to the ladder below.
 *
 * The input is the SAME `causesByName` every caller already builds from
 * `events.metadata.cause` (app/api/titles, /players, the viking page, the ops
 * horizon). A cause with no attacker is the lowercased HitType word ("fall",
 * "drowning", "burning", "tree"); a cause with one is the creature's display
 * name ("Deathsquito"). See lib/deaths.ts eilifCause + humanizeKiller — the
 * patterns below read both spellings, which is why they are regexes and not
 * equality.
 *
 * The patterns are DISJOINT, so a strict majority can only ever name one of
 * them for a given viking; that is what keeps a viking from qualifying twice.
 */
interface CauseOverride {
  source: Extract<EpithetSource, 'treefoe' | 'cliff' | 'drowning' | 'fire' | 'deathsquito'>;
  title: string;
  match: RegExp;
}

const CAUSE_OVERRIDES: readonly CauseOverride[] = [
  { source: 'treefoe', title: 'Treefoe', match: /tree/i },
  { source: 'cliff', title: 'the Cliff-Kisser', match: /fall/i },
  { source: 'drowning', title: 'the Half-Drowned', match: /drown/i },
  { source: 'fire', title: 'the Singed', match: /burn|fire|flame/i },
  { source: 'deathsquito', title: 'the Sting-Struck', match: /deathsquito/i },
];

/** The one override that is about NOT dying. */
const UNSLAIN_TITLE = 'the Unslain';
/** Ten hours in the hall, same bar as the hours floor, and never once killed. */
const UNSLAIN_MIN_MINUTES = 600;

/**
 * ABSOLUTE floors, keyed by the same source keys as DIMENSIONS. A viking may only
 * take a crown once their RAW value meets the floor for that dimension, in the
 * greedy pass and in the crown-spread fallback alike; below it the crown goes
 * unclaimed. Units follow the underlying stat: hours is stored in MINUTES
 * (total_playtime_minutes), distance in metres, map in percent. See the file
 * header for the reasoning and the full table.
 */
const FLOORS: Record<Dimension['source'], number> = {
  hours: 600, // 10 hours, stored as minutes
  kills: 50,
  damage: 2500,
  bossdmg: 500,
  deaths: 10,
  resources: 500,
  crafts: 100,
  distance: 20000, // metres
  builds: 250,
  map: 5, // percent explored
  fish: 5, // catches
  sail: 5000, // metres under sail
};

/**
 * An override's own floor: the cause must have taken a viking this many times
 * before the majority means anything. One unlucky birch on day one is a story,
 * not yet a title.
 */
const CAUSE_FLOOR = 3;

// Reverse lookup so an incumbent title string maps back to the dimension it came
// from — that dimension is the one hysteresis makes sticky. Overrides and flavor
// titles simply aren't here, so they carry no stickiness (a real deed replaces
// them, and that's a genuine promotion worth announcing, not churn). Nor are the
// RANK-2 titles: stickiness on a dimension is what keeps a CROWN from flipping,
// and lending it to the runner-up would bias them toward taking the crown off
// its holder, which is exactly the churn this bonus exists to stop. Rank 2 is
// stable for a different reason — "sole second, clearing third by the margin"
// names at most one viking, so the pass has nothing to churn between.
const SOURCE_BY_TITLE: ReadonlyMap<string, EpithetSource> = new Map(
  DIMENSIONS.map((d) => [d.epithet, d.source as EpithetSource]),
);

/**
 * Every title a viking EARNS — both rungs of all twelve dimension ladders, the
 * five death-cause overrides, and "the Unslain". Thirty in all.
 * Anything else the engine can produce is a personalized placeholder from
 * FLAVOR_POOL, and the difference is load-bearing policy, not decoration: the
 * announcer never demotes an earned title to a placeholder, and the ops horizon
 * labels that refusal "held" rather than a flip.
 *
 * MIRRORED in services/discord-bot/src/titles.js (the bot is plain JS and cannot
 * import this module); `scripts/epithets.test.mjs` asserts the two agree, so a
 * new dimension added here fails the root test suite until the bot follows.
 */
export const EARNED_TITLES: readonly string[] = Object.freeze([
  ...DIMENSIONS.map((d) => d.epithet),
  ...DIMENSIONS.map((d) => d.second),
  ...CAUSE_OVERRIDES.map((o) => o.title),
  UNSLAIN_TITLE,
]);
const EARNED_TITLE_SET: ReadonlySet<string> = new Set(EARNED_TITLES);

/** Is this recorded title one a viking earned, or a placeholder? */
export function isEarnedTitle(title: string | null | undefined): boolean {
  return EARNED_TITLE_SET.has((title ?? '').trim());
}

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
  /** how many are tied at secondMax (a rank-2 title needs a SOLE second) */
  secondCount: number;
  /** the third-highest value — a rank-2 title must clear it by LEADER_MARGIN */
  thirdMax: number;
}

/** Roster-wide distribution for a dimension (skips absent values). */
function statsFor(roster: PlayerWithStats[], dim: Dimension): DimStats {
  const values: number[] = [];
  for (const p of roster) {
    const v = dim.value(p);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) {
    return { median: 0, mean: 0, std: 0, max: 0, secondMax: 0, leaderCount: 0, secondCount: 0, thirdMax: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sorted = [...values].sort((a, b) => b - a);
  const max = sorted[0];
  const leaderCount = sorted.filter((v) => v === max).length;
  const secondMax = sorted.find((v) => v < max) ?? 0;
  const secondCount = secondMax > 0 ? sorted.filter((v) => v === secondMax).length : 0;
  const thirdMax = secondMax > 0 ? sorted.find((v) => v < secondMax) ?? 0 : 0;
  return {
    median: median(values),
    mean,
    std: Math.sqrt(variance),
    max,
    secondMax,
    leaderCount,
    secondCount,
    thirdMax,
  };
}

/** How many of a viking's death causes match an override's pattern. */
function causeCount(causes: string[], match: RegExp): number {
  return causes.filter((c) => match.test(c)).length;
}

/**
 * True when a MAJORITY of a viking's deaths came from one cause AND that cause
 * has taken them at least CAUSE_FLOOR times. This is Treefoe's original rule,
 * generalized to every override in CAUSE_OVERRIDES.
 */
function causeMajority(causes: string[], match: RegExp): boolean {
  if (causes.length === 0) return false;
  const n = causeCount(causes, match);
  if (n < CAUSE_FLOOR) return false;
  return n / causes.length > CAUSE_MAJORITY;
}

/**
 * "the Unslain" — ten hours in the hall and not one death. The only override
 * that reads the absence of a fact, so it is checked against the roster row
 * rather than against death causes: an empty cause list is also what a viking
 * with no death events looks like, and `stats.deaths` is the number that is
 * actually authoritative about whether they have ever fallen.
 */
function isUnslain(p: PlayerWithStats): boolean {
  const minutes = p.total_playtime_minutes ?? 0;
  if (!Number.isFinite(minutes) || minutes < UNSLAIN_MIN_MINUTES) return false;
  // A MISSING stats row is unknown, not zero: only a row that really says zero
  // counts, or a viking nothing has reported on yet would be crowned for it.
  const deaths = p.stats?.deaths;
  return typeof deaths === 'number' && deaths === 0;
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
  // The absolute floor comes first: a crown has to be earned in raw terms before
  // any relative gate gets a say, so a fresh world crowns nobody. The floor is
  // never waived — not even for an incumbent (an heir under the floor is no heir
  // in the fallback pass either).
  if (v < FLOORS[dim.source]) return null;
  if (s.median <= 0 || s.std <= 0) return null;

  const lead = v / s.median;
  const z = (v - s.mean) / s.std;

  // INCUMBENT HOLD — the keystone against churn. A viking who already wears THIS
  // dimension's title keeps a valid edge through a near-tie: as long as no rival
  // exceeds them by LEADER_MARGIN (`s.max <= v * LEADER_MARGIN` — trivially true
  // when they are themselves the leader), the distinctiveness gates below are
  // waived for them, so the title never evaporates into a placeholder on a
  // hair's-breadth swing. This is the SAME stickiness `fallbackWinner` applies in
  // the crown-spread pass, lifted up to the greedy pass — without it, hysteresis
  // was only a score BONUS and could not fire at all once a gate nulled the edge
  // (launch night: Charleif lost "Bane of Beasts" to a placeholder for a pass when
  // a rival's stopgap-derived kills nudged the median and knocked his lead under
  // MIN_LEAD; and Rosir's "the Ever-Present" flipped whenever another online
  // viking's live hours edged past his for a render).
  const isIncumbentDim = incumbentSource != null && dim.source === incumbentSource;
  const heldThroughTie = isIncumbentDim && s.max <= v * LEADER_MARGIN;

  if (dim.superlative) {
    // A superlative ("the Ever-Present") now behaves like a crown: it is claimed
    // anew only by a DECISIVE leader — sole max, clearing the runner-up by
    // LEADER_MARGIN — and otherwise only held by its incumbent through a near-tie.
    // A small lead no longer flips it, in either direction.
    const decisiveLeader =
      v >= s.max &&
      s.leaderCount === 1 &&
      (s.secondMax <= 0 || v >= s.secondMax * LEADER_MARGIN);
    if (!decisiveLeader && !heldThroughTie) return null;
  } else if (!heldThroughTie) {
    if (lead < MIN_LEAD) return null;
    if (z < MIN_Z) return null;
  }

  // A crown: sole roster leader, clearing the runner-up by a real margin
  // (or the only viking doing it at all).
  const soleLeader = v >= s.max && s.leaderCount === 1;
  const crown = soleLeader && (s.secondMax <= 0 || v >= s.secondMax * LEADER_MARGIN);

  let score = z;
  if (crown) score += LEADER_BONUS;
  if (crown && dim.combat) score += COMBAT_BONUS;
  if (isIncumbentDim) score += HYSTERESIS_BONUS;
  return score;
}

/** Stable alphabetical comparison (deterministic tie-breaks, independent of input order). */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Is this dimension's crown VACATED — i.e. is its roster leader already wearing some
 * other title? That is the one situation the fallback pass may fire in: the board has
 * a real owner, the sagas simply couldn't name them twice. When the leader is still
 * untitled they were no standout to begin with (they failed the gates like everyone
 * else), so nothing was vacated and no one inherits anything.
 */
function crownVacated(
  roster: PlayerWithStats[],
  dim: Dimension,
  s: DimStats,
  assigned: ReadonlySet<string>,
): boolean {
  if (!(s.max > 0)) return false;
  return roster.some((p) => {
    const v = dim.value(p);
    return (
      v != null && Number.isFinite(v) && v === s.max && assigned.has(p.character_name)
    );
  });
}

/**
 * Who inherits a vacated crown, judged only against the vikings still untitled.
 *
 * The distinctiveness gates are deliberately NOT re-applied here — next to a runaway
 * leader almost nobody clears them, which is exactly why the crown went begging. The
 * dimension's ABSOLUTE floor still is, though: inheritance hands down a real crown,
 * not a participation prize, so a heir under the floor is no heir. Beyond that, what
 * IS required is that the heir owns the board among the remaining field:
 *   (a) a LEADER_MARGIN lead over the next untitled viking, or being the only one with
 *       any value at all on it; and
 *   (b) hysteresis — a viking who ALREADY holds this title keeps it unless a rival
 *       clears them by that same margin, so an incumbent wins every tie and the title
 *       never churns down to a placeholder over a hair's-breadth swing.
 * Returns null when the field is too tight to name anyone; the crown then stays empty
 * and its would-be claimants fall to placeholders, as before.
 */
function fallbackWinner(
  dim: Dimension,
  untitled: PlayerWithStats[],
  incumbentOf: (p: PlayerWithStats) => string | null,
): { player: PlayerWithStats; value: number } | null {
  const floor = FLOORS[dim.source];
  const ranked: { player: PlayerWithStats; value: number }[] = [];
  for (const p of untitled) {
    const v = dim.value(p);
    // The floor applies to heirs too: an inherited crown is still a crown, and a
    // second-best who hasn't earned it in raw terms leaves it unclaimed.
    if (v != null && Number.isFinite(v) && v > 0 && v >= floor) {
      ranked.push({ player: p, value: v });
    }
  }
  ranked.sort(
    (a, b) => b.value - a.value || byName(a.player.character_name, b.player.character_name),
  );
  if (ranked.length === 0) return null;

  // (b) The incumbent of this very title holds it through any near-tie.
  const held = ranked.find((c) => incumbentOf(c.player) === dim.epithet);
  if (held) {
    const unseated = ranked.some(
      (c) => c !== held && c.value >= held.value * LEADER_MARGIN,
    );
    if (!unseated) return held;
  }

  // (a) Otherwise the highest value takes it — with a real lead, or alone on the board.
  const [top, next] = ranked;
  if (!next || top.value >= next.value * LEADER_MARGIN) return top;
  return null;
}

/**
 * Does this viking own the RANK-2 rung of a dimension?
 *
 * Rank 2 is a real title, not a participation prize, so it is gated exactly
 * like a crown, one step down the board:
 *   • SOLE second place on the roster (a tie for second names nobody), and
 *   • clearing THIRD by LEADER_MARGIN, or being the only other viking on the
 *     board at all, and
 *   • meeting the dimension's own absolute floor, the same number rank 1 must
 *     meet. A runner-up who has not done the work in raw terms stays hall-named.
 *
 * Because "sole second" is unique by construction, at most one viking can
 * qualify per dimension, which is what makes this pass deterministic without a
 * tie-break of its own. Whether the rank-1 crown is actually WORN, and whether
 * this viking is still untitled, are the caller's checks.
 */
function ownsSecondPlace(value: number | null, dim: Dimension, s: DimStats): boolean {
  if (value == null || !Number.isFinite(value) || value <= 0) return false;
  if (value < FLOORS[dim.source]) return false;
  if (!(s.secondMax > 0) || s.secondCount !== 1 || value !== s.secondMax) return false;
  return s.thirdMax <= 0 || value >= s.thirdMax * LEADER_MARGIN;
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
 *   2b. Hand down every crown VACATED by that pass — a dimension whose roster leader
 *      is now titled elsewhere — to the best still-untitled viking, so a hall with one
 *      power player still names its second-best provider, builder and strider instead
 *      of burying them in placeholders. The heir must lead the remaining field by
 *      LEADER_MARGIN (or be alone on the board), an incumbent of the title wins ties,
 *      and the hours superlative never falls back.
 *   3. Anyone still untitled gets a personalized placeholder — their incumbent one
 *      if it's still free (stability), else a name-hash pick de-duplicated against
 *      the roster.
 *   4. Every entry is then given its `placeholder`: the hall-name it would carry
 *      with no deed at all, unique across the roster (step 3 continued over the
 *      vikings who earned something). GET /api/titles publishes it and the
 *      announcer lands a dethroned wearer on it.
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

  // Entries are built WITHOUT their `placeholder` and completed in step 6, which
  // needs the finished flavor assignment to dedupe against.
  interface Draft {
    title: string;
    source: EpithetSource;
    placeholder?: string;
  }
  const result = new Map<string, Draft>();
  const assigned = new Set<string>(); // character_name
  const usedTitles = new Set<string>();

  // Precompute each dimension's roster-wide distribution once.
  const dimStats = new Map<EpithetSource, DimStats>();
  for (const dim of DIMENSIONS) dimStats.set(dim.source, statsFor(roster, dim));

  // ── 1. Deed dimensions, RANK 1 — score every pair, assign greedily by score. ──
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

  // ── 2. Inheritance — rank-1 crowns vacated by a viking who tops several boards. ──
  // One award per round, re-reading the field each time: taking a viking out of the
  // running changes who the next crown's heir is (and whether that crown has a clear
  // enough heir at all), so every round is judged on the roster as it now stands.
  // Rounds pick the vacated crown whose heir is the most distinctive on it (z-score,
  // the same yardstick the greedy pass ranks by), ties broken by dimension order —
  // so a viking in line for two vacated crowns inherits the one that is more theirs.
  for (;;) {
    const untitled = roster.filter((p) => !assigned.has(p.character_name));
    if (untitled.length === 0) break;
    let best: { dim: Dimension; player: PlayerWithStats; strength: number } | null = null;
    for (const dim of DIMENSIONS) {
      // "the Ever-Present" is a pure superlative: no one inherits second place.
      if (dim.superlative || usedTitles.has(dim.epithet)) continue;
      const s = dimStats.get(dim.source)!;
      if (!crownVacated(roster, dim, s, assigned)) continue;
      const heir = fallbackWinner(dim, untitled, incumbentOf);
      if (!heir) continue;
      const strength = s.std > 0 ? (heir.value - s.mean) / s.std : 0;
      if (best === null || strength > best.strength) {
        best = { dim, player: heir.player, strength };
      }
    }
    if (!best) break;
    result.set(best.player.character_name, {
      title: best.dim.epithet,
      source: best.dim.source,
    });
    assigned.add(best.player.character_name);
    usedTitles.add(best.dim.epithet);
  }

  // ── 3. OVERRIDES — a majority death cause, or never having died at all. ──
  // Each one is UNIQUE and each is handed to the viking the cause has taken
  // MOST; a qualifier who is already crowned keeps the crown (rank 1 outranks an
  // override) and the override passes to the next qualifier down. The patterns
  // are disjoint and every one of them needs a strict majority, so no viking is
  // ever in the running for two at once.
  for (const ov of CAUSE_OVERRIDES) {
    if (usedTitles.has(ov.title)) continue;
    const claimants = roster
      .map((p) => ({ p, causes: causesOf(p) }))
      .filter((x) => causeMajority(x.causes, ov.match))
      .map((x) => ({
        p: x.p,
        count: causeCount(x.causes, ov.match),
        frac: x.causes.length ? causeCount(x.causes, ov.match) / x.causes.length : 0,
      }))
      .sort(
        (a, b) =>
          b.count - a.count || b.frac - a.frac || byName(a.p.character_name, b.p.character_name),
      );
    const winner = claimants.find((c) => !assigned.has(c.p.character_name));
    if (!winner) continue;
    result.set(winner.p.character_name, { title: ov.title, source: ov.source });
    assigned.add(winner.p.character_name);
    usedTitles.add(ov.title);
  }

  // "the Unslain" — ten hours and no deaths; the longest-serving survivor wins it.
  if (!usedTitles.has(UNSLAIN_TITLE)) {
    const survivors = roster
      .filter((p) => isUnslain(p))
      .sort(
        (a, b) =>
          (b.total_playtime_minutes ?? 0) - (a.total_playtime_minutes ?? 0) ||
          byName(a.character_name, b.character_name),
      );
    const winner = survivors.find((p) => !assigned.has(p.character_name));
    if (winner) {
      result.set(winner.character_name, { title: UNSLAIN_TITLE, source: 'unslain' });
      assigned.add(winner.character_name);
      usedTitles.add(UNSLAIN_TITLE);
    }
  }

  // ── 4. RANK 2 — the clear runner-up on a board whose crown is already worn. ──
  // A hall of thirty has ten crowns and a lot of very good second places; this
  // is what keeps those second places from all reading as hall-names. The rung is
  // only offered when the rank-1 title of the SAME dimension is actually worn by
  // somebody (a board with no crown has no runner-up worth naming), and only to a
  // still-untitled viking — so the crown-holder can never take their own second
  // place. `ownsSecondPlace` is unique per dimension, so the only contest here is
  // a viking who is the runner-up on two boards at once: they take the one they
  // own most distinctly (z-score, the same yardstick the greedy pass ranks by),
  // ties broken by dimension order and then by name.
  {
    interface SecondEdge {
      name: string;
      dim: Dimension;
      strength: number;
    }
    const seconds: SecondEdge[] = [];
    for (const p of roster) {
      if (assigned.has(p.character_name)) continue;
      for (const dim of DIMENSIONS) {
        if (!usedTitles.has(dim.epithet)) continue; // rank 1 unworn: no second place
        if (usedTitles.has(dim.second)) continue;
        const s = dimStats.get(dim.source)!;
        const v = dim.value(p);
        if (!ownsSecondPlace(v, dim, s)) continue;
        const strength = s.std > 0 ? (v! - s.mean) / s.std : 0;
        seconds.push({ name: p.character_name, dim, strength });
      }
    }
    seconds.sort(
      (a, b) =>
        b.strength - a.strength ||
        dimOrder.get(a.dim.source)! - dimOrder.get(b.dim.source)! ||
        byName(a.name, b.name),
    );
    for (const e of seconds) {
      if (assigned.has(e.name) || usedTitles.has(e.dim.second)) continue;
      result.set(e.name, { title: e.dim.second, source: e.dim.source });
      assigned.add(e.name);
      usedTitles.add(e.dim.second);
    }
  }

  // ── 5. Personalized placeholders for the rest (stable, unique). ──
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

  // ── 6. THE HALL-NAME EVERY VIKING WOULD CARRY IF THEY EARNED NOTHING. ──
  // Every entry also reports a `placeholder` — see the field's doc comment. It is
  // simply step 5 CONTINUED over the whole roster: a hall-named viking's
  // placeholder is the name they already wear, and the earned ones are then dealt
  // their own picks, in name order, against the same used-set. So placeholders are
  // UNIQUE across the roster and agree with the assignment by construction, which
  // is exactly what the announcer needs — a viking whose title is taken away can
  // be put on their placeholder without ever colliding with another registry row.
  {
    const placeholderUsed = new Set<string>(usedTitles);
    const earnedFolk: PlayerWithStats[] = [];
    for (const p of roster) {
      const ep = result.get(p.character_name);
      if (!ep) continue;
      if (ep.source === 'flavor') ep.placeholder = ep.title;
      else if (ep.placeholder === undefined) earnedFolk.push(p);
    }
    earnedFolk.sort((a, b) => byName(a.character_name, b.character_name));
    for (const p of earnedFolk) {
      const ep = result.get(p.character_name)!;
      if (ep.placeholder !== undefined) continue; // duplicate roster row
      const pick = pickPlaceholder(p.character_name, placeholderUsed);
      ep.placeholder = pick;
      placeholderUsed.add(pick);
    }
  }

  const out = new Map<string, Epithet>();
  for (const [name, d] of result) {
    out.set(name, { title: d.title, source: d.source, placeholder: d.placeholder ?? d.title });
  }
  return out;
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
  const fallback = FLAVOR_POOL[hashName(player.character_name) % FLAVOR_POOL.length];
  return (
    map.get(player.character_name) ?? {
      title: fallback,
      source: 'flavor',
      placeholder: fallback,
    }
  );
}

export const BIO_LINES: ((first: string, title: string) => string)[] = [
  (first) =>
    `The sagas record little of ${first}. Only that the hearth was warmer when they were in the hall.`,
  (first, title) =>
    `Some called ${first} ${title}; the skalds wrote no more than that, and needed no more.`,
  (first) =>
    `Of ${first} few verses survive, yet every longhouse remembers the work of their hands.`,
  (first) =>
    `${first} left scarce a word behind, and needed none; the North knew them by their deeds.`,
  (first, title) =>
    `No saga names ${first} at length, but the fires burned longer on the nights ${title} sailed.`,
  // Expanded 2026-09-06 for launch: the bank below is the new writing.
  (first) =>
    `Of ${first} the sagas keep a single line, and that line is mostly about someone else's boat.`,
  (first) =>
    `Eilif marks ${first} present and leaves the rest to the telling. The telling has been slow in coming.`,
  (first) =>
    `Two skalds began the tale of ${first}. Both stopped at the same part, and neither would say which part.`,
  (first) =>
    `The account of ${first} ends mid-sentence. In fairness, so do most accounts in this hall.`,
  (first) =>
    `Half the verses about ${first} were carved into a bench. The bench is firewood now, and it burned well.`,
  (first) =>
    `Someone wrote down "ask ${first} about the boar" and left it there. No one ever asked.`,
  (first) =>
    `The oldest thing the hall can say of ${first} is that they were already here when it started asking.`,
  (first) =>
    `Munin forgot the deeds of ${first} and Hugin was looking elsewhere. The ravens have offered no apology.`,
  (first) =>
    `The saga of ${first} is short and mostly weather. The hall reads it every winter anyway.`,
  (first) =>
    `${first} appears once in the ledger, in the margin, in a hand nobody recognizes.`,
  (first) =>
    `The chroniclers waited for ${first} to do something worth the ink, then went to bed. It happened that night.`,
  (first) =>
    `Little of ${first} survives beyond the smoke stains above the spot where they liked to stand.`,
  (first) =>
    `The record of ${first} is short. The list of vikings who still owe them a favor is not.`,
  (first) =>
    `Eilif has watched ${first} come and go a hundred times and wrote none of it down. Eilif is not a skald.`,
  (first) =>
    `Every account of ${first} disagrees with the others, except the part about the fire. That part never changes.`,
  (first, title) =>
    `A wet winter took the page that held ${first}. What is left of it reads ${title}, and then a blur.`,
  (first, title) =>
    `${first} is entered in the ledger as ${title}, which is either modesty or thrift.`,
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
