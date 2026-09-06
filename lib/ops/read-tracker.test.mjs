// Unit tests for the cockpit's read tracker.
// Run: npx tsx lib/ops/read-tracker.test.mjs
//
// The thing under test is small, and what it is worth testing is not the code
// but the CONTRACT: a page that shows a number has to be able to say "I could
// not read". Two of the four v2 tabs shipped without that and would have
// rendered a refused query as a quiet week.

import assert from 'node:assert';
import { readTracker } from './read-tracker.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };

// ── A clean page reports nothing ────────────────────────────────────────────
{
  const t = readTracker();
  const rows = await t.read('events', async () => [1, 2, 3], []);
  t.noteError('events', null);
  eq(rows, [1, 2, 3], 'a successful read returns its rows');
  eq(t.failed, [], 'and nothing is reported as failed');
}

// ── The case that never throws, which is the whole point ────────────────────
// postgrest-js RESOLVES on a refused query. This is the shape of that: the
// callback completes, returns the fallback rows itself, and the only evidence
// anything went wrong is the error object it was handed.
{
  const t = readTracker();
  const rows = await t.read(
    'events',
    async () => {
      const { data, error } = { data: null, error: { code: '42703', message: 'column does not exist' } };
      t.noteError('events', error);
      return data ?? [];
    },
    [],
  );
  eq(rows, [], 'the page still gets an array it can render');
  eq(t.failed, ['events'], 'but the failure is on the record, which is the difference');
}

// ── A real throw is caught and named ────────────────────────────────────────
{
  const t = readTracker();
  const rows = await t.read('voice_lines', async () => { throw new Error('socket hang up'); }, ['fallback']);
  eq(rows, ['fallback'], 'a throw yields the fallback rather than taking the page down');
  eq(t.failed, ['voice_lines'], 'and is reported by name');
}

// ── One read, one entry, however many ways it reports itself ───────────────
// The sessions read on the Performance tab is two queries under one name, and
// both failing must not print "sessions, sessions".
{
  const t = readTracker();
  t.noteError('sessions', { code: '1' });
  t.noteError('sessions', { code: '2' });
  eq(t.failed, ['sessions'], 'a name is recorded once no matter how often it fails');
}

// ── Falsy errors are not failures ──────────────────────────────────────────
// PostgREST hands back `error: null` on success, and undefined when a caller
// coalesces two of them. Neither is a failure, and a tracker that thought so
// would put a red banner on every healthy render.
{
  const t = readTracker();
  t.noteError('a', null);
  t.noteError('b', undefined);
  t.noteError('c', false);
  t.noteError('d', 0);
  t.noteError('e', '');
  eq(t.failed, [], 'no falsy error value is ever a failed read');
  t.noteError('f', { code: 'PGRST301' });
  eq(t.failed, ['f'], 'and a real error object still is');
}

// ── Order is the order they failed ─────────────────────────────────────────
// The banner prints this list, and a stable order is what makes two renders of
// the same outage comparable.
{
  const t = readTracker();
  t.noteError('milestones', { code: '1' });
  t.noteError('events', { code: '1' });
  t.noteError('oaths', { code: '1' });
  eq(t.failed, ['milestones', 'events', 'oaths'], 'names are listed in the order they failed');
}

// ── Independence: one tracker never sees another page's failures ──────────
{
  const a = readTracker();
  const b = readTracker();
  a.noteError('events', { code: '1' });
  eq(b.failed, [], 'two trackers do not share state');
  ok(a.failed !== b.failed, 'and do not share the array either');
}

console.log(`read-tracker.test: ${passed} assertions passed`);
