// Tests for the world_day stamp on feed events (/api/webhook §4).
//
//   npx tsx lib/webhook/world-day.test.mjs
import assert from 'node:assert';
import { WORLD_DAY_FRESH_MS, hasWorldDay, worldDayFromStatus, stampWorldDay } from './world-day.ts';

const T = Date.parse('2026-10-06T02:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// hasWorldDay
assert.equal(hasWorldDay({ world_day: 212 }), true);
assert.equal(hasWorldDay({ world_day: '212' }), false, 'a string is not a day');
assert.equal(hasWorldDay({}), false);
assert.equal(hasWorldDay(null), false);

// fresh row → its day
assert.equal(worldDayFromStatus({ world_day: 212, updated_at: iso(T - 60_000) }, T), 212);
assert.equal(worldDayFromStatus({ world_day: 212, updated_at: iso(T - WORLD_DAY_FRESH_MS) }, T), 212, 'boundary is inclusive');
// stale row → nothing
assert.equal(worldDayFromStatus({ world_day: 212, updated_at: iso(T - WORLD_DAY_FRESH_MS - 1) }, T), undefined);
// an OLD event (catch-up batch) against a fresh row → nothing either
assert.equal(worldDayFromStatus({ world_day: 212, updated_at: iso(T) }, T - 2 * 3600_000), undefined);
// missing / malformed
assert.equal(worldDayFromStatus(null, T), undefined);
assert.equal(worldDayFromStatus({ world_day: null, updated_at: iso(T) }, T), undefined);
assert.equal(worldDayFromStatus({ world_day: 0, updated_at: iso(T) }, T), undefined, 'day 0 is not a real day');
assert.equal(worldDayFromStatus({ world_day: 212, updated_at: 'garbage' }, T), undefined);
assert.equal(worldDayFromStatus({ world_day: 212 }, T), undefined);

// stampWorldDay
assert.deepEqual(stampWorldDay({ cause: 'fall' }, 212), { cause: 'fall', world_day: 212 });
assert.deepEqual(stampWorldDay({ world_day: 7 }, 212), { world_day: 7 }, 'never overwrites the producer');
const m = { cause: 'fall' };
assert.equal(stampWorldDay(m, undefined), m, 'no day → untouched');

console.log('world-day: all passed');
