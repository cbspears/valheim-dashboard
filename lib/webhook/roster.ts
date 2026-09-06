// Roster reconciliation — the PURE half of /api/webhook's `sync` handling.
//
// The log poller sends `sync` every 120 s (services/log-poller SYNC_EVERY_MS)
// with `metadata.online` = the authoritative list of character names connected
// right now. The handler must end with exactly those names online, everyone else
// offline, and a players row existing for every name.
//
// WHY THIS IS A SEPARATE, TESTED FILE (2026-09-06). The handler used to do it
// with a sequential SELECT + UPDATE per name — 2N + 3 round trips, forty-three
// at a full hall of twenty, every two minutes. Collapsing that to one roster
// read plus set arithmetic is the right shape, but it moves the correctness of
// launch night's presence into the set arithmetic, and the write path cannot be
// exercised against production. So the arithmetic lives here, pure, and
// lib/webhook/roster.test.mjs drives it.
//
// THE RULE THAT MADE THIS NECESSARY: a character name is producer-supplied and
// must NEVER be interpolated into a PostgREST filter. postgrest-js's `.in()`
// wraps a value in double quotes only when it matches /[,()]/ and never escapes
// an embedded double quote, so a name like `x","Bren` inside an `in.(…)` list
// silently splits into two list entries and matches a row nobody asked for —
// HTTP 200, no error, wrong viking. Reading the whole roster (one row per
// viking, cap twenty) and intersecting HERE is correct for any string a game
// client can produce, and it is cheaper than the loop it replaced.

/** One `players` row, as much of it as reconciliation needs. */
export interface RosterRow {
  id: string;
  character_name: string;
  is_online: boolean | null;
}

/** What the handler should write, in ids and names — never in filters. */
export interface RosterPlan {
  /** Rows to mark online + touch last_seen_at. Ids, so no name goes in a filter. */
  onlineIds: string[];
  /** Rows marked online that this sync says are gone. Ids, same reason. */
  offlineIds: string[];
  /** Names with no players row at all, deduped, in first-seen order. */
  unseenNames: string[];
}

/**
 * Decide the three writes a `sync` implies, from the announced roster and the
 * `players` rows as they stand.
 *
 * Name matching is EXACT, which is what the per-name `.eq('character_name', …)`
 * loop this replaced did, so a name differing only in case is a different viking
 * here exactly as it was before.
 *
 * Duplicate roster rows for one name (the 2026-07-25 forked-row incident, 325
 * rows in a week) are all flipped together rather than one of them being picked
 * arbitrarily, so a fork cannot leave half a viking online.
 */
export function planRosterSync(onlineNames: string[], roster: RosterRow[]): RosterPlan {
  const online = new Set(onlineNames);
  const known = new Set(roster.map((r) => r.character_name));

  return {
    onlineIds: roster.filter((r) => online.has(r.character_name)).map((r) => r.id),
    // Only rows currently marked online are worth an UPDATE: a viking who was
    // already offline and is still offline should not cost a write.
    offlineIds: roster.filter((r) => r.is_online && !online.has(r.character_name)).map((r) => r.id),
    // Deduped: `metadata.online` is a producer-supplied array and nothing
    // upstream promises it holds each name once. Two copies of one new name
    // would otherwise be two rows in a single INSERT racing each other.
    unseenNames: [...new Set(onlineNames.filter((n) => !known.has(n)))],
  };
}
