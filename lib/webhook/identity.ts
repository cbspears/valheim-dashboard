// Identity refusals — the PURE half of /api/webhook's two "this is not your
// viking" gates. The route keeps the reads and writes; the DECISION and the
// exact words of each refusal live here so they can be asserted in a test
// instead of only in production logs.
//
// Two independent bindings guard a character name, and they are released
// separately (release both when a viking is handed over wholesale):
//
//   players.steam_id        — first Steam account to join under the name (3b)
//   players.discord_user_id — the Discord account an /oath CODE bound to it (2e)
//
// Every message below is reproduced verbatim from the handler it was lifted
// out of; the log lines are what an admin greps for at 2am, so they must not
// drift.

import { createHash } from 'node:crypto';

/**
 * A short fingerprint of a Steam id, for a row THE PUBLIC CAN READ.
 *
 * WHY (T-3 audit, data-2). A mismatched join annotates its `events` row, and
 * `events` carries a `public read events` policy: anon holds SELECT on every
 * column including `metadata`, so
 * `events?metadata->>identity=eq.steam_mismatch&select=metadata` used to hand
 * both Steam64 ids to anyone holding the publishable key. That is exactly the
 * value db/2026-07-11_players_pii_revoke.sql took away from anon on the
 * `players` table — a real external account id the public site never uses, and
 * one you can paste straight into steamcommunity.com/profiles/<id>. The launch
 * wipe re-binds every name from scratch, which is when a mismatch gets likely.
 *
 * Twelve hex characters of sha256 is enough to tell two accounts apart in the
 * cockpit and in a journal line, and it is not a profile id. It is a
 * CORRELATION HANDLE, not a secret-grade digest: Steam64 ids are a small,
 * enumerable space, so anyone determined can grind candidates against it. The
 * operator never needs to — the full ids are in the journal line
 * (steamMismatchLog) and in players.steam_id, which the ops cockpit reads under
 * the service role.
 */
export function steamIdFingerprint(steamId: string | null | undefined): string | null {
  if (typeof steamId !== 'string') return null;
  const trimmed = steamId.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
}

/**
 * The metadata a mismatched join may carry on its (public) `events` row:
 * the marker plus a fingerprint of each side, never the ids themselves.
 */
export function steamMismatchMeta(
  boundSteamId: string | null | undefined,
  seenSteamId: string | null | undefined,
) {
  return {
    identity: 'steam_mismatch' as const,
    boundSteamIdHash: steamIdFingerprint(boundSteamId),
    seenSteamIdHash: steamIdFingerprint(seenSteamId),
  };
}

/** Escape ilike wildcards so a character name is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_]/g, (c) => `\\${c}`);
}

// ── Steam binding (oath + pin write gates, §2e / §2f) ───────────────────────

/**
 * The refusal a mismatched Steam binding logs. Names the release SQL because
 * this line IS the runbook entry: whoever reads it in the journal needs the fix
 * in the same breath.
 */
export function steamMismatchLog(
  type: string,
  characterName: string,
  boundSteamId: string | null,
  seen: string | null,
): string {
  return (
    `[webhook] STEAM MISMATCH ${type} ${characterName}: bound ${boundSteamId ?? 'null'} saw ${seen ?? 'null'} — ` +
    `write refused. Release it with: update players set steam_id = null where character_name = '${characterName}'`
  );
}

/**
 * The body a refused oath/pin returns. HTTP 200 is deliberate and lives in the
 * route: the log poller treats any non-2xx as a failed tick, rewinds its byte
 * cursor and re-reads the whole batch forever, so a permanently-refused write
 * would wedge the pipeline (joins, deaths and chat included) rather than
 * dropping one write. The refusal is in the body; both sides log it.
 */
export function steamMismatchBody(characterName: string) {
  return {
    ok: false,
    status: 'identity_mismatch',
    character: characterName,
    detail:
      'That character is bound to a different Steam account. An admin has to release it (players.steam_id) first.',
  };
}

// ── Discord binding (the one-time /oath claim code, §2e) ────────────────────

/**
 * `bind`   — nobody has claimed this character, or the SAME Discord account is
 *            re-linking (a re-shout, a reinstall, a fresh code). Allowed.
 * `refuse` — the character is already bound to a DIFFERENT Discord account.
 *            Refused; only an admin can move it.
 *
 * Valheim allows duplicate character names and never verifies them, so without
 * this anyone could roll a character called "Alice", join, shout their own claim
 * code as her, and pull her stats, deaths and pins under their own account.
 */
export type RelinkDecision = 'bind' | 'refuse';

export function decideRelink({
  boundDiscordUserId,
  claimDiscordUserId,
}: {
  /** players.discord_user_id already on the shouter's row (null = unclaimed). */
  boundDiscordUserId?: string | null;
  /** The Discord account the consumed claim code was minted for. */
  claimDiscordUserId: string;
}): RelinkDecision {
  const bound = boundDiscordUserId ?? null;
  if (bound && bound !== claimDiscordUserId) return 'refuse';
  return 'bind';
}

/** The refusal a blocked relink logs, release SQL included. */
export function relinkRefusalLog(
  characterName: string,
  boundDiscordUserId: string,
  claimDiscordUserId: string,
  shouterId: string | null | undefined,
): string {
  return (
    `[identity] refused relink of "${characterName}" — already linked to Discord ` +
    `${boundDiscordUserId}, claim code was minted for ${claimDiscordUserId}. An admin must release it ` +
    `(update players set discord_user_id = null where id = '${shouterId}') before it can move.`
  );
}

/**
 * The body a blocked relink returns. The claim is already consumed by the time
 * we get here (that UPDATE is the atomic check-and-consume), so this says so
 * plainly: the bot surfaces the status to whoever asked for the code.
 */
export function relinkRefusalBody(characterName: string) {
  return {
    ok: false,
    linked: false,
    status: 'character_already_linked',
    character: characterName,
    detail:
      'That character is already linked to a different Discord account. An admin has to release it first.',
  };
}
