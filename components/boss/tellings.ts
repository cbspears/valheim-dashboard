// Pure helpers for the war-room's saga slot. No React, no Supabase, so
// scripts/tellings-site.test.mjs can drive them directly.
//
// A boss may now carry several tellings (db/2026-09-06_boss_tellings.sql): the
// Skald's, written on the kill, and any a viking has told since with
// `@Eilif retell <Boss>: <text>`. Exactly one is `chosen`, and that is the one
// the page shows.

import type { BossTelling } from '@/lib/types';

/**
 * The telling the war-room shows: the chosen one, and otherwise the newest.
 *
 * The fallback is not decoration. `boss_tellings_one_chosen_idx` means choosing
 * a telling is two statements (clear the boss's flag, then set the new one), so
 * there is a real instant, and a real failure mode, in which a boss has rows and
 * none of them is chosen. Falling back to the newest keeps a saga on the page
 * through it.
 *
 * Rows arrive chosen-first, then newest first (lib/data.ts getBossTellings), so
 * the chosen one is inside the bounded window however old it is. The `find`
 * here does not depend on that ordering, which is the point: if the query ever
 * loses its `chosen` sort, this still shows the kept telling.
 */
export function pickTelling(tellings: BossTelling[]): BossTelling | null {
  if (!Array.isArray(tellings) || tellings.length === 0) return null;
  return tellings.find((t) => t.chosen) ?? tellings[0];
}

/** Everything except the one on show, in the order it came back. */
export function otherTellings(tellings: BossTelling[], shown: BossTelling | null): BossTelling[] {
  if (!Array.isArray(tellings)) return [];
  return shown ? tellings.filter((t) => t.id !== shown.id) : tellings;
}

/** "as told by Bren" / "as told by the Skald". */
export function byline(telling: BossTelling | null): string {
  if (!telling) return 'as told by the Skald';
  if (telling.source === 'skald') return 'as told by the Skald';
  const name = (telling.author_character ?? '').trim();
  return name ? `as told by ${name}` : 'as told by a viking';
}

/**
 * A telling, split into paragraphs on blank lines.
 *
 * Rendered as plain text nodes in <p> elements, never as markdown and never as
 * HTML: the text is whatever a player typed into a Discord message, stored raw
 * on purpose (services/discord-bot/src/tellings.js strips control characters
 * and caps the length, and nothing else). React escapes a text node, so `**` is
 * two asterisks here and a `<script>` is five words.
 */
export function splitParagraphs(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
