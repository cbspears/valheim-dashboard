// Server-liveness detection.
//
// The failure this exists for: when the Valheim server process stops, the log
// simply stops growing. The poller sits at EOF forever, keeps reporting the
// last known roster, and the dashboard keeps saying ONLINE. That happened
// twice unnoticed (2026-07-15→07-28 and 2026-08-15→08-20).
//
// The live server writes a "Connections N ZDOS:" heartbeat line roughly every
// ~10 minutes even with zero players, so a log that has not grown in
// STALE_LOG_THRESHOLD_MS (default 30m) means the game server is down. The SFTP
// transport is observed separately: a failed connect is a *different* failure
// (network/host/credentials) and must never be read as "game server down", so
// a failed observation freezes the clock instead of advancing it.
//
// Everything here is pure so the state machine can be tested without a network:
// feed it observations, get back the next state plus at most one action.

export const DEFAULT_STALE_LOG_THRESHOLD_MS = 30 * 60 * 1000; // 30m
export const DEFAULT_DOWN_REALERT_MS = 6 * 60 * 60 * 1000; // 6h

/** Coerce a finite number, else the fallback. */
function num(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Normalize a (possibly absent or hand-edited) persisted liveness blob. */
export function normalizeLiveness(s) {
  const o = s && typeof s === 'object' ? s : {};
  const fin = (v) => (Number.isFinite(v) ? v : null);
  return {
    lastSize: fin(o.lastSize),
    lastMtimeMs: fin(o.lastMtimeMs),
    lastGrowthAt: fin(o.lastGrowthAt),
    serverDown: o.serverDown === true,
    downSince: fin(o.downSince),
    lastAlertAt: fin(o.lastAlertAt),
  };
}

/** Age of the log in whole seconds, or null before the first observation. */
export function logAgeSec(state, now) {
  const s = normalizeLiveness(state);
  if (s.lastGrowthAt === null) return null;
  return Math.max(0, Math.round((now - s.lastGrowthAt) / 1000));
}

/**
 * Advance the liveness state machine by one observation.
 *
 * obs: { now, ok, size, mtimeMs }
 *   ok=false  → the log could not be observed at all (SFTP connect/stat failed).
 *               Not evidence about the game server: state is returned untouched.
 *   size      → current byte length of the remote log. A change in EITHER
 *               direction counts as growth: a smaller size means the log was
 *               truncated, which is what a server *restart* looks like, i.e.
 *               very much alive.
 *   mtimeMs   → optional remote mtime; used to seed the clock on the first
 *               observation (so a cold start doesn't pretend the log just grew)
 *               and as a secondary growth signal.
 *
 * cfg: { staleLogThresholdMs, downReAlertMs }
 *
 * Returns { state, action, logAgeSec } where action is null or one of:
 *   { kind: 'down'|'still-down'|'recovered', downSince, logAgeSec, downForSec }
 * Exactly one 'down' fires per transition; while down, 'still-down' repeats at
 * most every downReAlertMs.
 */
export function evaluateLiveness(prev, obs, cfg = {}) {
  const staleMs = num(cfg.staleLogThresholdMs, DEFAULT_STALE_LOG_THRESHOLD_MS);
  const reAlertMs = num(cfg.downReAlertMs, DEFAULT_DOWN_REALERT_MS);
  const state = normalizeLiveness(prev);
  const now = Number.isFinite(obs?.now) ? obs.now : Date.now();

  // Unobservable (transport failure) → hold everything, report nothing.
  if (obs?.ok === false) return { state, action: null, logAgeSec: logAgeSec(state, now) };

  const size = Number.isFinite(obs?.size) ? obs.size : null;
  if (size === null) return { state, action: null, logAgeSec: logAgeSec(state, now) };
  const mtimeMs = Number.isFinite(obs?.mtimeMs) ? obs.mtimeMs : null;

  const first = state.lastSize === null;
  const grew =
    !first &&
    (size !== state.lastSize ||
      (mtimeMs !== null && state.lastMtimeMs !== null && mtimeMs > state.lastMtimeMs));

  if (first) {
    // Cold start (or a state.json predating this feature). Take the most recent
    // credible evidence of the log having been written — a persisted
    // lastGrowthAt from before the restart, or the remote mtime — so a restart
    // never resets the staleness clock. Clamped to `now` against clock skew.
    const candidate = Math.max(state.lastGrowthAt ?? 0, mtimeMs ?? 0);
    state.lastGrowthAt = candidate > 0 ? Math.min(candidate, now) : now;
  } else if (grew) {
    state.lastGrowthAt = now;
  }
  state.lastSize = size;
  state.lastMtimeMs = mtimeMs;

  const ageMs = Math.max(0, now - state.lastGrowthAt);
  const age = Math.round(ageMs / 1000);
  let action = null;

  if (ageMs >= staleMs) {
    if (!state.serverDown) {
      state.serverDown = true;
      state.downSince = state.lastGrowthAt;
      state.lastAlertAt = now;
      action = { kind: 'down', downSince: state.downSince, logAgeSec: age, downForSec: age };
    } else if (state.lastAlertAt === null || now - state.lastAlertAt >= reAlertMs) {
      state.lastAlertAt = now;
      action = { kind: 'still-down', downSince: state.downSince, logAgeSec: age, downForSec: age };
    }
  } else if (state.serverDown) {
    const downSince = state.downSince;
    action = {
      kind: 'recovered',
      downSince,
      logAgeSec: age,
      downForSec: downSince === null ? null : Math.max(0, Math.round((now - downSince) / 1000)),
    };
    state.serverDown = false;
    state.downSince = null;
    state.lastAlertAt = null;
  }

  return { state, action, logAgeSec: age };
}

/** "2026-08-15 19:03 UTC (14:03 CT)" — both zones, because ops reads both. */
export function formatWhen(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const d = new Date(ms);
  const utc = d.toISOString().replace('T', ' ').slice(0, 16);
  let ct;
  try {
    ct = d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    ct = null;
  }
  return ct ? `${utc} UTC (${ct} CT)` : `${utc} UTC`;
}

/** "1h 12m" / "3d 4h" / "45s" — coarse, human, never more than two units. */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'an unknown time';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}d ${h % 24}h` : `${d}d`;
}
