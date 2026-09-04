// Ops-cockpit heartbeat: reports this bot's liveness + its gated sub-loops'
// health to the dashboard's POST /api/ops/heartbeat. Best-effort only — a
// heartbeat failure must NEVER crash or block the bot itself (every path here
// swallows its own errors).

const loops = new Map();

// undici has no default timeout; a stalled heartbeat socket must not pile up
// behind the 60s heartbeat interval.
const FETCH_TIMEOUT_MS = 20000;

/**
 * Record one sub-loop tick result (called by the `safe()` wrapper in index.js).
 *
 * Field names matter: the cockpit's sub-loop chips (lib/ops/health.ts,
 * interface LoopMetric) read `lastSuccessAt` / `lastRunAt` / `lastError`, so a
 * failing loop only shows red if `lastError` is set and `lastSuccessAt` stops
 * moving. `ok` / `error` are kept for older readers.
 */
export function recordLoopResult(label, ok, errorMessage) {
  const now = new Date().toISOString();
  const prev = loops.get(label) || {};
  const error = ok ? null : sanitize(errorMessage);
  loops.set(label, {
    lastRunAt: now,
    lastSuccessAt: ok ? now : prev.lastSuccessAt,
    ok,
    error,
    lastError: error,
  });
}

/** Snapshot of every recorded loop's last result, keyed by label. */
export function loopsSnapshot() {
  return Object.fromEntries(loops);
}

// Strip anything that looks like a secret + long opaque tokens, collapse
// whitespace, and truncate. Mirrors the spirit of lib/ops/redact.ts (which
// does the authoritative redaction server-side) as a defense-in-depth layer
// before anything ever leaves this process.
function sanitize(input, max = 200) {
  if (!input) return null;
  let s = String(input);
  s = s.replace(/(token|key|secret|bearer|password)\s*[:=]?\s*\S+/gi, '$1=[redacted]');
  s = s.replace(/[A-Za-z0-9+/_-]{32,}/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Resolve the dashboard's heartbeat endpoint from OPS_HEARTBEAT_URL or WEBHOOK_URL. */
export function resolveHeartbeatUrl() {
  if (process.env.OPS_HEARTBEAT_URL) return process.env.OPS_HEARTBEAT_URL;
  if (process.env.WEBHOOK_URL) {
    return `${process.env.WEBHOOK_URL.replace(/\/api\/webhook\/?$/, '')}/api/ops/heartbeat`;
  }
  return null;
}

/**
 * Build a heartbeat sender for `component`. Returns a no-op (logged once) if
 * OPS_HEARTBEAT_TOKEN is unset or no dashboard URL can be resolved.
 */
export function createHeartbeatSender(component, logger = console) {
  const token = process.env.OPS_HEARTBEAT_TOKEN;
  const url = resolveHeartbeatUrl();
  if (!token) {
    logger.warn?.(`[heartbeat] OPS_HEARTBEAT_TOKEN unset — ${component} heartbeats disabled`);
    return async () => {};
  }
  if (!url) {
    logger.warn?.(`[heartbeat] no dashboard URL (set OPS_HEARTBEAT_URL or WEBHOOK_URL) — ${component} heartbeats disabled`);
    return async () => {};
  }
  return async ({ status = 'ok', error, metrics, version, instance } = {}) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ component, instance, version, status, error: sanitize(error), metrics }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn?.(`[heartbeat] ${component} POST HTTP ${res.status}`);
    } catch (e) {
      logger.warn?.(`[heartbeat] ${component} POST failed: ${e.message}`);
    }
  };
}
