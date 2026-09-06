// One rule for every producer-supplied event time, in one place.
//
// THE BUG THIS EXISTS FOR (red-team, 2026-09-05). Two of the three ingest paths
// on /api/gs-ingest are UNAUTHENTICATED by design — the mod runs on players' PCs
// and cannot hold a secret, so `source:'client'` and `source:'eilif-death'` carry
// no Bearer token and the POST URL ships inside the public Thunderstore pack. The
// only gates are the world name (public) and a presence check on a character name
// (also public: /api/status currentPlayers and /players list them). Both death
// paths then validated their `tsUtc` with nothing but `Date.parse`, and the value
// went verbatim into `events.created_at`. So one anonymous POST naming any
// currently-online viking, dated 2999-01-01, was enough to:
//
//   • FREEZE THE #server FEED FOREVER. The Discord relay's cursor IS
//     `events.created_at` and only ever moves forward, so after that row the
//     `.gt(created_at, cursor)` query matched nothing again. A tick that posts
//     nothing is a success, so the ops heartbeat and the watchdog stayed green
//     while the feed was dead.
//   • POISON EVERY FUTURE RECAP. The recap's death query was `gte(windowStart)`
//     with no upper bound, so the forged row counted in the Fallen board and the
//     "The Bold" Player-of-the-Day tally every single day, forever.
//
// Recovery needed hand-editing the bot's state.json AND deleting the row.
//
// THE RULE. A producer may say WHEN something happened, but not that it happened
// after now. A clock a few minutes ahead is an ordinary skewed PC and its report
// is still true, so the tolerance below is generous; anything past it is coerced
// down to now rather than rejected, because losing a real viking's death to a
// badly-set clock is the worse failure. The clamp is applied at every point where
// producer-supplied time becomes a stored timestamp, so no single path can
// reintroduce the hole.
//
// Belt and braces beyond this module: services/discord-bot/src/relay.js never
// RELAYS a future-dated row (and repairs a cursor already poisoned by one — its
// cursor is events.inserted_at since 2026-09-06, so a forged created_at can no
// longer move it at all), services/discord-bot/src/recap.js bounds its window at
// both ends, and lib/ops/consistency.ts raises a finding when future-dated rows
// exist.

/**
 * How far ahead of "now" a producer's timestamp may sit and still be taken at
 * face value. Generous on purpose: a player's PC clock drifting a couple of
 * minutes is normal, and the whole ingest pipeline re-posts on a ~120s cadence.
 */
export const FUTURE_EVENT_TOLERANCE_MS = 5 * 60_000;

export interface ClampedEventTime {
  /** The time to store. Never more than FUTURE_EVENT_TOLERANCE_MS ahead of now. */
  iso: string;
  /** True when the producer's value was ahead of the tolerance and was pulled back. */
  clamped: boolean;
  /** What the producer actually claimed, when it was clamped (for the log line). */
  claimedIso: string | null;
}

/** Is this instant further ahead of `now` than we are willing to believe? */
export function isFutureBeyondTolerance(ms: number, nowMs: number = Date.now()): boolean {
  return Number.isFinite(ms) && ms > nowMs + FUTURE_EVENT_TOLERANCE_MS;
}

/**
 * Normalize one producer-supplied event time to something safe to store.
 *
 * Accepts an ISO string, a Date or epoch milliseconds. Anything unparseable —
 * and anything further ahead than the tolerance — becomes `now`, with `clamped`
 * set so the caller can log what was refused. Times in the PAST are left alone:
 * a backfill, a replayed log batch and a late report are all legitimate.
 *
 * That last sentence used to end "and a past-dated row can only ever be skipped
 * by a cursor, never freeze one", which treated the skip as the harmless half.
 * It was not: the #server relay cursored on this very column, so a past-dated
 * row written after a newer one was skipped SILENTLY AND FOREVER — the 2026-09-06
 * rehearsal posted 20 of 20 joins and 0 of 20 leaves, and every health signal
 * stayed green throughout. Past-dating is still legitimate and is still left
 * alone here; what changed is that no consumer may cursor on a producer's clock.
 * The relay now cursors on `events.inserted_at`
 * (db/2026-09-06_events_inserted_at.sql, services/discord-bot/src/relay.js).
 */
export function clampEventTime(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): ClampedEventTime {
  const nowIso = new Date(nowMs).toISOString();

  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') ms = Date.parse(value);
  else ms = NaN;

  if (!Number.isFinite(ms)) return { iso: nowIso, clamped: false, claimedIso: null };

  if (isFutureBeyondTolerance(ms, nowMs)) {
    return { iso: nowIso, clamped: true, claimedIso: new Date(ms).toISOString() };
  }
  return { iso: new Date(ms).toISOString(), clamped: false, claimedIso: null };
}

/** The clamped ISO string on its own, for callers with nothing to log. */
export function clampEventTimeIso(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): string {
  return clampEventTime(value, nowMs).iso;
}
