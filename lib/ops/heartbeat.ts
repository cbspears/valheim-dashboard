// Pure validation + normalization for POST /api/ops/heartbeat.
//
// Kept separate from the route handler (which owns auth, rate-limit, and the DB
// upsert) so the payload rules — the component allowlist, status coercion, and
// the ok/last_success derivation — can be unit-tested without a DB or Next.

import { sanitize, sanitizeMetrics } from './redact';

/** Only these components may heartbeat. Anything else is a 400. */
export const HEARTBEAT_ALLOWLIST = ['discord-bot', 'log-poller', 'map-snapshot', 'stats-parser'] as const;
export type HeartbeatComponent = (typeof HEARTBEAT_ALLOWLIST)[number];

export type HeartbeatStatus = 'ok' | 'degraded' | 'error';
const VALID_STATUS: HeartbeatStatus[] = ['ok', 'degraded', 'error'];

export interface NormalizedHeartbeat {
  component: HeartbeatComponent;
  instance: string | null;
  version: string | null;
  status: HeartbeatStatus;
  /** True when this beat counts as a success (bumps last_success). */
  isOk: boolean;
  /** Sanitized, truncated error summary (empty string → null). */
  errorSummary: string | null;
  /** Deep-sanitized metrics (secret-free). */
  metrics: Record<string, unknown>;
}

export type ValidateResult =
  | { ok: true; value: NormalizedHeartbeat }
  | { ok: false; status: number; error: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Validate + normalize a heartbeat body. Returns a 400 result for a missing/
 * non-allowlisted component or an out-of-range status; otherwise a normalized,
 * redacted value ready to upsert.
 *
 * Body: { component, instance?, version?, status?: ok|degraded|error,
 *         ok?: boolean, error?: string, metrics?: object }
 */
export function validateHeartbeat(body: unknown): ValidateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const component = str(b.component);
  if (!component) {
    return { ok: false, status: 400, error: "'component' is required" };
  }
  if (!HEARTBEAT_ALLOWLIST.includes(component as HeartbeatComponent)) {
    return { ok: false, status: 400, error: `unknown component '${sanitize(component, 40)}'` };
  }

  // Status: default 'ok'. If a status is provided it must be valid.
  let status: HeartbeatStatus = 'ok';
  if (b.status !== undefined) {
    const s = str(b.status);
    if (!s || !VALID_STATUS.includes(s as HeartbeatStatus)) {
      return { ok: false, status: 400, error: "'status' must be ok|degraded|error" };
    }
    status = s as HeartbeatStatus;
  }

  // The `ok` boolean, when present, overrides: ok:false forces 'error'-grade,
  // ok:true forces a success. Derive isOk per the shared contract:
  // success when status==='ok' OR ok===true.
  const okFlag = typeof b.ok === 'boolean' ? b.ok : undefined;
  if (okFlag === false && b.status === undefined) status = 'error';
  const isOk = status === 'ok' || okFlag === true;

  const errorSummary = sanitize(b.error, 200) || null;
  const metrics = sanitizeMetrics(b.metrics);

  return {
    ok: true,
    value: {
      component: component as HeartbeatComponent,
      instance: str(b.instance),
      version: str(b.version),
      status,
      isOk,
      errorSummary,
      metrics,
    },
  };
}
