// Off-PC watchdog — GET /api/ops/watchdog
//
// The ops cockpit (/admin/ops) is PULL-only and every producer it watches runs
// on Charlie's PC, so "the PC is off" is exactly the case nothing can report. An
// external pinger (.github/workflows/watchdog.yml, every 15 min) hits THIS route
// on Vercel, which reads Supabase directly, decides whether anything is down,
// and pushes a Discord message if so. Nothing in that chain touches the PC.
//
// AUTH: Bearer WATCHDOG_TOKEN, FAIL CLOSED exactly like /api/ops/heartbeat — if
// the env is unset the route serves nobody (503); a wrong token is 401.
//
// SECURITY: reads with the SERVICE ROLE key (bypasses RLS; ops_heartbeats and
// ops_alerts are service-role-only tables). The key is never returned or logged.
// Only sanitized-at-write strings (error summaries) are echoed back.
//
// LOUD-ON-MISCONFIG: if the DB is unreachable, the ops_alerts row can't be read/
// written, or Discord rejects the post, the route answers 5xx. The GitHub job
// fails on any non-2xx and GitHub emails — so a broken watchdog is itself
// alerted on, rather than silently doing nothing (the original failure mode).
//
// Evaluation + alert-decision logic is pure and lives in lib/ops/watchdog.ts
// (unit-tested); this file is only IO.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import { safeEqual } from '@/lib/ops/auth';
import type { HeartbeatRow } from '@/lib/ops/health';
import {
  ALERT_KEY,
  OK_STATE,
  RE_ALERT_AFTER_SEC,
  WATCHDOG_TARGETS,
  decideAlert,
  evaluateWatchdog,
  formatAlertMessage,
  formatRecoveryMessage,
  type AlertState,
} from '@/lib/ops/watchdog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store, no-cache, must-revalidate' };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Extract a Bearer token from the Authorization header. */
function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** POST one message to a channel with the bot token (no discord.js on Vercel). */
async function postToDiscord(content: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.WATCHDOG_CHANNEL_ID;
  if (!token || !channelId) {
    return { ok: false, error: 'discord not configured (DISCORD_TOKEN / WATCHDOG_CHANNEL_ID)' };
  }
  // Only allow pings when a mention was deliberately configured.
  const mention = process.env.WATCHDOG_MENTION?.trim();
  const allowed = mention ? { parse: ['users', 'roles'] } : { parse: [] as string[] };
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bot ${token}`,
          'content-type': 'application/json',
          'user-agent': 'EilifWatchdog (valheim-dashboard, 1.0)',
        },
        body: JSON.stringify({ content, allowed_mentions: allowed }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      // Body may carry a Discord error code; it never contains our token.
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `discord HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'discord post failed' };
  }
}

interface AlertRow {
  key: string;
  state: string | null;
  signature: string | null;
  since: string | null;
  last_alert_at: string | null;
  alert_count: number | null;
}

function toAlertState(row: AlertRow | null): AlertState | null {
  if (!row) return null;
  return {
    state: row.state === 'alerting' ? 'alerting' : 'ok',
    signature: row.signature,
    since: row.since,
    lastAlertAt: row.last_alert_at,
    alertCount: row.alert_count ?? 0,
  };
}

export async function GET(request: Request) {
  // ---- 0. Rate limit (per-IP, best-effort) --------------------------------
  if (!rateLimit(ipFromRequest(request))) {
    return json({ error: 'rate limited' }, 429);
  }

  // ---- 1. Auth (fail closed) ----------------------------------------------
  const expected = process.env.WATCHDOG_TOKEN;
  if (!expected) {
    return json({ error: 'watchdog not configured' }, 503);
  }
  const provided = bearer(request);
  if (!provided || !safeEqual(provided, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }

  // `?dry=1` evaluates and reports without posting to Discord or writing state —
  // for manual curling while tuning thresholds.
  const dry = new URL(request.url).searchParams.get('dry') === '1';

  const db = serviceClient();
  if (!db) {
    return json({ error: 'supabase not configured' }, 500);
  }

  const nowMs = Date.now();

  // ---- 2. Read the two liveness sources -----------------------------------
  let serverStatusUpdatedAt: string | null = null;
  let serverIsOnline: boolean | null = null;
  try {
    const { data, error } = await db
      .from('server_status')
      .select('updated_at, is_online')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    serverStatusUpdatedAt = (data?.updated_at as string | null) ?? null;
    serverIsOnline = (data?.is_online as boolean | null) ?? null;
  } catch (err) {
    console.error('[ops/watchdog] server_status read failed:', err instanceof Error ? err.message : 'error');
    return json({ error: 'database unreachable' }, 500);
  }

  const heartbeats: Record<string, HeartbeatRow> = {};
  try {
    const { data, error } = await db
      .from('ops_heartbeats')
      .select('component, instance, version, status, last_success, last_attempt, error_summary, metrics, updated_at')
      .in('component', WATCHDOG_TARGETS.map((t) => t.key));
    if (error) throw error;
    for (const r of (data ?? []) as HeartbeatRow[]) {
      heartbeats[r.component] = { ...r, metrics: (r.metrics ?? {}) as Record<string, unknown> };
    }
  } catch (err) {
    console.error('[ops/watchdog] ops_heartbeats read failed:', err instanceof Error ? err.message : 'error');
    return json({ error: 'database unreachable' }, 500);
  }

  // ---- 3. Evaluate (pure) --------------------------------------------------
  const evaluation = evaluateWatchdog({ nowMs, heartbeats, serverStatusUpdatedAt, serverIsOnline });

  const summary = {
    ok: evaluation.ok,
    checkedAt: evaluation.checkedAt,
    unhealthyCount: evaluation.unhealthy.length,
    neverReported: evaluation.neverReported,
    signature: evaluation.signature,
    reAlertAfterSec: RE_ALERT_AFTER_SEC,
    checks: evaluation.checks,
  };

  if (dry) {
    return json({ ...summary, dryRun: true, alert: { action: 'none', reason: 'dry-run' } });
  }

  // ---- 4. Read prior alert state (dedupe memory) --------------------------
  let prior: AlertState | null;
  try {
    const { data, error } = await db
      .from('ops_alerts')
      .select('key, state, signature, since, last_alert_at, alert_count')
      .eq('key', ALERT_KEY)
      .maybeSingle();
    if (error) throw error;
    prior = toAlertState((data as AlertRow | null) ?? null);
  } catch (err) {
    // Almost always the unapplied migration. Answer 5xx so the GitHub job fails
    // loudly rather than us re-alerting Discord every 15 minutes with no memory.
    console.error('[ops/watchdog] ops_alerts read failed:', err instanceof Error ? err.message : 'error');
    return json(
      {
        ...summary,
        error: 'alert state unavailable — is db/2026-08-21_ops_alerts.sql applied?',
      },
      500,
    );
  }

  // ---- 5. Decide, post, persist -------------------------------------------
  const decision = decideAlert(evaluation, prior, nowMs);

  let notified: { attempted: boolean; ok: boolean; error?: string } = { attempted: false, ok: false };
  if (decision.action !== 'none') {
    const content =
      decision.action === 'alert'
        ? formatAlertMessage(evaluation, decision, {
            dashboardUrl: dashboardOpsUrl(),
            mention: process.env.WATCHDOG_MENTION ?? null,
          })
        : formatRecoveryMessage(evaluation, prior, nowMs, {
            dashboardUrl: dashboardOpsUrl(),
            mention: process.env.WATCHDOG_MENTION ?? null,
          });
    const res = await postToDiscord(content);
    notified = { attempted: true, ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    if (!res.ok) {
      // Do NOT persist the new state — the next run must retry the same alert.
      console.error('[ops/watchdog] discord post failed:', res.error);
      return json(
        { ...summary, alert: { action: decision.action, reason: decision.reason }, notified },
        502,
      );
    }
  }

  try {
    const { error } = await db.from('ops_alerts').upsert(
      {
        key: ALERT_KEY,
        state: decision.next.state,
        signature: decision.next.signature,
        since: decision.next.since,
        last_alert_at: decision.next.lastAlertAt,
        alert_count: decision.next.alertCount,
        updated_at: new Date(nowMs).toISOString(),
      },
      { onConflict: 'key' },
    );
    if (error) throw error;
  } catch (err) {
    console.error('[ops/watchdog] ops_alerts write failed:', err instanceof Error ? err.message : 'error');
    return json({ ...summary, error: 'alert state write failed', notified }, 500);
  }

  return json({
    ...summary,
    alert: {
      action: decision.action,
      reason: decision.reason,
      explain: decision.explain,
      nextAlertEligibleAt: decision.nextAlertEligibleAt,
      priorState: prior ?? OK_STATE,
      state: decision.next,
    },
    notified,
  });
}

/**
 * Deep link for the Discord message. Same canonical origin as `metadataBase` in
 * app/layout.tsx; overridable for a self-hosted/preview origin.
 */
function dashboardOpsUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://eilif-dashboard.vercel.app';
  return `${base.replace(/\/$/, '')}/admin/ops`;
}
