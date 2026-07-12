// Best-effort, in-memory per-IP token bucket.
//
// PER SERVERLESS INSTANCE, best-effort only: the bucket map lives in module
// memory, so each Vercel lambda instance has its own copy and every cold start
// resets it. This is a coarse abuse throttle to blunt a flood from a single
// source — NOT a global, durable guarantee. Limits are deliberately generous:
// honest game mods post every ~120s, so 60 requests / 60s / IP never trips a
// real emitter while still capping a runaway or malicious caller.

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
