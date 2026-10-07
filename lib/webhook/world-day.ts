// The in-game world day stamped onto feed events — the PURE half of
// /api/webhook §4.
//
// WHY. The Story page (lib/episodes.ts) reads `events.metadata.world_day` to
// say "the world at day N", but until 2026-10-07 nothing wrote it, so every
// night's day range was null. The live day already lives in
// `server_status.world_day` (GsValheimStats emitter, see lib/map-replay.ts),
// so the webhook copies it onto each event as it is recorded.
//
// THE GATE, in order:
//   1. The event already carries metadata.world_day → left exactly as sent.
//   2. The request body carries `worldDay` → that (it is the freshest source
//      there is, and §6 is about to write it to server_status anyway).
//   3. Otherwise the single server_status row, ONLY if its updated_at is within
//      WORLD_DAY_FRESH_MS of the event's own time. A stale row (server down, a
//      catch-up batch of old log lines) means NO stamp: a missing day just drops
//      the "Day N" phrase, a wrong one prints a false fact.

export const WORLD_DAY_FRESH_MS = 15 * 60_000;

function validDay(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : undefined;
}

/** True when the event's own metadata already names its world day. */
export function hasWorldDay(metadata: Record<string, unknown> | null | undefined): boolean {
  return validDay(metadata?.world_day) !== undefined;
}

/**
 * The day a server_status row vouches for at `occurredAtMs`, or undefined when
 * the row is missing, unreadable, malformed or not fresh.
 */
export function worldDayFromStatus(
  row: { world_day?: unknown; updated_at?: unknown } | null | undefined,
  occurredAtMs: number,
  freshMs: number = WORLD_DAY_FRESH_MS,
): number | undefined {
  if (!row) return undefined;
  const day = validDay(row.world_day);
  if (day === undefined) return undefined;
  const updated = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
  if (!Number.isFinite(updated) || !Number.isFinite(occurredAtMs)) return undefined;
  return Math.abs(occurredAtMs - updated) <= freshMs ? day : undefined;
}

/** metadata with world_day added — never overwrites one the producer sent. */
export function stampWorldDay(
  metadata: Record<string, unknown>,
  day: number | undefined,
): Record<string, unknown> {
  if (day === undefined || hasWorldDay(metadata)) return metadata;
  return { ...metadata, world_day: day };
}
