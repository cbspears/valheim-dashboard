// Unit tests for the ops redactor. Run: npx tsx lib/ops/redact.test.mjs
import assert from 'node:assert';
import { sanitize, sanitizeMetrics } from './redact.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── Secrets are stripped ──────────────────────────────────────────────────
{
  const s = sanitize('failed with token=abcdef123456ghijkl on retry');
  ok(!s.includes('abcdef123456ghijkl'), `token value stripped, got: ${s}`);
  ok(s.includes('token=[redacted]'), `token label kept, got: ${s}`);
}
{
  const s = sanitize('Authorization: Bearer sk-verysecretvalue0987654321abcdef');
  ok(!s.toLowerCase().includes('verysecret'), `bearer stripped, got: ${s}`);
}
{
  // JWT-shaped
  const jwt = 'eyJhbGciOiJIUzI1Ni000000.eyJzdWIiOiIxMjM0NTY3.SIG_aaaaaaaaaa';
  const s = sanitize(`error jwt ${jwt}`);
  ok(!s.includes('eyJhbGci'), `jwt stripped, got: ${s}`);
}
{
  // long hex blob
  const s = sanitize('sha ' + 'a'.repeat(40));
  ok(s.includes('[redacted]') && !s.includes('a'.repeat(40)), `long hex stripped, got: ${s}`);
}
{
  // long base64 blob
  const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';
  const s = sanitize(`key ${blob}`);
  ok(!s.includes(blob), `base64 blob stripped, got: ${s}`);
}

// ── Ordinary prose survives ───────────────────────────────────────────────
{
  const s = sanitize('the log poller could not reach the SFTP host after 3 tries');
  ok(s.includes('SFTP host') && s.includes('3 tries'), `prose preserved, got: ${s}`);
}

// ── Truncation + whitespace collapse ──────────────────────────────────────
{
  const s = sanitize('word  \n\t  spaced', 200);
  ok(s === 'word spaced', `whitespace collapsed, got: "${s}"`);
}
{
  const long = 'x'.repeat(500);
  const s = sanitize(long, 200);
  ok(s.length <= 200, `truncated to <=200, got ${s.length}`);
}

// ── Non-strings coerced safely ────────────────────────────────────────────
{
  ok(sanitize(null) === '', 'null → empty');
  ok(sanitize(undefined) === '', 'undefined → empty');
  ok(sanitize(42) === '42', 'number coerced');
}

// ── sanitizeMetrics: deep, strings redacted, numbers kept ─────────────────
{
  const m = sanitizeMetrics({
    lag: 12,
    ok: true,
    note: 'token=supersecretvalue1234567890',
    nested: { url: 'password=hunter2hunter2hunter2' },
    arr: ['bearer abcdefghijklmnopqrstuvwx', 5],
  });
  ok(m.lag === 12 && m.ok === true, 'numbers/booleans preserved');
  ok(!JSON.stringify(m).includes('supersecret'), 'nested string secret stripped');
  ok(!JSON.stringify(m).includes('hunter2hunter2'), 'deep secret stripped');
  ok(!JSON.stringify(m).includes('abcdefghijklmnopqrstuvwx'), 'array bearer stripped');
}
{
  ok(Object.keys(sanitizeMetrics('not an object')).length === 0, 'non-object → {}');
  ok(Object.keys(sanitizeMetrics(null)).length === 0, 'null → {}');
}

console.log(`redact.test: ${passed} assertions passed`);
