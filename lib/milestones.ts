// Collective Milestones ("Great Deeds") — the evaluator half of the engine.
//
// Two layers:
//   1. A PURE core (evaluateMilestones + the METRICS map + aggregate maths) that
//      takes definition rows + an { metric: value } aggregate map and returns the
//      milestones newly crossed this cycle. No I/O — unit-tested in
//      scripts/milestones.test.mjs.
//   2. An async orchestrator (evaluateAndRecord) called at the end of the
//      client-stats merge in /api/gs-ingest: it loads the still-unachieved rows,
//      computes the aggregates in one batch, marks the crossed ones achieved
//      (idempotent, guarded on achieved_at is null), and writes each new deed
//      into the Saga (events). The Discord bot's own loop then drains the
//      achieved-but-unannounced rows.
//
// ⚠️ The evaluator does NOT queue in-game voice (2026-08-22). A deed's Discord
// embed and its spoken line are ONE announcement moment, fired together by the
// bot when it announces the deed — not split between "crossed" and "announced".
// When several deeds cross in the same cycle they are ALL marked achieved here
// (no silencing, no quiet flags); announced_at stays NULL on each so the bot can
// drain them sequentially, one per tick, with its own MILESTONE_MIN_GAP_MS
// between announcements. Rarity is a property of the thresholds
// (db/2026-08-22_milestones_reseed.sql), not of a gate in this file.
//
// v1 metrics are restricted to columns already persisted by the pipeline — no
// new counters. Distances are summed from the per-mode breakdown that
// /api/gs-ingest folds into player_stats.gs_stats.distances (walk/run/sail);
// playtime is derived from sessions exactly like the Vikings page does.
//
// Tolerates the milestones table not existing yet (pre-migration): it logs once
// and skips so ingest is never blocked.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Milestone, GameSession } from './types';
import { formatDistance, formatNumber } from './format';

// ── types ────────────────────────────────────────────────────────────────────

/** A milestone definition row, as loaded by the evaluator (= the DB shape). */
export type MilestoneRow = Milestone;

/** metric key -> current server-wide value (metres, counts, hours, percent). */
export type Aggregates = Record<string, number>;

export interface CrossedMilestone {
  def: MilestoneRow;
  /** the aggregate value at the moment of crossing (stamped as achieved_value). */
  value: number;
}

// ── metric map (v1) ──────────────────────────────────────────────────────────
//
// Each entry reduces the raw rows the orchestrator fetches once into a single
// server-wide number. Kept as pure functions of already-persisted data so the
// same maths can be exercised in tests without a database.

export interface AggregateInput {
  /** player_stats rows (select '*') — read defensively (columns may be absent). */
  stats: Record<string, unknown>[];
  /** session rows for the playtime derivation. */
  sessions: GameSession[];
  /** character_names currently online — decides which open session counts live. */
  onlineNames: ReadonlySet<string>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Total playtime minutes per character from sessions — the same rule the Vikings
 * page uses (lib/data.playtimeMinutesByCharacter): closed sessions count their
 * duration; an open session only counts live time for a character that is
 * currently online, and only its most recent one (stale dangling opens dropped).
 * Inlined here (rather than imported from lib/data) to keep this module free of a
 * data-layer dependency, so lib/data can import the evaluator without a cycle.
 */
function playtimeMinutes(sessions: GameSession[], onlineNames: ReadonlySet<string>): number {
  const byName = new Map<string, GameSession[]>();
  for (const s of sessions) {
    if (!s.character_name) continue;
    const arr = byName.get(s.character_name) ?? [];
    arr.push(s);
    byName.set(s.character_name, arr);
  }
  const now = Date.now();
  let total = 0;
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime());
    sorted.forEach((s, i) => {
      if (s.duration_minutes != null) {
        total += s.duration_minutes;
      } else if (i === sorted.length - 1 && onlineNames.has(name)) {
        total += Math.max(0, Math.round((now - new Date(s.joined_at).getTime()) / 60_000));
      }
    });
  }
  return total;
}

/** Per-mode distance (metres) folded into gs_stats.distances by /api/gs-ingest. */
function distances(row: Record<string, unknown>): { walk: number; run: number; sail: number } {
  const gs = row.gs_stats as { distances?: { walk?: unknown; run?: unknown; sail?: unknown } } | null | undefined;
  const d = gs?.distances;
  return { walk: num(d?.walk), run: num(d?.run), sail: num(d?.sail) };
}

function sumStats(stats: Record<string, unknown>[], key: string): number {
  let total = 0;
  for (const r of stats) total += num(r[key]);
  return total;
}

/**
 * Total catches for one viking from `player_stats.gs_stats.fish`.
 *
 * The canonical shape written by /api/gs-ingest (via lib/gs-client
 * parseSelfSnapshot) is an array of `{ item, count }` — the pickups[] breakdown
 * filtered to the prefab ids in config/fish.ts, e.g.
 * `[{ item: 'Fish3', count: 4 }, { item: 'Fish1', count: 2 }]`. Nothing else
 * writes it, but this is jsonb from a third-party mod's payload, so read it
 * defensively: a missing/renamed key, a null blob, a non-numeric count, or the
 * plausible-but-unused `{ Fish1: 2 }` map shape must all degrade to a number
 * rather than throw and take the whole ingest cycle's evaluation with them.
 */
function fishCount(row: Record<string, unknown>): number {
  const gs = row.gs_stats as { fish?: unknown } | null | undefined;
  const list = gs?.fish;
  if (Array.isArray(list)) {
    let total = 0;
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      total += num((f as { count?: unknown }).count);
    }
    return total;
  }
  // Fallback: a bare `{ prefabId: count }` map, should the blob ever arrive that way.
  if (list && typeof list === 'object') {
    let total = 0;
    for (const v of Object.values(list as Record<string, unknown>)) total += num(v);
    return total;
  }
  return 0;
}

export const METRICS: Record<string, (a: AggregateInput) => number> = {
  // Per-mode distances (metres) — sail vs walk/run split lives in gs_stats.
  sail_total: (a) => a.stats.reduce((t, r) => t + distances(r).sail, 0),
  walk_run_total: (a) => a.stats.reduce((t, r) => t + distances(r).walk + distances(r).run, 0),

  // Straight sums over the player_stats cumulative columns.
  deaths_total: (a) => sumStats(a.stats, 'deaths'),
  kills_total: (a) => sumStats(a.stats, 'kills'),
  boss_kills_total: (a) => sumStats(a.stats, 'boss_kills'),
  damage_total: (a) => sumStats(a.stats, 'damage_dealt'),
  resources_total: (a) => sumStats(a.stats, 'resources_harvested'),
  crafts_total: (a) => sumStats(a.stats, 'items_crafted'),
  builds_total: (a) => sumStats(a.stats, 'structures_built'),

  // Catches, summed from each viking's per-species fish breakdown in gs_stats
  // (there is no dedicated column — fish ride along in pickups[]/resources).
  fish_total: (a) => a.stats.reduce((t, r) => t + fishCount(r), 0),

  // Total hours lived, derived from sessions like the Vikings page.
  playtime_total_hours: (a) => playtimeMinutes(a.sessions, a.onlineNames) / 60,

  // Average explored percentage across vikings who have a reading.
  explored_avg_pct: (a) => {
    const pcts = a.stats
      .map((r) => r.map_explored_pct)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (pcts.length === 0) return 0;
    return pcts.reduce((t, v) => t + v, 0) / pcts.length;
  },
};

/** Compute every v1 metric from the fetched rows (one batch → the aggregate map). */
export function computeAggregates(input: AggregateInput): Aggregates {
  const out: Aggregates = {};
  for (const [key, fn] of Object.entries(METRICS)) out[key] = fn(input);
  return out;
}

// ── pure evaluator ───────────────────────────────────────────────────────────

/**
 * Given the definition rows and the current aggregate map, return the milestones
 * whose threshold has JUST been crossed — i.e. not already achieved
 * (achieved_at is null) and value >= threshold for a metric we actually know.
 * Sorted by the row's `sort` for a stable announce order. Pure + idempotent:
 * already-achieved rows are never returned, so re-running is a no-op.
 */
export function evaluateMilestones(defs: MilestoneRow[], aggregates: Aggregates): CrossedMilestone[] {
  const crossed: CrossedMilestone[] = [];
  for (const def of defs) {
    if (def.achieved_at) continue; // already earned — idempotency guard
    if (!(def.metric in aggregates)) continue; // unknown metric — never fires
    const value = aggregates[def.metric];
    if (value >= def.threshold) crossed.push({ def, value });
  }
  return crossed.sort((a, b) => a.def.sort - b.def.sort);
}

/** Interpolate {value} (the achieved aggregate, rounded) into a ceremonial line. */
export function renderLine(line: string, value: number): string {
  return line.replace(/\{value\}/g, Math.round(value).toLocaleString('en-US'));
}

/** Metric-aware display of an aggregate value ("1.8 Mm"→"1,750.0 km", "1,000", "25%", "1,000 h"). */
export function formatMetricValue(metric: string, value: number): string {
  if (metric === 'sail_total' || metric === 'walk_run_total') return formatDistance(value);
  if (metric === 'playtime_total_hours') return `${formatNumber(Math.round(value))} h`;
  if (metric === 'explored_avg_pct') return `${Math.round(value)}%`;
  return formatNumber(Math.round(value));
}

// ── plain-language metric labels (copy doctrine) ────────────────────────────
//
// Deed titles ("The Length of Norway") are ceremonial flavor; a viewer can't
// tell WHAT is being tracked from the title alone. These labels/descriptions
// say plainly what each metric counts, so the UI can put the plain label up
// front and keep the flavor title as a subtitle/quote (per the repo-wide copy
// doctrine: titles say what, Norse flavor lives in subtitles).

export interface MetricInfo {
  /** plain label for the tracker, e.g. "Distance sailed". */
  label: string;
  /** short "what counts" clause, lowercase, no leading article — e.g. "every viking's sailing combined". */
  description: string;
}

export const METRIC_INFO: Record<string, MetricInfo> = {
  sail_total: { label: 'Distance sailed', description: "every viking's sailing combined" },
  walk_run_total: { label: 'Distance on foot', description: 'walking and running, all vikings' },
  deaths_total: { label: 'Deaths', description: 'every viking who has fallen' },
  kills_total: { label: 'Foes slain', description: 'every kill, all vikings' },
  boss_kills_total: { label: 'Bosses slain', description: 'the Forsaken felled, one by one' },
  damage_total: { label: 'Damage dealt', description: 'every point of damage dealt, all vikings' },
  resources_total: { label: 'Resources gathered', description: 'everything harvested by the crew' },
  crafts_total: { label: 'Items crafted', description: "everything shaped by the crew's own hands" },
  builds_total: { label: 'Pieces built', description: 'every piece placed, all vikings' },
  playtime_total_hours: { label: 'Hours lived in the world', description: 'combined time played' },
  explored_avg_pct: { label: 'Map explored', description: "clan average across every viking's map" },
  fish_total: { label: 'Fish caught', description: 'every catch landed, all vikings' },
};

/** Plain label + description for a metric key; falls back to the raw key if unmapped. */
export function metricInfo(metric: string): MetricInfo {
  return METRIC_INFO[metric] ?? { label: metric, description: '' };
}

// ── per-metric "chains" (tiered deeds grouped under one tracker) ───────────
//
// Several deeds share a metric and differ only by threshold (e.g. 3 sail
// tiers). To the viewer that's one tracker with multiple tiers, not 3
// unrelated deeds — group upcoming progress by metric so the UI can render
// one row per tracker: the nearest unearned tier as the "next" deed, and any
// further tiers as a short "then:" list.

export interface MilestoneChain {
  metric: string;
  label: string;
  description: string;
  /** current aggregate value for this metric. */
  value: number;
  /** the nearest unearned tier in this chain (highest pct). */
  next: MilestoneProgress;
  /** further unearned tiers beyond `next`, ascending by threshold. */
  laterTiers: Milestone[];
}

/**
 * Group a MilestoneSummary's `upcoming` list into per-metric chains, sorted by
 * the chain's next-tier progress (closest to earning first) — same ordering
 * principle as `upcoming` itself, just collapsed to one row per tracker.
 */
export function groupUpcomingChains(upcoming: MilestoneProgress[]): MilestoneChain[] {
  const byMetric = new Map<string, MilestoneProgress[]>();
  for (const p of upcoming) {
    const arr = byMetric.get(p.milestone.metric) ?? [];
    arr.push(p);
    byMetric.set(p.milestone.metric, arr);
  }

  const chains: MilestoneChain[] = [];
  for (const [metric, progresses] of byMetric) {
    const [next, ...rest] = [...progresses].sort((a, b) => b.pct - a.pct);
    const info = metricInfo(metric);
    chains.push({
      metric,
      label: info.label,
      description: info.description,
      value: next.value,
      next,
      laterTiers: rest.sort((a, b) => a.milestone.threshold - b.milestone.threshold).map((p) => p.milestone),
    });
  }

  return chains.sort((a, b) => b.next.pct - a.next.pct);
}

// ── dashboard summary (pure) ─────────────────────────────────────────────────

export interface MilestoneProgress {
  /** the milestone whose threshold is nearest to being reached, unachieved. */
  milestone: Milestone;
  /** current aggregate value for its metric. */
  value: number;
  /** progress toward the threshold, 0–100 (capped just under 100). */
  pct: number;
}

export interface MilestoneSummary {
  /** the most recently achieved deed (by achieved_at), or null if none yet. */
  latest: Milestone | null;
  /** all achieved deeds, most recent first. */
  achieved: Milestone[];
  /** all unachieved deeds with live progress, nearest (highest %) first. */
  upcoming: MilestoneProgress[];
  /** the single nearest unachieved deed (upcoming[0]) — the "next deed". */
  next: MilestoneProgress | null;
}

/**
 * Fold the definition rows + live aggregates into what the Hall card and the
 * /world ledger render: what's been achieved, and live progress toward what
 * hasn't. Pure (no I/O) so it stays testable and cheap to call per request.
 */
export function summarizeMilestones(defs: Milestone[], aggregates: Aggregates): MilestoneSummary {
  const achieved = defs
    .filter((m) => m.achieved_at)
    .sort((a, b) => new Date(b.achieved_at as string).getTime() - new Date(a.achieved_at as string).getTime());

  const upcoming: MilestoneProgress[] = defs
    .filter((m) => !m.achieved_at)
    .map((m) => {
      const value = aggregates[m.metric] ?? 0;
      const pct = m.threshold > 0 ? Math.min(99, Math.round((value / m.threshold) * 100)) : 0;
      return { milestone: m, value, pct };
    })
    .sort((a, b) => b.pct - a.pct);

  return {
    latest: achieved[0] ?? null,
    achieved,
    upcoming,
    next: upcoming[0] ?? null,
  };
}

// ── orchestrator (async, called from /api/gs-ingest) ─────────────────────────

// Postgres "relation does not exist" — the milestones migration isn't applied.
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = `${error.message || ''}`.toLowerCase();
  return error.code === '42P01' || /relation .*milestones.* does not exist|could not find the table/.test(msg);
}

let warnedMissing = false;

/**
 * Load unachieved milestone rows, evaluate them against the live aggregates,
 * stamp any newly crossed as achieved, and write each one's Saga event. Cheap:
 * if every milestone is already achieved the very first query returns nothing
 * and we bail before touching the heavier stats/session reads. All failures are
 * the caller's problem to swallow (the ingest hook wraps this in try/catch), but
 * the missing-table case is handled here so a fresh environment logs once and
 * skips instead of throwing.
 *
 * Announcement (Discord embed + in-game voice, together) belongs to the bot —
 * this function never queues voice and never sets announced_at.
 *
 * @returns a small summary for logging.
 */
export async function evaluateAndRecord(
  client: SupabaseClient,
  log: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } = console,
): Promise<{ crossed: number; skipped?: string }> {
  // 1. Unachieved definitions only — the cheap guard + missing-table probe.
  const { data: defsRaw, error: defErr } = await client
    .from('milestones')
    .select('*')
    .is('achieved_at', null);
  if (defErr) {
    if (isMissingTable(defErr)) {
      if (!warnedMissing) {
        log.info?.('[milestones] table not migrated yet — skipping until db/2026-07-05_milestones.sql is applied');
        warnedMissing = true;
      }
      return { crossed: 0, skipped: 'missing-table' };
    }
    throw new Error(`milestones read: ${defErr.message}`);
  }
  warnedMissing = false;
  const defs = (defsRaw ?? []) as MilestoneRow[];
  if (defs.length === 0) return { crossed: 0 }; // all earned — nothing to do

  // 2. One batch of reads → the aggregate map.
  const [statsRes, sessionsRes, onlineRes] = await Promise.all([
    client.from('player_stats').select('*'),
    client.from('sessions').select('*'),
    client.from('players').select('character_name, is_online'),
  ]);
  const stats = (statsRes.data ?? []) as Record<string, unknown>[];
  const sessions = (sessionsRes.data ?? []) as GameSession[];
  const onlineNames = new Set(
    ((onlineRes.data ?? []) as { character_name: string; is_online: boolean }[])
      .filter((p) => p.is_online && p.character_name)
      .map((p) => p.character_name),
  );

  const aggregates = computeAggregates({ stats, sessions, onlineNames });
  const crossed = evaluateMilestones(defs, aggregates);
  if (crossed.length === 0) return { crossed: 0 };

  // 3. Record each newly-crossed deed. The UPDATE is guarded on achieved_at is
  //    null so a concurrent ingest (or the same ~120s snapshot re-POSTed) can't
  //    double-fire; only when OUR update flips the row do we write the Saga
  //    event. ALL crossed deeds are recorded in this one pass — the sequencing
  //    of their announcements is entirely the bot's business (it announces the
  //    oldest unannounced row per tick, MILESTONE_MIN_GAP_MS apart), so nothing
  //    is suppressed, delayed or flagged here.
  const now = new Date().toISOString();
  let recorded = 0;
  for (const { def, value } of crossed) {
    const achievedValue = Math.round(value);
    const { data: flipped, error: upErr } = await client
      .from('milestones')
      .update({ achieved_at: now, achieved_value: achievedValue })
      .eq('id', def.id)
      .is('achieved_at', null)
      .select('id');
    if (upErr) {
      log.error?.(`[milestones] mark ${def.id} failed: ${(upErr as { message?: string }).message}`);
      continue;
    }
    if (!flipped || (flipped as unknown[]).length === 0) continue; // lost the race — already flipped

    const line = renderLine(def.line, value);

    // Saga feed — a 'milestone' event so it lands in /events + Episodes.
    await client.from('events').insert({
      type: 'milestone',
      character_name: null,
      metadata: { milestone: def.id, title: def.title, line, equivalence: def.equivalence },
      created_at: now,
    });

    // NO voice_lines insert here, deliberately. The in-game line and the Discord
    // embed are a single announcement moment owned by the bot: it queues the
    // voice line at the instant it posts the embed. Queueing here instead would
    // make Eilif speak the deed the moment the threshold crossed and then post
    // about it minutes later — two announcements for one deed, and it would
    // bypass the bot's sequential MILESTONE_MIN_GAP_MS pacing when several deeds
    // cross together. The row (achieved_at set, announced_at still NULL) is the
    // whole handoff.

    recorded++;
    log.info?.(`[milestones] achieved "${def.title}" (${def.metric} >= ${def.threshold}, value ${achievedValue})`);
  }

  return { crossed: recorded };
}
