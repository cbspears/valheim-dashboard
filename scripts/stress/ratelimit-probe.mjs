#!/usr/bin/env node
// How much room does ONE producer actually have?
//
// lib/rate-limit.ts gives every IP 60 requests per 60 seconds, refilling
// linearly, and lib/rate-limit.ipFromRequest keys on the first `x-forwarded-for`
// hop. That means all of these share ONE bucket:
//
//   • the log poller — every join, leave, death, position, chat mirror, oath,
//     pin and roster sync for the WHOLE server, from one process on one machine;
//   • the game server's Emitter — one address for every server payload.
//
// A player's own client mod posts from that player's own address, so the client
// paths have 60/min each and are never the problem. The poller is.
//
// This probe measures the real budget at real-time cadence (no simulated clock,
// no compression), which is the only way the number means anything: it fires a
// burst from one address, records where the 429s begin, then measures the steady
// rate that address can sustain.
//
// Usage (local stack only):
//   BASE_URL=http://localhost:3400 WEBHOOK_SECRET=stress-secret \
//     node scripts/stress/ratelimit-probe.mjs

const base = process.env.BASE_URL || 'http://localhost:3400';
const secret = process.env.WEBHOOK_SECRET || 'stress-secret';
const ip = process.env.PROBE_IP || '203.0.113.99';
const burst = parseInt(process.env.BURST || '90', 10);

// Loopback HOSTNAME, not the substring — "localhost.example.com" contains it.
let probeHost = null;
try {
  probeHost = new URL(base).hostname;
} catch { /* handled below */ }
if (!['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(probeHost)) {
  console.error(`Refusing to probe a non-loopback BASE_URL (${base}).`);
  process.exit(2);
}

// `sync` with an empty roster is the cheapest webhook shape that still goes all
// the way through auth + the rate limiter without writing a feed row.
const body = JSON.stringify({ type: 'sync', metadata: { online: [], serverOnline: true } });

async function hit() {
  const res = await fetch(`${base}/api/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret, 'x-forwarded-for': ip },
    body,
  });
  return res.status;
}

console.log(`[probe] one address (${ip}), burst of ${burst} against ${base}/api/webhook`);
const codes = [];
for (let i = 0; i < burst; i++) codes.push(await hit());
const firstRefusal = codes.findIndex((c) => c === 429);
const accepted = codes.filter((c) => c === 200).length;
console.log(`[probe] burst: ${accepted}/${burst} accepted; first 429 at request #${firstRefusal + 1}`);

console.log('[probe] now measuring the sustained rate for 60s (1 request per second)...');
let ok = 0;
let refused = 0;
const start = Date.now();
while (Date.now() - start < 60_000) {
  const s = await hit();
  if (s === 200) ok++;
  else refused++;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`[probe] sustained 1/s for 60s: ${ok} accepted, ${refused} refused.`);
console.log(
  '[probe] budget for ONE address = 60 requests / 60 s. At 20 players the log poller sends roughly ' +
    '20 position posts + the chat mirror + joins/leaves/deaths + a roster sync every minute, all from ' +
    'that single address.',
);

// ── phase 3: the catch-up batch ──────────────────────────────────────────────
//
// What happens when the poller comes back from an outage with more than a
// minute's worth of log to replay. services/log-poller/src/poller.js:235 throws
// on ANY non-2xx, and tick() (poller.js:249) catches that, RESTORES the byte
// cursor and rethrows — so the whole batch is re-read and re-posted on the next
// tick. This reproduces exactly that loop: a batch bigger than the bucket, an
// all-or-nothing dispatch, and a rewind on the first refusal.
//
// Bounded to five cycles. A real poller has no bound.
const batchSize = parseInt(process.env.BATCH || '75', 10);
// A SEPARATE address from phase 1/2, so this phase starts on a full bucket
// rather than whatever the first two minutes left behind — and settable, so two
// probe runs inside a minute do not share a partly-drained one. (The old form
// rewrote whatever PROBE_IP was given into <prefix>.98, which silently ignored
// the environment and made tick 1's number depend on run history.)
const probeIp2 = process.env.PROBE_IP_BATCH || '203.0.113.98';
if (probeIp2 === ip) {
  console.warn(
    `[probe] WARNING: PROBE_IP_BATCH (${probeIp2}) is the same address as PROBE_IP. Phase 3 will start on a ` +
      'bucket phases 1 and 2 already drained, so tick 1 will under-report. Use a different address.',
  );
}
console.log(`\n[probe] catch-up batch: ${batchSize} events in one tick from ${probeIp2}, poller semantics (rewind on any non-2xx)`);

async function hit2() {
  const res = await fetch(`${base}/api/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret, 'x-forwarded-for': probeIp2 },
    body,
  });
  return res.status;
}

let drained = false;
for (let cycle = 1; cycle <= 5; cycle++) {
  let delivered = 0;
  let failedAt = null;
  for (let i = 0; i < batchSize; i++) {
    const s = await hit2();
    if (s !== 200) {
      failedAt = i + 1;
      break;
    }
    delivered++;
  }
  if (failedAt === null) {
    console.log(`[probe] tick ${cycle}: all ${batchSize} delivered — cursor advances, batch drains.`);
    drained = true;
    break;
  }
  console.log(
    `[probe] tick ${cycle}: delivered ${delivered}/${batchSize}, refused at #${failedAt} — ` +
      `poller rewinds the cursor and re-reads the SAME batch (plus whatever the log gained meanwhile).`,
  );
  await new Promise((r) => setTimeout(r, 20_000)); // the poller's POLL_INTERVAL_MS
}
if (!drained) {
  console.log(
    '[probe] the batch never drained in five ticks. In production that is joins, leaves, deaths, chat ' +
      'and the roster sync all stopped, with the batch growing every cycle.',
  );
}
