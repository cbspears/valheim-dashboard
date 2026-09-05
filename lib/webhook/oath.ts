// Oath text parsing — the PURE half of /api/webhook's `oath` branch.
//
// The route keeps every database call; everything here is string work that used
// to be written inline inside the handler, where it could only be exercised by
// posting a real oath at a real Supabase. Extracted verbatim (same regexes, same
// order of operations) so it can be tested directly — see oath.test.mjs.
//
// The shape of a sworn oath, as the bot's DM and the /oath page both describe it:
//
//     /s /oath ABCDEF - your vow, one line
//     ^^^^^^^^ ^^^^^^ ^ ^^^^^^^^^^^^^^^^^^
//     shout    code   separator  the oath itself
//
// The code is optional (only a first-time identity link carries one) and the
// separator is whatever the player copied out of the instructions.

/**
 * The one-time identity claim code alphabet: six characters from an
 * unambiguous set (no I, O, 0, 1) minted by the Discord bot into
 * identity_claims. Anchored, so only a whole token can ever look like a code.
 */
export const CLAIM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * Separators the published instructions can put between the code and the vow.
 * An oath's real first character is never one of these, which is what makes the
 * unconditional strip below safe: em dash, en dash, hyphen, colon, whitespace.
 *
 * WHY IT MATTERS: stripping only the code token left the dash on the front of
 * the stored oath, and the signature wall really did read
 * "<dash> I SWEAR TO ALWAYS WANDER OFF" for a live player.
 */
const LEADING_SEPARATORS = /^[\s\u2014\u2013\-:]+/;

/** The first whitespace-delimited token of an oath (may be ''). */
export function firstOathToken(text: string): string {
  return text.split(/\s+/)[0] ?? '';
}

/** True when a token has the SHAPE of a claim code (not that one exists). */
export function isClaimCode(token: string): boolean {
  return CLAIM_CODE_PATTERN.test(token);
}

/**
 * Drop any leading separator run and surrounding whitespace.
 *
 * Idempotent: after one pass the string cannot start with a separator, so the
 * route's belt-and-braces second call is a no-op (it exists for the player who
 * types the dash WITHOUT a live code — already consumed, or a later re-swear).
 */
export function stripLeadingSeparators(text: string): string {
  return text.replace(LEADING_SEPARATORS, '').trim();
}

/**
 * Remove a consumed claim code from the front of an oath, along with the
 * separator that followed it, leaving the vow itself.
 *
 * Only ever called once a claim has actually been consumed — a token that
 * merely LOOKS like a code but matched no live claim stays in the oath text,
 * exactly as before.
 */
export function stripClaimCode(text: string, token: string): string {
  return stripLeadingSeparators(text.slice(token.length));
}

/** Normalize the inbound `text` field the same way the route always has. */
export function normalizeOathText(text: unknown): string {
  return typeof text === 'string' ? text.trim() : '';
}
