// "Coming up": the pure maths behind /admin/ops/horizon.
//
// WHAT THIS FILE IS FOR. The overview tab answers "is it working". The activity
// tab answers "what did it do". This one answers the question an operator asks
// at 22:50 on launch night: what happens next, and is any of it late? Everything
// here turns a schedule (a cron hour, a world-day cycle, a cursor, a threshold)
// into a number of seconds and a state, so the page can render a countdown that
// is either right or honestly absent.
//
// PURE. No I/O, no 'server-only', no Next imports. The reads live in
// app/admin/ops/horizon/data.ts and hand plain rows to these functions, which is
// what lets lib/ops/horizon.test.mjs run the whole file under tsx with no
// database and no network. See docs/OPS-COCKPIT-V2.md section 3.
//
// THE HOUSE RULE THAT SHAPES EVERY SIGNATURE: never assume healthy on absence.
// A missing cursor is `'unknown'`, not `'idle'`. A missing timestamp is `null`,
// not `0`. Every function that can fail to know something returns null and lets
// the page print "not reported" rather than a confident zero.

import type { Milestone } from '../types';
// The relay's own numbers, declared once (see ./relay) and re-exported so
// this module's public surface is unchanged for its callers and its tests.
export { RELAY_BATCH, RELAY_TICK_MS, RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import { RELAY_BATCH, RELAY_TICK_MS, RELAY_BEHIND_SEC, RELAY_BEHIND_ROWS } from './relay';
import {
  summarizeMilestones,
  formatMetricValue,
  metricInfo,
  type Aggregates,
} from '../milestones';

// ── constants that mirror the bot, and where each one comes from ────────────
//
// These are the FALLBACKS. When the bot has reported its own `metrics.schedule`
// block (services/discord-bot/src/heartbeat.js), the page uses the bot's numbers
// and says so. Until the bot is restarted on the host that block is absent, so
// the page falls back to these and labels them as read from the code rather than
// from the running process. Getting that label wrong is how a cockpit tells a
// confident lie about a value nobody has actually confirmed.

/** services/discord-bot/src/recap.js: `cron.schedule('0 <RECAP_EVENING_HOUR> * * *')`. */
export const RECAP_HOUR_DEFAULT = 23;
/** services/discord-bot/src/index.js: `const TZ = process.env.TZ || 'America/Chicago'`. */
export const RECAP_TZ_DEFAULT = 'America/Chicago';
/** services/discord-bot/src/voice.js: `CADENCE_MINUTES = 120`. */
export const VOICE_CADENCE_MINUTES_DEFAULT = 120;
/** services/discord-bot/src/voice.js: `DEFAULT_MIN_GAP_MS = 1_800_000` (VOICE_MIN_GAP_MS). */
export const VOICE_MIN_GAP_MS_DEFAULT = 1_800_000;
/** services/discord-bot/src/voice.js: `DAWN_EVERY_DAYS = 3`. */
export const DAWN_EVERY_DAYS_DEFAULT = 3;
// The relay's batch size, tick interval and behind-thresholds are declared once
// in ./relay and re-exported here, so this page and the Performance tab cannot
// drift apart on what "behind" means. See that file for why.
/** app/api/ops/watchdog: at most one re-alert every 6 h while unhealthy. */
export const WATCHDOG_REALERT_HOURS = 6;
/** eilif-map-snapshot.service runs the loop on a five minute cadence. */
export const MAP_CADENCE_SEC = 300;

/**
 * The interval each bot loop ticks on when its env var is unset, transcribed
 * from services/discord-bot/src/index.js runLive().
 *
 * These are FALLBACKS in the same sense as the recap hour: they are what the
 * code does with no env var set, so a cockpit using them before the bot has
 * reported is quoting the program rather than guessing. The page still says
 * which of the two it is showing, because a host that has overridden
 * TITLES_INTERVAL_MS would make the fallback quietly wrong.
 */
export const LOOP_INTERVAL_DEFAULTS_MS: Record<string, number> = {
  relay: 15_000,
  bosses: 30_000,
  events: 600_000,
  identityConfirm: 30_000,
  voice: 60_000,
  voiceExpire: 300_000,
  titles: 600_000,
  milestones: 120_000,
  bossPolls: 60_000,
  heartbeat: 60_000,
};

// ── time zones without a library ────────────────────────────────────────────

/**
 * The UTC offset of `tz` at instant `atMs`, in milliseconds (positive east).
 *
 * Intl gives us the wall-clock fields of an instant in any zone but no offset,
 * so this reads those fields back as if they were UTC and subtracts. That
 * difference IS the offset, and it is DST-correct by construction because Intl
 * applied the right rule when it formatted.
 *
 * Returns null for a zone name Intl rejects, which is the only failure mode
 * (a typo in `process.env.TZ` on the host reaching us through a heartbeat).
 */
export function zoneOffsetMs(atMs: number, tz: string): number | null {
  if (!Number.isFinite(atMs)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atMs));
  } catch {
    return null;
  }
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = Number(p.value);
  if (!Number.isFinite(f.year) || !Number.isFinite(f.month) || !Number.isFinite(f.day)) return null;
  // hourCycle h23 gives 0..23, but some ICU builds still emit 24 for midnight.
  const hour = f.hour === 24 ? 0 : f.hour;
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second);
  return asUtc - atMs;
}

/** The calendar date in `tz` at `atMs`, as {y, m, d}. Null for a bad zone. */
export function zoneDateParts(
  atMs: number,
  tz: string,
): { y: number; m: number; d: number; hour: number; minute: number } | null {
  const off = zoneOffsetMs(atMs, tz);
  if (off === null) return null;
  const shifted = new Date(atMs + off);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d hh:mm.
 *
 * Two passes, because the offset depends on the instant we are trying to find:
 * guess with the offset at the naive UTC reading, then re-guess with the offset
 * at that guess. Two iterations settle every real zone (offsets move by at most
 * an hour or two, never by a day), and a third would only matter for a zone that
 * changes its rule inside the same hour.
 *
 * On a spring-forward gap (02:30 does not exist in America/Chicago on the second
 * Sunday in March) this lands on the instant one offset later, which is what a
 * cron would fire at as well. It never returns a time in the past relative to
 * the requested date, and it never throws.
 */
export function zonedTimeToMs(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  tz: string,
): number | null {
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const off = zoneOffsetMs(guess, tz);
    if (off === null) return null;
    const next = naive - off;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

/**
 * The next instant at or after `nowMs` when the wall clock in `tz` reads
 * hh:mm. Null when the zone is unusable or the hour is out of range, so a page
 * that cannot compute a countdown prints the configured hour as text instead of
 * an invented number. A wrong countdown is worse than no countdown.
 */
export function nextDailyRun(
  nowMs: number,
  hour: number,
  minute: number,
  tz: string,
): number | null {
  if (!Number.isFinite(nowMs)) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const today = zoneDateParts(nowMs, tz);
  if (!today) return null;
  // Three candidate days covers every case: today's run may be still to come,
  // already past (so tomorrow), or shifted across a date line by the offset.
  for (let add = 0; add <= 2; add++) {
    const base = Date.UTC(today.y, today.m - 1, today.d) + add * 86_400_000;
    const day = new Date(base);
    const t = zonedTimeToMs(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute,
      tz,
    );
    if (t !== null && t > nowMs) return t;
  }
  return null;
}

/** `nextDailyRun` at the top of the hour: the shape a `0 H * * *` cron fires on. */
export function nextCronRun(nowMs: number, hour: number, tz: string): number | null {
  return nextDailyRun(nowMs, hour, 0, tz);
}

/**
 * Midnight at the start of a bare `YYYY-MM-DD` day, read in `tz`.
 *
 * Exists for one caller and one bug (fixed 2026-09-06). `RECAPS_START` is a bare
 * date in the bot's env, and the bot turns it into an instant with
 * `new Date(\`${RECAPS_START}T00:00:00\`)` (services/discord-bot/src/index.js)
 * with NO trailing Z, which Node resolves in the host's local zone,
 * America/Chicago.
 * The cockpit was parsing the same string with an explicit Z, i.e. in UTC, five
 * to six hours earlier. On the boundary day, which is launch day itself, the
 * page would have said "launch gate open since 2026-09-09" while the bot was
 * still holding the recap silent. Every other clock on this tab is zone-correct;
 * this one now is too.
 *
 * Null for a malformed date or a zone Intl rejects, so the caller prints the
 * configured date as text rather than an invented comparison.
 */
export function ymdStartMs(ymd: string | null | undefined, tz: string): number | null {
  if (typeof ymd !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = zonedTimeToMs(y, mo, d, 0, 0, tz);
  if (t === null) return null;
  // Reject a date that does not exist (2026-02-30 would otherwise roll forward
  // into March and silently answer for a day nobody wrote down).
  const parts = zoneDateParts(t, tz);
  if (!parts || parts.y !== y || parts.m !== mo || parts.d !== d) return null;
  return t;
}

/**
 * The soonest of several daily wall-clock times in one zone. This is what a
 * systemd `OnCalendar=*-*-* 00,06,12,18:00:00` fires on, and it is how the world
 * backup timer's next run is derived. Null when none of them can be computed.
 */
export function nextOfDailyHours(
  nowMs: number,
  hours: number[],
  minute: number,
  tz: string,
): number | null {
  let best: number | null = null;
  for (const h of hours) {
    const t = nextDailyRun(nowMs, h, minute, tz);
    if (t === null) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** "23:00" in `tz`. Empty string for a zone Intl rejects. */
export function clockInZone(atMs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(atMs));
  } catch {
    return '';
  }
}

/** "Wed Sep 09, 23:00" in `tz`. Empty string for a zone Intl rejects. */
export function stampInZone(atMs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(atMs));
  } catch {
    return '';
  }
}

// ── the bot's reported schedule, resolved against the fallbacks ─────────────

/** The raw `metrics.schedule` block, exactly as heartbeat.js publishes it. */
export interface BotScheduleLike {
  reportedAt?: string | null;
  recapHour?: number | null;
  recapTz?: string | null;
  recapChannel?: string | null;
  recapsStart?: string | null;
  nextRecapAt?: string | null;
  voiceCadenceMinutes?: number | null;
  voiceMinGapMs?: number | null;
  dawnEveryDays?: number | null;
  ambientOnlineMinutes?: number | null;
  lastDawnDay?: number | null;
  relayCursor?: string | null;
  loopsEnabled?: Record<string, boolean> | null;
  intervalsMs?: Record<string, number> | null;
  channels?: Record<string, string | null> | null;
}

export interface ResolvedSchedule {
  /** True when the bot actually sent a schedule block. */
  reported: boolean;
  /** When the bot computed it. Null when it did not report. */
  reportedAtMs: number | null;
  recapHour: number;
  recapTz: string;
  recapChannel: string | null;
  recapsStart: string | null;
  /** The next recap instant, or null when no zone can be resolved. */
  nextRecapAtMs: number | null;
  /**
   * Where that instant came from:
   *   'bot'      the bot computed it in its own zone, which is authoritative.
   *   'computed' this page computed it from the reported or default hour.
   *   'none'     no usable zone, so the page prints the hour as text instead.
   */
  nextRecapSource: 'bot' | 'computed' | 'none';
  voiceCadenceMinutes: number;
  voiceMinGapMs: number;
  dawnEveryDays: number;
  /** Null when the bot has not reported. NEVER defaulted to zero. */
  ambientOnlineMinutes: number | null;
  lastDawnDay: number | null;
  relayCursor: string | null;
  loopsEnabled: Record<string, boolean> | null;
  /** Always populated: LOOP_INTERVAL_DEFAULTS_MS with anything the bot reported on top. */
  intervalsMs: Record<string, number>;
  /** True when the intervals above came from the bot rather than from the defaults. */
  intervalsReported: boolean;
}

/**
 * Fold the bot's reported schedule together with the repo's constants.
 *
 * The rule, and the reason this is a function rather than a spread: a CONFIGURED
 * value (a cron hour, a cadence, a zone) falls back to the constant in the repo,
 * because that constant is what the code does when the env var is unset, so the
 * fallback is right rather than merely plausible. A MEASURED value (banked
 * online minutes, the last dawn day, the relay cursor) does NOT fall back at
 * all: it stays null, because nothing outside that process knows it and a
 * default would be an invention. `reported` tells the page which world it is in
 * so it can label every fallback rather than quietly presenting it as fact.
 */
export function resolveSchedule(
  block: BotScheduleLike | null | undefined,
  nowMs: number,
): ResolvedSchedule {
  const reported = Boolean(block);
  const hour =
    typeof block?.recapHour === 'number' && Number.isInteger(block.recapHour)
      && block.recapHour >= 0 && block.recapHour <= 23
      ? block.recapHour
      : RECAP_HOUR_DEFAULT;
  const tz = typeof block?.recapTz === 'string' && block.recapTz.length > 0
    ? block.recapTz
    : RECAP_TZ_DEFAULT;

  // Prefer the bot's own answer: it holds the zone database the cron actually
  // fires against. Fall back to computing it here, which is the same maths.
  const botNext = parseIso(block?.nextRecapAt);
  const computedNext = nextCronRun(nowMs, hour, tz);
  const nextRecapAtMs = botNext ?? computedNext;
  const nextRecapSource: ResolvedSchedule['nextRecapSource'] =
    botNext !== null ? 'bot' : computedNext !== null ? 'computed' : 'none';

  return {
    reported,
    reportedAtMs: parseIso(block?.reportedAt),
    recapHour: hour,
    recapTz: tz,
    recapChannel: typeof block?.recapChannel === 'string' ? block.recapChannel : null,
    recapsStart: typeof block?.recapsStart === 'string' ? block.recapsStart : null,
    nextRecapAtMs,
    nextRecapSource,
    voiceCadenceMinutes: positiveOr(block?.voiceCadenceMinutes, VOICE_CADENCE_MINUTES_DEFAULT),
    voiceMinGapMs: nonNegativeOr(block?.voiceMinGapMs, VOICE_MIN_GAP_MS_DEFAULT),
    dawnEveryDays: positiveOr(block?.dawnEveryDays, DAWN_EVERY_DAYS_DEFAULT),
    ambientOnlineMinutes:
      typeof block?.ambientOnlineMinutes === 'number' && Number.isFinite(block.ambientOnlineMinutes)
        ? block.ambientOnlineMinutes
        : null,
    lastDawnDay:
      typeof block?.lastDawnDay === 'number' && Number.isFinite(block.lastDawnDay)
        ? block.lastDawnDay
        : null,
    relayCursor: typeof block?.relayCursor === 'string' ? block.relayCursor : null,
    loopsEnabled: block?.loopsEnabled ?? null,
    intervalsMs: { ...LOOP_INTERVAL_DEFAULTS_MS, ...(block?.intervalsMs ?? {}) },
    intervalsReported: Boolean(block?.intervalsMs),
  };
}

/**
 * Seconds still owed on the ambient min-gap: the gap length minus how long ago
 * the last voice line of ANY kind was queued. Zero when the gap is clear or when
 * there has never been a line (voice.js treats a null last-line as clear).
 */
export function minGapRemainingSec(
  newestVoiceQueuedAt: string | null | undefined,
  minGapMs: number,
  nowMs: number,
): number {
  const last = parseIso(newestVoiceQueuedAt);
  if (last === null || !Number.isFinite(minGapMs) || minGapMs <= 0) return 0;
  return Math.max(0, (minGapMs - (nowMs - last)) / 1000);
}

function positiveOr(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegativeOr(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// ── the dawn line's own clock ───────────────────────────────────────────────

export interface DawnNext {
  /** The world day the next dawn line is due on. */
  day: number;
  /** True when that day is the day the world is on right now. */
  isToday: boolean;
  /** True when today is a dawn day and the bot has already spoken it. */
  spokenToday: boolean;
  /** World days from now until `day`. 0 when it is due today. */
  daysAway: number;
}

/**
 * When the next dawn line is due, in world days.
 *
 * The rule in services/discord-bot/src/voice.js checkDawn(): fire on every
 * `everyDays`-th world day, once per day (`lastDawnDay !== day`), and only to a
 * hall with somebody in it. The population gate is deliberately NOT modelled
 * here: it is a condition at the moment of firing, not a schedule, and the page
 * states it beside the number instead of folding it in. Day zero never fires,
 * which is what makes a wipe (the counter going back to 1) start the cycle over
 * rather than go silent.
 */
export function nextDawnWorldDay(
  worldDay: number | null | undefined,
  lastDawnDay: number | null | undefined,
  everyDays: number = DAWN_EVERY_DAYS_DEFAULT,
): DawnNext | null {
  const every = Math.floor(everyDays);
  if (!Number.isFinite(every) || every <= 0) return null;
  if (worldDay === null || worldDay === undefined || !Number.isFinite(worldDay)) return null;
  const d = Math.max(0, Math.floor(worldDay));
  const eligibleToday = d > 0 && d % every === 0;
  const spokenToday = eligibleToday && lastDawnDay === d;
  if (eligibleToday && !spokenToday) {
    return { day: d, isToday: true, spokenToday: false, daysAway: 0 };
  }
  const next = (Math.floor(d / every) + 1) * every;
  return { day: next, isToday: false, spokenToday, daysAway: next - d };
}

// ── the ambient cadence ─────────────────────────────────────────────────────

export type AmbientState = 'unknown' | 'accumulating' | 'held-by-gap' | 'ready';

export interface AmbientCadence {
  /** Online-time minutes banked toward the next ambient line. Null = not reported. */
  minutesAccumulated: number | null;
  /** Online minutes still to bank before the cadence is met. Null = not reported. */
  minutesOwed: number | null;
  /** Seconds still owed on the global min-gap. 0 when the gap is clear. */
  blockedByGapSec: number;
  /** True only when the cadence is met AND the gap is clear. */
  ready: boolean;
  state: AmbientState;
}

/**
 * Where the Voice of the Hall is in its ambient cycle.
 *
 * Two independent clocks have to line up for an ambient line to be queued
 * (voice.js tick()): the hall has to have banked `cadenceMinutes` of
 * somebody-online time, AND the last voice line of any kind has to be older than
 * VOICE_MIN_GAP_MS. Either one alone explains "why has Eilif not said anything",
 * so both are returned rather than collapsed into one boolean.
 *
 * `onlineMinutes` is null when the bot has not reported its schedule block yet.
 * The state is then 'unknown' and the page says so: it must not read as
 * "accumulating from zero", which is a number nobody measured.
 */
export function ambientCadence(
  onlineMinutes: number | null | undefined,
  cadenceMinutes: number = VOICE_CADENCE_MINUTES_DEFAULT,
  minGapRemainingSec: number = 0,
): AmbientCadence {
  const gap = Number.isFinite(minGapRemainingSec) ? Math.max(0, minGapRemainingSec) : 0;
  const cadence = Number.isFinite(cadenceMinutes) && cadenceMinutes > 0
    ? cadenceMinutes
    : VOICE_CADENCE_MINUTES_DEFAULT;
  if (onlineMinutes === null || onlineMinutes === undefined || !Number.isFinite(onlineMinutes)) {
    return {
      minutesAccumulated: null,
      minutesOwed: null,
      blockedByGapSec: gap,
      ready: false,
      state: 'unknown',
    };
  }
  const banked = Math.max(0, onlineMinutes);
  const owed = Math.max(0, cadence - banked);
  if (owed > 0) {
    return {
      minutesAccumulated: banked,
      minutesOwed: owed,
      blockedByGapSec: gap,
      ready: false,
      state: 'accumulating',
    };
  }
  if (gap > 0) {
    return {
      minutesAccumulated: banked,
      minutesOwed: 0,
      blockedByGapSec: gap,
      ready: false,
      state: 'held-by-gap',
    };
  }
  return {
    minutesAccumulated: banked,
    minutesOwed: 0,
    blockedByGapSec: 0,
    ready: true,
    state: 'ready',
  };
}

// ── the relay cursor ────────────────────────────────────────────────────────

export type RelayState = 'unknown' | 'idle' | 'working' | 'behind';

export interface RelayDrain {
  /** Seconds between the relay's cursor and the newest inserted row. Null = unknown. */
  behindSec: number | null;
  /**
   * Seconds since the cursor's own timestamp. This is NOT lateness: a cursor
   * that has not moved in five days is a hall nobody has played in. It is here
   * so the panel can say which of the two it is looking at.
   */
  cursorAgeSec: number | null;
  /** Rows written after the cursor, i.e. rows the relay has not reached yet. */
  pending: number | null;
  /** Estimated seconds to drain `pending` at BATCH rows per tick. Null when unknown or idle. */
  drainSec: number | null;
  state: RelayState;
}

/**
 * How far behind the Discord relay's cursor is, and how long it needs to catch up.
 *
 * NOT THE SAME FUNCTION AS `relayBacklog` in lib/ops/performance.ts, which is
 * why they no longer share a name. That one counts the pending rows itself out
 * of the event rows the Performance tab already holds and reports the age of the
 * OLDEST waiting row. This one is given a bounded `count(*)` from the database,
 * so it can see a backlog older than any page window, measures behind-ness as
 * the gap between the cursor and the newest row that exists, and adds the
 * estimate this tab is actually for: how many ticks the queue takes to drain.
 * Both judge 'behind' by the shared thresholds in ./relay.
 *
 * This is the panel the 2026-09-06 rehearsal earned: 21 of 43 rows were never
 * posted to #server while every heartbeat on the overview read healthy, because
 * the relay's own loop was ticking fine and the cursor was the thing that was
 * wrong. A backlog is the only visible symptom of that class of failure.
 *
 * `pending` counts EVERY row after the cursor, not only the ones the relay will
 * post: relay.tick() reads all types and steps over the ones it does not
 * recognise, advancing the cursor either way. So this is "rows the relay has not
 * reached yet", and the page says exactly that rather than "unposted events".
 *
 * The thresholds are RELAY_BEHIND_SEC behind, or more than RELAY_BEHIND_ROWS
 * waiting, both from ./relay so this page and the Performance tab judge the
 * relay by one rule. One tick is 15 s and one batch is 50 rows, so a healthy
 * relay clears anything short of that inside a minute.
 */
export function relayDrain(
  cursorIso: string | null | undefined,
  newestInsertedAt: string | null | undefined,
  pending: number | null | undefined,
  nowMs: number,
): RelayDrain {
  const cursorMs = parseIso(cursorIso);
  if (cursorMs === null) {
    return { behindSec: null, cursorAgeSec: null, pending: null, drainSec: null, state: 'unknown' };
  }
  const cursorAgeSec = Math.max(0, (nowMs - cursorMs) / 1000);
  const newestMs = parseIso(newestInsertedAt);
  // Behind-ness is measured against the newest row that exists, not against the
  // clock: a quiet hall is not a late relay, and the cursor legitimately sits
  // still for hours when nothing is being written.
  const behindSec = newestMs === null ? null : Math.max(0, (newestMs - cursorMs) / 1000);
  const rows = typeof pending === 'number' && Number.isFinite(pending) ? Math.max(0, pending) : null;

  if (rows === null) {
    // No count available: fall back on the timestamps alone, which can still
    // say "behind" but can never say "idle" with any confidence.
    if (behindSec === null) {
      return { behindSec: null, cursorAgeSec, pending: null, drainSec: null, state: 'unknown' };
    }
    return {
      behindSec,
      cursorAgeSec,
      pending: null,
      drainSec: null,
      state: behindSec > RELAY_BEHIND_SEC ? 'behind' : 'working',
    };
  }
  if (rows === 0) {
    return { behindSec: behindSec ?? 0, cursorAgeSec, pending: 0, drainSec: null, state: 'idle' };
  }
  const ticks = Math.ceil(rows / RELAY_BATCH);
  const drainSec = (ticks * RELAY_TICK_MS) / 1000;
  const late = rows > RELAY_BEHIND_ROWS || (behindSec !== null && behindSec > RELAY_BEHIND_SEC);
  return { behindSec, cursorAgeSec, pending: rows, drainSec, state: late ? 'behind' : 'working' };
}

// ── Great Deeds closest to firing ───────────────────────────────────────────

/**
 * A deed figure, formatted for THIS page rather than for the Hall card.
 *
 * `formatMetricValue()` in lib/milestones rounds a percent metric to a whole
 * percent, which is right on a public card where "28%" is the whole story. It
 * is wrong here, because this panel prints three numbers of the same metric in
 * one sentence: the value, the threshold and what is still needed. On the live
 * "The First Mile" deed (threshold 1 percent of the map, hall average 0.3) all
 * three rounded to the same integer and the line read "needs 1% more to reach
 * 1%. Now at 0%", which is three wrong numbers in nine words.
 *
 * So percent metrics get one decimal here and everything else is left to the
 * shared formatter, which keeps counts, hours and distances identical to every
 * other surface. The convention is the column name: the milestones table names
 * its percent metrics with a `_pct` suffix (`explored_avg_pct` today).
 */
export function formatDeedValue(metric: string, value: number): string {
  if (!Number.isFinite(value)) return formatMetricValue(metric, 0);
  if (metric.endsWith('_pct')) {
    // toFixed(1) rather than a rounded integer: 0.3 must not read as 0, and the
    // threshold 1 must not read as the same number as the 0.7 still owed.
    return `${(Math.round(value * 10) / 10).toFixed(1)}%`;
  }
  return formatMetricValue(metric, value);
}

export interface DeedProgress {
  id: string;
  title: string;
  /** Plain label for what is counted, e.g. "Foes slain". */
  metricLabel: string;
  /** Lowercase clause saying what counts, e.g. "every kill, all vikings". */
  metricDescription: string;
  /** Progress toward the threshold, 0 to 99 (summarizeMilestones caps it). */
  pct: number;
  /** Current aggregate, formatted with its unit ("1,750.0 km", "1,000 h"). */
  valueLabel: string;
  /** The threshold, formatted the same way. */
  thresholdLabel: string;
  /** What is still needed, formatted the same way. "0" when already over. */
  remainingLabel: string;
  /** The raw remaining amount, for sorting or a bar. Never negative. */
  remaining: number;
}

/**
 * The unachieved Great Deeds nearest their thresholds, nearest first.
 *
 * Wraps `summarizeMilestones()` from lib/milestones (already pure and already
 * tested by scripts/milestones.test.mjs) rather than recomputing progress, so
 * this page, the Hall card and the evaluator that actually fires the deed can
 * never disagree about how close one is. All this adds is the "needs N more"
 * figure, which no other surface prints.
 */
export function upcomingDeeds(
  defs: Milestone[],
  aggregates: Aggregates,
  limit: number = 8,
): DeedProgress[] {
  const summary = summarizeMilestones(defs, aggregates);
  const cap = Math.max(0, Math.floor(limit));
  return summary.upcoming.slice(0, cap).map((p) => {
    const info = metricInfo(p.milestone.metric);
    const remaining = Math.max(0, p.milestone.threshold - p.value);
    return {
      id: p.milestone.id,
      title: p.milestone.title,
      metricLabel: info.label,
      metricDescription: info.description,
      pct: p.pct,
      valueLabel: formatDeedValue(p.milestone.metric, p.value),
      thresholdLabel: formatDeedValue(p.milestone.metric, p.milestone.threshold),
      remainingLabel: formatDeedValue(p.milestone.metric, remaining),
      remaining,
    };
  });
}

// ── titles about to change hands ────────────────────────────────────────────

export type TitleContestKind = 'flipping' | 'contested' | 'seed';

export interface TitleContestInput {
  name: string;
  /** players.current_title: the title the hall currently knows them by. */
  incumbent: string | null;
  /** The engine's answer WITH hysteresis, i.e. what the bot will write next tick. */
  stable: string | null;
  /** The engine's answer with the incumbent removed, i.e. the raw standings. */
  raw: string | null;
  /** Which dimension earned the stable title, for tinting. */
  source?: string;
}

export interface TitleContest extends TitleContestInput {
  kind: TitleContestKind;
}

/**
 * Which vikings are about to be re-titled, and which are merely being pushed at.
 *
 * The Discord bot's titles loop (services/discord-bot/src/titles.js) polls
 * /api/titles every 10 minutes and announces whenever the engine's answer
 * differs from `players.current_title`. So:
 *
 *   flipping  the engine already disagrees with the incumbent even WITH the
 *             hysteresis bonus applied. The bot announces this at its next tick.
 *   contested hysteresis is the only thing holding the title: strip the
 *             incumbent bonus and a rival wins. Nothing is announced, but the
 *             title is one good night from moving.
 *   seed      no incumbent recorded yet. The bot writes it silently the first
 *             time it sees it, with no announcement (that is the seeding pass
 *             db/2026-07-05_titles.sql describes).
 *
 * Everything settled is dropped. An empty array means no title is moving, which
 * the page renders as a sentence rather than as an empty table.
 */
export function titleContests(rows: TitleContestInput[]): TitleContest[] {
  const out: TitleContest[] = [];
  for (const r of rows) {
    const incumbent = norm(r.incumbent);
    const stable = norm(r.stable);
    const raw = norm(r.raw);
    if (!incumbent && stable) {
      out.push({ ...r, kind: 'seed' });
      continue;
    }
    if (incumbent && stable && stable !== incumbent) {
      out.push({ ...r, kind: 'flipping' });
      continue;
    }
    if (incumbent && stable === incumbent && raw && raw !== incumbent) {
      out.push({ ...r, kind: 'contested' });
    }
  }
  // Flips first (they are about to be announced), then contests, then seeds;
  // alphabetical inside each so two renders a second apart do not reshuffle.
  const rank: Record<TitleContestKind, number> = { flipping: 0, contested: 1, seed: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

function norm(s: string | null | undefined): string | null {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > 0 ? t : null;
}

// ── things with an expiry ───────────────────────────────────────────────────

/**
 * Rows whose `at` timestamp falls between now and `nowMs + withinMs`, soonest
 * first. Rows already past are dropped (they are expired, not expiring, and the
 * overview's consistency checks already own that case); rows with no readable
 * timestamp are dropped rather than sorted to one end.
 */
export function expiringSoon<T>(
  rows: T[],
  at: (row: T) => string | null | undefined,
  nowMs: number,
  withinMs: number,
): T[] {
  const limit = nowMs + Math.max(0, withinMs);
  return rows
    .map((row) => ({ row, t: parseIso(at(row)) }))
    .filter((x): x is { row: T; t: number } => x.t !== null && x.t >= nowMs && x.t <= limit)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.row);
}

// ── the watchdog's next window ──────────────────────────────────────────────

/**
 * The earliest instant the watchdog is allowed to post again while it stays
 * unhealthy. Null when it has never posted, which is the honest answer for a
 * watchdog that has been quiet since it was installed: there is no window to
 * count down to, and printing "in 6 h" from a null would be an invention.
 */
export function nextWatchdogAlertAt(
  lastAlertAtIso: string | null | undefined,
  reAlertHours: number = WATCHDOG_REALERT_HOURS,
): number | null {
  const t = parseIso(lastAlertAtIso);
  if (t === null) return null;
  const hours = Number.isFinite(reAlertHours) && reAlertHours > 0 ? reAlertHours : WATCHDOG_REALERT_HOURS;
  return t + hours * 3_600_000;
}

// ── periodic producers: is the next one late? ───────────────────────────────

export type CadenceState = 'unknown' | 'due-soon' | 'overdue';

export interface CadenceEta {
  /** When the next run is expected, epoch ms. Null when the last run is unknown. */
  nextAtMs: number | null;
  /** Seconds until then. Negative when it is already late. Null when unknown. */
  untilSec: number | null;
  state: CadenceState;
}

/**
 * Project the next run of a fixed-cadence producer from its last one.
 *
 * Used for the map snapshot (a five minute loop) and for anything else that
 * repeats on a period rather than on a clock. It is a projection, not a
 * schedule: the loop's phase is whatever its last run set, so the page labels
 * the number "expected" and never "scheduled".
 */
export function cadenceEta(
  lastAtIso: string | null | undefined,
  cadenceSec: number,
  nowMs: number,
): CadenceEta {
  const last = parseIso(lastAtIso);
  const period = Number.isFinite(cadenceSec) && cadenceSec > 0 ? cadenceSec : null;
  if (last === null || period === null) {
    return { nextAtMs: null, untilSec: null, state: 'unknown' };
  }
  const nextAtMs = last + period * 1000;
  const untilSec = (nextAtMs - nowMs) / 1000;
  // One whole period late is the point at which a missed run stops being jitter.
  return { nextAtMs, untilSec, state: untilSec < -period ? 'overdue' : 'due-soon' };
}

// ── the next Forsaken ───────────────────────────────────────────────────────

export interface BossRowLike {
  name: string;
  biome?: string | null;
  sort_order: number;
  is_killed?: boolean | null;
  killed_at?: string | null;
}

export interface NextBoss {
  /** The lowest-ordered boss still standing, or null when all eight are down. */
  next: BossRowLike | null;
  /** The most recently felled boss, by killed_at. */
  lastFelled: BossRowLike | null;
  /** Seconds since that fall. Null when nothing has fallen yet. */
  sinceLastSec: number | null;
  felled: number;
  total: number;
}

/** Progression: who is next, who fell last, and how long ago. */
export function nextBoss(rows: BossRowLike[], nowMs: number): NextBoss {
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  const next = ordered.find((b) => !b.is_killed) ?? null;
  let lastFelled: BossRowLike | null = null;
  let lastMs: number | null = null;
  for (const b of ordered) {
    const t = parseIso(b.killed_at);
    if (t === null) continue;
    if (lastMs === null || t > lastMs) {
      lastMs = t;
      lastFelled = b;
    }
  }
  return {
    next,
    lastFelled,
    sinceLastSec: lastMs === null ? null : Math.max(0, (nowMs - lastMs) / 1000),
    felled: ordered.filter((b) => b.is_killed).length,
    total: ordered.length,
  };
}

// ── the merged "next up" rail ───────────────────────────────────────────────

export interface ScheduleItem {
  id: string;
  /** What fires, in plain words. */
  label: string;
  /** When, epoch ms. Null means "known to be scheduled, time not computable". */
  atMs: number | null;
  /** One clause of context: the cron line, the cadence, the gate. */
  detail: string;
  /** True when the time is projected from a cadence rather than read off a clock. */
  estimated?: boolean;
  /** True when something else has to be true before it fires (a populated hall). */
  conditional?: boolean;
}

/**
 * One ordered rail out of every clock on the page: soonest first, then the
 * items whose time cannot be computed, then a stable tie-break by id so two
 * renders a second apart do not reshuffle.
 *
 * Items with no time are kept rather than dropped. "The recap has no countdown
 * because the bot has not reported its hour" is information; silently omitting
 * the recap from the rail is not.
 */
export function mergeSchedule(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => {
    if (a.atMs === null && b.atMs === null) return a.id.localeCompare(b.id);
    if (a.atMs === null) return 1;
    if (b.atMs === null) return -1;
    return a.atMs - b.atMs || a.id.localeCompare(b.id);
  });
}

// ── launch day ──────────────────────────────────────────────────────────────

export type LaunchStepStatus = 'done' | 'open' | 'not-visible';

export interface LaunchStep {
  n: number;
  title: string;
  owner: 'Charlie' | 'Claude' | 'Both';
  /** Set only on steps the cockpit can actually check against a table. */
  checkedHere?: boolean;
  /** Extra context worth carrying onto the page. */
  note?: string;
}

/**
 * The step list of record, from docs/LAUNCH-DAY.md (2026-09-05, re-audited
 * 2026-09-06). Titles and owners are transcribed from that file's headings; it
 * is the sequence of record and this table must not drift from it.
 *
 * Step 0 is not on the day: it is due 2026-09-08 and is the hard blocker for
 * everything after step 8.
 */
export const LAUNCH_STEPS: LaunchStep[] = [
  { n: 0, title: 'Generate the launch world and hand over the .fwl and .db pair', owner: 'Charlie', note: 'Due 2026-09-08, not on the day. Blocks step 12.' },
  { n: 1, title: 'Prove Steam is really on 1.0', owner: 'Claude' },
  { n: 2, title: 'Rebuild all four plugins against the 1.0 assemblies', owner: 'Claude' },
  { n: 3, title: 'Load-test the two server DLLs locally', owner: 'Claude', note: 'Conditional.' },
  { n: 4, title: 'Stage the artifacts', owner: 'Claude' },
  { n: 5, title: 'Stop the three services, then the pre-wipe gate', owner: 'Claude' },
  { n: 6, title: 'Three backups, then the wipe preview', owner: 'Claude' },
  { n: 7, title: 'Panel Stop', owner: 'Charlie' },
  { n: 8, title: 'Panel Steam Update, then read the version back', owner: 'Charlie', note: 'The point of no return.' },
  { n: 9, title: 'Swap the two server DLLs', owner: 'Charlie' },
  { n: 10, title: 'Remove ValheimPlus', owner: 'Charlie' },
  { n: 11, title: 'Put the player cap back', owner: 'Charlie' },
  { n: 12, title: 'Sweep the box, then upload the launch world', owner: 'Charlie' },
  { n: 13, title: 'Fill the Start form and Start', owner: 'Charlie', note: 'Death penalty back to Casual.' },
  { n: 14, title: 'Pull anything that failed to load, then Stop and Start again', owner: 'Charlie' },
  { n: 15, title: 'Read the boot and write down what actually loaded', owner: 'Claude' },
  { n: 16, title: 'Client zips to Charlie, and start the index clock', owner: 'Both', note: 'EilifPaths 1.5.0 upload is the longest pole.' },
  { n: 17, title: '15:00 CT go or no-go', owner: 'Charlie' },
  { n: 18, title: 'Wait for the index, then mint pack v12', owner: 'Claude' },
  { n: 19, title: 'Rebuild the Mac config bundle, then the site config and deploy', owner: 'Both' },
  { n: 20, title: 'The wipe, the reverts, and the restart', owner: 'Claude', checkedHere: true, note: 'Checked here from the wipe and the bot pilot flags.' },
  { n: 21, title: "Charlie's own last look", owner: 'Charlie' },
  { n: 22, title: 'The GO post, then Session Zero', owner: 'Charlie' },
];

/** Launch day, from docs/LAUNCH-DAY.md. Valheim 1.0 / Deep North day. */
export const LAUNCH_YMD = { y: 2026, m: 9, d: 9 } as const;
/** The zone every time in the runbook is written in. */
export const LAUNCH_TZ = 'America/Chicago';
/** docs/LAUNCH-DAY.md step 22: the GO post, then Session Zero, 17:00 to 17:30 CT. */
export const LAUNCH_RUNBOOK_HOUR = 17;

export interface LaunchMoment {
  /** The instant to count down to. Null only when the zone is unusable. */
  atMs: number | null;
  /** Where it came from, so the page can say which. */
  source: 'gathering' | 'runbook';
}

/**
 * The instant the countdown points at.
 *
 * Prefer the real scheduled Discord gathering when one exists on launch day:
 * that row is what the players actually see, and it moves if Charlie moves it.
 * Fall back to the runbook's 17:00 CT, and say which one is being used. A
 * gathering on any other date is ignored rather than counted down to, because a
 * weekly raid night three days out is not launch.
 *
 * TAKES THE WHOLE LIST, NOT THE SOONEST ROW (fixed 2026-09-06). This used to be
 * handed `gatherings[0]`, and `getUpcomingEvents` sorts ascending by start, so
 * it was only ever right by luck: schedule anything at all before the 9th, a
 * rehearsal night or a plugin test, and the launch gathering drops to index 1.
 * The panel would then have fallen back to the runbook and printed "no gathering
 * is on the calendar for that date" while the launch gathering sat one row
 * lower. It scans for a row whose date IN THE ZONE is launch day, and takes the
 * earliest such row, so several rows on the 9th resolve to the first of them.
 */
export function launchMomentMs(
  scheduled: string | null | undefined | ReadonlyArray<string | null | undefined>,
  tz: string = LAUNCH_TZ,
): LaunchMoment {
  const runbook = zonedTimeToMs(LAUNCH_YMD.y, LAUNCH_YMD.m, LAUNCH_YMD.d, LAUNCH_RUNBOOK_HOUR, 0, tz);
  const candidates = Array.isArray(scheduled)
    ? scheduled
    : [scheduled as string | null | undefined];

  let best: number | null = null;
  for (const iso of candidates) {
    const t = parseIso(iso);
    if (t === null) continue;
    const parts = zoneDateParts(t, tz);
    if (!parts || parts.y !== LAUNCH_YMD.y || parts.m !== LAUNCH_YMD.m || parts.d !== LAUNCH_YMD.d) {
      continue;
    }
    if (best === null || t < best) best = t;
  }
  if (best !== null) return { atMs: best, source: 'gathering' };
  return { atMs: runbook, source: 'runbook' };
}

export interface LaunchSignals {
  /**
   * True when the bot heartbeat says every pilot channel override is reverted.
   * Null when the bot has not reported (do not guess: an unheard bot is unknown,
   * not compliant).
   */
  pilotOverridesReverted: boolean | null;
  /**
   * Rows in `events` stamped before the launch date. Zero after the wipe has
   * run; a positive number is the pilot world still in the table. Null when the
   * count could not be read.
   */
  preLaunchEventRows: number | null;
}

export interface LaunchStepState {
  step: LaunchStep;
  status: LaunchStepStatus;
  /** What the cockpit actually looked at, or why it cannot look. */
  evidence: string;
}

/**
 * Grade the step list against what the database can prove.
 *
 * The honesty rule this function exists to enforce: only two things on launch
 * day leave a trace the cockpit can read, and everything else is graded
 * 'not-visible' rather than 'open' or 'done'. A step list that quietly ticked
 * itself off would be worse than no step list, because it would be trusted.
 */
export function launchStepStates(signals: LaunchSignals): LaunchStepState[] {
  return LAUNCH_STEPS.map((step) => {
    if (step.n === 20) {
      const { pilotOverridesReverted: reverted, preLaunchEventRows: preRows } = signals;
      if (reverted === null && preRows === null) {
        return { step, status: 'not-visible' as const, evidence: 'The bot has not reported and the event count could not be read.' };
      }
      if (reverted === true && preRows === 0) {
        return { step, status: 'done' as const, evidence: 'Pilot channel overrides are reverted and no event predates launch day.' };
      }
      const parts: string[] = [];
      if (reverted === false) parts.push('pilot channel overrides are still set');
      if (reverted === null) parts.push('the bot has not reported its flags');
      if (typeof preRows === 'number' && preRows > 0) {
        parts.push(`${preRows.toLocaleString('en-US')} event rows still predate launch day`);
      }
      if (preRows === null) parts.push('the pre-launch event count could not be read');
      return { step, status: 'open' as const, evidence: capitalize(parts.join(', ')) + '.' };
    }
    return {
      step,
      status: 'not-visible' as const,
      evidence: 'Nothing in the database records this step. Track it in docs/LAUNCH-DAY.md.',
    };
  });
}

/**
 * The next `limit` steps that are not done: the answer to "what is left".
 *
 * 'not-visible' counts as not done on purpose. The cockpit cannot see step 2, so
 * the only safe assumption is that it has not happened, and the page prints the
 * reason next to it.
 */
export function nextOpenSteps(states: LaunchStepState[], limit: number = 3): LaunchStepState[] {
  return states.filter((s) => s.status !== 'done').slice(0, Math.max(0, Math.floor(limit)));
}

/** Seconds from `nowMs` to the launch instant. Negative once it is past. */
export function launchCountdownSec(nowMs: number, launchMs: number): number {
  return (launchMs - nowMs) / 1000;
}

/**
 * Whole days from `nowMs` to `launchMs`, counted on the calendar in `tz` rather
 * than by dividing by 86400. "T minus 3" has to mean three sleeps, not 2.6
 * rounded, or the number on the page disagrees with the one in everybody's head.
 * Null when the zone is unusable.
 */
export function daysUntilInZone(nowMs: number, launchMs: number, tz: string): number | null {
  const a = zoneDateParts(nowMs, tz);
  const b = zoneDateParts(launchMs, tz);
  if (!a || !b) return null;
  const aUtc = Date.UTC(a.y, a.m - 1, a.d);
  const bUtc = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((bUtc - aUtc) / 86_400_000);
}

/**
 * A claim code, masked to its first two characters.
 *
 * AN UNCONSUMED CLAIM CODE IS A LIVE CREDENTIAL, NOT AN IDENTIFIER (2026-09-06).
 * services/discord-bot/src/identity.js says so in as many words: "anyone who can
 * read the code in a public channel could shout it in-game first and bind THIS
 * user's Hall-voice to their own viking", which is why the bot delivers it by DM
 * and has deliberately no public fallback. The cockpit is admin-only, but it is
 * also routinely screenshotted into handoffs, and nothing an operator does with
 * that panel needs the code itself: the action is "tell them to run /link
 * again", never "type this in". The rest of the row still identifies the claim.
 *
 * IT IS APPLIED IN THE LOADER, NOT IN THE COMPONENT, and that distinction was
 * earned the hard way: masking it in the JSX still left the raw six characters
 * in the page, because the row used the code as its React key and keys are
 * serialised into the flight payload. Verified by grepping the rendered HTML for
 * a synthetic code: one hit, inside `["$","li","K7QM2X",{...}]`. Masking here
 * means the raw value never leaves the server at all.
 *
 * This is not a new rule in the redact.ts sense (that guards heartbeat strings).
 * It is the same instinct applied to the one credential the cockpit can read.
 */
export function maskClaimCode(code: string | null | undefined): string {
  if (typeof code !== 'string' || code.length === 0) return '(no code)';
  if (code.length <= 2) return '*'.repeat(code.length);
  return `${code.slice(0, 2)}${'*'.repeat(code.length - 2)}`;
}

// ── shared ──────────────────────────────────────────────────────────────────

/** Epoch ms from an ISO string, or null. Kept local so this file has no imports it does not need. */
function parseIso(at: string | null | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
