// The insights strip: the paragraph on top of the wall of facts.
//
// WHAT THIS FILE IS. The overview answers "is every component up". It does not
// answer "of everything true right now, what is the one thing worth saying".
// This module does. It takes six bounded reads worth of plain rows and returns
// a small set of short, specific sentences, each one computed from a named
// window against a named threshold, ranked so the worst thing is first.
//
// PURE, AND THAT IS THE POINT. No I/O, no 'server-only', no Supabase client.
// Everything here is data in, sentences out, which is what lets
// insights.test.mjs fabricate a 24 h and assert exactly which cards fire and
// which stay silent. The fetching lives in
// components/ops/insights/loadInsights.ts and is thin enough to read.
//
// THE FIVE RULES EVERY CANDIDATE OBEYS:
//   1. It is computed. No card says anything that is not a number off a row.
//   2. It names its window and its threshold in the evidence line, so the
//      reader can disagree with the rule rather than only with the verdict.
//   3. It does not fire when the data it needs is missing. A silent card is
//      correct; a vague card is not. Absence is never reported as health.
//   4. It carries its own caption (see `explain`), because a number with no
//      caption is the exact thing the owner asked us to fix.
//   5. Its copy is plain operator English, no Norse register, no em dashes.
//
// WHY THE SEVERITIES ARE ORDERED critical, warn, good, info. `good` outranks
// `info` on purpose: a `good` card is a positive event that actually happened
// (a new viking arrived, the relay is caught up), while `info` is context that
// is true every render (the world day, the busiest hour). In a quiet week the
// events are what an operator wants at the top of a four-card strip; in a bad
// week nothing `good` outranks a `warn` anyway.

import type { GlossaryEntry } from './glossary';
import type { Milestone } from '../types';
import { computeAggregates, summarizeMilestones, formatMetricValue, metricInfo } from '../milestones';
import { COMPONENTS, HEADROOM_WARN_FRACTION } from './health';
// The relay thresholds, declared once (see ./relay) and re-exported so this
// module's public surface is unchanged for its callers and its tests.
export { RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import { RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import {
  DAY_MS,
  HOUR_MS,
  WINDOW_24H_MS,
  ageSecFrom,
  countInBuckets,
  formatAgeSec,
  formatCount,
  formatDurationSec,
  formatPercent,
  hourBuckets,
  stampUtc as stampUtcShared,
  toMs,
} from './window';

// ── Thresholds, all in one place so a reader can audit every rule at once ────
//
// Each one is a judgement call, and each one is written into the evidence line
// of the card it governs, so the page never asserts a threshold it will not
// show you.

/**
 * Players are online and no event row has been written for this long.
 *
 * Three hours, not minutes. A viking who logs in and builds quietly writes no
 * rows at all: joins, leaves and deaths are the only things the poller records,
 * so a long silence is a normal evening, not an outage. Three hours of it while
 * the emitter still reports somebody connected is odd enough to say out loud,
 * and the card says plainly that a quiet build session looks the same.
 */
export const SILENT_HALL_SEC = 3 * 60 * 60;

/**
 * The relay is behind when one waiting row has waited longer than
 * RELAY_BEHIND_SEC, or when MORE THAN RELAY_BEHIND_ROWS rows are waiting at once.
 *
 * Strictly more than, not "at least". The bot relays in batches of 50
 * (`metrics.schedule.relayBatch`, read live on 2026-09-06), so exactly 50
 * waiting rows is one tick's work and not yet a backlog. docs/OPS-COCKPIT-V2.md
 * §9.5 words the rule "more than 50 rows pending" and lib/ops/performance.ts
 * implements it with `>`; this file used `>=` until 2026-09-06, which made the
 * overview strip and the performance tab disagree at exactly 50 rows.
 */
// Declared in ./relay and re-exported at the top of this file: the same two
// numbers the Performance tab judges the relay by.

/**
 * A deed achieved but not announced for longer than this is a backlog.
 * The bot's milestone loop runs about every 2 minutes, so 15 minutes is roughly
 * seven missed passes: comfortably past a slow tick, well short of an hour.
 */
export const ANNOUNCE_BACKLOG_SEC = 15 * 60;

/** An unachieved Great Deed at or above this fraction of its threshold is imminent. */
export const DEED_IMMINENT_FRACTION = 0.9;

/** Deaths flag when the last 24 h beats the 7 d daily average by this much. */
export const DEATH_SPIKE_FACTOR = 2;
/** ...and only above this many deaths, so 1 against an average of 0.3 stays quiet. */
export const DEATH_SPIKE_MIN_DEATHS = 3;

/**
 * A component whose last success is this far into its stale window gets a card.
 * Declared in ./health beside the windows it is a fraction of, so this card and
 * the Performance tab's gauges soften the same cliff at the same point.
 */
export const COMPONENT_HEADROOM_FRACTION = HEADROOM_WARN_FRACTION;

/** How fresh server_status has to be for its roster to be worth quoting. */
export const SERVER_STATUS_FRESH_SEC = 5 * 60;

/** Cards the strip may ever render at once. The contract clamps `limit` to this. */
export const MAX_CARDS = 6;

// ── Shapes ──────────────────────────────────────────────────────────────────

export type InsightSeverity = 'critical' | 'warn' | 'good' | 'info';

/** Sort key for `rankInsights`. See the file header for why `good` beats `info`. */
/** Weight for a card about something that has not happened yet. Sorts above context. */
export const WEIGHT_FORWARD = 2;
/** Weight for everything else. */
export const WEIGHT_DEFAULT = 5;

export const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warn: 1,
  good: 2,
  info: 3,
};

export interface Insight {
  /** Stable id. Also the tie-break key and what a bug report cites. */
  id: string;
  severity: InsightSeverity;
  /** One short sentence. The thing worth saying. */
  headline: string;
  /** One line of numbers, each with its unit, its window and the threshold. */
  evidence: string;
  /** The id of the caption below. Same value as `explain.id`. */
  glossaryId: string;
  /** The caption, rendered by <Explain/>. Every card has one. */
  explain: GlossaryEntry;
  /** When the evidence happened, for recency ranking. Null when it is a state, not an event. */
  atMs: number | null;
  /**
   * Tie-break inside a severity band. Lower sorts first, default WEIGHT_DEFAULT.
   *
   * It exists for one class of card: a countdown has no timestamp, so the
   * recency rule below would always bury it under ambient context that happens
   * to carry one. "3 deeds are about to fire" is the most forward-looking thing
   * this strip computes and it was ranking last of the Info cards.
   */
  weight?: number;
  /** Optional pointer to the tab that shows the whole picture. */
  link?: { href: string; label: string };
}

export interface InsightEventRow {
  type: string;
  character_name: string | null;
  created_at: string | null;
  inserted_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface InsightHeartbeatRow {
  component: string;
  status: string | null;
  last_success: string | null;
  metrics: Record<string, unknown> | null;
}

export interface InsightServerStatus {
  current_players: string[] | null;
  player_count: number | null;
  world_day: number | null;
  updated_at: string | null;
}

export interface InsightPlayerRow {
  character_name: string | null;
  first_seen_at: string | null;
  is_online: boolean | null;
  last_seen_at: string | null;
}

/**
 * Whether each of the six reads behind the strip actually returned.
 *
 * WHY THIS IS NOT OPTIONAL. `safeRead` hands a failed query the same empty array
 * an empty table produces, so without this flag a PostgREST error or a statement
 * timeout on `events` is indistinguishable from a quiet night, and the strip
 * prints "0 events in the last 24 h" and an all-clear over a database it could
 * not see. That is the one failure mode this whole file exists to avoid (header
 * rule 3), and it is the LIKELY failure on a busy launch night, not the total
 * outage the `supabaseOk` flag already covers.
 */
export interface InsightReads {
  events: boolean;
  heartbeats: boolean;
  serverStatus: boolean;
  milestones: boolean;
  playerStats: boolean;
  newPlayers: boolean;
}

/** Operator-facing name for each read, in the order loadInsights issues them. */
export const READ_LABELS: { key: keyof InsightReads; label: string }[] = [
  { key: 'events', label: 'the event log (events)' },
  { key: 'heartbeats', label: 'component heartbeats (ops_heartbeats)' },
  { key: 'serverStatus', label: 'the server status row (server_status)' },
  { key: 'milestones', label: 'the Great Deed definitions (milestones)' },
  { key: 'playerStats', label: 'viking totals (player_stats)' },
  { key: 'newPlayers', label: 'the roster (players)' },
];

export interface InsightInput {
  /** The page's render clock. Every window below is measured back from it. */
  nowMs: number;
  /** False when the client is unconfigured or every read failed. */
  supabaseOk: boolean;
  /** events rows over `eventsWindowMs`, any order. */
  events: InsightEventRow[];
  /** True when the events read hit its row limit, so the 7 d totals are floors. */
  eventsTruncated: boolean;
  /** The window the events were read over. WINDOW_7D_MS in the live page. */
  eventsWindowMs: number;
  /** Every ops_heartbeats row. */
  heartbeats: InsightHeartbeatRow[];
  /** The single server_status row, or null when it could not be read. */
  serverStatus: InsightServerStatus | null;
  /** milestones definition rows, achieved and not. */
  milestones: Milestone[];
  /** player_stats rows, read defensively (columns may be absent). */
  playerStats: Record<string, unknown>[];
  /** players whose first_seen_at is inside the events window, newest first. */
  newPlayers: InsightPlayerRow[];
  /** True when the players read hit its limit, so the new-viking count is a floor. */
  newPlayersTruncated: boolean;
  /** Which reads returned. A read that failed is never treated as an empty table. */
  reads: InsightReads;
}

// ── Small pure helpers, each tested on its own ──────────────────────────────

/** Rows whose created_at falls inside the last `windowMs`. Unparseable rows are dropped. */
export function eventsInWindow(
  events: InsightEventRow[],
  nowMs: number,
  windowMs: number,
): InsightEventRow[] {
  const from = nowMs - windowMs;
  return events.filter((e) => {
    const t = toMs(e.created_at);
    return t !== null && t >= from && t <= nowMs;
  });
}

/** Newest created_at across the rows, epoch ms, or null when there are none. */
export function newestEventMs(events: InsightEventRow[]): number | null {
  let best: number | null = null;
  for (const e of events) {
    const t = toMs(e.created_at);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/** Newest inserted_at across the rows, epoch ms, or null. Insertion order, not producer time. */
export function newestInsertedMs(events: InsightEventRow[]): number | null {
  let best: number | null = null;
  for (const e of events) {
    const t = toMs(e.inserted_at);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

export interface ConcurrencyPeak {
  peak: number;
  atMs: number | null;
  joins: number;
  leaves: number;
}

/**
 * Highest number of vikings connected at once, reconstructed by replaying the
 * join and leave rows in the window in time order.
 *
 * KNOWN AND DELIBERATE UNDERCOUNT: a session that began before the window opens
 * contributes no join row, so it is not counted, and its leave row is ignored
 * rather than driving the count negative. The card says so. The alternative
 * would be a seventh read of `sessions`, and the contract allows six.
 */
export function peakConcurrency(
  events: InsightEventRow[],
  windowStartMs: number,
  nowMs: number,
): ConcurrencyPeak {
  const rows = events
    .map((e) => ({ e, t: toMs(e.created_at) }))
    .filter((r): r is { e: InsightEventRow; t: number } => r.t !== null)
    .filter((r) => r.t >= windowStartMs && r.t <= nowMs)
    .sort((a, b) => a.t - b.t);

  const online = new Set<string>();
  let peak = 0;
  let atMs: number | null = null;
  let joins = 0;
  let leaves = 0;
  for (const { e, t } of rows) {
    const name = e.character_name;
    if (!name) continue;
    if (e.type === 'join') {
      joins += 1;
      online.add(name);
      if (online.size > peak) {
        peak = online.size;
        atMs = t;
      }
    } else if (e.type === 'leave') {
      leaves += 1;
      online.delete(name);
    }
  }
  return { peak, atMs, joins, leaves };
}

export interface MismatchSummary {
  count: number;
  /** Distinct joining-account fingerprints seen. */
  accounts: string[];
  /** Distinct character names affected. */
  names: string[];
  newestMs: number | null;
}

/**
 * Steam identity mismatches inside the window, off the annotation the webhook
 * writes onto the join row itself (`metadata.identity = 'steam_mismatch'`, the
 * same key lib/ops/db.ts filters on). The row is anon-readable, so it carries
 * fingerprints and never a Steam64 id; the strip quotes counts only.
 */
export function identityMismatchSummary(
  events: InsightEventRow[],
  windowStartMs: number,
  nowMs: number,
): MismatchSummary {
  const accounts = new Set<string>();
  const names = new Set<string>();
  let count = 0;
  let newestMs: number | null = null;
  for (const e of events) {
    const t = toMs(e.created_at);
    if (t === null || t < windowStartMs || t > nowMs) continue;
    const meta = e.metadata ?? {};
    if (meta.identity !== 'steam_mismatch') continue;
    count += 1;
    if (newestMs === null || t > newestMs) newestMs = t;
    const seen = meta.seenSteamIdHash;
    if (typeof seen === 'string' && seen.trim()) accounts.add(seen.trim());
    if (e.character_name) names.add(e.character_name);
  }
  return { count, accounts: [...accounts], names: [...names], newestMs };
}

export interface ComponentHeadroom {
  key: string;
  label: string;
  ageSec: number;
  staleAfterSec: number;
  /** ageSec / staleAfterSec. Above 1 the component is already stale. */
  used: number;
}

/**
 * Components that have reported successfully but are deep into their stale
 * window. The state chip on the overview cannot show this: it reads healthy at
 * 10 percent of the window and healthy at 95 percent, and those are different
 * facts on launch night.
 *
 * Components already past their threshold are excluded: the overview is already
 * shouting about those, and repeating it here would waste a card.
 */
export function componentHeadroom(
  heartbeats: InsightHeartbeatRow[],
  nowMs: number,
  fraction: number = COMPONENT_HEADROOM_FRACTION,
): ComponentHeadroom[] {
  const byKey = new Map(heartbeats.map((h) => [h.component, h]));
  const out: ComponentHeadroom[] = [];
  for (const def of COMPONENTS) {
    // The two 'render' components are alive because this page rendered, and
    // their stale window is 0, which would divide by zero.
    if (def.staleAfterSec <= 0 || def.source !== 'ops_heartbeats') continue;
    const hb = byKey.get(def.key);
    const ageSec = ageSecFrom(nowMs, hb?.last_success ?? null);
    if (ageSec === null) continue; // never reported: unknown, not "nearly stale"
    const used = ageSec / def.staleAfterSec;
    if (used < fraction || used > 1) continue;
    out.push({ key: def.key, label: def.label, ageSec, staleAfterSec: def.staleAfterSec, used });
  }
  return out.sort((a, b) => b.used - a.used);
}

export interface RelayState {
  /** 'behind' | 'current' | 'unknown'. */
  state: 'behind' | 'current' | 'unknown';
  /** Rows written after the relay's mark: the cursor, or its last successful run. */
  pending: number;
  /** How long the OLDEST pending row has been waiting, in seconds. 0 when none are. */
  waitingSec: number;
  /** Age of the mark itself, in seconds. Old with 0 pending just means a quiet hall. */
  markAgeSec: number;
  /** True when the bot reported an actual cursor rather than only a loop timestamp. */
  fromCursor: boolean;
}

/**
 * How far behind the Discord relay is.
 *
 * TWO SOURCES, IN ORDER OF HONESTY.
 *   1. The bot's own relay cursor, if it reports one
 *      (`metrics.schedule.relayCursor`, added by the horizon track). Then
 *      `pending` is exactly the rows written after it.
 *   2. Otherwise the relay loop's `lastSuccessAt` from `metrics.subLoops`, and
 *      `pending` is the rows inserted since that tick. That is an inference,
 *      not a cursor: a tick that posted nothing looks identical to a tick that
 *      posted everything, which is precisely the failure the 2026-09-06
 *      rehearsal found. The card labels it as inferred.
 * With neither, the state is 'unknown' and no card is rendered at all.
 *
 * "BEHIND" IS ABOUT WAITING ROWS, NOT ABOUT AN OLD MARK. A cursor that has not
 * moved in six hours because nobody has played is a caught-up relay, not a
 * broken one, so the age of the mark on its own never raises the alarm: it
 * takes rows written after the mark, and the OLDEST of them waiting longer than
 * the threshold (or more than RELAY_BEHIND_ROWS of them at once).
 */
export function relayState(
  heartbeats: InsightHeartbeatRow[],
  events: InsightEventRow[],
  nowMs: number,
): RelayState {
  const bot = heartbeats.find((h) => h.component === 'discord-bot');
  const metrics = (bot?.metrics ?? null) as Record<string, unknown> | null;
  const schedule = (metrics?.schedule ?? null) as Record<string, unknown> | null;
  const cursorMs = toMs((schedule?.relayCursor as string | null | undefined) ?? null);

  let markMs = cursorMs;
  let fromCursor = true;
  if (markMs === null) {
    fromCursor = false;
    const loops = ((metrics?.subLoops ?? metrics?.loops) ?? null) as Record<
      string,
      { lastSuccessAt?: string; lastRunAt?: string }
    > | null;
    markMs = toMs(loops?.relay?.lastSuccessAt ?? loops?.relay?.lastRunAt ?? null);
  }
  if (markMs === null) {
    return { state: 'unknown', pending: 0, waitingSec: 0, markAgeSec: 0, fromCursor: false };
  }

  let pending = 0;
  let oldestPendingMs: number | null = null;
  for (const e of events) {
    const t = toMs(e.inserted_at);
    if (t === null || t <= markMs) continue;
    pending += 1;
    if (oldestPendingMs === null || t < oldestPendingMs) oldestPendingMs = t;
  }
  const waitingSec = oldestPendingMs === null ? 0 : Math.max(0, (nowMs - oldestPendingMs) / 1000);
  const markAgeSec = Math.max(0, (nowMs - markMs) / 1000);
  const behind = pending > RELAY_BEHIND_ROWS || (pending > 0 && waitingSec > RELAY_BEHIND_SEC);
  return { state: behind ? 'behind' : 'current', pending, waitingSec, markAgeSec, fromCursor };
}

export interface DeedProgress {
  id: string;
  title: string;
  metric: string;
  value: number;
  threshold: number;
  /** value / threshold, capped at 0.99 by summarizeMilestones. */
  fraction: number;
}

/**
 * Unachieved Great Deeds at or above `fraction` of their threshold.
 *
 * The aggregate map comes from `computeAggregates` (lib/milestones.ts), the same
 * function the evaluator and the /world page use, so a deed can never read one
 * percentage here and another there. Two metrics are NOT evaluated because the
 * strip does not read the tables behind them: `playtime_total_hours` needs
 * `sessions` and `boss_kills_total` needs `bosses`, and the six-read budget is
 * spent. They score zero, so they never claim to be imminent, and the card says
 * which totals it used.
 */
export const DEED_METRICS_NOT_EVALUATED = ['playtime_total_hours', 'boss_kills_total'];

export function deedsWithinReach(
  milestones: Milestone[],
  playerStats: Record<string, unknown>[],
  fraction: number = DEED_IMMINENT_FRACTION,
): DeedProgress[] {
  const aggregates = computeAggregates({
    stats: playerStats,
    sessions: [],
    onlineNames: new Set<string>(),
  });
  const summary = summarizeMilestones(milestones, aggregates);
  return summary.upcoming
    .filter((u) => !DEED_METRICS_NOT_EVALUATED.includes(u.milestone.metric))
    .filter((u) => u.milestone.threshold > 0 && u.pct / 100 >= fraction)
    .map((u) => ({
      id: u.milestone.id,
      title: u.milestone.title,
      metric: u.milestone.metric,
      value: u.value,
      threshold: u.milestone.threshold,
      fraction: u.pct / 100,
    }));
}

// ── Caption helper ──────────────────────────────────────────────────────────

const RUNBOOK = 'https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT.md';

function caption(
  id: string,
  title: string,
  what: string,
  why: string,
  healthy: string,
  whenRed: string,
  link?: { href: string; label: string },
): GlossaryEntry {
  return { id, title, what, why, healthy, whenRed, link: link ?? { href: RUNBOOK, label: 'Ops runbook' } };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * "Sep 06 21:10 UTC" for an evidence line that needs a moment, not an age.
 *
 * The format itself lives in ./window, which is also where the activity tab's
 * row stamps come from: two hand-written copies of it were live at the end of
 * the v2 build. All this adds is the fallback wording, because these strings sit
 * mid-sentence ("Reached an unknown time") rather than in a table cell.
 */
export function stampUtc(ms: number | null): string {
  return stampUtcShared(ms, 'an unknown time');
}

// ── The candidates ──────────────────────────────────────────────────────────

/**
 * Every insight that fires against this input, in a fixed source order.
 *
 * Not ranked: `rankInsights` does that, and keeping the two apart is what makes
 * the ranking testable on its own. Never empty: with nothing to flag it returns
 * the "nothing to report" card, because a strip that vanishes reads as a broken
 * strip rather than as a quiet system.
 */
export function buildInsights(input: InsightInput): Insight[] {
  const { nowMs, events, heartbeats, serverStatus, milestones, playerStats, newPlayers, reads } = input;

  if (!input.supabaseOk) {
    return [
      {
        id: 'insights-unavailable',
        severity: 'critical',
        headline: 'The insights could not be computed.',
        evidence:
          'The service-role read failed or the database is unconfigured, so none of the six queries behind this strip returned rows. The rest of this page is unaffected.',
        glossaryId: 'insight-unavailable',
        explain: caption(
          'insight-unavailable',
          'Insights unavailable',
          'The strip runs six bounded reads at render time. This card means the client was null (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY unset in this deployment) or every one of those reads threw.',
          'It is the difference between "nothing is wrong" and "we cannot tell". The strip never renders an all-clear it did not compute.',
          'Never shown. Any other card on this strip means the reads worked.',
          'Check the Database row in the component table below. If that is healthy the reads failed for another reason, so read the Vercel function log for this render.',
        ),
        atMs: nowMs,
      },
    ];
  }

  const out: Insight[] = [];

  // 0. A read that did not return. Every rule below is gated on the reads it
  // needs, so a failed read costs its cards rather than turning them into
  // zeroes; this card is what makes that silence legible. It is a `warn`, which
  // also withdraws the all-clear at the bottom of this function: the strip must
  // never say "the last 24 h look normal" over data it could not read.
  const failedReads = READ_LABELS.filter((r) => !reads[r.key]);
  if (failedReads.length > 0) {
    const n = failedReads.length;
    const total = READ_LABELS.length;
    out.push({
      id: 'read-failed',
      severity: 'warn',
      headline: `${n} of the ${total} reads behind this strip did not return.`,
      evidence:
        `Failed: ${failedReads.map((r) => r.label).join(', ')}. ` +
        `Every rule that needs ${n === 1 ? 'it' : 'them'} was skipped for this render rather than counting the empty result as a zero, ` +
        `and the all-clear card is withheld. The other ${total - n} ${plural(total - n, 'read', 'reads')} returned.`,
      glossaryId: 'insight-read-failed',
      explain: caption(
        'insight-read-failed',
        'Incomplete read',
        'A per-read success flag on each of the six queries behind this strip. A failed query and an empty table both come back as an empty list, so the strip records which of the two it was.',
        'Without it a PostgREST error or a statement timeout on the events read would render as "0 events in the last 24 h" and the strip would print an all-clear over a database it could not see. A partial failure is far more likely under load than a total one, and it is the dangerous half.',
        'No card. All six reads return on a healthy render.',
        'One failed read is usually a timeout under load or a column that moved; all six is the database or the service-role key. Check the Database row in the component table below, then this render in the Vercel function log.',
      ),
      atMs: nowMs,
    });
  }

  const win24 = nowMs - WINDOW_24H_MS;
  const win7 = nowMs - input.eventsWindowMs;
  const last24 = eventsInWindow(events, nowMs, WINDOW_24H_MS);
  const last7 = eventsInWindow(events, nowMs, input.eventsWindowMs);
  const newestMs = newestEventMs(events);
  const newestRow = events.find((e) => toMs(e.created_at) === newestMs) ?? null;

  const statusAgeSec = ageSecFrom(nowMs, serverStatus?.updated_at ?? null);
  const statusFresh = statusAgeSec !== null && statusAgeSec <= SERVER_STATUS_FRESH_SEC;
  const online = serverStatus?.current_players?.length ?? serverStatus?.player_count ?? 0;

  // 1. Silent hall: somebody is connected and nothing at all is being recorded.
  // Needs the event log: an unread events table is not evidence of silence.
  if (reads.events && statusFresh && online > 0) {
    const quietSec = newestMs === null ? null : (nowMs - newestMs) / 1000;
    if (quietSec === null || quietSec > SILENT_HALL_SEC) {
      out.push({
        id: 'silent-hall',
        severity: 'warn',
        headline: `${online} ${plural(online, 'viking is', 'vikings are')} online and nothing is being recorded.`,
        evidence:
          `server_status was refreshed ${formatAgeSec(statusAgeSec)} and lists ${online} connected. ` +
          `The newest events row is ${quietSec === null ? 'older than the 7 d read window' : formatAgeSec(quietSec)}. ` +
          `Threshold: ${formatDurationSec(SILENT_HALL_SEC)} of silence with somebody online.`,
        glossaryId: 'silent-hall',
        explain: caption(
          'silent-hall',
          'Silent hall',
          'The gap between the newest events row and now, compared against the roster in server_status.current_players. Only evaluated while server_status is itself fresh.',
          'Joins, leaves and deaths all reach the site through the log poller. If somebody is connected and none of those has been written for hours, the poller path is the likely break, and nothing else on the overview says so until its heartbeat threshold trips.',
          `No card. Silence under ${formatDurationSec(SILENT_HALL_SEC)}, or an empty hall, is normal.`,
          'A quiet building session looks exactly like this, so check the log poller heartbeat first. If it is healthy, compare the roster here with the Vikings page: an emitter reporting ghosts is the other way this fires.',
        ),
        atMs: newestMs,
        link: { href: '/admin/ops/activity', label: 'What fired' },
      });
    }
  }

  // 2. The relay, both directions. One card either way, never both.
  //
  // Needs BOTH reads: the mark comes from the bot's heartbeat and the pending
  // rows come from events, so a failed events read would otherwise render a
  // confident "0 rows behind" over a backlog of any size.
  const relay: RelayState =
    reads.events && reads.heartbeats
      ? relayState(heartbeats, events, nowMs)
      : { state: 'unknown', pending: 0, waitingSec: 0, markAgeSec: 0, fromCursor: false };
  if (relay.state === 'behind') {
    out.push({
      id: 'relay-behind',
      severity: 'warn',
      headline: `The Discord relay is ${formatCount(relay.pending)} ${plural(relay.pending, 'row', 'rows')} behind.`,
      evidence: relay.fromCursor
        ? `${formatCount(relay.pending)} ${plural(relay.pending, 'row has', 'rows have')} landed in events past the bot's relay cursor, the oldest waiting ${formatDurationSec(relay.waitingSec)}. Thresholds: more than ${RELAY_BEHIND_ROWS} rows waiting, or one row waiting over ${formatDurationSec(RELAY_BEHIND_SEC)}.`
        : `${formatCount(relay.pending)} ${plural(relay.pending, 'row has', 'rows have')} been written to events since the relay loop last succeeded ${formatAgeSec(relay.markAgeSec)}, the oldest waiting ${formatDurationSec(relay.waitingSec)}. Thresholds: more than ${RELAY_BEHIND_ROWS} rows waiting, or one row waiting over ${formatDurationSec(RELAY_BEHIND_SEC)}. Inferred from the loop timestamp: the bot does not report its cursor in this heartbeat.`,
      glossaryId: 'relay-backlog',
      explain: caption(
        'relay-backlog',
        'Relay backlog',
        'Rows in events written after the point the Discord bot has relayed up to. Read from the bot\'s own cursor when it reports one, otherwise inferred from the last successful run of its relay loop.',
        'A relay tick that posts nothing is recorded as a success, so a silently skipped row leaves the heartbeat and the watchdog both green. The 2026-09-06 rehearsal lost 21 of 43 feed rows this way and nothing on the cockpit noticed.',
        `0 rows pending, or a handful written in the last few seconds that the next tick will take. An old cursor with nothing waiting is a quiet hall, not a fault.`,
        'Check the Event relay row in the bot loops table. If it is healthy and this keeps growing, the cursor is stuck: read the bot journal on the host for the relay tick, and compare events.inserted_at with the cursor it reports.',
      ),
      atMs: newestInsertedMs(events),
      link: { href: '/admin/ops/horizon', label: 'Coming up' },
    });
  } else if (relay.state === 'current') {
    // "BEHIND" IS A THRESHOLD, NOT "NOT ZERO". Rows the next tick will take are
    // a working relay, so this card can legitimately carry a non-zero count, and
    // the old headline then read "Good: the relay is 50 rows behind", which is a
    // card arguing with its own chip. It claims 0 only when it is 0, and
    // otherwise says the rows are in flight.
    const caught = relay.pending === 0;
    out.push({
      id: 'relay-current',
      severity: 'good',
      headline: caught
        ? 'The relay is 0 rows behind.'
        : `The relay is keeping up, ${formatCount(relay.pending)} ${plural(relay.pending, 'row', 'rows')} still in flight.`,
      evidence:
        (relay.fromCursor
          ? `${formatCount(relay.pending)} ${plural(relay.pending, 'row is', 'rows are')} past the bot's relay cursor, which it last moved ${formatAgeSec(relay.markAgeSec)}.`
          : `${formatCount(relay.pending)} ${plural(relay.pending, 'row has', 'rows have')} been written since the relay loop last succeeded ${formatAgeSec(relay.markAgeSec)}. Inferred from the loop timestamp, not a cursor.`) +
        (caught
          ? ` ${formatCount(last24.length)} events in the last 24 h.`
          : ` The oldest has waited ${formatDurationSec(relay.waitingSec)}, inside both thresholds: more than ${RELAY_BEHIND_ROWS} rows waiting, or one row waiting over ${formatDurationSec(RELAY_BEHIND_SEC)}.`),
      glossaryId: 'relay-current',
      explain: caption(
        'relay-current',
        'Relay caught up',
        'The same measurement as the relay backlog card, reading clear: no events row is newer than the point the bot has relayed up to.',
        'It is the one component whose failure is invisible everywhere else on this page, so its healthy state is worth stating rather than assuming.',
        `0 rows pending, or a handful the next tick will take. It turns into the backlog card at more than ${RELAY_BEHIND_ROWS} rows waiting, or one row waiting over ${formatDurationSec(RELAY_BEHIND_SEC)}.`,
        'Not applicable while this card is showing. If it flips to the backlog card, that card carries the next step.',
      ),
      atMs: null,
      link: { href: '/admin/ops/horizon', label: 'Coming up' },
    });
  }

  // 3. Great Deeds that fired and were never announced.
  const unannounced = milestones
    .filter((m) => m.achieved_at && !m.announced_at)
    .map((m) => ({ m, at: toMs(m.achieved_at) }))
    .filter((r): r is { m: Milestone; at: number } => r.at !== null)
    .sort((a, b) => a.at - b.at);
  const oldestUnannounced = unannounced[0] ?? null;
  if (reads.milestones && oldestUnannounced && (nowMs - oldestUnannounced.at) / 1000 > ANNOUNCE_BACKLOG_SEC) {
    const n = unannounced.length;
    out.push({
      id: 'announce-backlog',
      severity: 'warn',
      headline: `${formatCount(n)} Great ${plural(n, 'Deed has', 'Deeds have')} fired and nobody has been told.`,
      evidence: `Achieved with announced_at still null. Oldest: ${oldestUnannounced.m.title}, ${formatAgeSec((nowMs - oldestUnannounced.at) / 1000)}. Threshold: ${formatDurationSec(ANNOUNCE_BACKLOG_SEC)}, against a bot loop that runs about every 2 min.`,
      glossaryId: 'announce-backlog',
      explain: caption(
        'announce-backlog',
        'Announce backlog',
        'milestones rows with achieved_at set and announced_at still null. The evaluator stamps the first, the Discord bot stamps the second when it posts the deed.',
        'The deed happened in the world and the hall never heard about it. Nothing else on the cockpit shows the gap between those two moments, and a deed announced three days late is worse than one announced never.',
        `0 rows, or a backlog younger than ${formatDurationSec(ANNOUNCE_BACKLOG_SEC)} while the bot's loop catches up.`,
        'Check the Milestone evaluator row in the bot loops table. A disabled or erroring loop is the usual cause; a channel the bot cannot post in is the other.',
      ),
      atMs: oldestUnannounced.at,
      link: { href: '/admin/ops/activity', label: 'What fired' },
    });
  }

  // 4. The busiest hour, and how it compares with an ordinary hour this week.
  //
  // THE TWO NUMBERS ON THIS CARD DESCRIBE THE SAME ROWS, which took a fix.
  // hourBuckets(now, 24) spans the 24 UTC hour buckets ending in the current
  // partial one; the rolling `last24` window is [now - 24 h, now]. They are not
  // the same set: up to an hour of rows sits inside the rolling day but before
  // the oldest bucket, and countInBuckets drops those rather than piling them
  // into the first column (window.ts explains why). Quoting the rolling total
  // beside a bucketed peak therefore compared a peak against rows that could
  // never have been in it. So the whole read is fed to the buckets and the
  // total is the SUM OF THE BUCKETS.
  if (reads.events) {
    const buckets = hourBuckets(nowMs, 24);
    const counts = countInBuckets(
      events.map((e) => e.created_at),
      buckets,
    );
    let peakIdx = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[peakIdx]) peakIdx = i;
    const bucketed = counts.reduce((a, b) => a + b, 0);
    const perHour7d = last7.length / (input.eventsWindowMs / HOUR_MS);
    if (counts[peakIdx] > 0) {
      out.push({
        id: 'busiest-hour',
        severity: 'info',
        headline: `The busiest hour of the last 24 h was ${buckets[peakIdx].label} UTC, ${formatCount(counts[peakIdx])} events.`,
        evidence: `${formatCount(bucketed)} events fell across those 24 UTC hour buckets, the newest of them still filling. Against ${perHour7d < 10 ? perHour7d.toFixed(1) : Math.round(perHour7d)} events per hour on average over the last 7 d${input.eventsTruncated ? ', which is a floor: the 7 d read hit its row limit' : ''}.`,
        glossaryId: 'busiest-hour',
        explain: caption(
          'busiest-hour',
          'Busiest hour',
          'The hour bucket with the most events rows in the last 24 UTC hours, next to the mean events per hour over the last 7 d. Buckets are aligned in UTC, which is why the label says so, and the newest bucket is the current hour and still filling. The total on this card counts the rows in those buckets, not the rolling 24 h, so it and the peak describe the same rows.',
          'It is the shape of an evening. Knowing what a normal peak looks like is what makes tonight\'s peak readable, and it is the cheapest early signal that twenty players behave differently from five.',
          'No healthy range: this is context, not a fault. A peak far above the weekly mean is a busy night, not a problem.',
          'Not applicable. If the peak is zero the strip shows the quiet-window card instead.',
        ),
        atMs: buckets[peakIdx].startMs,
        link: { href: '/admin/ops/activity', label: 'What fired' },
      });
    }
  }

  // 5. Peak concurrency, replayed from join and leave rows.
  const conc = peakConcurrency(events, win7, nowMs);
  if (reads.events && conc.peak > 0) {
    out.push({
      id: 'peak-concurrency',
      severity: 'info',
      headline: `Peak concurrency over the last 7 d was ${formatCount(conc.peak)} ${plural(conc.peak, 'viking', 'vikings')}.`,
      evidence: `Reached ${stampUtc(conc.atMs)}, replayed from ${formatCount(conc.joins)} join and ${formatCount(conc.leaves)} leave rows. Sessions that began before the window opened are not counted, so this is a floor.`,
      glossaryId: 'peak-concurrency',
      explain: caption(
        'peak-concurrency',
        'Peak concurrency',
        'The largest number of distinct character names connected at the same moment, reconstructed by replaying join and leave rows from events in time order.',
        'The server is capped at 20. This is the only number on the cockpit that says how close a real night has come to that cap, and it is what the launch capacity question turns on.',
        'No healthy range: it is a measurement of how busy the hall got. Anything approaching the configured cap is worth planning around.',
        'If it reads lower than you know a night was, the window opened mid-session: joins before the window are invisible to this replay. The Vikings attendance grid counts sessions instead and does not have that blind spot.',
      ),
      atMs: conc.atMs,
      link: { href: '/admin/ops/activity', label: 'What fired' },
    });
  }

  // 6. Great Deeds close enough to fire tonight.
  const close = reads.milestones && reads.playerStats ? deedsWithinReach(milestones, playerStats) : [];
  if (close.length > 0) {
    const first = close[0];
    // The deed title is ceremonial and never says what it counts, so the number
    // gets its unit from the metric registry: "deaths: 24 of 25", not "24 of 25".
    const unit = metricInfo(first.metric).label.toLowerCase();
    out.push({
      id: 'deed-imminent',
      severity: 'info',
      headline: `${formatCount(close.length)} Great ${plural(close.length, 'Deed is', 'Deeds are')} within ${formatPercent(1 - DEED_IMMINENT_FRACTION)} of firing.`,
      evidence: `Closest: ${first.title} at ${formatPercent(first.fraction)} of its threshold, ${unit}: ${formatMetricValue(first.metric, first.value)} of ${formatMetricValue(first.metric, first.threshold)}. Computed from player_stats totals; the playtime and boss deeds are not evaluated here.`,
      glossaryId: 'deed-imminent',
      explain: caption(
        'deed-imminent',
        'Deed within reach',
        'Unachieved milestones rows whose metric is at or above 90 percent of its threshold, using the same computeAggregates() the evaluator and the /world page use, over the player_stats rows read for this render. The evidence names the metric behind the number, because a deed title is ceremonial and does not say what it counts.',
        'A deed crossing is one announcement moment in Discord and one spoken line in the hall. Knowing which is next is how you tell a real crossing from a double announcement, and it is the fun one to watch on a launch night.',
        'No healthy range. This is a countdown, not a fault.',
        'If a deed sits above 90 percent for days with people playing, the metric behind it is not moving: check the Milestone evaluator loop and whether gs-ingest is still writing player_stats.',
      ),
      atMs: null,
      // A countdown carries no timestamp, so without this it loses every
      // recency tie-break to context that happens to have one, and the most
      // forward-looking card the strip computes ranks last of the Info cards.
      weight: WEIGHT_FORWARD,
      link: { href: '/admin/ops/horizon', label: 'Coming up' },
    });
  }

  // 7. Deaths, compared with an ordinary day this week. Suppressed on a
  // truncated read, where the weekly average would be understated and the
  // comparison would manufacture a spike out of a row limit.
  if (reads.events && !input.eventsTruncated) {
    const deaths24 = last24.filter((e) => e.type === 'death').length;
    const deaths7 = last7.filter((e) => e.type === 'death').length;
    const perDay = deaths7 / (input.eventsWindowMs / DAY_MS);
    if (deaths24 >= DEATH_SPIKE_MIN_DEATHS && perDay > 0 && deaths24 > perDay * DEATH_SPIKE_FACTOR) {
      const factor = deaths24 / perDay;
      out.push({
        id: 'death-spike',
        severity: 'warn',
        headline: `Deaths are running ${factor.toFixed(1)}x the weekly average.`,
        evidence: `${formatCount(deaths24)} deaths in the last 24 h against ${perDay.toFixed(1)} per day over the last 7 d. Thresholds: ${DEATH_SPIKE_FACTOR}x and at least ${DEATH_SPIKE_MIN_DEATHS} deaths.`,
        glossaryId: 'death-spike',
        explain: caption(
          'death-spike',
          'Death rate',
          'events rows of type death in the last 24 h, against the mean deaths per day over the last 7 d. Both counts come from the same single read.',
          'Death penalty and difficulty are tuned by feel and corrected by data. A spike is also what a new biome, a new boss, or a mis-set panel difficulty tier looks like from here.',
          'No healthy range: some nights are harder. It is the change that is worth reading, not the number.',
          'Check what changed. The panel death-penalty tier, a boss fight, or a group pushing into a new biome all show up as this. The activity tab breaks the deaths down by cause.',
        ),
        atMs: nowMs,
        link: { href: '/admin/ops/activity', label: 'What fired' },
      });
    }
  }

  // 8. New vikings. In launch week this is the interesting card.
  const fresh = newPlayers
    .map((p) => ({ p, at: toMs(p.first_seen_at) }))
    .filter((r): r is { p: InsightPlayerRow; at: number } => r.at !== null && r.at >= win24 && r.at <= nowMs)
    .sort((a, b) => b.at - a.at);
  if (reads.newPlayers && fresh.length > 0) {
    // THE COUNT IS A FLOOR WHEN THE READ WAS CUT. The players read is capped and
    // ordered newest first, so when it comes back full AND every row it returned
    // is inside the 24 h window, there may be more names the limit removed. The
    // server cap of 20 concurrent does not bound distinct new names across a day
    // (a re-roll or a rename writes another row), and launch week is exactly
    // when this rule matters, so the card hedges rather than under-reporting.
    const floored = input.newPlayersTruncated && fresh.length === newPlayers.length;
    const names = fresh.slice(0, 4).map((r) => r.p.character_name ?? 'unnamed');
    out.push({
      id: 'new-viking',
      severity: 'good',
      headline: `${floored ? 'At least ' : ''}${formatCount(fresh.length)} new ${plural(fresh.length, 'viking', 'vikings')} in the last 24 h.`,
      evidence: `${names.join(', ')}${fresh.length > names.length ? ` and ${fresh.length - names.length} more` : ''}. Newest first seen ${formatAgeSec((nowMs - fresh[0].at) / 1000)}.${floored ? ` The players read returned its full ${formatCount(newPlayers.length)} rows and every one of them is inside the window, so the count is a floor.` : ''}`,
      glossaryId: 'new-viking',
      explain: caption(
        'new-viking',
        'New viking',
        'players rows whose first_seen_at falls inside the last 24 h. The row is created by the webhook on a character name\'s first ever join. The read is capped, and the headline says "at least" when that cap may have cut names out of the count.',
        'A name appearing here for the first time is a real person who found the server. It is also the moment a mis-typed character name creates a duplicate viking, which is far cheaper to fix on the day than a week later.',
        'No healthy range. Growth is the point.',
        'If a name here looks like a near-duplicate of an existing viking, that is a character renamed or re-rolled, and the two rows will split that person\'s stats until they are merged by hand.',
      ),
      atMs: fresh[0].at,
    });
  }

  // 9. Steam identity mismatches.
  const mismatch = identityMismatchSummary(events, win7, nowMs);
  if (reads.events && mismatch.count > 0) {
    const sameAccount = mismatch.accounts.length === 1;
    out.push({
      id: 'identity-mismatch',
      severity: 'warn',
      headline: `${formatCount(mismatch.count)} Steam identity ${plural(mismatch.count, 'mismatch', 'mismatches')} in the last 7 d.`,
      evidence: `${mismatch.names.length} character ${plural(mismatch.names.length, 'name', 'names')} joined from ${formatCount(mismatch.accounts.length)} ${plural(mismatch.accounts.length, 'account', 'accounts')} other than the bound one${sameAccount ? ', all the same account' : ''}. Newest ${formatAgeSec(ageSecFrom(nowMs, mismatch.newestMs))}. Oath, pin and Discord-link writes are frozen for those names.`,
      glossaryId: 'identity-mismatch',
      explain: caption(
        'identity-mismatch',
        'Steam identity mismatch',
        'events join rows annotated metadata.identity = steam_mismatch: somebody joined under a character name already bound to a different Steam account. The row carries fingerprints only, never a Steam64 id.',
        'Presence is still recorded, so the site looks normal, but that name\'s oath, pin and Discord-link writes stay frozen until an admin releases the binding. Two friends sharing a character name is the usual cause, and a name-squat is the other.',
        '0 in the last 7 d.',
        'The full table with the release SQL is further down this page. Release the binding only when you know which account should own the name.',
      ),
      atMs: mismatch.newestMs,
    });
  }

  // 10. A component that is still healthy but running out of window.
  const headroom = componentHeadroom(heartbeats, nowMs);
  // The Companion stops polling when the hall empties, by design, so its
  // headroom is not a signal while nobody is connected.
  const quietHall = statusFresh && online === 0;
  const worth = headroom.filter((h) => !(quietHall && h.key === 'companion-voice'));
  if (reads.heartbeats && worth.length > 0) {
    const h = worth[0];
    out.push({
      id: 'component-headroom',
      severity: 'warn',
      headline: `${h.label} is close to its stale threshold.`,
      evidence: `Last successful report ${formatAgeSec(h.ageSec)}, which is ${formatPercent(h.used)} of its ${formatDurationSec(h.staleAfterSec)} window. ${formatDurationSec(h.staleAfterSec - h.ageSec)} of slack left. Threshold for this card: ${formatPercent(COMPONENT_HEADROOM_FRACTION)}.`,
      glossaryId: 'component-headroom',
      explain: caption(
        'component-headroom',
        'Stale-window headroom',
        'The age of a component\'s ops_heartbeats.last_success as a fraction of the staleAfterSec in its registry entry (lib/ops/health.ts). Only components that are still inside their window appear here.',
        'The state chip reads healthy at 10 percent of the window and healthy at 95 percent. Those are different facts. This is the early warning the chip cannot give, and on launch night it is the difference between noticing a stall and being told about one.',
        `Under ${formatPercent(COMPONENT_HEADROOM_FRACTION)} of the window for every component.`,
        'A component that hovers here is running slower than its configured cadence rather than being down. Check its journal on the host for a long tick, and consider whether the cadence in the registry still matches reality.',
      ),
      atMs: null,
      link: { href: '/admin/ops/performance', label: 'Performance' },
    });
  }

  // 11. A completely quiet day. The honest, common state on a weeknight.
  // Needs the event log: "no events" and "no events read" are different facts,
  // and only the first one belongs on a card.
  if (reads.events && last24.length === 0) {
    out.push({
      id: 'quiet-window',
      severity: 'info',
      headline: 'No events were recorded in the last 24 h.',
      evidence:
        (newestRow && newestMs !== null
          ? `The newest row is a ${newestRow.type} ${formatAgeSec((nowMs - newestMs) / 1000)}. `
          : `Nothing at all in the ${Math.round(input.eventsWindowMs / DAY_MS)} d read window. `) +
        (statusFresh
          ? `The emitter reports ${online} ${plural(online, 'viking', 'vikings')} online and refreshed ${formatAgeSec(statusAgeSec)}.`
          : `server_status was last refreshed ${formatAgeSec(statusAgeSec)}, so the roster is not fresh enough to quote.`),
      glossaryId: 'quiet-window',
      explain: caption(
        'quiet-window',
        'Quiet window',
        'Zero events rows with a created_at inside the last 24 h. events is where every join, leave, death and boss kill lands.',
        'An empty hall writes nothing, and that is not a fault. This card exists so that "no events" is stated rather than left as an empty chart the reader has to interpret.',
        'Not a health signal either way. With nobody online it is expected; with people online the silent-hall card fires instead and that one is a warning.',
        'If you know somebody was playing during this window, this is the first evidence that the log poller path is broken, and the silent-hall card should have fired. Check whether server_status is fresh.',
      ),
      atMs: newestMs,
      link: { href: '/admin/ops/activity', label: 'What fired' },
    });
  }

  // 12. The world clock, and whether the emitter is still writing it.
  // `serverStatus` is already null when its read failed, but the flag is checked
  // explicitly so this rule reads like every other one and cannot be re-enabled
  // by a future caller that supplies a stale row alongside a failed read.
  if (reads.serverStatus && serverStatus) {
    if (!statusFresh) {
      out.push({
        id: 'emitter-quiet',
        severity: 'warn',
        headline: 'The server emitter has gone quiet.',
        evidence: `server_status was last refreshed ${formatAgeSec(statusAgeSec)}, past its ${formatDurationSec(SERVER_STATUS_FRESH_SEC)} threshold. The roster and the world day shown on the public site are that old.`,
        glossaryId: 'emitter-quiet',
        explain: caption(
          'emitter-quiet',
          'Server emitter freshness',
          'The age of server_status.updated_at. The GsValheimStats emitter mod writes that row about every 2 minutes and cannot send a heartbeat of its own, so its freshness is the only evidence it is alive.',
          'Everything player-facing that says who is online, and the world day itself, is read from this row. A stale row means the site is confidently showing an old world.',
          `Refreshed inside ${formatDurationSec(SERVER_STATUS_FRESH_SEC)}.`,
          'The mod is on the game server, not this host, so check the server is up and the emitter loaded. The Server emitter row in the pipeline table below carries the same signal.',
        ),
        atMs: toMs(serverStatus.updated_at),
      });
    } else {
      out.push({
        id: 'world-clock',
        severity: 'info',
        headline: `The world is on day ${formatCount(serverStatus.world_day ?? 0)}, with ${formatCount(online)} ${plural(online, 'viking', 'vikings')} online.`,
        evidence:
          `server_status was refreshed ${formatAgeSec(statusAgeSec)} by the emitter, which writes it about every 2 min.` +
          (reads.events
            ? ` ${formatCount(last24.length)} events in the last 24 h, ${formatCount(last7.length)}${input.eventsTruncated ? ' or more' : ''} in the last 7 d.`
            : ' The event log could not be read for this render, so no event counts are quoted here.'),
        glossaryId: 'world-clock',
        explain: caption(
          'world-clock',
          'World clock',
          'server_status.world_day and current_players, with the age of that row. It is the same row the public Hall page reads.',
          'It is the one line that says which world this cockpit is looking at. After a wipe or a cutover, a day number that has not reset is the fastest way to notice the site is still pointed at the old world.',
          'Fresh inside 5 min, with a day number that matches the world you expect.',
          'A day number from the previous world after a cutover means server_status was not zeroed. That is the exact fault the 2026-08-23 wipe left behind, and it makes the map snapshotter frame the wrong day.',
        ),
        atMs: toMs(serverStatus.updated_at),
      });
    }
  }

  // 13. Nothing needs acting on. Fires whenever no Act or Watch card fired, not
  // only when the strip would otherwise be empty: the context cards below
  // (quiet window, world clock, busiest hour) are true on every quiet render, so
  // an "empty strip" fallback would be unreachable code and the all-clear would
  // never be stated. This card carries the three numbers behind the all-clear so
  // it is legible rather than asserted, and it ranks above the context cards.
  //
  // AND ONLY WHEN EVERY READ RETURNED. The read-failed card above is a `warn`
  // and would already withdraw the all-clear on its own, so this condition is
  // deliberately unreachable today and a mutation that removes it fails no test.
  // It is defence in depth, not dead code: this is the one card on the strip that
  // must never be able to fire over data nobody read, and one condition guarding
  // that is one refactor away from zero. Do not delete it as redundant.
  const everyReadReturned = READ_LABELS.every((r) => reads[r.key]);
  if (everyReadReturned && !out.some((i) => i.severity === 'critical' || i.severity === 'warn')) {
    const componentsFresh = heartbeats.filter((h) => {
      const def = COMPONENTS.find((c) => c.key === h.component);
      if (!def || def.staleAfterSec <= 0) return false;
      const age = ageSecFrom(nowMs, h.last_success);
      return age !== null && age <= def.staleAfterSec;
    }).length;
    out.push({
      id: 'nothing-to-report',
      severity: 'good',
      headline: 'The last 24 h look normal.',
      evidence: `${formatCount(last24.length)} events in the last 24 h, ${formatCount(componentsFresh)} ${plural(componentsFresh, 'component', 'components')} reporting inside their stale window, ${formatCount(unannounced.length)} ${plural(unannounced.length, 'deed', 'deeds')} waiting to be announced.`,
      glossaryId: 'nothing-to-report',
      explain: caption(
        'nothing-to-report',
        'Nothing to report',
        'The all-clear. It renders whenever every rule on this strip ran and none of them produced an Act or a Watch card, and it carries the three numbers behind that verdict so the all-clear is legible rather than asserted.',
        'A strip that says nothing is indistinguishable from a strip that is broken. This card is how the reader can tell the difference, and it is the one line to look for before closing the page.',
        'This card present, with no Act or Watch card above it, is the healthy state.',
        'Not applicable. The moment any rule fires an Act or a Watch card, this one stops rendering and that card takes the top of the strip.',
      ),
      atMs: nowMs,
    });
  }

  return out;
}

/**
 * Order the cards and cut them to `limit`.
 *
 * Severity first, then `weight`, then recency (an insight with a timestamp beats
 * one without, and a newer one beats an older), then source order from
 * buildInsights, which Array.prototype.sort preserves. That last tie-break is
 * what stops two renders a second apart from reshuffling a strip whose contents
 * have not changed.
 *
 * WHY `weight` SITS BETWEEN SEVERITY AND RECENCY. Recency is the right rule for
 * cards about something that happened, and the wrong one for a card about
 * something that has not happened yet: a countdown has no timestamp, so it lost
 * every tie to ambient context that had one. On a quiet render that pushed "1
 * Great Deed is within 10 percent of firing", the single most forward-looking
 * fact the strip computes, below the world clock and the quiet-window card,
 * which restate what the all-clear already said. Weight is how a card declares
 * itself forward-looking; nothing else uses it, and severity still wins.
 */
export function rankInsights(all: Insight[], limit: number): Insight[] {
  const capped = Math.max(1, Math.min(MAX_CARDS, Math.floor(limit)));
  return [...all]
    .sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      const w = (a.weight ?? WEIGHT_DEFAULT) - (b.weight ?? WEIGHT_DEFAULT);
      if (w !== 0) return w;
      if (a.atMs !== null && b.atMs !== null && a.atMs !== b.atMs) return b.atMs - a.atMs;
      if (a.atMs !== null && b.atMs === null) return -1;
      if (a.atMs === null && b.atMs !== null) return 1;
      return 0;
    })
    .slice(0, capped);
}

// ── What was checked, so absence is legible ─────────────────────────────────

interface CheckDef {
  id: string;
  /** Named the way an operator would say it out loud. */
  title: string;
  /** Insight ids that mean this check flagged something. */
  flags: string[];
  /** Whether this check had the data it needed to run at all. */
  ran: (input: InsightInput) => boolean;
}

/**
 * The checks behind the strip, listed so the page can say what came back clear.
 *
 * This is NOT "everything is healthy": it is "these rules ran and did not fire",
 * which is a claim about the rules, not about the world. A check with no data
 * behind it says so by not appearing at all, which is why every entry carries a
 * `ran` predicate rather than being assumed to have run.
 */
export const CHECKS: CheckDef[] = [
  {
    id: 'presence',
    title: 'the roster against the event log',
    flags: ['silent-hall'],
    // The silent-hall rule short-circuits unless server_status is fresh AND
    // somebody is on it, so with an empty hall it never touches the event log
    // and this check did not run. It said otherwise until 2026-09-06, which on
    // an ordinary quiet render claimed a comparison that never happened.
    ran: (i) => {
      if (!i.reads.serverStatus || !i.reads.events || i.serverStatus === null) return false;
      const age = ageSecFrom(i.nowMs, i.serverStatus.updated_at);
      if (age === null || age > SERVER_STATUS_FRESH_SEC) return false;
      const on = i.serverStatus.current_players?.length ?? i.serverStatus.player_count ?? 0;
      return on > 0;
    },
  },
  {
    id: 'relay',
    title: 'the Discord relay backlog',
    flags: ['relay-behind'],
    ran: (i) =>
      i.reads.events &&
      i.reads.heartbeats &&
      relayState(i.heartbeats, i.events, i.nowMs).state !== 'unknown',
  },
  {
    id: 'announce',
    title: 'deeds waiting to be announced',
    flags: ['announce-backlog'],
    ran: (i) => i.reads.milestones && i.milestones.length > 0,
  },
  {
    id: 'deaths',
    title: 'the death rate against the weekly average',
    flags: ['death-spike'],
    ran: (i) => i.reads.events && !i.eventsTruncated && i.events.length > 0,
  },
  {
    id: 'identity',
    title: 'Steam identity mismatches',
    flags: ['identity-mismatch'],
    ran: (i) => i.reads.events && i.events.length > 0,
  },
  {
    id: 'headroom',
    title: 'component headroom against the stale thresholds',
    flags: ['component-headroom'],
    ran: (i) => i.reads.heartbeats && i.heartbeats.length > 0,
  },
  {
    id: 'emitter',
    title: 'server emitter freshness',
    flags: ['emitter-quiet'],
    ran: (i) => i.reads.serverStatus && i.serverStatus !== null,
  },
];

/** Titles of the checks that ran on real data and did not flag anything. */
export function checksNotFlagged(input: InsightInput, fired: Insight[]): string[] {
  if (!input.supabaseOk) return [];
  const firedIds = new Set(fired.map((f) => f.id));
  return CHECKS.filter((c) => c.ran(input))
    .filter((c) => !c.flags.some((id) => firedIds.has(id)))
    .map((c) => c.title);
}
