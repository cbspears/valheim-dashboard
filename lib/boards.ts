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
}

/** Great Deeds roll-up (the `milestones` table). */
export interface DeedsSummary {
  achieved: number;
  total: number;
  latest: { title: string; achievedAt: string | null } | null;
}

/** The eight ready-to-paste sign strings. */
export interface Boards {
  kills: string;
  deaths: string;
  builds: string;
  resources: string;
  explored: string;
  distance: string;
  titles: string;
  deeds: string;
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

/**
 * Top-N leaderboard for one numeric stat.
 *
 * Zero (and null / NaN) is SKIPPED rather than shown: a sign listing five vikings
 * with "0" reads as a broken feed, and the boards are meant to celebrate.
 */
function statBoard(
  header: string,
  players: BoardPlayer[],
  pick: (p: BoardPlayer) => number | null | undefined,
  format: (n: number) => string,
): string {
  const rows = players
    .map((p) => ({ name: p.name, value: Number(pick(p) ?? 0) }))
    .filter((r) => Number.isFinite(r.value) && r.value > 0)
    .sort(byValueThenName)
    .slice(0, TOP_N)
    .map((r) => ({ label: truncate(r.name, MAX_NAME_CHARS), value: format(r.value) }));
  return renderBoard(header, rows, true);
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

/** Build all eight sign strings from an already-flattened roster. */
export function buildBoards(players: BoardPlayer[], deeds: DeedsSummary): Boards {
  return {
    kills: statBoard('Kills', players, (p) => p.kills, formatCount),
    deaths: statBoard('Deaths', players, (p) => p.deaths, formatCount),
    builds: statBoard('Builds', players, (p) => p.builds, formatCount),
    resources: statBoard('Resources', players, (p) => p.resources, formatCount),
    explored: statBoard('Explored', players, (p) => p.exploredPct, formatPct),
    distance: statBoard('Distance', players, (p) => p.distanceM, formatKm),
    titles: titlesBoard(players),
    deeds: deedsBoard(deeds),
  };
}
