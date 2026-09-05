// Best-effort, in-memory per-IP token bucket.
//
// PER SERVERLESS INSTANCE, best-effort only: the bucket map lives in module
// memory, so each Vercel lambda instance has its own copy and every cold start
// resets it. This is a coarse abuse throttle to blunt a flood from a single
// source — NOT a global, durable guarantee. Limits are deliberately generous:
// honest game mods post every ~120s, so 60 requests / 60s / IP never trips a
// real emitter while still capping a runaway or malicious caller.
//
// The one caller that DOES trip it is the log poller, which funnels a whole
// server's events through a single address — see the two-tier webhook budget at
// the bottom of this file.

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

// Soft cap so a stream of unique spoofed IPs can't grow the map without bound
// (best-effort — on overflow we just drop the oldest-cleared state and start over).
const MAX_BUCKETS = 10_000;

/** First hop of `x-forwarded-for` (the original client) or a stable fallback. */
export function ipFromRequest(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Consume one token for `ip`. Returns true when the request is allowed, false
 * when the bucket is empty (caller should answer 429). Tokens refill linearly
 * at `limit` per `windowMs`.
 */
export function rateLimit(ip: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const refillPerMs = limit / windowMs;

  const existing = buckets.get(ip);
  if (!existing) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    buckets.set(ip, { tokens: limit - 1, updatedAt: now });
    return true;
  }

  // Refill proportional to elapsed time, capped at the bucket size.
  const refilled = Math.min(limit, existing.tokens + (now - existing.updatedAt) * refillPerMs);
  existing.updatedAt = now;
  if (refilled < 1) {
    existing.tokens = refilled;
    return false;
  }
  existing.tokens = refilled - 1;
  return true;
}

// ---- Two-tier webhook budget (stress-1) -------------------------------------
//
// /api/webhook is not like the public routes. Every join, leave, death,
// position, chat mirror, oath, pin and roster sync for the WHOLE server arrives
// from ONE address — the log poller is a single process on a single machine —
// and the poller's delivery is all-or-nothing: a non-2xx anywhere in a batch
// rewinds its byte cursor and re-sends the whole batch next tick. Under the
// flat 60/min that made a catch-up batch larger than 60 events undrainable:
// 60 accepted, one refused, rewind, and the next tick could only ever push
// another 20 (the refill rate) before being refused again. Measured at 20
// players the poller sends ~21 posts per minute, so roughly three minutes of
// backlog was enough to wedge the pipeline permanently.
//
// The route is already gated by WEBHOOK_SECRET, so the IP bucket is not what
// protects it — the secret is. The budget is therefore split in two, on two
// SEPARATE keys so neither can drain the other:
//
//   • a caller that presented the right secret gets WEBHOOK_AUTHED_LIMIT
//     (1200/min = 20/s), roughly 57x the measured steady-state load, which
//     leaves room for an hour of backlog to drain in one tick while still
//     capping a runaway emitter;
//   • everyone else keeps the strict WEBHOOK_UNAUTHED_LIMIT (60/min), and that
//     bucket is consumed BEFORE the 401 is returned, so brute-forcing the
//     secret is still throttled at sixty guesses a minute per address.

/** Requests per minute for a caller that presented the shared secret. */
export const WEBHOOK_AUTHED_LIMIT = 1200;
/** Requests per minute for a caller that did not (brute-force throttle). */
export const WEBHOOK_UNAUTHED_LIMIT = 60;
/** The window both budgets are measured over. */
export const WEBHOOK_WINDOW_MS = 60_000;

/**
 * The bucket a webhook caller draws from. Authenticated and unauthenticated
 * traffic from the same address are deliberately DIFFERENT keys: a flood of
 * bad-secret requests from a spoofed x-forwarded-for must not be able to empty
 * the poller's bucket and wedge the pipeline.
 */
export function webhookRateKey(ip: string, authenticated: boolean): string {
  return `${authenticated ? 'webhook:auth' : 'webhook:anon'}:${ip}`;
}

/** The limit that applies to one webhook caller. */
export function webhookRateLimitFor(authenticated: boolean): number {
  return authenticated ? WEBHOOK_AUTHED_LIMIT : WEBHOOK_UNAUTHED_LIMIT;
}

/**
 * Consume one token from the caller's webhook bucket. Returns true when the
 * request may proceed, false when the caller should get a 429.
 */
export function webhookRateLimit(ip: string, authenticated: boolean): boolean {
  return rateLimit(
    webhookRateKey(ip, authenticated),
    webhookRateLimitFor(authenticated),
    WEBHOOK_WINDOW_MS
  );
}
