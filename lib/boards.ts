// Living Boards — the sign strings shown in-game.
//
// A server-side plugin polls GET /api/boards every ~60s and writes these strings
// straight onto Valheim signs. That makes this module a RENDERING contract, not a
// display helper: whatever comes out here is literally what a viking reads off a
// plank in Skogheim, so it has to be short, stable, and safe for the sign's TMP
// renderer.
//
// PURE (no Supabase, no Next, no imports) so every rule below is unit-tested in
// lib/boards.test.mjs without standing up a database — same split as
// lib/ops/watchdog.ts (pure decisions) vs its route (IO only).
//
// Three properties the plugin depends on:
//   1. DETERMINISTIC — value desc, then name asc. The plugin only rewrites a sign
//      when the string CHANGES, so an unstable sort would burn a sign write (and
//      a client re-sync) every single poll for no reason.
//   2. BUDGETED — each board is capped at BOARD_CHAR_BUDGET. A vanilla sign
//      silently clips long text, and clipping mid-line looks like a bug; dropping
//      whole trailing rows instead degrades honestly.
//   3. POOR-MAN'S RICH TEXT — vanilla signs render a TMP subset. We use `<b>` and
//      AT MOST ONE `<color=#...>` per board; anything fancier renders as literal
//      angle brackets on the plank.

/** Rows per stat board. Five fits a sign; more gets clipped by the budget anyway. */
export const TOP_N = 5;

/** A viking's name is truncated past this so a row can't push the value off the plank. */
export const MAX_NAME_CHARS = 12;

/** Living Titles are free text (the epithet engine writes them) — cap them too. */
export const MAX_TITLE_CHARS = 24;

/** Hard cap per board string, markup included. Rows past it are dropped whole. */
export const BOARD_CHAR_BUDGET = 200;

/** The single accent colour a board may spend, reserved for the leader's value. */
export const ACCENT = '#f2c14e';

/** Shown instead of rows when nobody qualifies (plain, per the repo copy doctrine). */
export const EMPTY_LINE = 'no entries yet';

/** One viking, already flattened from players + player_stats. */
export interface BoardPlayer {
  name: string;
  /** Living Title (players.current_title); '' or null when untitled. */
  title: string | null;
  kills: number;
  deaths: number;
  builds: number;
  resources: number;
  crafts: number;
  distanceM: number;
  exploredPct: number | null;
  longestLifeSec: number;
  bestKillsBeforeDeath: number;
  damageDealt: number;
  /**
   * Playtime in MINUTES, derived from `sessions` the same way /players derives
   * its Hours board (closed sessions at their recorded duration, plus the one
   * open session of a viking who is online right now). NOT
   * `players.total_playtime_minutes` — nothing in the live pipeline writes that
   * column, so it reads back 0 for every real viking.
   */
  playtimeMin: number;
  /**
   * Total catches — the same number the site's Anglers board counts: the GREATER
   * of the per-species `gs_stats.fish` sum and the profile's own
   * `gs_stats.fishCaught`. Either source alone can be short of the truth (the
   * species list is empty on Valheim 1.0; the profile total carries no species),
   * so the max is the honest reading. The max is taken in the route, next to the
   * blob it reads — this module stays pure.
   */
  fishCaught: number;
}

/** Great Deeds roll-up (the `milestones` table). */
export interface DeedsSummary {
  achieved: number;
  total: number;
  latest: { title: string; achievedAt: string | null } | null;
}

/**
 * The twelve ready-to-paste sign strings: ten ranked stat boards (one per
 * leaderboard the dashboard shows on /players) plus Living Titles and Great Deeds.
 *
 * The six original keys never change spelling — `builds`, not `built`; a rename
 * would blank every sign already claimed with `[board:builds]` in the world.
 */
export interface Boards {
  kills: string;
  deaths: string;
  builds: string;
  resources: string;
  explored: string;
  distance: string;
  damage: string;
  hours: string;
  crafts: string;
  fish: string;
  titles: string;
  deeds: string;
}

/**
 * The leader-only plaques: the same ten RANKED stat boards, each cut down to its top row.
 *
 * Ten, not twelve, on purpose. Living Titles is alphabetical (colouring a first name would
 * invent a winner) and Great Deeds is a warband total, not a race — neither has a leader to
 * put on a plaque, so neither gets one here or in the marker vocabulary.
 */
export interface Leaders {
  kills: string;
  deaths: string;
  builds: string;
  resources: string;
  explored: string;
  distance: string;
  damage: string;
  hours: string;
  crafts: string;
  fish: string;
}

// ── Formatters ────────────────────────────────────────────────────────────
// Deliberately NOT lib/format.ts: that module is the website's display layer
// (it pulls in date-fns and switches units — "920 m" under a kilometre), while a
// sign needs one fixed unit per board so a row never changes width between polls.

/** Trim to `max` characters, spending the last one on an ellipsis. */
export function truncate(s: string, max: number): string {
  const v = (s ?? '').trim();
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}

/** 1842 -> "1,842". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Metres -> "84.2 km". Always kilometres, always one decimal (stable width). */
export function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Minutes -> "12.5 h". Always hours, always one decimal — same reasoning as
 * formatKm: one fixed unit per board so a row never changes width between polls
 * (the site's formatPlaytime switches between "48m" and "2h 5m", which would).
 */
export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

/** 31.94 -> "31.9%" (drops a trailing ".0", matching the site). */
export function formatPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * Seconds -> "2h 5m". Both parts always, so the column stays aligned.
 *
 * No required board renders this today — it is exported for the plugin, which
 * receives `data.players[].longestLifeSec` raw and may build its own sign.
 */
export function formatLifeSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Board assembly ────────────────────────────────────────────────────────

/** Value desc, then name asc. Raw `<`/`>` on purpose — localeCompare varies with ICU. */
function byValueThenName(a: { name: string; value: number }, b: { name: string; value: number }): number {
  if (b.value !== a.value) return b.value - a.value;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Append lines while they fit the budget; the header always survives. */
function fitBudget(lines: string[]): string {
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const next = `${out}\n${lines[i]}`;
    if (next.length > BOARD_CHAR_BUDGET) break;
    out = next;
  }
  return out;
}

/**
 * One rendered row, kept split so the accent can wrap the VALUE exactly. Values
 * contain spaces ("84.2 km"), so re-parsing a joined line would colour only "km".
 */
interface Row {
  label: string;
  value: string;
}

/** Wrap a whole value in the board's single accent. */
function accent(value: string): string {
  return `<color=${ACCENT}>${value}</color>`;
}

/** `<b>Header</b>` + one line per row, budget-fitted, no trailing newline. */
function renderBoard(header: string, rows: Row[], accentFirst: boolean): string {
  const head = `<b>${header}</b>`;
  if (rows.length === 0) return `${head}\n${EMPTY_LINE}`;
  const lines = rows.map((r, i) => `${r.label} ${accentFirst && i === 0 ? accent(r.value) : r.value}`);
  return fitBudget([head, ...lines]);
}

/** One ranked stat board: its header word, how to read its number, how to render it. */
interface StatSpec {
  header: string;
  pick: (p: BoardPlayer) => number | null | undefined;
  format: (n: number) => string;
}

/**
 * The ten ranked stat boards, declared ONCE — one per leaderboard /players shows.
 * The full board and the leader plaque both render from this table, which is what makes
 * "the plaque names whoever tops the board" true by construction instead of by two lists
 * happening to agree.
 */
const STATS: Record<keyof Leaders, StatSpec> = {
  kills: { header: 'Kills', pick: (p) => p.kills, format: formatCount },
  deaths: { header: 'Deaths', pick: (p) => p.deaths, format: formatCount },
  builds: { header: 'Builds', pick: (p) => p.builds, format: formatCount },
  resources: { header: 'Resources', pick: (p) => p.resources, format: formatCount },
  explored: { header: 'Explored', pick: (p) => p.exploredPct, format: formatPct },
  distance: { header: 'Distance', pick: (p) => p.distanceM, format: formatKm },
  damage: { header: 'Damage', pick: (p) => p.damageDealt, format: formatCount },
  hours: { header: 'Hours', pick: (p) => p.playtimeMin, format: formatHours },
  crafts: { header: 'Crafts', pick: (p) => p.crafts, format: formatCount },
  fish: { header: 'Catches', pick: (p) => p.fishCaught, format: formatCount },
};

/**
 * Every ranked stat key, in board order — the keys that have a leader plaque.
 *
 * Derived from STATS rather than typed out again: a board added to that table is a
 * board the vocabulary below advertises, with no second list to forget.
 */
export const STAT_KEYS = Object.keys(STATS) as (keyof Leaders)[];

/**
 * THE MARKER VOCABULARY: every board key this feed carries, stat boards first.
 *
 * Served as `keys` on the payload so a plugin can claim any `[board:<key>]` whose key
 * appears here — and honour `[board:<key>:leader]` for any key in STAT_KEYS — without a
 * code change the next time a board is added. Order is stable and append-only; a key is
 * never re-spelled, because a sign in the world is already claimed with the old one.
 */
export const BOARD_KEYS: readonly string[] = [...STAT_KEYS, 'titles', 'deeds'];

/**
 * The top `limit` rows of one ranked stat, rendered.
 *
 * Zero (and null / NaN) is SKIPPED rather than shown: a sign listing five vikings
 * with "0" reads as a broken feed, and the boards are meant to celebrate. That skip is
 * why an empty stat's plaque says "no entries yet" rather than naming a leader at 0.
 */
function rankedBoard(players: BoardPlayer[], spec: StatSpec, limit: number): string {
  const rows = players
    .map((p) => ({ name: p.name, value: Number(spec.pick(p) ?? 0) }))
    .filter((r) => Number.isFinite(r.value) && r.value > 0)
    .sort(byValueThenName)
    .slice(0, limit)
    .map((r) => ({ label: truncate(r.name, MAX_NAME_CHARS), value: spec.format(r.value) }));
  return renderBoard(spec.header, rows, true);
}

/** Top-N leaderboard for one numeric stat. */
function statBoard(players: BoardPlayer[], spec: StatSpec): string {
  return rankedBoard(players, spec, TOP_N);
}

/**
 * The same board, cut to its single top row — a compact plaque for a small sign.
 *
 * Same header, same truncation, same formatter, same tie-break, same accent: it IS the
 * board's first line, so a plaque and a full board standing side by side can never
 * disagree about who is winning.
 */
function leaderPlaque(players: BoardPlayer[], spec: StatSpec): string {
  return rankedBoard(players, spec, 1);
}

/**
 * Every titled viking on one plank, alphabetical — not a ranking, so it spends no
 * accent (colouring an arbitrary first name would imply a winner). Untitled
 * vikings are skipped; the budget still caps how many rows reach the sign.
 */
function titlesBoard(players: BoardPlayer[]): string {
  const rows = players
    .filter((p) => (p.title ?? '').trim().length > 0)
    .map((p) => ({ name: p.name, title: (p.title ?? '').trim() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({
      label: truncate(p.name, MAX_NAME_CHARS),
      value: `— ${truncate(p.title, MAX_TITLE_CHARS)}`,
    }));
  return renderBoard('Living Titles', rows, false);
}

/** Great Deeds roll-up: progress, then the most recent deed earned. */
function deedsBoard(deeds: DeedsSummary): string {
  if (!deeds || deeds.total <= 0) return renderBoard('Great Deeds', [], false);
  // The progress line IS the value here, so it takes the board's one accent whole.
  const lines = [`<b>Great Deeds</b>`, accent(`${formatCount(deeds.achieved)} of ${formatCount(deeds.total)}`)];
  if (deeds.latest?.title) lines.push(`Latest: ${truncate(deeds.latest.title, MAX_TITLE_CHARS)}`);
  return fitBudget(lines);
}

/** Build all twelve sign strings from an already-flattened roster. */
export function buildBoards(players: BoardPlayer[], deeds: DeedsSummary): Boards {
  return {
    kills: statBoard(players, STATS.kills),
    deaths: statBoard(players, STATS.deaths),
    builds: statBoard(players, STATS.builds),
    resources: statBoard(players, STATS.resources),
    explored: statBoard(players, STATS.explored),
    distance: statBoard(players, STATS.distance),
    damage: statBoard(players, STATS.damage),
    hours: statBoard(players, STATS.hours),
    crafts: statBoard(players, STATS.crafts),
    fish: statBoard(players, STATS.fish),
    titles: titlesBoard(players),
    deeds: deedsBoard(deeds),
  };
}

/**
 * Build the ten leader plaques from the same roster.
 *
 * A player asks for one by writing `[board:kills:leader]` instead of `[board:kills]`; the
 * plugin resolves that claim against this map and falls back to the full board if a feed
 * ever answers without it, so nothing here can freeze a sign.
 */
export function buildLeaders(players: BoardPlayer[]): Leaders {
  return {
    kills: leaderPlaque(players, STATS.kills),
    deaths: leaderPlaque(players, STATS.deaths),
    builds: leaderPlaque(players, STATS.builds),
    resources: leaderPlaque(players, STATS.resources),
    explored: leaderPlaque(players, STATS.explored),
    distance: leaderPlaque(players, STATS.distance),
    damage: leaderPlaque(players, STATS.damage),
    hours: leaderPlaque(players, STATS.hours),
    crafts: leaderPlaque(players, STATS.crafts),
    fish: leaderPlaque(players, STATS.fish),
  };
}
