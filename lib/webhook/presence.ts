// Presence bookkeeping — the PURE half of /api/webhook's join/leave handling:
// the two halves of the replay guard, and the session close math.
//
// WHY A REPLAY GUARD EXISTS. The log poller redelivers its WHOLE batch when any
// call in a tick fails (at-least-once delivery), so the same join or leave can
// arrive twice. `leave` is naturally idempotent (it closes the newest open
// session; a second one finds none) and `death` has its own +/-3 min dedupe, but
// `join` used to insert a fresh events row AND a fresh open session every time,
// so one retried tick opened a second, never-closed session and double-counted
// the arrival — inflating playtime forever.
//
// The guard has two halves, and both are needed:
//   1. EXACT redelivery (type + character + created_at). The poller stamps
//      occurredAt from the log line itself, so a replay is byte-identical to
//      the original. A genuine re-join a second later has a different timestamp
//      and is deliberately NOT suppressed.
//   2. NEAR MISS (this file's rejoin grace). A retry whose timestamp shifted, or
//      a join arriving while a session for this character is still open (the
//      poller's own reconnect can produce one).

/**
 * A join within this much of an already-open session's start is the SAME join
 * arriving again, not a real second arrival.
 */
export const REJOIN_GRACE_MS = 60_000;

/**
 * Only join/leave carry presence, and only a named event can be matched.
 * A type guard, so the caller keeps the narrowing the inline check gave it.
 */
export function shouldReplayGuard(
  type: string,
  characterName: string | null,
): characterName is string {
  return (type === 'join' || type === 'leave') && !!characterName;
}

/**
 * Is the open session we found the very join being processed?
 *
 * Unparseable timestamps answer FALSE, which opens a session rather than
 * swallowing one: a duplicated join is a smaller problem than a missed one, and
 * that is the same way the exact-match half fails.
 */
export function isSameJoin(
  occurredAtMs: number,
  openJoinedAtIso: string | null | undefined,
  graceMs: number = REJOIN_GRACE_MS,
): boolean {
  if (!openJoinedAtIso) return false;
  const openedMs = new Date(openJoinedAtIso).getTime();
  if (!Number.isFinite(occurredAtMs) || Number.isNaN(openedMs)) return false;
  return Math.abs(occurredAtMs - openedMs) <= graceMs;
}

/**
 * Minutes to stamp on a session being closed: rounded, never negative (a leave
 * that somehow predates its join reads 0, not a negative playtime).
 *
 * An unparseable joined_at yields NaN, which is what the handler has always
 * produced and what the Supabase client serializes to a null duration_minutes.
 * That is deliberately preserved here: an honest empty column beats a
 * fabricated duration, and callers that want a number can check it.
 */
export function sessionDurationMinutes(joinedAtIso: string, leftAtMs: number): number {
  const joinedMs = new Date(joinedAtIso).getTime();
  return Math.max(0, Math.round((leftAtMs - joinedMs) / 60000));
}
