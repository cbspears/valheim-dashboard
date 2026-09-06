// The bot's Supabase clients carry a fetch deadline (SUPABASE_FETCH_TIMEOUT_MS,
// 15 s). This is what that deadline has to be true of.
//
// THE BUG IT REGRESSES (launch-eve review, 2026-09-06). The first cut used
// `AbortSignal.timeout()`, which aborts with a **TimeoutError**. postgrest-js
// 2.108.2 only treats `name === 'AbortError'` (or `code === 'ABORT_ERR'`) as
// "do not retry", so a deadline hit looked like an ordinary network failure on
// a retryable method: it retried three more times, each with a fresh deadline,
// with 1 s / 2 s / 4 s of backoff in between. Measured against a stub server
// that never answers, with the deadline at 1500 ms: 13,004 ms and FOUR requests.
// At the shipped 15 s that is 67 s for one stalled read — four and a half relay
// ticks, not the one the comment promised.
//
// Run:
//   node scripts/supabase-deadline.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import http from 'node:http';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

const DEADLINE_MS = 700;
process.env.SUPABASE_FETCH_TIMEOUT_MS = String(DEADLINE_MS);

// A server that answers /fast at once and NEVER answers anything else, which is
// what a stalled Supabase connection looks like from here.
const hits = [];
const pending = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  req.resume();
  if (req.url.startsWith('/rest/v1/fast')) {
    res.setHeader('content-type', 'application/json');
    res.end('[]');
    return;
  }
  pending.push(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.SUPABASE_URL = base;
process.env.SUPABASE_ANON_KEY = 'anon-key-for-the-stub';
// The module reads the deadline at import time, so it is imported after the env
// is set — hence the dynamic import rather than a top-level one. A static
// `import` would be hoisted above the assignment above and silently test the
// 15 s default instead of this file's 700 ms.
const { readClient, fetchWithDeadline } = await import('../src/supabase.js');
const db = readClient();

// ── 1. a stalled read costs ONE deadline and ONE request ────────────────────
{
  hits.length = 0;
  const t0 = Date.now();
  const res = await db.from('events').select('*').gte('inserted_at', '2026-09-05T23:00:00.123456+00:00').limit(50);
  const elapsed = Date.now() - t0;

  eq(hits.length, 1, 'the deadline stops the request instead of retrying it three more times');
  ok(elapsed < DEADLINE_MS * 2.5,
    `a stalled read costs about one deadline, not four plus backoff (elapsed ${elapsed} ms)`);
  ok(res.error, 'and it comes back as an ordinary postgrest error');
  eq(res.data, null, 'with no data');
  ok(/AbortError/.test(res.error.message),
    'the abort reason is an AbortError — the name postgrest-js checks before deciding to retry');
  ok(/SUPABASE_FETCH_TIMEOUT_MS/.test(res.error.message),
    'and the message names the knob, so the journal says what to change');
  ok(/aborted/i.test(res.error.hint ?? ''),
    'postgrest recognises it well enough to fill in its own hint');
}

// ── 2. it is an ERROR RESULT, never an unhandled rejection ──────────────────
//
// Every loop in index.js handles `{ error }`; none of them would survive a
// rejected promise escaping a supabase-js call.
{
  eq(unhandled.length, 0, 'a cut-off Supabase call never becomes an unhandled rejection');
}

// ── 3. the gallery's storage upload degrades the same way ───────────────────
//
// src/gallery.js does `const { error: upErr } = await db.storage...upload(...)`
// and throws on upErr. A raw DOMException coming back instead would blow past
// that branch and out of a messageCreate handler.
{
  hits.length = 0;
  const t0 = Date.now();
  const { data, error } = await db.storage.from('gallery').upload('probe.webp', Buffer.from('x'), {
    contentType: 'image/webp',
    upsert: true,
  });
  ok(Date.now() - t0 < DEADLINE_MS * 2.5, 'a stalled upload is cut at the deadline too');
  eq(data, null, 'no data');
  ok(error, 'and storage-js hands back an error object rather than throwing a DOMException');
  eq(hits.length, 1, 'storage does not retry it either');
}

// ── 4. a caller-supplied signal does not disarm the deadline ────────────────
//
// The first cut composed signals with `AbortSignal.any` and fell back to
// `init.signal ?? deadline` when that helper was missing — silently dropping
// the deadline for any call that passed a signal of its own.
{
  const never = new AbortController(); // never aborted
  const t0 = Date.now();
  // Raced against a watchdog: if the deadline is dropped this call never
  // settles at all, and a hanging test is a test nobody can read the result of.
  const outcome = await Promise.race([
    fetchWithDeadline(`${base}/rest/v1/stall`, { signal: never.signal })
      .then(() => 'resolved', (e) => e?.name ?? 'threw'),
    new Promise((r) => { const t = setTimeout(() => r('NEVER SETTLED'), DEADLINE_MS * 4); t.unref?.(); }),
  ]);
  eq(outcome, 'AbortError', 'the deadline still fires when the caller supplied its own signal');
  ok(Date.now() - t0 < DEADLINE_MS * 2.5, 'and it fires on time');
}

// ── 5. the caller's own abort still wins, and still reads as an abort ───────
{
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 40);
  let name = null;
  try {
    await fetchWithDeadline(`${base}/rest/v1/stall`, { signal: ctl.signal });
  } catch (e) {
    name = e?.name;
  }
  eq(name, 'AbortError', "the caller's own abort still cancels the request");
}

// ── 6. a healthy response is untouched ─────────────────────────────────────
{
  hits.length = 0;
  const { data, error } = await db.from('fast').select('*');
  eq(error, null, 'a fast query is not affected by the deadline');
  ok(Array.isArray(data), 'and returns its rows');
  eq(hits.length, 1, 'in one request');
}

for (const res of pending) { try { res.destroy(); } catch { /* ignore */ } }
server.close();
eq(unhandled.length, 0, 'and nothing anywhere in this file rejected unhandled');
console.log(`supabase-deadline.test: ${passed} assertions passed`);
process.exit(0);
