// Tests for lib/supabase-fetch.ts — the retrying fetch we hand to every
// supabase-js client on the Vercel side.
//
// The defect these encode: Supabase's REST edge kills a cold path at 5 s and
// answers HTTP 504 (~0.25 % of calls). supabase-js treats that as a valid
// response — `{ data: null, error }` — so the route renders "no data" for a
// request that was never refused. Only a retry survives it, and the retry has
// to be picky: a plain INSERT re-sent after a 504 whose first attempt actually
// landed duplicates an `events` row, which is worse than the 504.
//
//   npx tsx scripts/supabase-fetch.test.mjs

import assert from 'node:assert';
import { retryingFetch, shouldRetry } from '../lib/supabase-fetch.ts';

let passed = 0;
function check(fn, msg) {
  fn();
  passed += 1;
  console.log(`  ok   ${msg}`);
}
const eq = (a, b, msg) => check(() => assert.strictEqual(a, b, msg), msg);
const ok = (cond, msg) => check(() => assert.ok(cond, msg), msg);

const URL_ROWS = 'https://proj.supabase.co/rest/v1/player_stats?select=*&name=eq.Ch%C3%A6rlie';
const UPSERT_HEADERS = { Prefer: 'resolution=merge-duplicates,return=minimal' };

/** A fake fetch that answers with the next status in the list, recording every call. */
function scripted(statuses) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return new Response(status === 200 ? '[{"kills":5}]' : 'gateway', { status });
  };
  fn.calls = calls;
  return fn;
}

/** A fake fetch that never answers — it only ever rejects when its signal aborts. */
function hangs(onCall) {
  const calls = [];
  const fn = (input, init) => {
    calls.push({ input, init });
    onCall?.(calls.length);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  fn.calls = calls;
  return fn;
}

const silent = () => {};
const fast = (extra = {}) => ({ baseDelayMs: 1, log: silent, ...extra });

// ── 1. the policy helper, with no socket in sight ────────────────────────────

eq(shouldRetry('GET', {}, 504), true, 'GET 504 retries');
eq(shouldRetry('get', {}, 502), true, 'method case is irrelevant');
eq(shouldRetry('HEAD', {}, 503), true, 'HEAD 503 retries');
eq(shouldRetry('GET', {}, null), true, 'a thrown network error on GET retries');
eq(shouldRetry('GET', {}, 500), false, '500 is Postgres answering — never retried');
eq(shouldRetry('GET', {}, 404), false, '404 is an answer, not a failure');
eq(shouldRetry('GET', {}, 401), false, '4xx is never retried');
eq(shouldRetry('GET', {}, 200), false, 'a good response is not retried');
eq(shouldRetry('POST', {}, 504), false, 'a plain insert must NEVER be retried (it would duplicate an events row)');
eq(shouldRetry('POST', {}, null), false, 'not even on a network error — the insert may have landed');
eq(shouldRetry('POST', UPSERT_HEADERS, 504), true, 'an upsert keyed on a conflict target is idempotent');
eq(shouldRetry('PATCH', UPSERT_HEADERS, 503), true, 'PATCH with merge-duplicates retries');
eq(shouldRetry('DELETE', UPSERT_HEADERS, 502), true, 'DELETE with merge-duplicates retries');
eq(shouldRetry('POST', { Prefer: 'return=representation' }, 504), false, 'a Prefer without the token is still a plain insert');
eq(shouldRetry('POST', UPSERT_HEADERS, 500), false, 'an idempotent write still does not retry a 500');
// Header shapes supabase-js and Request objects actually use.
eq(shouldRetry('POST', [['prefer', 'resolution=merge-duplicates']], 504), true, 'header pairs are read');
eq(shouldRetry('POST', new Headers({ prefer: 'resolution=merge-duplicates' }), 504), true, 'a Headers instance is read');
eq(shouldRetry('POST', { PREFER: 'RESOLUTION=MERGE-DUPLICATES' }, 504), true, 'name and value are both case-insensitive');
eq(shouldRetry('POST', undefined, 504), false, 'no headers at all = plain insert');

// ── 2. the 504 this whole file exists for ───────────────────────────────────

{
  const f = scripted([504, 200]);
  const res = await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS);
  eq(res.status, 200, 'GET: 504 then 200 returns the 200');
  eq(f.calls.length, 2, 'exactly one retry was spent');
  eq(JSON.parse(await res.text())[0].kills, 5, 'and the body is the real one, parseable by supabase-js');
}

{
  // Three 504s: the caller gets the last response UNCHANGED, so supabase-js
  // still turns it into its normal `{ data: null, error }` — we never throw a
  // shape the routes have not already been written against.
  const f = scripted([504]);
  const res = await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS);
  eq(res.status, 504, 'GET: 504 x3 returns the last 504 rather than throwing');
  eq(f.calls.length, 3, 'default is 3 attempts (2 retries)');
}

{
  const f = scripted([500]);
  eq((await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS)).status, 500, '500 comes straight back');
  eq(f.calls.length, 1, 'a 500 is Postgres answering — not retried');
}

{
  const f = scripted([404]);
  eq((await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS)).status, 404, '404 comes straight back');
  eq(f.calls.length, 1, '404 is not retried');
}

// ── 3. writes: the insert/upsert split ──────────────────────────────────────

{
  const f = scripted([504]);
  const res = await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"type":"death"}',
  });
  eq(res.status, 504, 'a plain insert hands the 504 back');
  eq(f.calls.length, 1, 'and is never re-sent — one events row, or none, never two');
}

{
  const f = scripted([503, 200]);
  const body = '{"player_id":"p1","kills":9}';
  const res = await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS, {
    method: 'POST',
    headers: UPSERT_HEADERS,
    body,
  });
  eq(res.status, 200, 'an upsert retries a 503');
  eq(f.calls.length, 2, 'exactly one retry');
  eq(f.calls[1].body, body, 'the SAME body is re-sent');
  eq(f.calls[1].method, 'POST', 'and the method survives the retry');
}

{
  // A stream body can only be read once, so a retry would re-send nothing.
  const f = scripted([504]);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); c.close(); } });
  const res = await retryingFetch(fast({ fetchImpl: f }))(URL_ROWS, {
    method: 'POST',
    headers: UPSERT_HEADERS,
    body: stream,
    duplex: 'half',
  });
  eq(res.status, 504, 'a streamed body is handed back on the first failure');
  eq(f.calls.length, 1, 'a stream is never replayed');
}

// ── 4. the per-attempt deadline (a manual controller, never AbortSignal.timeout) ──

{
  // Everything hangs: three attempts, then the deadline's AbortError is thrown
  // — deterministically, not "some time after the function budget ran out".
  const f = hangs();
  const started = Date.now();
  let thrown = null;
  try {
    await retryingFetch(fast({ fetchImpl: f, deadlineMs: 25 }))(URL_ROWS);
  } catch (e) {
    thrown = e;
  }
  ok(thrown, 'a stalled GET eventually throws');
  eq(thrown.name, 'AbortError', 'and it is a real AbortError, not a TimeoutError');
  ok(/per-attempt deadline/.test(thrown.message), 'the message names the deadline');
  eq(f.calls.length, 3, 'each attempt got its own deadline');
  ok(Date.now() - started < 2000, 'the whole thing is bounded, not 4 x deadline + backoff');
}

{
  // First attempt stalls past the deadline, the second answers.
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push(init);
    if (calls.length === 1) {
      return await new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    return new Response('[]', { status: 200 });
  };
  const res = await retryingFetch(fast({ fetchImpl, deadlineMs: 25 }))(URL_ROWS);
  eq(res.status, 200, 'a deadline abort is retried like any other failure');
  eq(calls.length, 2, 'one stall, one answer');
}

{
  // The deadline must not outlive the attempt it belongs to: once a response is
  // kept, its body must still be readable however long the caller takes.
  const fetchImpl = async () => new Response('[{"kills":1}]', { status: 200 });
  const res = await retryingFetch(fast({ fetchImpl, deadlineMs: 15 }))(URL_ROWS);
  await new Promise((r) => setTimeout(r, 40));
  eq(JSON.parse(await res.text())[0].kills, 1, 'a kept response is not aborted by its own stale deadline');
}

// ── 5. the caller's own signal always wins ──────────────────────────────────

{
  const ac = new AbortController();
  const f = hangs(() => setTimeout(() => ac.abort(new Error('caller changed its mind')), 10));
  let thrown = null;
  try {
    await retryingFetch(fast({ fetchImpl: f, deadlineMs: 5000 }))(URL_ROWS, { signal: ac.signal });
  } catch (e) {
    thrown = e;
  }
  eq(thrown?.message, 'caller changed its mind', "the caller's abort reason is rethrown untouched");
  eq(f.calls.length, 1, 'and it stops the retries dead — no second attempt');
}

{
  // Already aborted before the first attempt: never touch the network at all.
  const ac = new AbortController();
  ac.abort(new Error('too late'));
  const f = scripted([200]);
  await assert.rejects(
    () => retryingFetch(fast({ fetchImpl: f }))(URL_ROWS, { signal: ac.signal }),
    /too late/,
  );
  passed += 1;
  console.log('  ok   an already-aborted signal short-circuits');
  eq(f.calls.length, 0, 'no request is made at all');
}

// ── 6. backoff, logging, and the knobs ──────────────────────────────────────

{
  // 250 ms then 750 ms at the shipped default, scaled down here so the suite
  // stays fast; the shape (x3, with jitter on top) is what is asserted.
  const f = scripted([504, 504, 200]);
  const started = Date.now();
  const res = await retryingFetch({ fetchImpl: f, baseDelayMs: 60, log: silent })(URL_ROWS);
  const elapsed = Date.now() - started;
  eq(res.status, 200, 'two 504s then a 200');
  ok(elapsed >= 240, `both backoff steps were slept (60 + 180 ms, got ${elapsed} ms)`);
  ok(elapsed < 1500, `and no longer than the tripling implies (got ${elapsed} ms)`);
}

{
  const lines = [];
  const f = scripted([504, 502, 200]);
  await retryingFetch({ fetchImpl: f, baseDelayMs: 1, log: (m) => lines.push(m) })(URL_ROWS);
  eq(lines.length, 2, 'one log line per retry, none for the attempt that worked');
  ok(/GET \/rest\/v1\/player_stats/.test(lines[0]), 'the line carries method and path');
  ok(!lines[0].includes('Ch'), 'the query string — which carries player names — is stripped');
  ok(!lines[0].includes('?'), 'no query string at all reaches the log');
  ok(/HTTP 504/.test(lines[0]) && /HTTP 502/.test(lines[1]), 'each line names its status');
  ok(/retry 1\/2/.test(lines[0]) && /retry 2\/2/.test(lines[1]), 'and its attempt number');
}

{
  const f = scripted([504]);
  eq((await retryingFetch(fast({ fetchImpl: f, retries: 0 }))(URL_ROWS)).status, 504, 'retries: 0 is honored');
  eq(f.calls.length, 1, 'a single attempt');

  const g = scripted([504, 504, 504, 504, 200]);
  eq((await retryingFetch(fast({ fetchImpl: g, retries: 4 }))(URL_ROWS)).status, 200, 'retries: 4 is honored');
  eq(g.calls.length, 5, 'five attempts');
}

{
  // A Request object (what some callers hand to fetch) is read for method and
  // headers just like an init would be.
  const f = scripted([504, 200]);
  const req = new Request(URL_ROWS, { method: 'GET' });
  eq((await retryingFetch(fast({ fetchImpl: f }))(req)).status, 200, 'a Request input retries too');
  eq(f.calls.length, 2, 'one retry for the Request form');
}

console.log(`supabase-fetch.test: ${passed} assertions passed`);
