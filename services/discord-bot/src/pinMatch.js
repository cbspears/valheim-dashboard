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
// This mirrors lib/pin-match.ts (the Next app / webhook side). Keep them in sync.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the pin ({ id, name, ... }) whose name best matches `caption`, or null.
 * "Best" = the longest pin name that appears as a bounded word/phrase.
 * @param {string|null|undefined} caption
 * @param {Array<{id:string,name:string}>} pins
 */
export function matchPinInCaption(caption, pins) {
  if (!caption || !caption.trim() || !Array.isArray(pins) || pins.length === 0) return null;
  const candidates = pins
    .filter((p) => p && p.name && p.name.trim())
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const pin of candidates) {
    const name = pin.name.trim();
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(caption)) return pin;
  }
  return null;
}
