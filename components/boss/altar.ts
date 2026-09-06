// Does this Forsaken have a real altar on the atlas? Pure, so
// scripts/boss-altar-link.test.mjs can drive it without a database.
//
// WHAT THIS REPLACED. The war-room used to decide with a hardcoded set:
//
//   // Bosses with a marked altar on the demo atlas
//   const BOSSES_ON_MAP = new Set(['eikthyr', 'the elder']);
//
// which was true of a demo atlas that /map stopped rendering ("intentionally NOT
// rendered here anymore", app/map/page.tsx). So Eikthyr and The Elder promised
// "The altar is marked on the atlas" and linked to a map with no altar on it,
// while every boss that DOES get a real altar pin today — /api/gs-ingest writes
// one of kind 'boss' named "<Boss> altar" at the war party's centroid when the
// boss falls — got no link at all. The set was also hardcoded, so it would have
// survived the launch wipe and carried both promises into launch night on a
// world where nothing had been charted (T-3 audit site-4).
//
// The pin's name and kind are lib/altar.ts's, imported rather than retyped: the
// route that writes the pin, the Discord bot's altar loop and this page all have
// to agree on the same string, and three copies of " altar" is how they stop
// agreeing.

import { ALTAR_PIN_KIND, altarPinName } from '@/lib/altar';

/** The shape this needs from a pin row; `LivePin` satisfies it. */
export interface AltarCandidatePin {
  name: string | null;
  /** The row's true `pins.kind` — 'boss' for an altar. */
  pinKind?: string | null;
}

/**
 * The altar pin for this boss, or null.
 *
 * Matching is case- and space-insensitive on BOTH sides. The boss name comes
 * from `bosses.name` and the pin name was built from it by altarPinName(), so
 * they normally match exactly — but a pin is also a thing a viking can create by
 * shouting `/pin`, the name column is free text, and a rename of a boss row (row
 * 8 has been renamed once already) would otherwise silently drop the link. The
 * `kind` check is what keeps a player's pin called "eikthyr altar" from being
 * read as the hall's own: only /api/gs-ingest writes kind 'boss'.
 */
export function findAltarPin<T extends AltarCandidatePin>(
  pins: T[] | null | undefined,
  bossName: string | null | undefined,
): T | null {
  const want = norm(altarPinName(bossName));
  if (!want) return null;
  return (pins ?? []).find((p) => p?.pinKind === ALTAR_PIN_KIND && norm(p?.name) === want) ?? null;
}

/** Lowercase, collapse runs of whitespace, trim. */
function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
