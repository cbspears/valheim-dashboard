// Tests for the token bucket and, mainly, for the TWO-TIER webhook budget.
//
// The defect these encode (stress-1): /api/webhook is the one route where a
// single address legitimately carries a whole server's traffic — the log poller
// is one process on one machine, posting every join, leave, death, position,
// chat mirror, oath, pin and roster sync. Its delivery is all-or-nothing, so a
// flat 60/min made any catch-up batch of more than 60 events permanently
// undrainable. The route is gated by WEBHOOK_SECRET, so the budget now depends
// on whether the caller presented it — on two SEPARATE buckets, so a flood of
// bad-secret requests can never drain the poller's.
//
//   npx tsx lib/rate-limit.test.mjs

import {
  rateLimit,
  ipFromRequest,
  webhookRateKey,
  webhookRateLimit,
  webhookRateLimitFor,
  WEBHOOK_AUTHED_LIMIT,
  WEBHOOK_UNAUTHED_LIMIT,
  WEBHOOK_WINDOW_MS,
} from './rate-limit.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

// Buckets live in module memory and are keyed by string, so every test uses a
// key nothing else touches.
let n = 0;
const freshIp = () => `198.51.100.${(n += 1)}-${Math.random()}`;

/** How many of `count` calls this key is allowed, back to back. */
function accepted(key, count, limit, windowMs) {
  let allowed = 0;
  for (let i = 0; i < count; i++) if (rateLimit(key, limit, windowMs)) allowed += 1;
  return allowed;
}

console.log('\nipFromRequest - who the bucket is keyed on');
eq(
  ipFromRequest(new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } })),
  '203.0.113.5',
  'the FIRST hop is the client'
);
eq(ipFromRequest(new Request('http://x/')), 'unknown', 'no header at all falls back to one shared bucket');
eq(
  ipFromRequest(new Request('http://x/', { headers: { 'x-forwarded-for': '  203.0.113.7  ' } })),
  '203.0.113.7',
  'and it is trimmed'
);

console.log('\nrateLimit - the bucket itself');
{
  const k = freshIp();
  eq(accepted(k, 10, 10, 60_000), 10, 'a full bucket accepts exactly its limit');
  ok(!rateLimit(k, 10, 60_000), 'and refuses the next one');
}
{
  const k = freshIp();
  eq(accepted(k, 100, 60, 60_000), 60, 'the old flat budget: 60 of 100 accepted');
}

console.log('\nThe two-tier webhook budget');
eq(WEBHOOK_UNAUTHED_LIMIT, 60, 'an unauthenticated caller keeps the strict 60/min');
eq(WEBHOOK_AUTHED_LIMIT, 1200, 'a caller with the secret gets 1200/min (20/s)');
eq(WEBHOOK_WINDOW_MS, 60_000, 'both are measured over one minute');
eq(webhookRateLimitFor(true), WEBHOOK_AUTHED_LIMIT, 'authenticated -> the generous limit');
eq(webhookRateLimitFor(false), WEBHOOK_UNAUTHED_LIMIT, 'unauthenticated -> the strict one');

ok(
  webhookRateKey('203.0.113.9', true) !== webhookRateKey('203.0.113.9', false),
  'the same address draws on two DIFFERENT buckets'
);
ok(webhookRateKey('a', true).includes('a'), 'and the key still carries the address');

console.log('\nThe catch-up batch that used to wedge the pipeline');
{
  // The reproduction from scripts/stress/ratelimit-probe.mjs phase 3: 75 events
  // in one tick, from one address, all-or-nothing.
  const ip = freshIp();
  let delivered = 0;
  for (let i = 0; i < 75; i++) {
    if (!webhookRateLimit(ip, true)) break;
    delivered += 1;
  }
  eq(delivered, 75, 'a 75-event catch-up batch drains in ONE tick');
}
{
  const ip = freshIp();
  let delivered = 0;
  for (let i = 0; i < 75; i++) {
    if (!rateLimit(`old-flat:${ip}`, 60, 60_000)) break;
    delivered += 1;
  }
  eq(delivered, 60, 'under the old flat budget it stalled at 60 — the bug, for the record');
}
{
  const ip = freshIp();
  // ~21 posts/min measured at 20 players; an hour of backlog is ~1260 events.
  let delivered = 0;
  for (let i = 0; i < 1200; i++) {
    if (!webhookRateLimit(ip, true)) break;
    delivered += 1;
  }
  eq(delivered, 1200, 'and so does an hour of it, up to the new ceiling');
  ok(!webhookRateLimit(ip, true), 'past the ceiling a runaway emitter is still capped');
}

console.log('\nBrute force is still throttled, and cannot starve the poller');
{
  const ip = freshIp();
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (webhookRateLimit(ip, false)) allowed += 1;
  eq(allowed, 60, 'sixty wrong-secret attempts a minute per address, then 429');
  ok(
    webhookRateLimit(ip, true),
    'and the poller, from that very same address, is untouched by the flood'
  );
}

console.log(
  failures === 0 ? '\nrate-limit: all checks passed\n' : `\nrate-limit: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
