// Off-PC watchdog — PURE evaluation + alert decisions (data in → decision out).
//
// WHY THIS EXISTS: every producer in the pipeline (discord-bot, log-poller,
// map-snapshot, stats-parser) runs on Charlie's PC, and /admin/ops is PULL-only —
// somebody has to open it. So when the PC is off, or the game server dies, the
// only thing that notices is a human who happens to look. A ~7h outage on
// 2026-08-17 and a 6-day server outage both went unseen that way.
//
// The watchdog closes that hole by being PUSH-based and hosted somewhere the PC
// can't take down: GitHub Actions curls GET /api/ops/watchdog on Vercel every
// 15 minutes; this module decides whether that ping should turn into a Discord
// message. It reuses computeState() from ./health.ts (same state machine the
// cockpit renders) so "stale" means the same thing in both places — only the
// thresholds differ (see WATCHDOG_TARGETS below).
//
// PURE + dependency-free (no Next, no Supabase, no fetch) so the whole
// alert-or-not decision is unit-testable: lib/ops/watchdog.test.mjs. The route
// handler owns all the IO (auth, the service-role reads, the Discord POST, and
// persisting the state row).

import { computeState, type HealthState, type HeartbeatRow } from './health';

/** Primary key of the single state row this watchdog keeps in ops_alerts. */
export const ALERT_KEY = 'watchdog';

/** While something stays unhealthy, re-alert at most this often (anti-spam). */
export const RE_ALERT_AFTER_SEC = 6 * 60 * 60;

/** The external pinger's cadence — thresholds must comfortably exceed it. */
export const PING_INTERVAL_SEC = 15 * 60;

export type WatchdogSource = 'ops_heartbeats' | 'server_status';

export interface WatchdogTarget {
  key: string;
  /** Plain operational label first (copy doctrine) — this is what Discord shows. */
  label: string;
  source: WatchdogSource;
  /** How often the producer is supposed to report. */
  cadenceSec: number;
  /** Silence longer than this is an alert. */
  staleAfterSec: number;
  /** One-line "what this failing actually means", included in the alert. */
  meaning: string;
}

/**
 * WATCHDOG THRESHOLDS ARE DELIBERATELY LOOSER THAN THE COCKPIT'S.
 *
 * lib/ops/health.ts marks the bot stale after 180s because a human is staring at
 * the page and wants the truth *now*. This path is different: it is polled every
 * 15 minutes by GitHub's scheduler, which is itself best-effort and routinely
 * runs several minutes late. Any threshold at or below the poll interval would
 * fire on scheduler jitter alone, and a watchdog that cries wolf gets muted —
 * which would put us right back where we started.
 *
 * So every threshold here is >= PING_INTERVAL_SEC + a real margin:
 *   • 60s-cadence producers  → 20 min  (≈20 missed ticks: unambiguously dead)
 *   • 300s-cadence producers → 45 min  (≈9 missed ticks)
 *   • server_status (120s)   → 20 min
 * Worst-case detection latency is threshold + one ping interval (~35–60 min),
 * which is the right trade against a 7-hour outage nobody saw.
 */
export const WATCHDOG_TARGETS: WatchdogTarget[] = [
  {
    key: 'discord-bot',
    label: 'Discord bot',
    source: 'ops_heartbeats',
    cadenceSec: 60,
    staleAfterSec: 20 * 60,
    meaning: 'No events, recaps, milestones or chat mirror are reaching Discord.',
  },
  {
    key: 'log-poller',
    label: 'Log poller',
    source: 'ops_heartbeats',
    cadenceSec: 60,
    staleAfterSec: 20 * 60,
    meaning: 'Joins, leaves, deaths and shouts are not being ingested.',
  },
  {
    key: 'map-snapshot',
    label: 'Map snapshot',
    source: 'ops_heartbeats',
    cadenceSec: 300,
    staleAfterSec: 45 * 60,
    meaning: 'The /map image is frozen at its last successful pull.',
  },
  {
    key: 'stats-parser',
    label: 'Stats parser',
    source: 'ops_heartbeats',
    cadenceSec: 300,
    staleAfterSec: 45 * 60,
    meaning: 'Player stats are no longer being refreshed.',
  },
  {
    key: 'game-server',
    label: 'Game server',
    source: 'server_status',
    cadenceSec: 120,
    staleAfterSec: 20 * 60,
    meaning: 'The Valheim server (or the GsValheimStats emitter on it) has gone quiet.',
  },
];

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface WatchdogInput {
  nowMs: number;
  /** ops_heartbeats rows keyed by component (missing key = never reported). */
  heartbeats: Record<string, HeartbeatRow | undefined>;
  /** server_status.updated_at (null when the row/column has never been written). */
  serverStatusUpdatedAt: string | null;
  /** server_status.is_online. */
  serverIsOnline: boolean | null;
}

export interface WatchdogCheck {
  key: string;
  label: string;
  source: WatchdogSource;
  state: HealthState;
  /** True only when this should wake somebody up. `unknown` never does. */
  unhealthy: boolean;
  ageSec: number | null;
  staleAfterSec: number;
  lastSuccess: string | null;
  /** Plain sentence: what we observed and why it is (or isn't) an alert. */
  detail: string;
}

export interface WatchdogEvaluation {
  checkedAt: string;
  ok: boolean;
  checks: WatchdogCheck[];
  unhealthy: WatchdogCheck[];
  /** Keys that have never reported at all — reported, but never alerted on. */
  neverReported: string[];
  /**
   * Stable fingerprint of WHAT is wrong (`key:state,…`). A change in this while
   * already alerting means a different/extra thing broke → worth re-alerting.
   */
  signature: string;
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

/** Compact human age: "45s", "12m", "3.2h", "6d". `null` → "never". */
export function formatAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return 'never';
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = sec / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Evaluate every watched producer plus the game server.
 *
 * The honesty rules from lib/ops/health.ts carry over unchanged:
 *   • A component we have NEVER heard from is `unknown`, and unknown is NEVER an
 *     alert. We cannot tell "not deployed yet" from "down" with zero data, and a
 *     watchdog that pages about a producer that has not shipped yet is noise.
 *     (stats-parser is exactly this case today — it gains its heartbeat now.)
 *     Once it reports once, silence afterwards is `stale` and DOES alert.
 *   • `stale` (was reporting, now silent) and `degraded` (reporting, but its own
 *     beat says error) both alert.
 */
export function evaluateWatchdog(input: WatchdogInput): WatchdogEvaluation {
  const { nowMs, heartbeats, serverStatusUpdatedAt, serverIsOnline } = input;
  const checks: WatchdogCheck[] = [];

  for (const target of WATCHDOG_TARGETS) {
    if (target.source === 'server_status') {
      checks.push(serverStatusCheck(target, nowMs, serverStatusUpdatedAt, serverIsOnline));
      continue;
    }

    const hb = heartbeats[target.key];
    if (!hb || !hb.last_success) {
      checks.push({
        ...blank(target),
        state: 'unknown',
        detail: hb
          ? 'Has checked in but never reported a success yet — not alerting until it does.'
          : 'Has never reported a heartbeat — not alerting until it does once.',
      });
      continue;
    }

    const errored = hb.status === 'error' || hb.status === 'degraded';
    const state = computeState(nowMs, toMs(hb.last_success), target.staleAfterSec, { errored });
    const ageSec = ageOf(nowMs, hb.last_success);
    checks.push({
      ...blank(target),
      state,
      unhealthy: state === 'stale' || state === 'degraded',
      ageSec,
      lastSuccess: hb.last_success,
      detail:
        state === 'stale'
          ? `Silent for ${formatAge(ageSec)} (allowed ${formatAge(target.staleAfterSec)}).`
          : state === 'degraded'
            ? `Reporting, but its last beat said "${hb.status}"${hb.error_summary ? `: ${hb.error_summary}` : ''}.`
            : `Last success ${formatAge(ageSec)} ago.`,
    });
  }

  const unhealthy = checks.filter((c) => c.unhealthy);
  return {
    checkedAt: new Date(nowMs).toISOString(),
    ok: unhealthy.length === 0,
    checks,
    unhealthy,
    neverReported: checks.filter((c) => c.state === 'unknown').map((c) => c.key),
    signature: unhealthy
      .map((c) => `${c.key}:${c.state}`)
      .sort()
      .join(','),
  };
}

/**
 * The game server can't heartbeat, so its liveness is INFERRED from how fresh
 * server_status is (the emitter mod on the server is the only thing that writes
 * it on a cadence). Note `is_online` is sticky-true in the ingest paths — it is
 * set true on activity and effectively never set false — so freshness is the
 * load-bearing signal here and `is_online: false` is treated as a second,
 * explicit signal rather than the primary one.
 */
function serverStatusCheck(
  target: WatchdogTarget,
  nowMs: number,
  updatedAt: string | null,
  isOnline: boolean | null,
): WatchdogCheck {
  if (!updatedAt) {
    return {
      ...blank(target),
      state: 'unknown',
      detail: 'server_status has never been written — not alerting until it is.',
    };
  }
  const ageSec = ageOf(nowMs, updatedAt);
  const state = computeState(nowMs, toMs(updatedAt), target.staleAfterSec);
  if (state === 'stale') {
    return {
      ...blank(target),
      state,
      unhealthy: true,
      ageSec,
      lastSuccess: updatedAt,
      detail: `server_status has not been updated for ${formatAge(ageSec)} (allowed ${formatAge(
        target.staleAfterSec,
      )}) — the server or its emitter mod is down.`,
    };
  }
  if (isOnline === false) {
    return {
      ...blank(target),
      state: 'degraded',
      unhealthy: true,
      ageSec,
      lastSuccess: updatedAt,
      detail: `server_status is fresh (${formatAge(ageSec)} old) but reports the server OFFLINE.`,
    };
  }
  return {
    ...blank(target),
    state,
    ageSec,
    lastSuccess: updatedAt,
    detail: `server_status updated ${formatAge(ageSec)} ago, server online.`,
  };
}

function blank(target: WatchdogTarget): WatchdogCheck {
  return {
    key: target.key,
    label: target.label,
    source: target.source,
    state: 'unknown',
    unhealthy: false,
    ageSec: null,
    staleAfterSec: target.staleAfterSec,
    lastSuccess: null,
    detail: '',
  };
}

// ── Alert decision (state machine over the ops_alerts row) ───────────────────

export interface AlertState {
  state: 'ok' | 'alerting';
  /** Signature of the unhealthy set at the last alert (null while ok). */
  signature: string | null;
  /** ISO time the CURRENT state began — drives the "down for X" line. */
  since: string | null;
  lastAlertAt: string | null;
  alertCount: number;
}

export type AlertAction = 'none' | 'alert' | 'recover';

export type AlertReason =
  | 'healthy'
  | 'first-unhealthy'
  | 'signature-changed'
  | 're-alert'
  | 'suppressed'
  | 'recovered';

export interface AlertDecision {
  action: AlertAction;
  reason: AlertReason;
  /** Plain explanation, echoed in the JSON response for manual curling. */
  explain: string;
  /** The row to persist after the action succeeds. */
  next: AlertState;
  /** When suppressed: when the next re-alert becomes due. */
  nextAlertEligibleAt: string | null;
}

export const OK_STATE: AlertState = {
  state: 'ok',
  signature: null,
  since: null,
  lastAlertAt: null,
  alertCount: 0,
};

/**
 * Decide whether this run should post to Discord. Three ways to alert:
 *   1. TRANSITION — we were ok (or have no state at all) and something broke.
 *   2. SIGNATURE CHANGE — already alerting, but a different/extra thing broke.
 *   3. RE-ALERT — still broken and the last alert is older than `reAlertAfterSec`
 *      (6h by default), so a long outage nags rather than fading into silence.
 * Anything else while unhealthy is SUPPRESSED — 96 pings a day must not become
 * 96 messages a day. Going healthy while alerting posts one recovery message.
 */
export function decideAlert(
  evaluation: WatchdogEvaluation,
  prior: AlertState | null,
  nowMs: number,
  reAlertAfterSec: number = RE_ALERT_AFTER_SEC,
): AlertDecision {
  const nowIso = new Date(nowMs).toISOString();
  const wasAlerting = prior?.state === 'alerting';

  // ── Healthy now ──────────────────────────────────────────────────────────
  if (evaluation.ok) {
    if (wasAlerting) {
      return {
        action: 'recover',
        reason: 'recovered',
        explain: 'Everything is healthy again after an alert — posting the all-clear.',
        next: { state: 'ok', signature: null, since: nowIso, lastAlertAt: nowIso, alertCount: 0 },
        nextAlertEligibleAt: null,
      };
    }
    return {
      action: 'none',
      reason: 'healthy',
      explain: 'All checks healthy; nothing to say.',
      next: {
        state: 'ok',
        signature: null,
        since: prior?.since ?? nowIso,
        lastAlertAt: prior?.lastAlertAt ?? null,
        alertCount: 0,
      },
      nextAlertEligibleAt: null,
    };
  }

  // ── Unhealthy now ────────────────────────────────────────────────────────
  const alerting = (reason: AlertReason, explain: string): AlertDecision => ({
    action: 'alert',
    reason,
    explain,
    next: {
      state: 'alerting',
      signature: evaluation.signature,
      // "since" tracks the whole unhealthy episode, not each re-alert.
      since: wasAlerting && prior?.since ? prior.since : nowIso,
      lastAlertAt: nowIso,
      alertCount: (prior?.alertCount ?? 0) + 1,
    },
    nextAlertEligibleAt: new Date(nowMs + reAlertAfterSec * 1000).toISOString(),
  });

  if (!wasAlerting) {
    return alerting('first-unhealthy', 'First unhealthy run since the last all-clear.');
  }
  if (prior!.signature !== evaluation.signature) {
    return alerting(
      'signature-changed',
      `The failing set changed (was "${prior!.signature ?? 'none'}", now "${evaluation.signature}").`,
    );
  }

  const lastAlertMs = toMs(prior!.lastAlertAt);
  const sinceLastAlertSec = lastAlertMs === null ? null : (nowMs - lastAlertMs) / 1000;
  if (sinceLastAlertSec === null || sinceLastAlertSec >= reAlertAfterSec) {
    return alerting(
      're-alert',
      `Still unhealthy and the last alert was ${formatAge(sinceLastAlertSec)} ago (re-alert every ${formatAge(
        reAlertAfterSec,
      )}).`,
    );
  }

  return {
    action: 'none',
    reason: 'suppressed',
    explain: `Already alerted ${formatAge(sinceLastAlertSec)} ago for the same problem — staying quiet.`,
    next: {
      state: 'alerting',
      signature: prior!.signature,
      since: prior!.since,
      lastAlertAt: prior!.lastAlertAt,
      alertCount: prior!.alertCount,
    },
    nextAlertEligibleAt: new Date(lastAlertMs! + reAlertAfterSec * 1000).toISOString(),
  };
}

// ── Discord message formatting ───────────────────────────────────────────────

/** Discord hard-caps a message at 2000 characters. */
export const DISCORD_MAX_CONTENT = 2000;

export interface MessageOptions {
  /** Deep link a reader can open — the cockpit. */
  dashboardUrl?: string | null;
  /** Optional `<@id>` / `<@&id>` prefix so the alert actually pings someone. */
  mention?: string | null;
}

function clamp(s: string): string {
  return s.length <= DISCORD_MAX_CONTENT ? s : `${s.slice(0, DISCORD_MAX_CONTENT - 1)}…`;
}

function header(mention: string | null | undefined, line: string): string {
  const m = mention && mention.trim().length > 0 ? `${mention.trim()} ` : '';
  return `${m}${line}`;
}

/** ONE concise message naming every unhealthy check and what it means. */
export function formatAlertMessage(
  evaluation: WatchdogEvaluation,
  decision: AlertDecision,
  opts: MessageOptions = {},
): string {
  const n = evaluation.unhealthy.length;
  const repeat = decision.reason === 're-alert' ? ' (still down)' : '';
  const lines: string[] = [
    header(
      opts.mention,
      `🔴 **Eilif watchdog: ${n} ${n === 1 ? 'check' : 'checks'} unhealthy**${repeat}`,
    ),
  ];
  for (const c of evaluation.unhealthy) {
    const target = WATCHDOG_TARGETS.find((t) => t.key === c.key);
    lines.push(`• **${c.label}** — ${c.state}. ${c.detail}${target ? ` ${target.meaning}` : ''}`);
  }
  if (decision.next.since && decision.reason === 're-alert') {
    lines.push(`_Unhealthy since ${decision.next.since}._`);
  }
  const healthy = evaluation.checks.filter((c) => !c.unhealthy && c.state !== 'unknown').length;
  const never = evaluation.neverReported.length;
  lines.push(
    `_${healthy} other ${healthy === 1 ? 'check' : 'checks'} healthy${
      never > 0 ? `, ${never} never reported (${evaluation.neverReported.join(', ')})` : ''
    } · checked ${evaluation.checkedAt}_`,
  );
  if (opts.dashboardUrl) lines.push(opts.dashboardUrl);
  return clamp(lines.join('\n'));
}

/** The all-clear, posted exactly once on the way back to healthy. */
export function formatRecoveryMessage(
  evaluation: WatchdogEvaluation,
  prior: AlertState | null,
  nowMs: number,
  opts: MessageOptions = {},
): string {
  const sinceMs = toMs(prior?.since ?? null);
  const downFor = sinceMs === null ? null : (nowMs - sinceMs) / 1000;
  const what = prior?.signature ? prior.signature.split(',').map((s) => s.split(':')[0]).join(', ') : 'the pipeline';
  const lines = [
    header(opts.mention, '🟢 **Eilif watchdog: all clear**'),
    `${what} recovered${downFor === null ? '' : ` after ${formatAge(downFor)}`}. All ${
      evaluation.checks.filter((c) => c.state !== 'unknown').length
    } reporting checks are healthy.`,
    `_Checked ${evaluation.checkedAt}_`,
  ];
  if (opts.dashboardUrl) lines.push(opts.dashboardUrl);
  return clamp(lines.join('\n'));
}
