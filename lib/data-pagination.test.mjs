// Tests for fetchAllRows, the paging helper every windowed read in lib/data.ts
// now goes through. Run: npx tsx lib/data-pagination.test.mjs
//
// WHY IT EXISTS: PostgREST caps a response at 1000 rows server-side and reports
// nothing — `.limit(2000)` returns a thousand rows and a clean 200. Measured on
// this project 2026-09-27: a 2000-row session read with `Prefer: count=exact`
// answered `Content-Range: 0-999/1173`. Because the windowed reads are ordered
// OLDEST FIRST, the rows the cap ate were the newest ones, and the Story page
// stopped on 24 September while vikings had played on the 25th, 26th and 27th.
//
// Nothing here talks to Supabase. The fake builder below is the shape
// fetchAllRows actually consumes — a thenable resolving to `{ data, error }` —
// so these cases pin the paging arithmetic, not postgrest-js.
import { fetchAllRows } from './data.ts';

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

/** `n` rows that know their own index, so order is checkable and not just length. */
const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }));

/**
 * A fake PostgREST read over a fixed table.
 *
 * `serverCap` is the thing the real bug is made of: the server will never hand
 * back more than this many rows however wide the requested range is. Defaults to
 * 1000, the live `db-max-rows`.
 *
 * `errorOnCall` makes the nth call (1-based) resolve to `{ data: null, error }`.
 */
function fakeTable(table, { serverCap = 1000, errorOnCall = 0 } = {}) {
  const calls = [];
  const build = (from, to) => {
    calls.push([from, to]);
    if (calls.length === errorOnCall) {
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    }
    const width = Math.min(to - from + 1, serverCap);
    return Promise.resolve({ data: table.slice(from, from + width), error: null });
  };
  return { build, calls };
}

console.log('\na window wider than the cap comes back whole');
{
  const table = rows(2350);
  const { build, calls } = fakeTable(table);
  const got = await fetchAllRows(build, 1000);

  eq(got.length, 2350, 'every row in the window is returned, not the first thousand');
  eq(calls.length, 3, 'three pages fetched (1000 + 1000 + 350), then the short page stops it');
  ok(
    got.every((r, idx) => r.i === idx),
    'and they arrive in the query\'s own order — pages are concatenated, never interleaved'
  );
  ok(
    calls[0][0] === 0 && calls[0][1] === 999 && calls[1][0] === 1000 && calls[1][1] === 1999,
    `.range() is inclusive at both ends and walks forward, got ${JSON.stringify(calls)}`
  );
  // The regression this file exists for: the single-shot read the helper
  // replaced would have stopped here, one page in, silently.
  eq(got[got.length - 1].i, 2349, 'the NEWEST row survives — the one the 1000-row cap used to eat');
}

console.log('\nexactly one full page');
{
  const { build, calls } = fakeTable(rows(1000));
  const got = await fetchAllRows(build, 1000);
  eq(got.length, 1000, 'all thousand rows returned');
  eq(calls.length, 2, 'a full first page cannot be assumed to be the last — one empty page confirms it');
  eq(got[999].i, 999, 'and nothing is duplicated across the boundary');
}

console.log('\na short first page needs no second request');
{
  const { build, calls } = fakeTable(rows(12));
  const got = await fetchAllRows(build, 1000);
  eq(got.length, 12, 'the twelve rows come back');
  eq(calls.length, 1, 'one round trip — the common case pays nothing for paging');
}

console.log('\nan empty table');
{
  const { build, calls } = fakeTable([]);
  const got = await fetchAllRows(build, 1000);
  eq(got.length, 0, 'no rows');
  eq(calls.length, 1, 'and one request to learn it');
}

console.log('\nan error abandons the whole read (never a partial list)');
{
  const { build, calls } = fakeTable(rows(2350), { errorOnCall: 2 });
  const got = await fetchAllRows(build, 1000);
  // Documented semantics: a failed page yields [], exactly as the single-shot
  // reads did (`(data as T[]) ?? []` on a null-data error). Returning the first
  // page would be a silently truncated list indistinguishable from a complete
  // one — the very failure mode this helper was written to end.
  eq(got.length, 0, 'the thousand rows page one delivered are discarded, not handed back');
  eq(calls.length, 2, 'and paging stops at the failure rather than grinding on');
}

console.log('\nmaxRows caps a runaway walk');
{
  const { build, calls } = fakeTable(rows(50_000));
  const got = await fetchAllRows(build, 1000, 2000);
  eq(got.length, 2000, 'the walk stops at maxRows however many rows the table holds');
  eq(calls.length, 2, 'two pages, not fifty');
}
{
  // maxRows need not be a multiple of pageSize — the last page is clipped so the
  // walk lands exactly on it.
  const { build, calls } = fakeTable(rows(50_000));
  const got = await fetchAllRows(build, 1000, 2500);
  eq(got.length, 2500, 'an awkward maxRows is honoured exactly');
  eq(calls.length, 3, 'three pages, the last one clipped');
  ok(
    calls[2][0] === 2000 && calls[2][1] === 2499,
    `the clipped page asks for 500 rows, not 1000, got ${JSON.stringify(calls[2])}`
  );
}

console.log('\nthe default pageSize matches the server cap');
{
  // The point of the default: a 1000-row page is the largest the server will
  // ever fill, so a caller that passes nothing still pages correctly against it.
  const { build, calls } = fakeTable(rows(1500), { serverCap: 1000 });
  const got = await fetchAllRows(build);
  eq(got.length, 1500, 'a caller relying on the defaults still gets every row');
  eq(calls.length, 2, 'in two pages');
}

console.log(
  failures === 0 ? '\ndata-pagination: all checks passed\n' : `\ndata-pagination: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
