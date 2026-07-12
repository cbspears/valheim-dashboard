// Heartbeat ingest for the ops cockpit.
//
// The three host-side producers (discord-bot, log-poller, map-snapshot) POST here
// on a cadence so the cockpit knows they're alive. Auth is a shared Bearer token
// (OPS_HEARTBEAT_TOKEN). FAIL CLOSED: if that env is unset the endpoint never
// accepts a heartbeat (503); a missing/wrong token is 401.
//
// SECURITY: writes with the SERVICE ROLE key (bypasses RLS). The key is never
// returned or logged. Every stored string is run through the redactor first, so a
// producer that accidentally puts a token in an error message or a metric can't
// persist it into ops_heartbeats (which the cockpit renders).

import { createClient } from '@supabase/supabase-js';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import { safeEqual } from '@/lib/ops/auth';
import { validateHeartbeat } from '@/lib/ops/heartbeat';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

/** Extract a Bearer token from the Authorization header. */
function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function POST(request: Request) {
  // ---- 0. Rate limit (per-IP, best-effort) --------------------------------
  if (!rateLimit(ipFromRequest(request))) {
    return Response.json({ error: 'rate limited' }, { status: 429 });
  }

  // ---- 1. Auth (fail closed) ----------------------------------------------
  const expected = process.env.OPS_HEARTBEAT_TOKEN;
  if (!expected) {
    // Unconfigured → never accept a heartbeat.
    return Response.json({ error: 'heartbeat not configured' }, { status: 503 });
  }
  const provided = bearer(request);
  if (!provided || !safeEqual(provided, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ---- 2. Parse + validate + redact ---------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = validateHeartbeat(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  const hb = result.value;

  // ---- 3. Upsert on component (primary key) -------------------------------
  try {
    const db = serviceClient();
    const nowIso = new Date().toISOString();
    const row: Record<string, unknown> = {
      component: hb.component,
      instance: hb.instance,
      version: hb.version,
      status: hb.status,
      last_attempt: nowIso,
      error_summary: hb.errorSummary,
      metrics: hb.metrics,
      updated_at: nowIso,
    };
    if (hb.isOk) row.last_success = nowIso;

    const { error } = await db.from('ops_heartbeats').upsert(row, { onConflict: 'component' });
    if (error) throw error;

    return Response.json({ ok: true, component: hb.component, status: hb.status }, { status: 200 });
  } catch (err) {
    // Caller-safe message only — never leak the key or the raw error.
    console.error('[ops/heartbeat] upsert failed:', err instanceof Error ? err.message : 'error');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
