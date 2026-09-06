// PURE computation for the cockpit's Performance tab (/admin/ops/performance).
//
// WHAT THIS TAB ANSWERS. Every other cockpit page answers "is it running". This
// one answers "how fast, and how much room is left": how long a fact takes to
// travel from the game to the site, how long a queued line waits to be spoken,
// how close each component is to its own stale threshold, and how much of the
// Supabase free plan (500 MB of database, 1 GB of storage) launch week is about
// to spend.
//
// NO I/O IN THIS FILE. Not a Supabase import, not `server-only`, not a clock:
// every function takes `nowMs` when it needs the time. That is what makes the
// whole tab testable from a plain .mjs through tsx (see performance.test.mjs),
// and it is the layering rule docs/OPS-COCKPIT-V2.md §3 insists on. The reads
// live in app/admin/ops/performance/data.ts.
//
// THREE HOUSE RULES THIS FILE OBEYS EVERYWHERE:
//   1. Absence is never health. Every summary returns `null` rather than 0 for
//      an empty set, so a page prints "no data in this window" instead of a
//      confident zero that reads as "perfect".
//   2. Every number carries a unit in its name (`...Sec`, `...Bytes`,
//      `...PerHour`) so a caller cannot silently mix seconds with milliseconds.
//   3. Anything derived rather than recorded says so in its own type (see
//      `PerfProducer` and `ByteEstimate`), because a guess printed next to a
//      measurement is how an ops page starts lying.

// The relay thresholds, declared once (see ./relay) and re-exported so this
// module's public surface is unchanged for its callers and its tests.
export { RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import { RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import { HEADROOM_WARN_FRACTION } from './health';
import {
  DAY_MS,
  HOUR_MS,
  type Bucket,
  groupIntoBuckets,
  percentile,
  toMs,
} from './window';

// ════════════════════════════════════════════════════════════════════════════
// 1. POLLER LAG: events.inserted_at minus events.created_at
// ════════════════════════════════════════════════════════════════════════════

/** The two stamps every lag number on this page is built from. */
export interface LagRowLike {
  type?: string | null;
  character_name?: string | null;
  /** Producer time: the log line's clock, or real now for a direct write. */
  created_at: string | null;
  /** Insertion time, added 2026-09-05 (db/2026-09-06_events_inserted_at.sql). */
  inserted_at?: string | null;
  metadata?: unknown;
}

/**
 * The instant `events.inserted_at` was added AND BACKFILLED to `created_at`.
 *
 * WHY A PAGE NEEDS THIS CONSTANT. The migration set `inserted_at = created_at`
 * for every row that already existed, which is the right thing for the relay
 * cursor and the wrong thing for a lag chart: those rows all read as exactly
 * 0 s of pipeline delay, and a median computed over them is not a measurement,
 * it is an artefact of the backfill. Rows inserted before this instant are
 * counted and reported separately rather than quietly averaged in.
 *
 * Sourced from the migration file's own header line ("APPLIED to production
 * 2026-09-05 ~23:50 CT"), converted to UTC.
 */
export const INSERTED_AT_BACKFILL_MS = Date.parse('2026-09-06T04:50:00.000Z');

/**
 * Lag in seconds for each row that carries both stamps.
 *
 * Rows without `inserted_at`, or with an unparseable stamp, are DROPPED rather
 * than counted as zero. A negative lag (the producer's clock ahead of the
 * database's) is clamped to 0: it is a clock-skew artefact, not negative
 * pipeline delay, and letting it through would drag a median below the floor.
 * `lagAudit` is what tells a page how many rows were dropped or clamped, so the
 * clamping is visible rather than silent.
 */
export function lagSeconds(rows: LagRowLike[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const c = toMs(r.created_at);
    const i = toMs(r.inserted_at ?? null);
    if (c === null || i === null) continue;
    out.push(Math.max(0, (i - c) / 1000));
  }
  return out;
}

export interface LagAudit {
  /** Rows considered. */
  total: number;
  /** Rows with both stamps, so a lag could be computed. */
  measured: number;
  /** Rows with no `inserted_at` at all: written before the column existed. */
  missingInsertedAt: number;
  /** Rows whose `created_at` was AHEAD of `inserted_at`, clamped to 0 s. */
  clamped: number;
  /**
   * Rows inserted before the backfill, whose `inserted_at` was copied from
   * `created_at` and therefore reads as exactly 0 s. Real rows, useless lags.
   */
  backfilled: number;
}

/** Count what `lagSeconds` kept, dropped and clamped, so a page can say so. */
export function lagAudit(rows: LagRowLike[], backfillCutoffMs: number = INSERTED_AT_BACKFILL_MS): LagAudit {
  let measured = 0;
  let missingInsertedAt = 0;
  let clamped = 0;
  let backfilled = 0;
  for (const r of rows) {
    const c = toMs(r.created_at);
    const i = toMs(r.inserted_at ?? null);
    if (i === null) {
      missingInsertedAt++;
      continue;
    }
    if (c === null) continue;
    measured++;
    if (i < c) clamped++;
    if (i < backfillCutoffMs) backfilled++;
  }
  return { total: rows.length, measured, missingInsertedAt, clamped, backfilled };
}

/**
 * Drop the rows whose `inserted_at` was written by the backfill.
 *
 * WHY EVERY PERCENTILE ON THIS TAB GOES THROUGH THIS. The migration that added
 * `inserted_at` set it equal to `created_at` for every row that already existed,
 * which is right for the relay cursor and useless for a delay measurement: those
 * rows read as exactly 0 s. Left in, they do not merely add noise, they set the
 * answer. On 2026-09-06 all twenty rows in the 7 d window were backfilled ones,
 * so an unfiltered median printed a confident "0 ms" for a pipeline whose real
 * delay had not been measured at all. Filtered, the same window correctly says
 * it has no data, which is the house rule (absence is never health) applied to
 * the one case where the absence is disguised as a number.
 *
 * `lagAudit` still counts them, so the page can say how many were set aside.
 */
export function withoutBackfilled<T extends LagRowLike>(
  rows: T[],
  backfillCutoffMs: number = INSERTED_AT_BACKFILL_MS,
): T[] {
  return rows.filter((r) => {
    const i = toMs(r.inserted_at ?? null);
    return i !== null && i >= backfillCutoffMs;
  });
}

export interface LagSummary {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  /** How many values the summary was computed over. 0 means every field is null. */
  n: number;
}

/** Median, p90, p95 and worst of a set of lag seconds. Empty set: all null. */
export function lagSummary(values: number[]): LagSummary {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { p50: null, p90: null, p95: null, max: null, n: 0 };
  return {
    p50: percentile(clean, 50),
    p90: percentile(clean, 90),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    n: clean.length,
  };
}

export interface LagHistogramBin {
  /** Printable range, with units: "5 to 15 s". */
  label: string;
  /** Inclusive lower edge, seconds. */
  fromSec: number;
  /** Exclusive upper edge, seconds. `null` on the open-ended last bin. */
  toSec: number | null;
  count: number;
}

/**
 * The default bins, chosen from what the pipeline actually does rather than
 * from round numbers: the log poller reads over SFTP on a 20 s cadence, so
 * "under 5 s" is a direct write (gs-ingest), "5 to 30 s" is the poller working
 * normally, "30 s to 2 min" is a poller that missed a cycle, and anything past
 * 2 min is a backlog somebody should look at.
 */
export const LAG_BINS_SEC: number[] = [0, 5, 15, 30, 60, 120, 300];

/** Count values into bins. The last bin is open-ended ("300 s and over"). */
export function lagHistogram(values: number[], edges: number[] = LAG_BINS_SEC): LagHistogramBin[] {
  const e = [...edges].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (e.length === 0) return [];
  const bins: LagHistogramBin[] = e.map((from, idx) => {
    const to = idx < e.length - 1 ? e[idx + 1] : null;
    return {
      label: to === null ? `${from} s and over` : `${from} to ${to} s`,
      fromSec: from,
      toSec: to,
      count: 0,
    };
  });
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    // Below the first edge is still the first bin: a lag cannot be negative
    // after lagSeconds clamps, and dropping it would lose a real row.
    let idx = 0;
    for (let k = bins.length - 1; k >= 0; k--) {
      if (v >= bins[k].fromSec) {
        idx = k;
        break;
      }
    }
    bins[idx].count++;
  }
  return bins;
}

export interface WorstLagRow {
  lagSec: number;
  type: string | null;
  characterName: string | null;
  createdAt: string;
  insertedAt: string;
}

/**
 * The slowest rows in the window, worst first. This is the panel that turns a
 * p95 into something actionable: a percentile says "something is slow", these
 * five rows say which event type, whose character, and at what time of night.
 */
export function worstLagRows(rows: LagRowLike[], limit: number = 5): WorstLagRow[] {
  const out: WorstLagRow[] = [];
  for (const r of rows) {
    const c = toMs(r.created_at);
    const i = toMs(r.inserted_at ?? null);
    if (c === null || i === null) continue;
    out.push({
      lagSec: Math.max(0, (i - c) / 1000),
      type: r.type ?? null,
      characterName: r.character_name ?? null,
      createdAt: r.created_at as string,
      insertedAt: r.inserted_at as string,
    });
  }
  // Worst first; ties broken by the newer row so two identical lags order
  // deterministically instead of by however the database happened to answer.
  out.sort((a, b) => b.lagSec - a.lagSec || Date.parse(b.insertedAt) - Date.parse(a.insertedAt));
  return out.slice(0, Math.max(0, limit));
}

/** A percentile per bucket, for a sparkline. Empty buckets are `null`, not 0. */
export function percentilePerBucket(groups: number[][], p: number): (number | null)[] {
  return groups.map((g) => (g.length === 0 ? null : percentile(g, p)));
}

/** Lag values per bucket, keyed off `inserted_at` (when the row landed). */
export function lagPerBucket(rows: LagRowLike[], buckets: Bucket[]): number[][] {
  const grouped = groupIntoBuckets(rows, (r) => r.inserted_at ?? null, buckets);
  return grouped.map((g) => lagSeconds(g));
}

// ════════════════════════════════════════════════════════════════════════════
// 2. PRODUCER ATTRIBUTION (derived, never recorded)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Which half of the pipeline wrote a row.
 *
 * DERIVED FROM THE ROW SHAPE, NOT RECORDED. `events` has no `source` column, so
 * this is a set of rules read off the four insert sites in the codebase:
 *
 *   log-poller  app/api/webhook/route.ts       join, leave, raid, and the deaths
 *                                              the poller derives from the log
 *   gs-ingest   app/api/gs-ingest/route.ts     boss flips (metadata.source
 *               lib/deaths.ts                  'gs-milestone'), the Great Deeds
 *               lib/milestones.ts              evaluator, and client deaths
 *                                              (metadata.source 'eilif' or a
 *                                              metadata.gsDeathId)
 *   bot         services/discord-bot/scripts/  a hand-marked boss: a boss row
 *               mark-boss.js                   with no source key at all
 *
 * Every page that prints this must label it derived. The rules are correct as of
 * 2026-09-06; a new writer that does not stamp `metadata.source` lands in
 * 'unknown', which is the honest answer and is why 'unknown' is not a bug.
 */
export type PerfProducer = 'log-poller' | 'gs-ingest' | 'bot' | 'unknown';

export const PERF_PRODUCERS: PerfProducer[] = ['log-poller', 'gs-ingest', 'bot', 'unknown'];

export const PRODUCER_LABELS: Record<PerfProducer, string> = {
  'log-poller': 'Log poller',
  'gs-ingest': 'Client ingest',
  bot: 'Discord bot',
  unknown: 'Unattributed',
};

function metaOf(row: LagRowLike): Record<string, unknown> {
  const m = row.metadata;
  return m !== null && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** Attribute one event row to a producer. See PerfProducer for the rule table. */
export function producerOf(row: LagRowLike): PerfProducer {
  const type = (row.type ?? '').toLowerCase();
  const meta = metaOf(row);
  const source = typeof meta.source === 'string' ? meta.source : null;

  switch (type) {
    case 'join':
    case 'leave':
    case 'raid':
      // Presence and world events reach the database only through the poller's
      // webhook. Nothing else writes them.
      return 'log-poller';
    case 'death':
      // The Companion stamps source 'eilif'; the GsValheimStats snapshot path
      // stamps a gsDeathId. Everything else is the poller reading the log.
      if (source === 'eilif') return 'gs-ingest';
      if (typeof meta.gsDeathId === 'string') return 'gs-ingest';
      return 'log-poller';
    case 'milestone':
      // evaluateAndRecord() runs inside the gs-ingest route.
      return 'gs-ingest';
    case 'boss':
      // The automatic flip stamps source 'gs-milestone'; mark-boss.js does not.
      if (source === 'gs-milestone') return 'gs-ingest';
      return 'bot';
    default:
      return 'unknown';
  }
}

/** Rows per producer per bucket, for a stacked read of the ingest rate. */
export function producerCountsPerBucket(
  rows: LagRowLike[],
  buckets: Bucket[],
  at: (row: LagRowLike) => string | null = (r) => r.inserted_at ?? r.created_at,
): Record<PerfProducer, number[]> {
  const grouped = groupIntoBuckets(rows, at, buckets);
  const out = {} as Record<PerfProducer, number[]>;
  for (const p of PERF_PRODUCERS) out[p] = new Array<number>(buckets.length).fill(0);
  grouped.forEach((g, i) => {
    for (const row of g) out[producerOf(row)][i] += 1;
  });
  return out;
}

/** Totals per producer over a whole set of rows. */
export function producerTotals(rows: LagRowLike[]): Record<PerfProducer, number> {
  const out = {} as Record<PerfProducer, number>;
  for (const p of PERF_PRODUCERS) out[p] = 0;
  for (const row of rows) out[producerOf(row)] += 1;
  return out;
}

/** Lag summary split by producer, because the two halves are different things. */
export function lagByProducer(rows: LagRowLike[]): Record<PerfProducer, LagSummary> {
  const out = {} as Record<PerfProducer, LagSummary>;
  for (const p of PERF_PRODUCERS) {
    out[p] = lagSummary(lagSeconds(rows.filter((r) => producerOf(r) === p)));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. RELAY BACKLOG
// ════════════════════════════════════════════════════════════════════════════

export interface RelayBacklog {
  /**
   * 'unknown'   the bot has not published a relay cursor yet
   * 'idle'      nothing waiting
   * 'working'   a small backlog, inside one tick
   * 'behind'    more than BEHIND_SEC of rows waiting, or more than BEHIND_ROWS
   */
  state: 'unknown' | 'idle' | 'working' | 'behind';
  /** Rows newer than the cursor that are inside the read window. */
  pending: number;
  /** Age of the oldest pending row, seconds. Null when nothing is pending. */
  behindSec: number | null;
  /** The cursor as published, echoed back so the page can print it. */
  cursorIso: string | null;
  /**
   * True when `pending` counts only the rows inside the page's read window, so
   * a backlog older than the window would be under-reported.
   */
  boundedByWindow: boolean;
}

// The thresholds are declared once in ./relay and re-exported at the top of this
// file, so the number in a page's evidence line is the number the state was
// computed from, on this tab and on the overview strip alike.

/**
 * How far the #server relay is behind the events table.
 *
 * THE FAILURE THIS WATCHES. On 2026-09-06 a rehearsal found 21 of 43 feed rows
 * had never been posted to Discord and nothing anywhere had noticed: the relay
 * cursored on producer time, so a row stamped in the past was skipped forever
 * and a tick that posts nothing looks exactly like a tick with nothing to post.
 * The heartbeat stayed green throughout. A cursor that stops moving while rows
 * keep landing is the only visible symptom, and this is where it is visible.
 *
 * `rows` are the event rows already in memory for this page; `pending` therefore
 * counts only what is inside the page's window, which is what `boundedByWindow`
 * exists to say out loud.
 */
export function relayBacklog(
  cursorIso: string | null,
  rows: LagRowLike[],
  nowMs: number,
  opts: { windowBounded?: boolean } = {},
): RelayBacklog {
  const boundedByWindow = opts.windowBounded !== false;
  const cursorMs = toMs(cursorIso);
  if (cursorMs === null) {
    return { state: 'unknown', pending: 0, behindSec: null, cursorIso: null, boundedByWindow };
  }
  let pending = 0;
  let oldestPendingMs: number | null = null;
  for (const r of rows) {
    const t = toMs(r.inserted_at ?? null);
    if (t === null || t <= cursorMs) continue;
    pending++;
    if (oldestPendingMs === null || t < oldestPendingMs) oldestPendingMs = t;
  }
  if (pending === 0) {
    return { state: 'idle', pending: 0, behindSec: null, cursorIso, boundedByWindow };
  }
  const behindSec = Math.max(0, (nowMs - (oldestPendingMs as number)) / 1000);
  const state = behindSec > RELAY_BEHIND_SEC || pending > RELAY_BEHIND_ROWS ? 'behind' : 'working';
  return { state, pending, behindSec, cursorIso, boundedByWindow };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. ANNOUNCE AND SPEAK LATENCY
// ════════════════════════════════════════════════════════════════════════════

export interface LatencySummary extends LagSummary {
  /** Rows where the second stamp is still null: it happened, nobody heard it. */
  pending: number;
  /** Age of the oldest still-pending row, seconds. Null when none are pending. */
  oldestPendingSec: number | null;
}

/**
 * The gap between a thing happening and it being announced.
 *
 * Two stamps per row: when it happened, and when the bot said so. A row with the
 * first and not the second is `pending`, and its age is the number that matters
 * most on this panel: the bot polls for unannounced rows on a two minute loop,
 * so a pending row older than a few minutes is a real backlog, not jitter.
 */
export function announceLatency<T>(
  rows: T[],
  at: (row: T) => string | null | undefined,
  announcedAt: (row: T) => string | null | undefined,
  nowMs: number,
): LatencySummary {
  const values: number[] = [];
  let pending = 0;
  let oldestPendingMs: number | null = null;
  for (const r of rows) {
    const happened = toMs(at(r) ?? null);
    if (happened === null) continue;
    const announced = toMs(announcedAt(r) ?? null);
    if (announced === null) {
      pending++;
      if (oldestPendingMs === null || happened < oldestPendingMs) oldestPendingMs = happened;
      continue;
    }
    values.push(Math.max(0, (announced - happened) / 1000));
  }
  return {
    ...lagSummary(values),
    pending,
    oldestPendingSec: oldestPendingMs === null ? null : Math.max(0, (nowMs - oldestPendingMs) / 1000),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. VOICE QUEUE
// ════════════════════════════════════════════════════════════════════════════

export interface VoiceRowLike {
  kind?: string | null;
  status?: string | null;
  queued_at: string | null;
  spoken_at?: string | null;
  meta?: unknown;
}

/**
 * A queued line older than this has almost certainly been abandoned rather than
 * merely delayed. Matches VOICE_QUEUE_DEGRADED_SEC in lib/ops/health.ts on
 * purpose: the overview and this tab must not disagree about when a queue is bad.
 */
export const VOICE_STALLED_AFTER_SEC = 10 * 60;

export interface VoiceQueueHealth {
  /** Lines still waiting to be spoken. */
  queued: number;
  /**
   * Queued lines older than VOICE_STALLED_AFTER_SEC. There is no expiry column
   * and nothing deletes a queued line, so "stalled" is the only honest word: an
   * old queued line is one that nobody ever came to collect.
   */
  stalled: number;
  /** Age of the oldest queued line, seconds. Null when the queue is empty. */
  oldestQueuedSec: number | null;
  /** Lines spoken inside the window. */
  spokenInWindow: number;
  /** Speak latency (spoken_at minus queued_at) over the window. */
  speakLatency: LagSummary;
  /** Speak latency per `kind` (ambient, event, manual). */
  byKind: { kind: string; spoken: number; queued: number; latency: LagSummary }[];
}

/**
 * `queuedRows` is every row still `status = 'queued'` (unbounded in time, since
 * a stalled line can be weeks old); `windowRows` is the rows queued inside the
 * page's window, which is what the latency numbers are computed over.
 */
export function voiceQueueHealth(
  queuedRows: VoiceRowLike[],
  windowRows: VoiceRowLike[],
  nowMs: number,
  stalledAfterSec: number = VOICE_STALLED_AFTER_SEC,
): VoiceQueueHealth {
  let oldestQueuedMs: number | null = null;
  let stalled = 0;
  for (const r of queuedRows) {
    const t = toMs(r.queued_at);
    if (t === null) continue;
    if (oldestQueuedMs === null || t < oldestQueuedMs) oldestQueuedMs = t;
    if ((nowMs - t) / 1000 > stalledAfterSec) stalled++;
  }

  const spokenRows = windowRows.filter((r) => toMs(r.spoken_at ?? null) !== null);
  const latencyOf = (rows: VoiceRowLike[]) =>
    lagSummary(
      rows
        .map((r) => {
          const q = toMs(r.queued_at);
          const s = toMs(r.spoken_at ?? null);
          return q === null || s === null ? null : Math.max(0, (s - q) / 1000);
        })
        .filter((v): v is number => v !== null),
    );

  const kinds = [...new Set(windowRows.concat(queuedRows).map((r) => (r.kind ?? 'unknown').trim() || 'unknown'))].sort();
  const byKind = kinds.map((kind) => ({
    kind,
    spoken: spokenRows.filter((r) => (r.kind ?? 'unknown') === kind).length,
    queued: queuedRows.filter((r) => (r.kind ?? 'unknown') === kind).length,
    latency: latencyOf(spokenRows.filter((r) => (r.kind ?? 'unknown') === kind)),
  }));

  return {
    queued: queuedRows.length,
    stalled,
    oldestQueuedSec: oldestQueuedMs === null ? null : Math.max(0, (nowMs - oldestQueuedMs) / 1000),
    spokenInWindow: spokenRows.length,
    speakLatency: latencyOf(spokenRows),
    byKind,
  };
}

/**
 * Lines spoken since `sinceMs`, from rows the page has already read.
 *
 * The queue panel quotes its latencies over 7 d, because a hall that spoke four
 * times all week has no 24 h median worth printing. The count is the one figure
 * that is worth having over the short window as well: "one line spoken in the
 * last 24 h" and "one line spoken in the last 7 d" are different facts about the
 * same row, and only the first of them answers "is Eilif talking tonight".
 * Computed in memory off the 7 d read rather than as a second query.
 */
export function spokenSince(rows: VoiceRowLike[], sinceMs: number): number {
  let n = 0;
  for (const r of rows) {
    const t = toMs(r.spoken_at ?? null);
    if (t !== null && t >= sinceMs) n++;
  }
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. HEARTBEAT PRESSURE
// ════════════════════════════════════════════════════════════════════════════

export interface HeartbeatPressure {
  ageSec: number | null;
  staleAfterSec: number;
  /**
   * Age as a fraction of the stale threshold. Null when there is no last_success
   * to measure, or when the component has no threshold (the two "alive because
   * this page rendered" rows). Values over 1 are already stale.
   */
  fraction: number | null;
  /**
   * 'quiet' below HEADROOM_WARN_FRACTION, 'tightening' from there to 1, 'over'
   * past 1, 'unknown' at null.
   */
  band: 'quiet' | 'tightening' | 'over' | 'unknown';
}

/**
 * How much of a component's silence budget is used.
 *
 * THE GAP THIS FILLS. The overview's state chip is a cliff: healthy right up to
 * the threshold, then stale. A component sitting at 92% of its window has been
 * healthy for the whole of a slow decline that nobody could see. This is the
 * same fact as a fraction, which is what the Gauge draws.
 */
export function heartbeatPressure(
  nowMs: number,
  lastSuccessIso: string | null | undefined,
  staleAfterSec: number,
): HeartbeatPressure {
  const t = toMs(lastSuccessIso ?? null);
  const ageSec = t === null ? null : Math.max(0, (nowMs - t) / 1000);
  if (ageSec === null || !Number.isFinite(staleAfterSec) || staleAfterSec <= 0) {
    return { ageSec, staleAfterSec, fraction: null, band: 'unknown' };
  }
  const fraction = ageSec / staleAfterSec;
  return {
    ageSec,
    staleAfterSec,
    fraction,
    band: fraction > 1 ? 'over' : fraction >= HEADROOM_WARN_FRACTION ? 'tightening' : 'quiet',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 7. DATABASE AND STORAGE BUDGET
// ════════════════════════════════════════════════════════════════════════════

/** Supabase free plan, 2026-09-06. Both are hard ceilings, not soft warnings. */
export const FREE_PLAN_DB_BYTES = 500 * 1024 * 1024;
export const FREE_PLAN_STORAGE_BYTES = 1024 * 1024 * 1024;

/**
 * What a fresh, empty Supabase project already occupies before a single row of
 * ours exists: the system catalogs, the `auth`, `storage` and `realtime`
 * schemas, `supabase_migrations`, the installed extensions and their indexes.
 *
 * IT IS A CONSTANT BECAUSE IT CANNOT BE MEASURED FROM HERE. `pg_database_size()`
 * needs SQL and PostgREST has no route to it (docs/OPS-COCKPIT-V2.md §11).
 * Without this floor the estimate would read a couple of megabytes while the
 * Supabase dashboard reads seventy, and an operator would trust the wrong one.
 * 60 MB is the middle of the 45 to 80 MB a fresh project typically reports.
 * Applying db/2026-09-06_ops_db_size_rpc.sql replaces the whole estimate with
 * the real number and this constant stops being used.
 */
export const BASELINE_DB_BYTES = 60 * 1024 * 1024;

/**
 * Bytes per row, per table. Every one of these is an ESTIMATE and the page says
 * so wherever the total appears.
 *
 * HOW EACH NUMBER WAS ARRIVED AT. Start from 24 bytes of Postgres tuple header
 * plus alignment, add the fixed columns (a uuid is 16, a timestamptz is 8, an
 * int is 4), add a working guess for the variable text, then add roughly 40
 * bytes per index the row appears in (an index entry is the key plus a tuple
 * pointer). The jsonb columns dominate wherever they exist, which is why
 * `events`, `player_stats`, `bosses` and `ops_heartbeats` are the four rows
 * worth arguing about:
 *
 *   events           two uuids, two timestamptz, a short type, a name, and a
 *                    metadata blob that for a death carries pos, biome, cause,
 *                    hitType and a death id. Three indexes. ~512 B.
 *   player_stats     gs_stats holds per-boss damage, the fish map, the flags
 *                    array and the baseline. Five rows today, kilobytes each.
 *   bosses           fight_stats holds fighters, a damage map and players
 *                    present. Eight rows, so the constant barely matters.
 *   ops_heartbeats   the discord-bot row alone carries `loops` and `subLoops`,
 *                    twelve loops each with six keys. Four rows.
 *   chat_lines       one mirrored shout: the text plus a name.
 *   player_positions one row per viking, overwritten, never grows.
 *
 * A table missing from this map is counted at DEFAULT_ROW_BYTES and named in
 * the panel, so a new table cannot silently vanish from the budget.
 */
export const DEFAULT_ROW_BYTES = 256;

export const ROW_BYTES: Record<string, number> = {
  events: 512,
  sessions: 256,
  players: 320,
  player_stats: 4096,
  voice_lines: 384,
  milestones: 512,
  title_history: 160,
  poty_history: 192,
  oaths: 512,
  pins: 256,
  gallery_photos: 512,
  chat_lines: 256,
  player_positions: 128,
  bosses: 1536,
  discord_events: 384,
  identity_claims: 256,
  ops_heartbeats: 4096,
  ops_alerts: 512,
  server_status: 256,
  roadmap: 384,
};

export interface TableEstimate {
  table: string;
  /** Null when the count could not be read (table absent, or the read failed). */
  rows: number | null;
  bytesPerRow: number;
  /** Null when `rows` is null. */
  bytes: number | null;
  /** True when bytesPerRow fell back to DEFAULT_ROW_BYTES. */
  assumedRowSize: boolean;
}

export interface ByteEstimate {
  tables: TableEstimate[];
  /** Sum of the per-table estimates, excluding the baseline. */
  tableBytes: number;
  /** tableBytes plus BASELINE_DB_BYTES. What the page compares to 500 MB. */
  totalBytes: number;
  /** Tables whose count could not be read. */
  unreadable: string[];
  /** Always true here. Exists so a caller cannot print this as a measurement. */
  estimated: true;
}

/** Turn row counts into a byte estimate. `null` counts survive as `null`. */
export function estimateTableBytes(
  counts: Record<string, number | null>,
  baselineBytes: number = BASELINE_DB_BYTES,
): ByteEstimate {
  const tables: TableEstimate[] = Object.keys(counts)
    .sort()
    .map((table) => {
      const known = Object.prototype.hasOwnProperty.call(ROW_BYTES, table);
      const bytesPerRow = known ? ROW_BYTES[table] : DEFAULT_ROW_BYTES;
      const rows = counts[table];
      return {
        table,
        rows,
        bytesPerRow,
        bytes: rows === null ? null : rows * bytesPerRow,
        assumedRowSize: !known,
      };
    });
  const tableBytes = tables.reduce((sum, t) => sum + (t.bytes ?? 0), 0);
  return {
    tables,
    tableBytes,
    totalBytes: tableBytes + baselineBytes,
    unreadable: tables.filter((t) => t.rows === null).map((t) => t.table),
    estimated: true,
  };
}

export interface GrowthProjection {
  /** Mean bytes added per day over the samples given. Can be 0. */
  bytesPerDay: number;
  /**
   * Whole days until `currentBytes` reaches `ceilingBytes` at that rate.
   * NULL when growth is zero or negative: the page prints "not growing" rather
   * than a number, because Infinity formatted as a date is worse than silence.
   */
  daysToCeiling: number | null;
  /** True when the ceiling has already been passed. */
  overCeiling: boolean;
}

/**
 * Project a byte ceiling forward from per-day samples.
 *
 * The samples are bytes added per day, oldest first. The current (partial) day
 * is the caller's problem: pass it or leave it out, but do not pass it and then
 * wonder why the rate reads low. `projectGrowth` does not know which is which.
 */
export function projectGrowth(
  bytesPerDay: number[],
  currentBytes: number,
  ceilingBytes: number,
): GrowthProjection {
  const clean = bytesPerDay.filter((v) => Number.isFinite(v));
  const rate = clean.length === 0 ? 0 : clean.reduce((a, b) => a + b, 0) / clean.length;
  const overCeiling = currentBytes >= ceilingBytes;
  if (rate <= 0 || overCeiling) {
    return { bytesPerDay: Math.max(0, rate), daysToCeiling: null, overCeiling };
  }
  return {
    bytesPerDay: rate,
    daysToCeiling: Math.floor((ceilingBytes - currentBytes) / rate),
    overCeiling,
  };
}

/** Rows added per day, from a set of timestamps and day buckets. */
export function rowsPerDay(timestamps: (string | null | undefined)[], buckets: Bucket[]): number[] {
  const out = new Array<number>(buckets.length).fill(0);
  if (buckets.length === 0) return out;
  const first = buckets[0].startMs;
  for (const raw of timestamps) {
    const t = toMs(raw ?? null);
    if (t === null) continue;
    const idx = Math.floor((t - first) / DAY_MS);
    if (idx < 0 || idx >= buckets.length) continue;
    out[idx] += 1;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 8. SESSION CONCURRENCY AND DEATHS PER HOUR PLAYED
// ════════════════════════════════════════════════════════════════════════════

export interface SessionRowLike {
  character_name?: string | null;
  joined_at: string | null;
  left_at?: string | null;
}

/**
 * Peak simultaneous sessions inside each bucket.
 *
 * A sweep, not a sample: every session contributes a +1 at the later of its join
 * and the bucket start, and a -1 at the earlier of its leave and the bucket end,
 * so a session that spans midnight counts in both days rather than in neither.
 * An open session (left_at null) is treated as running to `nowMs`, which is the
 * truth for somebody still playing AND the reason a leaked open session inflates
 * every bucket after it: that is a real signal, and the consistency checks on the
 * overview are what name it.
 */
export function peakConcurrencyPerBucket(
  sessions: SessionRowLike[],
  buckets: Bucket[],
  nowMs: number,
): number[] {
  return buckets.map((b) => {
    const marks: { at: number; delta: number }[] = [];
    for (const s of sessions) {
      const start = toMs(s.joined_at);
      if (start === null) continue;
      const rawEnd = toMs(s.left_at ?? null);
      const end = rawEnd === null ? nowMs : rawEnd;
      if (end < start) continue; // a leave before its join is not a session
      const from = Math.max(start, b.startMs);
      const to = Math.min(end, b.endMs);
      if (to <= from) continue; // no overlap with this bucket
      marks.push({ at: from, delta: 1 });
      marks.push({ at: to, delta: -1 });
    }
    // Leaves before joins at the same instant, so a handover does not read as
    // two concurrent vikings.
    marks.sort((a, b2) => a.at - b2.at || a.delta - b2.delta);
    let cur = 0;
    let peak = 0;
    for (const m of marks) {
      cur += m.delta;
      if (cur > peak) peak = cur;
    }
    return peak;
  });
}

/** Total viking-hours played inside [startMs, endMs). Open sessions run to now. */
export function playedHoursInWindow(
  sessions: SessionRowLike[],
  startMs: number,
  endMs: number,
  nowMs: number,
): number {
  let ms = 0;
  for (const s of sessions) {
    const start = toMs(s.joined_at);
    if (start === null) continue;
    const rawEnd = toMs(s.left_at ?? null);
    const end = rawEnd === null ? nowMs : rawEnd;
    if (end < start) continue;
    const from = Math.max(start, startMs);
    const to = Math.min(end, endMs);
    if (to > from) ms += to - from;
  }
  return ms / HOUR_MS;
}

/**
 * Deaths per viking-hour played.
 *
 * NULL when nobody played, never 0: "no deaths per hour" and "nobody was on the
 * server" are opposite facts and printing the first for the second is exactly
 * the mistake the whole cockpit is built to avoid. This is the number that says
 * whether the death penalty and the difficulty tier are set right, and in launch
 * week it is the one to watch.
 */
export function deathsPerHourPlayed(deaths: number, playedHours: number): number | null {
  if (!Number.isFinite(playedHours) || playedHours <= 0) return null;
  return deaths / playedHours;
}

// ════════════════════════════════════════════════════════════════════════════
// 9. FIGHT-STATS REVISION COUNTERS (compare-and-swap traffic)
// ════════════════════════════════════════════════════════════════════════════

export interface BossRowLike {
  name: string;
  sort_order?: number | null;
  is_killed?: boolean | null;
  killed_at?: string | null;
  fight_stats?: unknown;
}

export interface BossRevRow {
  name: string;
  sortOrder: number | null;
  isKilled: boolean;
  killedAt: string | null;
  /**
   * 'none'    fight_stats is null: nothing has ever been folded into this boss
   * 'absent'  fight_stats exists but carries no rev: written before the
   *           compare-and-swap, or by a path that does not stamp one
   * 'number'  a real revision counter, the count of successful CAS writes
   * 'odd'     a rev that is present but not a finite number (a hand edit, a
   *           restore, a future writer that JSON-encoded it). The CAS cannot
   *           match it, so every write on that row gives up. Worth seeing.
   */
  revKind: 'none' | 'absent' | 'number' | 'odd';
  rev: number | null;
  /** How many vikings the fold has recorded on this fight. */
  fighters: number | null;
  /** Where the top-damage figure came from, when there is one. */
  topDamageFrom: string | null;
}

/**
 * Read the compare-and-swap revision off each boss row.
 *
 * WHAT IT IS FOR. `bosses.fight_stats` is the one row in this database written
 * by concurrent writers: the client-damage fold, the observed-damage fold and
 * the kill flip all read-modify-write the same jsonb, and lib/fight-stats-cas.ts
 * guards them with `fight_stats->>rev=eq.<what we read>`. The rev is therefore a
 * traffic counter for that contention, and the only place it is visible. A rev
 * climbing during a fight is the fold working; a rev stuck at the same number
 * while damage is being reported means writes are giving up.
 *
 * A boss with no rev is not a fault. Every row in production today predates the
 * counter, and the page must say "not stamped yet" rather than 0.
 */
export function bossRevRows(bosses: BossRowLike[]): BossRevRow[] {
  return bosses
    .map((b) => {
      const fs = b.fight_stats;
      const isObj = fs !== null && typeof fs === 'object' && !Array.isArray(fs);
      const o = isObj ? (fs as Record<string, unknown>) : null;
      const revRaw = o?.rev;
      let revKind: BossRevRow['revKind'] = 'none';
      let rev: number | null = null;
      if (o) {
        if (revRaw === undefined || revRaw === null) revKind = 'absent';
        else if (typeof revRaw === 'number' && Number.isFinite(revRaw)) {
          revKind = 'number';
          rev = revRaw;
        } else revKind = 'odd';
      }
      const fighters = Array.isArray(o?.fighters) ? (o!.fighters as unknown[]).length : null;
      return {
        name: b.name,
        sortOrder: typeof b.sort_order === 'number' ? b.sort_order : null,
        isKilled: b.is_killed === true,
        killedAt: b.killed_at ?? null,
        revKind,
        rev,
        fighters,
        topDamageFrom: typeof o?.topDamageFrom === 'string' ? (o.topDamageFrom as string) : null,
      };
    })
    .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99) || a.name.localeCompare(b.name));
}

// ════════════════════════════════════════════════════════════════════════════
// 10. DATA FRESHNESS LADDER
// ════════════════════════════════════════════════════════════════════════════

export interface FreshnessInput {
  /** What the reader sees on the public site. */
  surface: string;
  /** The row or object behind it, named so an operator knows where to look. */
  source: string;
  /** Age of the newest thing behind that surface, seconds. Null when unknown. */
  ageSec: number | null;
  /** Over this age the surface is stale. */
  staleAfterSec: number;
  /** Optional override: a caller that already computed staleness elsewhere. */
  staleOverride?: boolean;
}

export interface FreshnessRung extends FreshnessInput {
  state: 'fresh' | 'aging' | 'stale' | 'unknown';
}

/**
 * How old the newest row behind each public surface is.
 *
 * 'aging' is the band this exists for: past 70% of the threshold and not yet
 * stale, which is the state nothing else on the site can show. Unknown age is
 * 'unknown', never 'fresh'.
 */
export function freshnessLadder(inputs: FreshnessInput[]): FreshnessRung[] {
  return inputs.map((i) => {
    if (i.staleOverride === true) return { ...i, state: 'stale' as const };
    if (i.ageSec === null) return { ...i, state: 'unknown' as const };
    if (i.staleAfterSec <= 0) return { ...i, state: 'unknown' as const };
    const f = i.ageSec / i.staleAfterSec;
    return {
      ...i,
      state:
        f > 1 ? ('stale' as const) : f >= HEADROOM_WARN_FRACTION ? ('aging' as const) : ('fresh' as const),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 11. THIS PAGE'S OWN COST
// ════════════════════════════════════════════════════════════════════════════

export interface RenderCost {
  /** Wall clock spent inside the fetch block, milliseconds. */
  fetchMs: number;
  /** HTTP requests issued to Supabase, counting each head-only count as one. */
  queries: number;
  /** Rows actually transferred. Head-only counts transfer none. */
  rows: number;
  /** Requests to Supabase Storage: bucket listing plus object HEADs. */
  storageRequests: number;
  /** The budget this page is measured against, milliseconds. */
  budgetMs: number;
}

/** How much of the render budget the fetch block used. Over 1 is over budget. */
export function renderCostFraction(cost: RenderCost): number {
  if (!Number.isFinite(cost.budgetMs) || cost.budgetMs <= 0) return 0;
  return cost.fetchMs / cost.budgetMs;
}
