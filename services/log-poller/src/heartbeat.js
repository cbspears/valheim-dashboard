// Ops-cockpit heartbeat: reports this poller's liveness to the dashboard's
// POST /api/ops/heartbeat. Best-effort only — a heartbeat failure must NEVER
// crash or block the poller itself (every path here swallows its own errors).

import { readFileSync } from 'node:fs';

// THE VERSION EVERY HEARTBEAT CARRIES (2026-09-06, T-3 audit ops-4). The sender
// has always accepted a `version` and no call site ever passed one, so the
// cockpit's Version column read "unknown" for this row while the glossary
// explained it as the way to tell which build is running. Read once, defaulted
// in the sender, so no caller has to remember. Best effort: a failure yields
// null rather than breaking the heartbeat.
const PKG_VERSION = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const v = JSON.parse(raw)?.version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
})();

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
  // `version` defaults to this package's own version; an explicit one still wins.
  return async ({ status = 'ok', error, metrics, version = PKG_VERSION, instance } = {}) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ component, instance, version, status, error: sanitize(error), metrics }),
      });
      if (!res.ok) logger.warn?.(`[heartbeat] ${component} POST HTTP ${res.status}`);
    } catch (e) {
      logger.warn?.(`[heartbeat] ${component} POST failed: ${e.message}`);
    }
  };
}
