// Liveness for the two IN-GAME halves, recorded by the routes they poll.
//
// THE GAP THIS FILLS. The cockpit models the four host-side processes (they run
// on our Linux box and POST /api/ops/heartbeat themselves) and infers the
// third-party Emitter from server_status freshness. Nothing at all watched the
// two plugins that run INSIDE Valheim on the GTX host:
//
//   • EilifBoards — polls GET /api/boards to paint the leaderboard signs. On a
//     401 after a token rotation it logs "feed poll failed… Backing off" ONCE to
//     LogOutput.log and then keeps the last text on the signs forever. Nothing in
//     the database changes, so the cockpit stayed green while the signs quietly
//     froze.
//   • EilifCompanion's voice queue — polls GET /api/voice for lines to speak. A
//     Companion that fails to load after a game update (exactly what a 1.0
//     recompile risks) stops voice, pins and positions with no DB-visible symptom.
//
// Neither plugin can POST a heartbeat of its own (no token to spare, and the
// Boards plugin has no HTTP write path at all). But BOTH authenticate to a route
// we control on a known cadence — so an authed poll IS the liveness signal. The
// route records it, the cockpit reads it like any other heartbeat.
//
// FAIL-SOFT AND CHEAP, in that order:
//   • Only after a SUCCESSFUL auth check, so an unauthenticated prober can never
//     make a component look alive (or write rows at all).
//   • Throttled to once per THROTTLE_MS per component per serverless instance —
//     /api/voice is polled every few seconds, and the cockpit only needs to know
//     the poll is happening, not how often. Module-level state, so it is
//     per-instance and best-effort exactly like lib/rate-limit.ts; the worst case
//     is a few extra writes a minute across instances.
//   • Never throws and never blocks the response's correctness: a failed write is
//     logged and swallowed. Liveness bookkeeping must not break the thing it is
//     watching.

import 'server-only';
import { createClient } from '@supabase/supabase-js';

/** One write per component per minute per instance. */
const THROTTLE_MS = 60_000;

const lastWriteAt = new Map<string, number>();

/** Components recorded from a route poll rather than a POSTed heartbeat. */
export type RouteHeartbeatComponent = 'boards-plugin' | 'companion-voice';

/**
 * Record "an authenticated poll just succeeded" for `component`.
 *
 * Call AFTER the token check passes. Returns true when a row was written, false
 * when the call was throttled, unconfigured, or the write failed.
 */
export async function recordRouteHeartbeat(
  component: RouteHeartbeatComponent,
  metrics: Record<string, unknown> = {},
): Promise<boolean> {
  const now = Date.now();
  const last = lastWriteAt.get(component);
  if (last !== undefined && now - last < THROTTLE_MS) return false;
  // Claim the slot BEFORE awaiting so two concurrent polls don't both write.
  lastWriteAt.set(component, now);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false; // unconfigured → the cockpit shows 'unknown', which is honest

  try {
    const db = createClient(url, key, { auth: { persistSession: false } });
    const nowIso = new Date(now).toISOString();
    const { error } = await db.from('ops_heartbeats').upsert(
      {
        component,
        status: 'ok',
        last_success: nowIso,
        last_attempt: nowIso,
        error_summary: null,
        metrics: { ...metrics, lastPoll: nowIso },
        updated_at: nowIso,
      },
      { onConflict: 'component' },
    );
    if (error) throw error;
    return true;
  } catch (err) {
    // Let the next poll retry rather than holding the throttle slot on a failure.
    lastWriteAt.delete(component);
    console.error(`[ops] ${component} heartbeat write failed:`, err instanceof Error ? err.message : 'error');
    return false;
  }
}
