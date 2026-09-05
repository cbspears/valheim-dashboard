// Viking identity guard (audit security-3).
//
// Valheim allows DUPLICATE character names and never verifies them: anyone can
// roll a second character literally called "Alice", join, and every name-keyed
// write path (oath, pin, the /oath CODE Discord link, presence) would happily
// file it under the real Alice. The only stable identity the dedicated server
// gives us is the connecting SteamID, which the log poller already pairs with a
// character name ("Got connection SteamID <id>" → the next "Got character ZDOID
// from <name>"). It forwards that pairing as `steamId` on join/leave/oath/pin.
//
// This module is the whole decision, kept pure so it can be tested without a
// database (see identity-guard.test.mjs). The route does the I/O.
//
//   boundSteamId — players.steam_id for that character row (null = unclaimed)
//   seenSteamId  — the SteamID the poller currently pairs with that NAME
//   hasPairing   — whether the poller had a pairing at all for this event
//
// FIRST SIGHT BINDS: the first Steam account to join under a name owns that
// name until an admin releases it (`update players set steam_id = null where
// character_name = '<name>'`). That is deliberate — there is no better anchor —
// and it is why the launch wipe matters: after it, every name re-binds fresh.

/**
 * `bind`     — nobody owns this name yet; record the SteamID we just saw.
 * `match`    — the bound SteamID is the one currently playing this name.
 * `mismatch` — this name is bound to a DIFFERENT Steam account. Freeze the
 *              name-keyed write paths and alert; never overwrite the binding.
 * `unknown`  — no usable pairing (e.g. a shout captured before the join line
 *              was seen, or a producer that doesn't send `steamId`). ALLOW:
 *              this guard must never invent a false positive.
 */
export type IdentityDecision = 'bind' | 'match' | 'mismatch' | 'unknown';

export interface IdentityInput {
  /** players.steam_id for this character row, null when unclaimed. */
  boundSteamId?: string | null;
  /** SteamID the poller pairs with this character name right now. */
  seenSteamId?: string | null;
  /** False when the poller had no pairing for the name at all. */
  hasPairing?: boolean;
}

function normalize(id: string | null | undefined): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

/** Decide what a name-keyed write may do, given who owns the name. */
export function decideIdentity({
  boundSteamId,
  seenSteamId,
  hasPairing,
}: IdentityInput): IdentityDecision {
  const seen = normalize(seenSteamId);
  // No pairing (or an empty/junk one) is not evidence of anything.
  if (hasPairing === false || !seen) return 'unknown';
  const bound = normalize(boundSteamId);
  if (!bound) return 'bind';
  return bound === seen ? 'match' : 'mismatch';
}

/** True for the one decision that must block a name-keyed write. */
export function isIdentityMismatch(input: IdentityInput): boolean {
  return decideIdentity(input) === 'mismatch';
}
