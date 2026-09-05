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
    subtitle: 'Inferred. The mod cannot report for itself.',
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
  // 'stats-parser' was REMOVED here on 2026-09-04. eilif-stats-parser.service was
  // retired on 2026-08-23 (the webhook's 'stats' branch went with it) and is
  // inactive by design, but its ops_heartbeats row was still being read — so the
  // cockpit showed a permanently STALE component (last_success 2026-08-23) and
  // /admin/ops was red for a process nobody wants running. The DB row is left
  // alone on purpose (deleting rows is Charlie's call, not a deploy's):
  //   delete from ops_heartbeats where component = 'stats-parser';
  // Until he runs that, the row simply sits there unread.
  //
  // The two in-game plugins, whose liveness is recorded by the routes they poll
  // (lib/ops/route-heartbeat) because neither can POST a heartbeat of its own.
  {
    key: 'boards-plugin',
    label: 'Boards signs',
    group: 'pipeline',
    source: 'ops_heartbeats',
    // The plugin polls /api/boards about once a minute; two missed polls is a
    // real signal, and a token rotation shows up here within minutes instead of
    // never (its 401 only ever logged once, to a file on the GTX box).
    expectedCadenceSec: 60,
    staleAfterSec: 300,
    subtitle: 'Seen only when the signs ask for numbers.',
  },
  {
    key: 'companion-voice',
    label: 'In-game voice',
    group: 'pipeline',
    source: 'ops_heartbeats',
    // The Companion polls /api/voice every few seconds; the write is throttled to
    // once a minute, so the same window applies.
    expectedCadenceSec: 60,
    staleAfterSec: 300,
    subtitle: 'Heard when the hall still has a voice.',
  },
];

// Bot sub-loops — state derived from the discord-bot heartbeat's metrics, NOT
// from any separate process.
export const BOT_SUBLOOPS: ComponentDef[] = [
  { key: 'relay', label: 'Event relay', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 15, staleAfterSec: 300 },
  { key: 'bosses', label: 'Boss watch', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 30, staleAfterSec: 600 },
  { key: 'events-sync', label: 'Events sync', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 300, staleAfterSec: 1800 },
  { key: 'gallery-ingest', label: 'Gallery ingest', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 120, staleAfterSec: 900 },
  { key: 'voice-queue', label: 'Voice queue', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 60, staleAfterSec: 600 },
  { key: 'title-evaluator', label: 'Title evaluator', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 600, staleAfterSec: 3600 },
  { key: 'milestone-evaluator', label: 'Milestone evaluator', group: 'bot-loop', source: 'bot_metrics', expectedCadenceSec: 600, staleAfterSec: 3600 },
];

/**
 * Cockpit key → the labels the bot might file that loop's run result under.
 *
 * THE BUG THIS FIXES. The bot builds `metrics.subLoops` by iterating its
 * ENABLED-flags map (index.js ~219-234), whose keys are the hyphenated names
 * below, and merging in `loopsSnapshot()[key]` — but `safe()` records run
 * results under SHORTER labels ('voice', 'titles', 'milestones', 'events';
 * index.js:118/157/175/205). Only relay, bosses and identity-confirm happen to
 * spell the same in both places, so the five loops the cockpit listed arrived as
 * a bare `{enabled:true}` with no lastRunAt at all — and the cockpit was reading
 * `metrics.loops`, which the bot has never sent, so every one of them rendered
 * "unknown — The bot heartbeat did not report this loop".
 *
 * The bot is a separate deployable on the host and is deliberately NOT edited
 * here, so the mapping lives on this side: read `subLoops` (falling back to
 * `loops` in case the bot is ever renamed to match the docs), and for each
 * cockpit key merge whichever aliases the payload actually carries — the
 * enabled-flag entry and the run-result entry are two halves of one loop.
 */
const BOT_LOOP_ALIASES: Record<string, string[]> = {
  relay: ['relay'],
  bosses: ['bosses'],
  'events-sync': ['events-sync', 'events'],
  'gallery-ingest': ['gallery-ingest', 'gallery'],
  'voice-queue': ['voice-queue', 'voice'],
  'title-evaluator': ['title-evaluator', 'titles'],
  'milestone-evaluator': ['milestone-evaluator', 'milestones'],
};

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
  /**
   * Age in seconds of the OLDEST still-queued voice line while somebody is
   * actually on the server, or null when the queue is empty / nobody is on.
   *
   * A SECOND, INDEPENDENT signal for the in-game voice half, and the only one
   * that survives the heartbeat being wrong. The route heartbeat says "the
   * Companion is polling"; this says "and the lines it should be speaking are
   * actually leaving the queue". Lines pile up unspoken when the plugin loads but
   * its speak path is broken, or when it polls with a stale token — neither of
   * which stops the poll itself. Nobody online is NOT a fault (there is no one to
   * speak to), which is why the player count is part of the condition.
   */
  voiceQueueOldestSec?: number | null;
  /**
   * How many vikings the roster says are on the server right now.
   *
   * The Companion polls /api/voice ONLY while at least one player is connected
   * (EilifCompanionPlugin's PollSeconds: "only when >=1 player is connected"), so
   * an empty hall produces no polls at all. Without this, 'In-game voice' turned
   * STALE five minutes after the last player left and stayed red until somebody
   * logged back in: a red cockpit every single night, for a component that was
   * behaving exactly as designed. A quiet hall is now reported as unknown, which
   * is the honest answer, and never as healthy (this file never goes green on
   * absence).
   *
   * The count is only BELIEVED while `serverStatusUpdatedAt` is itself fresh: the
   * roster is read out of server_status, so a dead emitter reports an empty hall
   * whether or not anyone is playing, and taking that at face value would excuse
   * a genuinely dead voice half at exactly the wrong moment.
   *
   * Omit it and staleness works exactly as it did before for every component.
   */
  playersOnline?: number | null;
}

/** Queued longer than this with players online → the voice half is degraded. */
export const VOICE_QUEUE_DEGRADED_SEC = 10 * 60;

/**
 * How fresh server_status must be for its roster to be believed.
 *
 * Deliberately the SAME bound that turns 'server-emitter' stale, read off that
 * component's own definition so the two can never drift: past this age the
 * cockpit already declares the emitter unreliable, and a roster it no longer
 * trusts must not be used to excuse another component's silence.
 */
export const SERVER_STATUS_TRUST_SEC =
  COMPONENTS.find((c) => c.key === 'server-emitter')?.staleAfterSec ?? 300;

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
  /** The bot's own recordLoopResult shape (heartbeat.js): ok + error. */
  ok?: boolean;
  error?: string | null;
}

/**
 * Build the full component report set: core liveness, the pipeline processes,
 * and the bot sub-loops (derived from the discord-bot heartbeat metrics).
 */
export function buildHealth(input: HealthInput): ComponentReport[] {
  const { nowMs, supabaseOk, dashboardVersion, serverStatusUpdatedAt, heartbeats } = input;
  const out: ComponentReport[] = [];

  // Either passed explicitly, or carried on the companion-voice heartbeat row's
  // own metrics (that is how lib/ops/db hands it over — see the note there).
  const voiceMetric = heartbeats['companion-voice']?.metrics?.voiceQueueOldestSec;
  const voiceOldestSec =
    typeof input.voiceQueueOldestSec === 'number'
      ? input.voiceQueueOldestSec
      : typeof voiceMetric === 'number'
        ? voiceMetric
        : null;
  const voiceStalledSec =
    voiceOldestSec !== null && voiceOldestSec >= VOICE_QUEUE_DEGRADED_SEC ? voiceOldestSec : null;

  // An empty hall silences the Companion's /api/voice polling by design, so its
  // heartbeat is expected to go quiet with it. Only asserted when the caller
  // actually told us the roster is empty; an omitted count changes nothing.
  //
  // The roster is only trusted while server_status is itself fresh. That roster
  // IS server_status.current_players: if the emitter dies while vikings are
  // playing, the hall reads empty and a genuinely dead voice half would be
  // quietly downgraded from stale (red) to unknown (blue) — and server-emitter,
  // the one component that would contradict it, is exactly the component that
  // just went stale. So an aged server_status revokes the excuse and the voice
  // half stays stale, which is the honest answer when nothing is known.
  const serverStatusFresh = (() => {
    const t = toMs(serverStatusUpdatedAt);
    if (t === null) return false;
    return nowMs - t <= SERVER_STATUS_TRUST_SEC * 1000;
  })();
  const quietHall =
    serverStatusFresh && typeof input.playersOnline === 'number' && input.playersOnline === 0;

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
      out.push({ ...base(def), state: 'unknown', detail: 'Database unreachable this render, so status is unknown.' });
      continue;
    }
    if (!hb) {
      out.push({
        ...base(def),
        state: 'unknown',
        detail: 'No heartbeat recorded yet. This component has never checked in.',
      });
      continue;
    }
    const lastSuccessMs = toMs(hb.last_success);
    // A fresh poll is not enough for the voice half: lines queued for 10+ minutes
    // while players are on means the Companion is polling but not speaking.
    const voiceStalled = def.key === 'companion-voice' && voiceStalledSec !== null;
    const errored = hb.status === 'error' || hb.status === 'degraded' || voiceStalled;
    let state = computeState(nowMs, lastSuccessMs, def.staleAfterSec, { errored });
    // The one component whose silence is expected: with nobody on the server the
    // Companion does not poll, so an aged heartbeat is not evidence of a fault.
    // Downgraded to unknown, never up to healthy.
    const quietVoice = def.key === 'companion-voice' && quietHall && state === 'stale';
    if (quietVoice) state = 'unknown';
    out.push({
      ...base(def),
      state,
      ageSec: ageOf(nowMs, hb.last_success),
      version: hb.version,
      lastSuccess: hb.last_success,
      lastError: hb.error_summary,
      flags: flagsFromMetrics(hb.metrics),
      detail: quietVoice
        ? 'Nobody is on the server. The Companion only polls while a viking is connected, so a quiet heartbeat here is expected.'
        : voiceStalled
          ? `Polling, but a voice line has sat queued for ${Math.round(voiceStalledSec / 60)} min with players online. The Companion is not speaking them.`
          : errored && lastSuccessMs !== null
            ? `Last heartbeat reported status "${hb.status}".`
            : 'Health from the component\'s own heartbeat.',
    });
  }

  // ── Bot sub-loops, derived from the discord-bot heartbeat metrics ──────────
  // `subLoops` is what the bot actually sends (and what docs/OPS-COCKPIT.md
  // documents); `loops` is the name this file used to read and nothing has ever
  // written — kept as a fallback so renaming the bot's metric can't break this.
  const botHb = heartbeats['discord-bot'];
  const loops = ((botHb?.metrics?.subLoops ?? botHb?.metrics?.loops) ?? null) as Record<string, LoopMetric> | null;
  for (const def of BOT_SUBLOOPS) {
    if (!supabaseOk || !botHb) {
      out.push({
        ...base(def),
        state: 'unknown',
        detail: !supabaseOk
          ? 'Database unreachable this render, so status is unknown.'
          : 'The discord bot has not checked in, so its loops are unknown.',
      });
      continue;
    }
    // Merge every alias the payload carries: the bot files a loop's ENABLED flag
    // under the hyphenated name and its RUN RESULT under a shorter one, so the
    // two halves have to be put back together here (see BOT_LOOP_ALIASES).
    const parts = (BOT_LOOP_ALIASES[def.key] ?? [def.key])
      .map((alias) => loops?.[alias])
      .filter((v): v is LoopMetric => !!v && typeof v === 'object');
    const loop: LoopMetric | undefined = parts.length > 0 ? Object.assign({}, ...parts) : undefined;
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
    const errored = loop.ok === false || !!loop.lastError;
    out.push({
      ...base(def),
      state: computeState(nowMs, lastSuccessMs, def.staleAfterSec, { errored }),
      ageSec: ageOf(nowMs, successIso),
      lastSuccess: successIso,
      lastError: loop.lastError ?? loop.error ?? null,
      flags: [{ label: 'enabled', value: 'true' }],
      detail:
        lastSuccessMs === null
          ? 'The bot reports this loop is on, but has never recorded a tick result for it.'
          : 'Derived from the discord-bot heartbeat metrics.',
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
