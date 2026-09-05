// Death dedupe window — the PURE half of /api/webhook's §2i guard.
//
// Two producers can report the SAME death: the canonical GsValheimStatsClient
// path (metadata.source === 'gs', carries a real cause) and the legacy SFTP
// log-poller path (parses "ZDOID ... 0:0" log lines, no cause — the server log
// has none). With both live, one death would otherwise write two events rows,
// and every consumer downstream doubles it: two Discord posts, two entries in
// How We Die, an inflated recap death board.
//
// The window is deliberately WIDE (+/-3 minutes) because the two producers can
// be minutes apart when a tick backs up, and because a real second death that
// fast is a corpse run that has barely begun. It is the outermost of three
// defenses; the Discord relay collapses at 10 s and lib/deaths.ts holds the
// ingest-side rule.

/** A second death report for one viking inside this window is the same death. */
export const DEATH_DEDUPE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Only a named death can be deduped — the query keys on the character name.
 * Written as a type guard so the caller keeps the narrowing the inline
 * `type === 'death' && characterName` check used to give it.
 */
export function shouldDedupeDeath(
  type: string,
  characterName: string | null,
): characterName is string {
  return type === 'death' && !!characterName;
}

/**
 * The inclusive ISO bounds to search events in, either order: a report can
 * arrive before OR after the one already recorded.
 */
export function deathDedupeBounds(
  occurredAtMs: number,
  windowMs: number = DEATH_DEDUPE_WINDOW_MS,
): { lowerBound: string; upperBound: string } {
  return {
    lowerBound: new Date(occurredAtMs - windowMs).toISOString(),
    upperBound: new Date(occurredAtMs + windowMs).toISOString(),
  };
}
