// Ops cockpit auth — a stateless signed-cookie session, keyed by OPS_PASSWORD.
//
// There is no user table and no separate signing secret: the single shared
// OPS_PASSWORD both (a) is what a human types to log in and (b) is the HMAC key
// that signs the session cookie. A valid cookie is therefore proof the holder
// once presented the password, and it can't be forged without the password.
//
// FAIL CLOSED is the load-bearing property: if OPS_PASSWORD is unset in the
// environment, verifyPassword() and verifySession() BOTH always return false, so
// login can never succeed and the /admin/ops page always redirects to login —
// never a 500, never an accidentally-open cockpit.
//
// PURE (node:crypto only) so it unit-tests without Next. The route handlers own
// the actual cookie read/write via next/headers; this module only mints and
// verifies the cookie VALUE and checks the password.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'ops_session';
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // ~7 days
const VERSION = 'v1';

/** Cookie options shared by set (login) and clear (logout). */
export function cookieOptions(maxAgeSec: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}

/** The signing key, or null when OPS_PASSWORD is unset/empty (→ fail closed). */
function secret(): string | null {
  const p = process.env.OPS_PASSWORD;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/**
 * Length-independent constant-time string compare. Hashing both sides to a fixed
 * 32-byte digest first means timingSafeEqual never throws on a length mismatch
 * and the comparison itself leaks no length information.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** True only when OPS_PASSWORD is set AND `provided` matches it (constant-time). */
export function verifyPassword(provided: unknown): boolean {
  const key = secret();
  if (!key) return false; // fail closed
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return safeEqual(provided, key);
}

/**
 * Mint a signed session cookie value, or null when fail-closed (no password).
 * Format: `v1.<expEpochSec>.<hmacHex>`.
 */
export function signSession(nowMs: number = Date.now()): string | null {
  const key = secret();
  if (!key) return null; // fail closed
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SEC;
  const payload = `${VERSION}.${exp}`;
  const sig = createHmac('sha256', key).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verify a session cookie value. Returns false when fail-closed (no password),
 * when the value is malformed, when the signature doesn't match, or when expired.
 */
export function verifySession(
  cookieVal: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const key = secret();
  if (!key) return false; // fail closed
  if (typeof cookieVal !== 'string' || cookieVal.length === 0) return false;

  const parts = cookieVal.split('.');
  if (parts.length !== 3) return false;
  const [version, expStr, sig] = parts;
  if (version !== VERSION) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;

  const payload = `${version}.${expStr}`;
  const expected = createHmac('sha256', key).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) return false;

  // Expiry check comes last so a forged/short cookie fails on the signature.
  if (Math.floor(nowMs / 1000) > exp) return false;
  return true;
}
