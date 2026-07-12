// Unit tests for ops auth: sign/verify + fail-closed when OPS_PASSWORD unset.
// Run: npx tsx lib/ops/auth.test.mjs
import assert from 'node:assert';
import {
  signSession,
  verifySession,
  verifyPassword,
  safeEqual,
  SESSION_TTL_SEC,
} from './auth.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const withPassword = (pw, fn) => {
  const prev = process.env.OPS_PASSWORD;
  if (pw === undefined) delete process.env.OPS_PASSWORD;
  else process.env.OPS_PASSWORD = pw;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.OPS_PASSWORD;
    else process.env.OPS_PASSWORD = prev;
  }
};

// ── safeEqual: constant-time, length-independent ──────────────────────────
{
  ok(safeEqual('abc', 'abc') === true, 'equal strings match');
  ok(safeEqual('abc', 'abd') === false, 'different strings differ');
  ok(safeEqual('short', 'a much longer string') === false, 'length mismatch → false, no throw');
}

// ── FAIL CLOSED: no OPS_PASSWORD → everything rejects ─────────────────────
withPassword(undefined, () => {
  ok(verifyPassword('anything') === false, 'verifyPassword false when unset');
  ok(signSession() === null, 'signSession null when unset');
  ok(verifySession('v1.9999999999.deadbeef') === false, 'verifySession false when unset');
});
withPassword('', () => {
  ok(verifyPassword('') === false, 'empty password env is treated as unset (reject)');
  ok(signSession() === null, 'signSession null when empty');
});

// ── Happy path: sign then verify round-trips ──────────────────────────────
withPassword('hunter2-correct-horse', () => {
  ok(verifyPassword('hunter2-correct-horse') === true, 'correct password accepted');
  ok(verifyPassword('wrong') === false, 'wrong password rejected');
  const cookie = signSession();
  ok(typeof cookie === 'string' && cookie.split('.').length === 3, 'cookie is v.exp.sig');
  ok(verifySession(cookie) === true, 'freshly signed cookie verifies');
});

// ── A cookie signed under one password does NOT verify under another ──────
{
  let cookie;
  withPassword('password-A', () => { cookie = signSession(); });
  withPassword('password-B', () => {
    ok(verifySession(cookie) === false, 'cookie from other password rejected (forgery guard)');
  });
  withPassword('password-A', () => {
    ok(verifySession(cookie) === true, 'same password still verifies its own cookie');
  });
}

// ── Malformed cookies rejected ────────────────────────────────────────────
withPassword('pw', () => {
  ok(verifySession('') === false, 'empty rejected');
  ok(verifySession(undefined) === false, 'undefined rejected');
  ok(verifySession('garbage') === false, 'no-dots rejected');
  ok(verifySession('v1.notanumber.sig') === false, 'bad exp rejected');
  ok(verifySession('v2.9999999999.sig') === false, 'wrong version rejected');
  ok(verifySession('v1.9999999999.tampered') === false, 'bad signature rejected');
});

// ── Expiry enforced ───────────────────────────────────────────────────────
withPassword('pw', () => {
  const nowMs = Date.now();
  const fresh = signSession(nowMs);
  // Verify far in the future → expired.
  const future = nowMs + (SESSION_TTL_SEC + 60) * 1000;
  ok(verifySession(fresh, future) === false, 'expired cookie rejected');
  ok(verifySession(fresh, nowMs + 1000) === true, 'still-valid cookie accepted');
});

console.log(`auth.test: ${passed} assertions passed`);
