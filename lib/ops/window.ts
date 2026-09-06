// Shared time-window helpers for the ops cockpit v2 tabs, PURE (data in, data
// out) so every one of them unit-tests without Next or a database.
//
// WHY THIS FILE EXISTS. Four tabs (overview insights, activity, horizon,
// performance) all bucket rows into hours or days, quote a percentile, and print
// a duration or an age. Written four times those would disagree four ways: one
// tab's "last 24 h" would be a rolling window, another's a calendar day, and two
// medians would be computed by different rules. Everything that turns timestamps
// into buckets, numbers into percentiles, or seconds into words lives here, once.
//
// TWO HOUSE RULES THIS FILE ENFORCES:
//   1. Every window is EXPLICIT. There is no "recent". Callers pass a window
//      length and the label helpers print the unit, so a number on the page can
//      always be read as "N of X, over Y".
//   2. Buckets are aligned in UTC, never in the server's local zone. Vercel runs
//      in UTC and this box does not, so a locally-aligned bucket would put the
//      same row in different columns depending on where the page rendered.
//      Pages say so next to the axis (see BUCKET_TZ).

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The two windows the whole cockpit is allowed to ask for. */
export const WINDOW_24H_MS = 24 * HOUR_MS;
export const WINDOW_7D_MS = 7 * DAY_MS;

/**
 * Hard ceiling on rows returned by any single cockpit query.
 *
 * Every read on these pages is bounded twice: by a time window AND by an
 * explicit `.limit()`. This is the number that limit may not exceed. It is set
 * where it is because the busiest table (`events`) writes a few hundred rows on
 * a full evening, so 2000 covers a 7 day window with room to spare while still
 * being a number that cannot melt a serverless render if a loop ever runs away.
 */
export const ROW_LIMIT = 2000;

/** Bucket boundaries are aligned in this zone. Print it next to any bucket axis. */
export const BUCKET_TZ = 'UTC';

export interface Bucket {
  /** Inclusive start of the bucket, epoch ms. */
  startMs: number;
  /** Exclusive end of the bucket, epoch ms. */
  endMs: number;
  /** Short axis label: "14:00" for hours, "Sep 06" for days. Always UTC. */
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `hours` consecutive UTC-hour buckets, oldest first, the last one holding
 * `nowMs`. The last bucket is partial by construction (the hour is not over),
 * which is why a chart built on these should label it as the current hour rather
 * than invite a comparison with the full ones beside it.
 */
export function hourBuckets(nowMs: number, hours: number = 24): Bucket[] {
  const count = Math.max(1, Math.floor(hours));
  const currentStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const startMs = currentStart - i * HOUR_MS;
    const d = new Date(startMs);
    out.push({ startMs, endMs: startMs + HOUR_MS, label: `${pad2(d.getUTCHours())}:00` });
  }
  return out;
}

/**
 * `days` consecutive UTC-midnight buckets, oldest first, the last one holding
 * `nowMs`. Same partial-last-bucket caveat as hourBuckets.
 */
export function dayBuckets(nowMs: number, days: number = 7): Bucket[] {
  const count = Math.max(1, Math.floor(days));
  const currentStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const startMs = currentStart - i * DAY_MS;
    const d = new Date(startMs);
    out.push({
      startMs,
      endMs: startMs + DAY_MS,
      label: `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())}`,
    });
  }
  return out;
}

/** Epoch ms from an ISO string or a number, or null when it is not a time. */
export function toMs(at: string | number | Date | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : at.getTime();
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/**
 * Count how many of `timestamps` fall in each bucket. Anything outside every
 * bucket, or unparseable, is dropped rather than folded into an end bucket:
 * a chart that silently piles the past into its first column is a chart that
 * lies about the window it claims to show.
 */
export function countInBuckets(
  timestamps: (string | number | Date | null | undefined)[],
  buckets: Bucket[],
): number[] {
  const out = new Array<number>(buckets.length).fill(0);
  if (buckets.length === 0) return out;
  const first = buckets[0].startMs;
  const width = buckets[0].endMs - buckets[0].startMs;
  for (const raw of timestamps) {
    const t = toMs(raw);
    if (t === null) continue;
    const idx = Math.floor((t - first) / width);
    if (idx < 0 || idx >= buckets.length) continue;
    out[idx] += 1;
  }
  return out;
}

/**
 * Same shape as countInBuckets, but grouping whole rows so a caller can chart a
 * per-bucket statistic (a p90 lag per hour, say) rather than a count.
 */
export function groupIntoBuckets<T>(
  rows: T[],
  at: (row: T) => string | number | Date | null | undefined,
  buckets: Bucket[],
): T[][] {
  const out: T[][] = buckets.map(() => []);
  if (buckets.length === 0) return out;
  const first = buckets[0].startMs;
  const width = buckets[0].endMs - buckets[0].startMs;
  for (const row of rows) {
    const t = toMs(at(row));
    if (t === null) continue;
    const idx = Math.floor((t - first) / width);
    if (idx < 0 || idx >= buckets.length) continue;
    out[idx].push(row);
  }
  return out;
}

/**
 * Linear-interpolated percentile, `p` in 0..100. Returns null for an empty set
 * so a caller renders "no data" instead of a confident 0. Non-finite values are
 * dropped; the input array is never mutated.
 */
export function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const q = Math.min(100, Math.max(0, p)) / 100;
  const pos = (clean.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return clean[lo];
  return clean[lo] + (clean[hi] - clean[lo]) * (pos - lo);
}

/** percentile(values, 50). */
export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/** Arithmetic mean, or null for an empty set. Non-finite values are dropped. */
export function mean(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/** Age in seconds of `at` relative to `nowMs`, floored at 0, or null. */
export function ageSecFrom(nowMs: number, at: string | number | Date | null | undefined): number | null {
  const t = toMs(at);
  return t === null ? null : Math.max(0, (nowMs - t) / 1000);
}

/** Seconds from `nowMs` until `at`. Negative when it is already past. Null if unparseable. */
export function untilSecFrom(nowMs: number, at: string | number | Date | null | undefined): number | null {
  const t = toMs(at);
  return t === null ? null : (t - nowMs) / 1000;
}

/**
 * ── UTC clock labels ────────────────────────────────────────────────────────
 *
 * One clock format for the whole cockpit, always printed in UTC and always
 * saying so. The buckets above are UTC (BUCKET_TZ), the database stores
 * timestamptz, and these pages render on a server whose zone is neither
 * Vercel's nor the reader's: a bare "14:37" would mean three different instants
 * depending on where it was read.
 *
 * They live here rather than beside one tab because two tabs wrote the same
 * formatter: the activity tab's row stamps and the insights strip's evidence
 * lines produced identical strings from two implementations, which is one
 * rename away from the strip and the feed disagreeing about what time a thing
 * happened.
 */

/** "Sep 06 14:37 UTC". `fallback` is what an unparseable time prints. */
export function stampUtc(
  at: string | number | Date | null | undefined,
  fallback: string = 'unknown time',
): string {
  const t = toMs(at);
  if (t === null) return fallback;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )} UTC`;
}

/** "14:37:02": the seconds matter when two rows land in the same minute. */
export function clockUtc(at: string | number | Date | null | undefined): string {
  const t = toMs(at);
  if (t === null) return '--:--';
  const d = new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "Sep 06": the day heading a run of rows sits under. */
export function dayUtc(at: string | number | Date | null | undefined): string {
  const t = toMs(at);
  if (t === null) return 'unknown day';
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())}`;
}

/** ISO string for `windowMs` before `nowMs`. The `.gte()` bound of every windowed read. */
export function sinceIso(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString();
}

/**
 * A duration in plain words, always carrying its unit: "0 s", "42 s", "5 m",
 * "2 h 10 m", "3 d 4 h". Null renders as an em-dash-free placeholder.
 *
 * ROUND ONCE, THEN SPLIT. The first cut of this function split first and then
 * rounded the remainder on its own, which printed three durations that do not
 * exist. `floor(119.6 / 60)` is 1 and `round(119.6 % 60)` is 60, so 119.6 s came
 * out as "1 m 60 s"; the same shape gave "23 h 60 m" just under a day and
 * "4 d 24 h" just under five days. Both halves were individually correct and the
 * pair was wrong, which is the failure mode a caption cannot survive: three
 * separate tabs shipped that string to the page (the insights strip's card ages,
 * the horizon countdowns and the activity gaps) and all three reported it.
 *
 * So the total is rounded to a single unit FIRST and the split is exact integer
 * arithmetic on that total, which makes a carry impossible by construction. The
 * band is chosen from the rounded total too, so the bands stay contiguous:
 * 89 m 59 s is followed by 1 h 30 m, never by "90 m".
 */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'no data';
  const s = Math.max(0, sec);
  if (s < 1) {
    const ms = Math.round(s * 1000);
    // 999.6 ms rounds to 1000, which is a second and should say so.
    return ms >= 1000 ? '1 s' : `${ms} ms`;
  }

  const totalSec = Math.round(s);
  if (totalSec < 90) return `${totalSec} s`;
  if (totalSec < 90 * 60) {
    const m = Math.floor(totalSec / 60);
    const rest = totalSec % 60;
    return rest === 0 ? `${m} m` : `${m} m ${rest} s`;
  }

  const totalMin = Math.round(s / 60);
  if (totalMin < 48 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} m`;
  }

  const totalHr = Math.round(s / 3600);
  const d = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** "42 s ago" / "2 h 10 m ago", or "never" for null. */
export function formatAgeSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'never';
  return `${formatDurationSec(sec)} ago`;
}

/**
 * A countdown in plain words: "in 3 h 12 m", "due now", "overdue by 5 m".
 * Takes the same seconds-until value untilSecFrom returns.
 */
export function formatCountdownSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'not scheduled';
  if (Math.abs(sec) < 30) return 'due now';
  if (sec < 0) return `overdue by ${formatDurationSec(-sec)}`;
  return `in ${formatDurationSec(sec)}`;
}

/** Thousands-separated integer: 1234 becomes "1,234". Null renders "no data". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'no data';
  return Math.round(n).toLocaleString('en-US');
}

/** Byte size with a unit: "512 MB", "1.4 GB". Null renders "no data". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'no data';
  const b = Math.max(0, bytes);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A 0..1 fraction as a percentage with its sign: 0.42 becomes "42%". */
export function formatPercent(fraction: number | null | undefined, digits: number = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 'no data';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * A rate with its window spelled out: "18 per hour, last 24 h".
 * `windowMs` is the window the count was taken over.
 */
export function formatRatePerHour(count: number, windowMs: number): string {
  if (!Number.isFinite(count) || windowMs <= 0) return 'no data';
  const perHour = count / (windowMs / HOUR_MS);
  const shown = perHour >= 10 ? Math.round(perHour) : Math.round(perHour * 10) / 10;
  return `${shown} per hour`;
}

/**
 * The label the cockpit uses for a window length: "last 24 h", "last 7 d".
 *
 * One day is spelled "24 h" and not "1 d" on purpose: the short window on these
 * pages is a rolling day, and "last 1 d" reads like a calendar day boundary.
 */
export function windowLabel(windowMs: number): string {
  if (windowMs === WINDOW_24H_MS) return 'last 24 h';
  if (windowMs % DAY_MS === 0) return `last ${windowMs / DAY_MS} d`;
  if (windowMs % HOUR_MS === 0) return `last ${windowMs / HOUR_MS} h`;
  return `last ${Math.round(windowMs / MINUTE_MS)} min`;
}
