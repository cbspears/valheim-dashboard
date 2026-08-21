// Component health model for the ops cockpit — PURE (data in → result out).
//
// The cockpit's first duty is to answer "is each moving part actually running?"
// HONESTLY. The guiding rule: NEVER assume healthy just because a process is
// supposed to be up. A component is healthy only when we have a fresh, positive
// signal for it; absent that signal it is "unknown" or "stale", never green.
//
// Signal sources differ per component:
//   • ops_heartbeats  — the log poller, discord bot, and map snapshotter POST
//     their own heartbeats (they run on our host and can).
//   • server_status   — the 3rd-party GsValheimStats Emitter mod CANNOT heartbeat,
//     so the "server-emitter" component is INFERRED from how fresh server_status
//     is (the emitter is the only thing that updates it on a cadence).
//   • render          — the dashboard itself (alive because this page rendered)
//     and supabase (alive because a service-role query succeeded this render).
//   • bot_metrics     — the bot's sub-loops (events sync, gallery ingest, ...)
//     are NOT separate processes; their state is read out of the discord-bot
//     heartbeat's metrics. No bot heartbeat ⇒ their state is unknown.

export type HealthState = 'healthy' | 'degraded' | 'stale' | 'disabled' | 'unknown';

export type ComponentSource = 'ops_heartbeats' | 'server_status' | 'render' | 'bot_metrics';
export type ComponentGroup = 'core' | 'pipeline' | 'bot-loop';

export interface ComponentDef {
  key: string;
  label: string; // plain operational label FIRST (copy doctrine)
  group: ComponentGroup;
  source: ComponentSource;
  expectedCadenceSec: number;
  staleAfterSec: number;
  /** Norse-flavored one-liner for the unknown/empty state only. */
  subtitle?: string;
}

// Core liveness (this render) + the ingest pipeline processes.
export const COMPONENTS: ComponentDef[] = [
  {
    key: 'dashboard-api',
    label: 'Dashboard',
    group: 'core',
    source: 'render',
    expectedCadenceSec: 0,
    staleAfterSec: 0,
    subtitle: 'This page. Alive because it rendered.',
  },
  {
    key: 'supabase',
    label: 'Database',
    group: 'core',
    source: 'render',
    expectedCadenceSec: 0,
    staleAfterSec: 0,
    subtitle: 'The well every deed is drawn from.',
  },
  {
    key: 'server-emitter',
    label: 'Server emitter',
    group: 'pipeline',
    source: 'server_status',
    expectedCadenceSec: 120,
    staleAfterSec: 300,
    subtitle: 'Inferred — the mod cannot report for itself.',
  },
  {
    key: 'log-poller',
    label: 'Log poller',
    group: 'pipeline',
    source: 'ops_heartbeats',
    expectedCadenceSec: 60,
    staleAfterSec: 300,
    subtitle: 'Tails the longship log for deeds and deaths.',
  },
  {
    key: 'discord-bot',
    label: 'Discord bot',
    group: 'pipeline',
    source: 'ops_heartbeats',
    expectedCadenceSec: 60,
    staleAfterSec: 180,
    subtitle: 'The herald in the mead hall.',
  },
  {
    key: 'map-snapshot',
    label: 'Map snapshot',
    group: 'pipeline',
    source: 'ops_heartbeats',
    expectedCadenceSec: 300,
    staleAfterSec: 900,
    subtitle: 'Redraws the known world from the fog.',
  },
  {
    key: 'stats-parser',
    label: 'Stats parser',
    group: 'pipeline',
    source: 'ops_heartbeats',
    expectedCadenceSec: 300,
    staleAfterSec: 900,
    subtitle: 'Reads each viking’s tally from the save.',
  },
];

// Bot sub-loops — state derived from the discord-bot heartbeat's metrics.loops,
// NOT from any separate process.
export const BOT_SUBLOOPS: ComponentDef[] = [
  { key: 'events-sync', label: 'Events sync', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 300, staleAfterSec: 1800 },
  { key: 'gallery-ingest', label: 'Gallery ingest', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 120, staleAfterSec: 900 },
  { key: 'voice-queue', label: 'Voice queue', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 60, staleAfterSec: 600 },
  { key: 'title-evaluator', label: 'Title evaluator', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 600, staleAfterSec: 3600 },
  { key: 'milestone-evaluator', label: 'Milestone evaluator', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 600, staleAfterSec: 3600 },
];

/**
 * The core state machine. Given the last time we saw a SUCCESS, how stale that
 * is allowed to get, and optional disabled/errored flags, return a state.
 *
 *   disabled                         → 'disabled'
 *   no lastSuccess & not disabled    → 'unknown'   (never green on absence)
 *   age > staleAfter                 → 'stale'
 *   errored (but fresh)              → 'degraded'
 *   otherwise                        → 'healthy'
 */
export function computeState(
  nowMs: number,
  lastSuccessMs: number | null,
  staleAfterSec: number,
  opts: { disabled?: boolean; errored?: boolean } = {},
): HealthState {
  if (opts.disabled) return 'disabled';
  if (lastSuccessMs === null || !Number.isFinite(lastSuccessMs)) return 'unknown';
  const ageSec = (nowMs - lastSuccessMs) / 1000;
  if (ageSec > staleAfterSec) return 'stale';
  if (opts.errored) return 'degraded';
  return 'healthy';
}

// ── Report shapes ────────────────────────────────────────────────────────────

export interface HeartbeatRow {
  component: string;
  instance: string | null;
  version: string | null;
  status: string; // ok | degraded | error
  last_success: string | null;
  last_attempt: string | null;
  error_summary: string | null;
  metrics: Record<string, unknown>;
  updated_at: string | null;
}

export interface ComponentReport {
  key: string;
  label: string;
  group: ComponentGroup;
  state: HealthState;
  ageSec: number | null;
  cadenceSec: number;
  staleAfterSec: number;
  version: string | null;
  lastSuccess: string | null;
  lastError: string | null; // already sanitized upstream (stored redacted)
  flags: { label: string; value: string }[];
  detail: string; // plain explanation of how this state was derived
}

export interface HealthInput {
  nowMs: number;
  supabaseOk: boolean;
  dashboardVersion: string | null;
  serverStatusUpdatedAt: string | null;
  /** ops_heartbeats rows keyed by component. */
  heartbeats: Record<string, HeartbeatRow | undefined>;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function ageOf(nowMs: number, iso: string | null | undefined): number | null {
  const ms = toMs(iso);
  return ms === null ? null : Math.max(0, (nowMs - ms) / 1000);
}

/** Shape the bot's per-loop metrics report (best-effort; all fields optional). */
interface LoopMetric {
  enabled?: boolean;
  lastSuccessAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
}

/**
 * Build the full component report set: core liveness, the pipeline processes,
 * and the bot sub-loops (derived from the discord-bot heartbeat metrics).
 */
export function buildHealth(input: HealthInput): ComponentReport[] {
  const { nowMs, supabaseOk, dashboardVersion, serverStatusUpdatedAt, heartbeats } = input;
  const out: ComponentReport[] = [];

  for (const def of COMPONENTS) {
    if (def.key === 'dashboard-api') {
      out.push({
        ...base(def),
        state: 'healthy',
        ageSec: 0,
        version: dashboardVersion,
        lastSuccess: new Date(nowMs).toISOString(),
        detail: 'This page rendered, so the dashboard is serving.',
      });
      continue;
    }

    if (def.key === 'supabase') {
      out.push({
        ...base(def),
        state: supabaseOk ? 'healthy' : 'degraded',
        ageSec: supabaseOk ? 0 : null,
        version: null,
        lastSuccess: supabaseOk ? new Date(nowMs).toISOString() : null,
        detail: supabaseOk
          ? 'A service-role query succeeded during this render.'
          : 'The service-role query for this render failed or is unconfigured.',
      });
      continue;
    }

    if (def.source === 'server_status') {
      // INFERRED from server_status freshness — the emitter mod can't heartbeat.
      const lastSuccess = supabaseOk ? serverStatusUpdatedAt : null;
      const lastSuccessMs = toMs(lastSuccess);
      const state = supabaseOk
        ? computeState(nowMs, lastSuccessMs, def.staleAfterSec)
        : 'unknown';
      out.push({
        ...base(def),
        state,
        ageSec: ageOf(nowMs, lastSuccess),
        version: null, // third-party mod does not report a version
        lastSuccess,
        detail:
          'Inferred from server_status freshness (the GsValheimStats emitter cannot send a heartbeat).',
      });
      continue;
    }

    // ops_heartbeats-sourced pipeline processes.
    const hb = heartbeats[def.key];
    if (!supabaseOk) {
      out.push({ ...base(def), state: 'unknown', detail: 'Database unreachable this render — status unknown.' });
      continue;
    }
    if (!hb) {
      out.push({
        ...base(def),
        state: 'unknown',
        detail: 'No heartbeat recorded yet — this component has never checked in.',
      });
      continue;
    }
    const lastSuccessMs = toMs(hb.last_success);
    const errored = hb.status === 'error' || hb.status === 'degraded';
    out.push({
      ...base(def),
      state: computeState(nowMs, lastSuccessMs, def.staleAfterSec, { errored }),
      ageSec: ageOf(nowMs, hb.last_success),
      version: hb.version,
      lastSuccess: hb.last_success,
      lastError: hb.error_summary,
      flags: flagsFromMetrics(hb.metrics),
      detail:
        errored && lastSuccessMs !== null
          ? `Last heartbeat reported status "${hb.status}".`
          : 'Health from the component\'s own heartbeat.',
    });
  }

  // ── Bot sub-loops, derived from the discord-bot heartbeat metrics ──────────
  const botHb = heartbeats['discord-bot'];
  const loops = (botHb?.metrics?.loops ?? null) as Record<string, LoopMetric> | null;
  for (const def of BOT_SUBLOOPS) {
    if (!supabaseOk || !botHb) {
      out.push({
        ...base(def),
        state: 'unknown',
        detail: !supabaseOk
          ? 'Database unreachable this render — status unknown.'
          : 'The discord bot has not checked in, so its loops are unknown.',
      });
      continue;
    }
    const loop = loops?.[def.key];
    if (!loop) {
      out.push({
        ...base(def),
        state: 'unknown',
        detail: 'The bot heartbeat did not report this loop.',
      });
      continue;
    }
    if (loop.enabled === false) {
      out.push({
        ...base(def),
        state: 'disabled',
        flags: [{ label: 'enabled', value: 'false' }],
        detail: 'The bot reports this loop is turned off.',
      });
      continue;
    }
    const successIso = loop.lastSuccessAt ?? loop.lastRunAt ?? null;
    const lastSuccessMs = toMs(successIso);
    const errored = !!loop.lastError;
    out.push({
      ...base(def),
      state: computeState(nowMs, lastSuccessMs, def.staleAfterSec, { errored }),
      ageSec: ageOf(nowMs, successIso),
      lastSuccess: successIso,
      lastError: loop.lastError ?? null,
      flags: [{ label: 'enabled', value: 'true' }],
      detail: 'Derived from the discord-bot heartbeat metrics.',
    });
  }

  return out;
}

function base(def: ComponentDef): ComponentReport {
  return {
    key: def.key,
    label: def.label,
    group: def.group,
    state: 'unknown',
    ageSec: null,
    cadenceSec: def.expectedCadenceSec,
    staleAfterSec: def.staleAfterSec,
    version: null,
    lastSuccess: null,
    lastError: null,
    flags: [],
    detail: '',
  };
}

/** Surface a small set of non-secret boolean/string flags from metrics. */
function flagsFromMetrics(metrics: Record<string, unknown> | null | undefined): { label: string; value: string }[] {
  const flags = (metrics?.flags ?? null) as Record<string, unknown> | null;
  if (!flags || typeof flags !== 'object') return [];
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      out.push({ label: k, value: String(v) });
    }
  }
  return out.slice(0, 8);
}

/** Worst state across a set — for a roll-up header count. */
export const STATE_RANK: Record<HealthState, number> = {
  healthy: 0,
  disabled: 1,
  unknown: 2,
  degraded: 3,
  stale: 4,
};
