// The one place that answers "does this character belong on a public board?".
//
// WHY A MODULE AND NOT AN `.eq('excluded', false)` ON EVERY QUERY. Exclusion has
// to hold at two different kinds of read site, and a PostgREST filter only works
// at one of them:
//
//   • Roster reads DO join `players`, so they could filter in the database — but
//     `players.excluded` (db/2026-09-11_players_excluded.sql) may not be applied
//     yet, and a predicate naming a column that does not exist fails the WHOLE
//     query. A site that 500s until a migration lands is worse than one that
//     shows an alt for an afternoon.
//   • Aggregation reads DO NOT. `sessions`, `events` and the bot's tallies are
//     keyed by `character_name` with no join at all, and player_stats is keyed by
//     `player_id`. Nothing there can be filtered by a column on another table
//     without a second round trip.
//
// So the rule lives in JS, takes BOTH signals, and treats either as decisive:
// the flag when the row carries it, the name list (config/server.ts
// EXCLUDED_CHARACTER_NAMES) always. That also means the name list alone is a
// working exclusion before the migration is applied, which is what makes the
// rollout safe in either order.
//
// The Discord bot mirrors this file at services/discord-bot/src/excluded.js —
// it is a plain-JS service and cannot import TypeScript. Keep the two in step.

import { EXCLUDED_CHARACTER_NAMES } from '@/config/server';

/** Anything with a name and/or the flag: a players row, a session, an event, a tally key. */
export interface MaybeExcluded {
  character_name?: string | null;
  excluded?: boolean | null;
}

/**
 * Fold a character name to its comparison key: trimmed and case-folded, the same
 * rule the identity guard uses for "is this the same viking". A name that differs
 * only in case or padding must not slip past the list.
 */
function nameKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

const EXCLUDED_KEYS: ReadonlySet<string> = new Set(
  EXCLUDED_CHARACTER_NAMES.map((n) => nameKey(n)).filter(Boolean),
);

/** Is this character name on the config fallback list? Empty/blank is never excluded. */
export function isExcludedName(name: string | null | undefined): boolean {
  const key = nameKey(name);
  return key !== '' && EXCLUDED_KEYS.has(key);
}

/**
 * Is this row excluded from public/competitive surfaces?
 *
 * True when the database flag says so (`excluded === true`) OR the character's
 * name is on the config list. Deliberately NOT `!== false`: a row read without
 * the column (pre-migration, or a narrow select that never asked for it) carries
 * `undefined`, and treating that as excluded would empty every board.
 */
export function isExcludedPlayer(row: MaybeExcluded | null | undefined): boolean {
  if (!row) return false;
  if (row.excluded === true) return true;
  return isExcludedName(row.character_name);
}

/** Drop every excluded row, preserving order. The default filter for any public read. */
export function filterExcluded<T extends MaybeExcluded>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => !isExcludedPlayer(r));
}

/**
 * The excluded rows themselves — used to learn the `player_id`s that must be
 * dropped from `player_stats`, which carries no name of its own.
 */
export function onlyExcluded<T extends MaybeExcluded>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => isExcludedPlayer(r));
}

/**
 * Drop rows whose `player_id` belongs to an excluded character.
 *
 * `player_stats` has no `character_name`, so the caller resolves the excluded ids
 * from the roster first. A row with no usable id is KEPT: an orphan stat row is
 * an ingest problem, not evidence of exclusion, and silently dropping it would
 * quietly shrink every Great Deed aggregate.
 */
export function filterExcludedByPlayerId<T extends { player_id?: string | null }>(
  rows: readonly T[] | null | undefined,
  excludedIds: ReadonlySet<string>,
): T[] {
  if (excludedIds.size === 0) return [...(rows ?? [])];
  return (rows ?? []).filter((r) => {
    const id = r.player_id;
    return !(typeof id === 'string' && excludedIds.has(id));
  });
}
