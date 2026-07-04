// Caption → map-pin matching (the gallery ↔ map link).
//
// A community photo attaches to a place when the place's pin name appears in the
// photo caption ("sunset at Draugheim" → the "Draugheim" pin). Rules:
//   • case-insensitive
//   • whole-word / phrase boundary (unicode-aware) so "Draugheim" doesn't match
//     inside "Draugheimr", but "at Draugheim." (trailing punctuation) still does
//   • longest pin name wins when several match (so "High Ulfir" beats "Ulfir")
//   • an "at <place>" phrasing is a hint, not a requirement — a bare mention matches
//
// This mirrors services/discord-bot/src/pinMatch.js (the bot runs standalone
// Node, can't import this TS module). Keep the two in sync.

export interface MatchablePin {
  id: string;
  name: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the pin whose name best matches `caption`, or null. "Best" = the
 * longest pin name that appears as a bounded word/phrase (case-insensitive).
 */
export function matchPinInCaption<T extends MatchablePin>(
  caption: string | null | undefined,
  pins: T[]
): T | null {
  if (!caption || !caption.trim() || !pins?.length) return null;
  // Longest names first so the most specific place wins on a tie.
  const candidates = pins
    .filter((p) => p?.name && p.name.trim())
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const pin of candidates) {
    const name = pin.name.trim();
    // Unicode boundary: the name must not be flanked by another letter/number,
    // so accented place names (Draugheim, Æsirholm) and multi-word names work.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(caption)) return pin;
  }
  return null;
}
