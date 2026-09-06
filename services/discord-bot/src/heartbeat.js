// Ops-cockpit heartbeat: reports this bot's liveness + its gated sub-loops'
// health to the dashboard's POST /api/ops/heartbeat. Best-effort only — a
// heartbeat failure must NEVER crash or block the bot itself (every path here
// swallows its own errors).

import { readFile } from 'node:fs/promises';

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

// ── metrics.schedule: the bot answering for its own clocks ───────────────────
//
// WHY THIS EXISTS. The ops cockpit's "Coming up" tab (/admin/ops/horizon) has to
// say when the next recap fires, how much online-time the ambient voice has
// banked, and where the relay's cursor sits. All three live in this process:
// the cron hour is an env var on the host, the accumulator and the cursor are in
// state.json. Vercel can see none of it. Before this block the cockpit could
// only GUESS from the constants in the repo, and a guess that silently goes
// stale is the sort of number an operator stops trusting on the one night it
// matters.
//
// WHY HERE AND NOT index.js. createHeartbeatSender() already wraps every
// outgoing heartbeat, so merging a computed block in at this seam reaches the
// cockpit without touching where the metrics object is assembled.
//
// THREE RULES THIS CODE OBEYS, AND WHY EACH ONE IS LOAD-BEARING:
//
//   1. READ ONLY AND BEST EFFORT. state.json is read with the same expression
//      state.js uses, inside a try, and any failure yields `schedule: null`
//      rather than a heartbeat that does not send. A heartbeat that can break
//      the bot is strictly worse than a cockpit panel that says "the bot has not
//      reported this yet". Nothing here writes anything, ever.
//   2. NO SECRETS. Only cadence numbers, hours, zone names, channel names and
//      booleans, and every string still goes through sanitize().
//   3. THE COCKPIT MUST RENDER WITHOUT IT. The bot is deployed by hand on the
//      host, so this block does not exist until somebody restarts
//      eilif-discord-bot. Every panel that reads it is written to say so.

/** state.json, resolved exactly as state.js resolves it. */
const STATE_PATH = new URL('../state.json', import.meta.url);

/** parseInt an env var with a fallback, never NaN. Mirrors index.js's own reads. */
function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** A finite number or null. Anything a corrupt state.json could hold becomes null. */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A non-empty sanitized string, or null. */
function strOrNull(v) {
  if (typeof v !== 'string' || v.length === 0) return null;
  return sanitize(v, 64);
}

/**
 * The UTC offset of `tz` at `atMs`, in ms. Intl gives the wall-clock fields of
 * an instant in a zone but no offset, so read those fields back as if they were
 * UTC and subtract: the difference IS the offset, and it is DST-correct because
 * Intl applied the right rule. Null for a zone Intl rejects (a typo in TZ).
 */
function zoneOffsetMs(atMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(atMs));
    const f = {};
    for (const p of parts) if (p.type !== 'literal') f[p.type] = Number(p.value);
    const hour = f.hour === 24 ? 0 : f.hour;
    return Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second) - atMs;
  } catch {
    return null;
  }
}

/**
 * The next instant at which the wall clock in `tz` reads `hour`:00, as an ISO
 * string, or null when the zone is unusable. This is what `cron.schedule('0 H
 * * * *', { timezone: tz })` in recap.js actually fires on.
 *
 * The bot computes it rather than leaving it to the cockpit because the bot is
 * the only one that knows its own TZ and RECAP_EVENING_HOUR. The cockpit still
 * carries the same maths as a fallback for the window before the first restart,
 * and prefers this value when it is present.
 */
function nextDailyIso(nowMs, hour, tz) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const off0 = zoneOffsetMs(nowMs, tz);
  if (off0 === null) return null;
  const local = new Date(nowMs + off0);
  for (let add = 0; add <= 2; add++) {
    const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + add * 86400000;
    const day = new Date(base);
    const naive = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0, 0);
    // Two passes: the offset depends on the instant we are solving for.
    let guess = naive;
    for (let i = 0; i < 2; i++) {
      const off = zoneOffsetMs(guess, tz);
      if (off === null) return null;
      const next = naive - off;
      if (next === guess) break;
      guess = next;
    }
    if (guess > nowMs) return new Date(guess).toISOString();
  }
  return null;
}

/**
 * Everything the cockpit needs to answer "what happens next", read fresh on
 * every heartbeat. Never throws: returns null instead.
 *
 * The numbers here are the bot's ACTUAL configuration, not the repo's defaults,
 * which is the whole point: RECAP_EVENING_HOUR, VOICE_MIN_GAP_MS and the loop
 * gates all live in the host's .env and nothing else reports them anywhere.
 */
export async function scheduleBlock(nowMs = Date.now(), statePath = STATE_PATH) {
  try {
    // state.json holds the voice accumulator and the relay cursor. A missing or
    // corrupt file is normal on a fresh box and must degrade to nulls, not to a
    // thrown heartbeat: `asState`-style guard, same reasoning as state.js.
    let state = {};
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
    } catch {
      /* missing, unreadable or torn: every field below falls back to null */
    }
    const voice = state.voice && typeof state.voice === 'object' ? state.voice : {};
    const relay = state.relay && typeof state.relay === 'object' ? state.relay : {};

    const recapHour = (() => {
      const h = intEnv('RECAP_EVENING_HOUR', 23);
      return h >= 0 && h <= 23 ? h : 23;
    })();
    const recapTz = process.env.TZ || 'America/Chicago';
    const chronicleHour = (() => {
      const h = intEnv('CHRONICLE_HOUR', 20);
      return h >= 0 && h <= 23 ? h : 20;
    })();
    const chronicleOn = process.env.WEEKLY_CHRONICLE === '1';

    return {
      // When this block was computed, so the cockpit can age it independently of
      // the heartbeat row's own updated_at.
      reportedAt: new Date(nowMs).toISOString(),

      // ── the nightly recap (recap.js schedule()) ──
      recapHour,
      recapTz: strOrNull(recapTz),
      recapChannel: strOrNull(process.env.RECAP_CHANNEL || 'valheim'),
      // The launch gate: recaps stay silent until this date. A pilot value pulled
      // forward of launch is exactly what step 20b of docs/LAUNCH-DAY.md reverts.
      recapsStart: strOrNull(process.env.RECAPS_START),
      nextRecapAt: nextDailyIso(nowMs, recapHour, recapTz),

      // ── the weekly chronicle (Sunday, off unless WEEKLY_CHRONICLE=1) ──
      chronicleEnabled: chronicleOn,
      chronicleHour,
      chronicleWeekday: 0,
      chronicleChannel: strOrNull(process.env.CHRONICLE_CHANNEL === 'server' ? 'server' : 'valheim'),

      // ── the Voice of the Hall (voice.js) ──
      // CADENCE_MINUTES and DAWN_EVERY_DAYS are constants in voice.js, not env
      // vars, so they are restated here rather than read. They move only with a
      // code change, and this block moves with the same deploy.
      voiceCadenceMinutes: 120,
      voiceMinGapMs: intEnv('VOICE_MIN_GAP_MS', 1800000),
      dawnEveryDays: 3,
      // The live accumulators out of state.json. `ambientOnlineMinutes` is
      // someone-online time banked toward the next ambient line; `lastDawnDay` is
      // the world day the last dawn line was spoken on. Null when never set,
      // which the cockpit must render as "not reported" and never as zero.
      ambientOnlineMinutes: numOrNull(voice.onlineMinutes),
      ambientCount: numOrNull(voice.ambientCount),
      lastDawnDay: numOrNull(voice.lastDawnDay),

      // ── the #server relay's cursor (relay.js) ──
      // lastInsertedAt is the high-water mark of events.inserted_at the relay has
      // reached: the cockpit counts rows written after it to get the backlog.
      relayCursor: strOrNull(relay.lastInsertedAt) ?? strOrNull(relay.lastEventAt),
      relayLastInsertedAt: strOrNull(relay.lastInsertedAt),
      relayLastEventAt: strOrNull(relay.lastEventAt),
      relayInsertionFloor: strOrNull(relay.insertionFloor),
      relayHeldIds: Array.isArray(relay.lastInsertedIds) ? relay.lastInsertedIds.length : null,
      relayBatch: 50,

      // ── which loops are on, and how often each one ticks ──
      // `enabled` is what the env asks for. What is actually RUNNING is reported
      // separately in metrics.subLoops, which is the one to trust when they
      // disagree (a boss-polls seed can fail and leave the flag on).
      loopsEnabled: {
        relay: true,
        bosses: true,
        voice: process.env.VOICE_ENGINE === '1',
        eventsSync: process.env.EVENTS_SYNC === '1',
        galleryIngest: process.env.GALLERY_INGEST === '1',
        oathIngest: process.env.OATH_INGEST === '1',
        identityLink: process.env.IDENTITY_LINK !== '0',
        tellings: process.env.TELLINGS !== '0',
        titles: process.env.TITLES_ANNOUNCE !== '0',
        titlesDryRun: process.env.TITLES_DRY === '1',
        milestones: process.env.MILESTONES_ANNOUNCE !== '0',
        weeklyChronicle: chronicleOn,
        bossPolls: process.env.BOSS_POLLS === '1',
      },
      intervalsMs: {
        relay: intEnv('POLL_INTERVAL_MS', 15000),
        bosses: 30000,
        events: intEnv('EVENTS_INTERVAL_MS', 600000),
        identityConfirm: 30000,
        voice: 60000,
        voiceExpire: 300000,
        titles: intEnv('TITLES_INTERVAL_MS', 600000),
        milestones: intEnv('MILESTONES_INTERVAL_MS', 120000),
        bossPolls: intEnv('BOSS_POLLS_INTERVAL_MS', 60000),
        heartbeat: 60000,
      },

      // ── announce channels, for the launch-day revert check ──
      // Non-secret names only ('server' or 'valheim'), never ids.
      channels: {
        recap: strOrNull(process.env.RECAP_CHANNEL || 'valheim'),
        milestone: strOrNull(process.env.MILESTONE_CHANNEL || 'valheim'),
        oath: strOrNull(process.env.OATH_CHANNEL === 'server' ? 'server' : 'valheim'),
        title: strOrNull(process.env.TITLE_CHANNEL === 'valheim' ? 'valheim' : 'server'),
        bossPoll: strOrNull(process.env.BOSS_POLL_CHANNEL === 'server' ? 'server' : 'valheim'),
      },
    };
  } catch {
    // A schedule the cockpit cannot read is a dark panel. A heartbeat that
    // throws is a bot the cockpit thinks is dead. Never the second one.
    return null;
  }
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
      // The bot, and only the bot, carries its own schedule up to the cockpit.
      // Inside the try and behind a never-throwing helper, so the worst case is
      // a heartbeat with `schedule: null` rather than no heartbeat at all.
      const payloadMetrics =
        component === 'discord-bot'
          ? { ...(metrics || {}), schedule: await scheduleBlock() }
          : metrics;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ component, instance, version, status, error: sanitize(error), metrics: payloadMetrics }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn?.(`[heartbeat] ${component} POST HTTP ${res.status}`);
    } catch (e) {
      logger.warn?.(`[heartbeat] ${component} POST failed: ${e.message}`);
    }
  };
}
