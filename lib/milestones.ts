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
//      (idempotent, guarded on achieved_at is null), and fans each new deed out
//      to the Saga (events) + in-game voice (voice_lines). The Discord bot's own
//      loop picks up achieved-but-unannounced rows (announce cap lives there).
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
 * Load unachieved milestone rows, evaluate them against the live aggregates, and
 * record + fan out any newly crossed. Cheap: if every milestone is already
 * achieved the very first query returns nothing and we bail before touching the
 * heavier stats/session reads. All failures are the caller's problem to swallow
 * (the ingest hook wraps this in try/catch), but the missing-table case is
 * handled here so a fresh environment logs once and skips instead of throwing.
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

  // 3. Record + fan out each newly-crossed deed. The UPDATE is guarded on
  //    achieved_at is null so a concurrent ingest can't double-fire; only when
  //    OUR update flips the row do we insert the Saga event + voice line.
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

    // In-game voice — Eilif speaks it center-screen (Companion polls /api/voice).
    await client.from('voice_lines').insert({
      text: line,
      speaker: 'Eilif',
      kind: 'event',
      status: 'queued',
      meta: { milestone: def.id, title: def.title },
      queued_at: now,
    });

    recorded++;
    log.info?.(`[milestones] achieved "${def.title}" (${def.metric} >= ${def.threshold}, value ${achievedValue})`);
  }

  return { crossed: recorded };
}
