// Unit tests for the shared cockpit window helpers.
// Run: npx tsx lib/ops/window.test.mjs
import assert from 'node:assert';
import {
  hourBuckets,
  dayBuckets,
  countInBuckets,
  groupIntoBuckets,
  percentile,
  median,
  mean,
  ageSecFrom,
  untilSecFrom,
  sinceIso,
  toMs,
  formatDurationSec,
  formatAgeSec,
  formatCountdownSec,
  formatCount,
  formatBytes,
  formatPercent,
  formatRatePerHour,
  windowLabel,
  HOUR_MS,
  DAY_MS,
  WINDOW_24H_MS,
  WINDOW_7D_MS,
  ROW_LIMIT,
} from './window.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };

// A time deliberately mid-hour and mid-day so alignment is actually exercised.
const NOW = Date.parse('2026-09-06T14:37:12.000Z');

// ── hourBuckets ─────────────────────────────────────────────────────────────
{
  const b = hourBuckets(NOW, 24);
  eq(b.length, 24, '24 hour buckets');
  eq(b[23].label, '14:00', 'last bucket is the current UTC hour');
  eq(b[23].startMs, Date.parse('2026-09-06T14:00:00Z'), 'last bucket starts on the hour');
  ok(b[23].startMs <= NOW && NOW < b[23].endMs, 'now falls inside the last bucket');
  eq(b[0].label, '15:00', 'oldest bucket is 23 hours back');
  eq(b[0].startMs, Date.parse('2026-09-05T15:00:00Z'), 'oldest bucket start is aligned');
  for (let i = 1; i < b.length; i++) {
    ok(b[i].startMs === b[i - 1].endMs, `bucket ${i} is contiguous with the one before it`);
  }
  eq(hourBuckets(NOW, 0).length, 1, 'a zero count still yields one bucket rather than an empty axis');
}

// ── dayBuckets ──────────────────────────────────────────────────────────────
{
  const b = dayBuckets(NOW, 7);
  eq(b.length, 7, '7 day buckets');
  eq(b[6].label, 'Sep 06', 'last bucket is today, UTC');
  eq(b[6].startMs, Date.parse('2026-09-06T00:00:00Z'), 'day buckets align to UTC midnight');
  eq(b[0].label, 'Aug 31', 'oldest bucket is 6 days back');
  eq(b[6].endMs - b[6].startMs, DAY_MS, 'a day bucket is one day wide');
}

// ── countInBuckets ──────────────────────────────────────────────────────────
{
  const b = hourBuckets(NOW, 3); // 12:00, 13:00, 14:00
  const counts = countInBuckets(
    [
      '2026-09-06T12:00:00Z', // first bucket, on the boundary (inclusive start)
      '2026-09-06T12:59:59Z', // first bucket
      '2026-09-06T13:30:00Z', // second
      '2026-09-06T14:37:00Z', // third (current, partial)
      '2026-09-06T09:00:00Z', // before the window, dropped
      '2026-09-06T23:00:00Z', // after the window, dropped
      'not a time',           // unparseable, dropped
      null,
      undefined,
    ],
    b,
  );
  assert.deepStrictEqual(counts, [2, 1, 1], 'rows land in the right bucket and out-of-window rows are dropped');
  passed++;
  assert.deepStrictEqual(countInBuckets([], b), [0, 0, 0], 'no rows gives a zeroed axis, not an empty one');
  passed++;
}

// ── groupIntoBuckets ────────────────────────────────────────────────────────
{
  const b = hourBuckets(NOW, 2); // 13:00, 14:00
  const rows = [
    { at: '2026-09-06T13:10:00Z', lag: 4 },
    { at: '2026-09-06T13:50:00Z', lag: 9 },
    { at: '2026-09-06T14:05:00Z', lag: 1 },
    { at: '2026-09-05T14:05:00Z', lag: 99 }, // out of window
  ];
  const grouped = groupIntoBuckets(rows, (r) => r.at, b);
  eq(grouped.length, 2, 'one group per bucket');
  eq(grouped[0].length, 2, 'two rows in the 13:00 hour');
  eq(grouped[1].length, 1, 'one row in the current hour');
  eq(median(grouped[0].map((r) => r.lag)), 6.5, 'a per-bucket statistic is computable from the group');
}

// ── percentile / median / mean ──────────────────────────────────────────────
{
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  eq(percentile(v, 0), 1, 'p0 is the minimum');
  eq(percentile(v, 100), 10, 'p100 is the maximum');
  eq(percentile(v, 50), 5.5, 'p50 interpolates between the middle pair');
  eq(percentile(v, 90), 9.1, 'p90 interpolates');
  eq(percentile([], 50), null, 'empty set gives null, never a confident 0');
  eq(percentile([7], 90), 7, 'a single sample is every percentile');
  eq(percentile([3, 1, 2], 50), 2, 'input order does not matter');
  const original = [3, 1, 2];
  percentile(original, 50);
  assert.deepStrictEqual(original, [3, 1, 2], 'the input array is not mutated');
  passed++;
  eq(percentile([1, NaN, 3], 50), 2, 'non-finite samples are dropped');
  eq(percentile(v, -20), 1, 'p below 0 clamps to p0');
  eq(percentile(v, 500), 10, 'p above 100 clamps to p100');
  eq(mean([2, 4, 6]), 4, 'mean');
  eq(mean([]), null, 'mean of nothing is null');
}

// ── ages, countdowns, window bounds ─────────────────────────────────────────
{
  eq(ageSecFrom(NOW, new Date(NOW - 90_000).toISOString()), 90, 'age in seconds');
  eq(ageSecFrom(NOW, new Date(NOW + 5_000).toISOString()), 0, 'a future stamp floors at 0, never a negative age');
  eq(ageSecFrom(NOW, null), null, 'no timestamp gives null');
  eq(ageSecFrom(NOW, 'nonsense'), null, 'unparseable gives null');
  eq(untilSecFrom(NOW, new Date(NOW + 120_000).toISOString()), 120, 'seconds until a future stamp');
  eq(untilSecFrom(NOW, new Date(NOW - 60_000).toISOString()), -60, 'a past stamp reads negative, so overdue is visible');
  eq(sinceIso(NOW, WINDOW_24H_MS), '2026-09-05T14:37:12.000Z', 'since bound for 24 h');
  eq(sinceIso(NOW, WINDOW_7D_MS), '2026-08-30T14:37:12.000Z', 'since bound for 7 d');
  eq(toMs(new Date(NOW)), NOW, 'toMs accepts a Date');
  eq(toMs(NOW), NOW, 'toMs accepts epoch ms');
  eq(toMs(new Date('nope')), null, 'toMs rejects an invalid Date');
}

// ── formatting: every number carries its unit ───────────────────────────────
{
  eq(formatDurationSec(0.25), '250 ms', 'sub-second durations keep milliseconds');
  eq(formatDurationSec(0), '0 ms', 'zero is still a unit-bearing number');
  eq(formatDurationSec(42), '42 s', 'seconds');
  eq(formatDurationSec(120), '2 m', 'exact minutes drop the seconds part');
  eq(formatDurationSec(125), '2 m 5 s', 'minutes plus seconds');
  eq(formatDurationSec(7800), '2 h 10 m', 'hours plus minutes');
  eq(formatDurationSec(3 * 86400 + 4 * 3600), '3 d 4 h', 'days plus hours');
  eq(formatDurationSec(null), 'no data', 'null is said plainly');
  eq(formatDurationSec(-5), '0 ms', 'a negative duration floors at zero');

  // ── the carry, which three tabs shipped to the page before it was fixed ──
  // Each of these printed a duration that does not exist when the split came
  // before the rounding. They are the whole reason this helper is shared.
  eq(formatDurationSec(119.6), '2 m', 'a second that rounds up carries into the minute, not "1 m 60 s"');
  eq(formatDurationSec(23 * 3600 + 59 * 60 + 59.6), '24 h', 'a minute that rounds up carries into the hour, not "23 h 60 m"');
  eq(formatDurationSec(4 * 86400 + 23 * 3600 + 59 * 60 + 59.6), '5 d', 'an hour that rounds up carries into the day, not "4 d 24 h"');
  eq(formatDurationSec(0.9996), '1 s', 'a millisecond that rounds up carries into the second');

  // Band edges stay contiguous: the unit changes without a gap or an overlap.
  eq(formatDurationSec(89), '89 s', 'the last second before the minutes band');
  eq(formatDurationSec(90), '1 m 30 s', 'the first value in the minutes band');
  eq(formatDurationSec(90 * 60 - 1), '89 m 59 s', 'the last value in the minutes band');
  eq(formatDurationSec(90 * 60), '1 h 30 m', 'the first value in the hours band');
  eq(formatDurationSec(47 * 3600 + 59 * 60), '47 h 59 m', 'the last value in the hours band');
  eq(formatDurationSec(48 * 3600 - 1), '2 d', 'a second short of two days rounds up into the days band rather than printing "47 h 60 m"');
  eq(formatDurationSec(48 * 3600), '2 d', 'the first value in the days band');
  eq(formatAgeSec(42), '42 s ago', 'ages carry "ago"');
  eq(formatAgeSec(null), 'never', 'no age at all is "never"');
  eq(formatCountdownSec(7800), 'in 2 h 10 m', 'countdowns carry "in"');
  eq(formatCountdownSec(-300), 'overdue by 5 m', 'a passed time is named overdue');
  eq(formatCountdownSec(3), 'due now', 'inside half a minute is "due now"');
  eq(formatCountdownSec(null), 'not scheduled', 'nothing scheduled is said plainly');
  eq(formatCount(1234), '1,234', 'counts are grouped');
  eq(formatCount(null), 'no data', 'no count is said plainly');
  eq(formatBytes(900), '900 B', 'bytes');
  eq(formatBytes(1024 * 512), '512 kB', 'kilobytes');
  eq(formatBytes(1024 * 1024 * 300), '300 MB', 'megabytes');
  eq(formatBytes(1024 * 1024 * 1024 * 1.4), '1.4 GB', 'gigabytes keep one decimal under 10');
  eq(formatPercent(0.42), '42%', 'percent');
  eq(formatPercent(0.4256, 1), '42.6%', 'percent with a decimal');
  eq(formatRatePerHour(48, WINDOW_24H_MS), '2 per hour', 'a rate names its unit');
  eq(formatRatePerHour(12, WINDOW_24H_MS), '0.5 per hour', 'sub-unit rates keep one decimal');
  eq(windowLabel(WINDOW_24H_MS), 'last 24 h', '24 h window label');
  eq(windowLabel(WINDOW_7D_MS), 'last 7 d', '7 d window label');
  eq(windowLabel(30 * 60 * 1000), 'last 30 min', 'sub-hour window label');
}

// ── constants ───────────────────────────────────────────────────────────────
{
  eq(WINDOW_24H_MS, 24 * HOUR_MS, '24 h window constant');
  eq(WINDOW_7D_MS, 7 * DAY_MS, '7 d window constant');
  ok(ROW_LIMIT === 2000, 'the shared row ceiling is 2000');
}

console.log(`window.test.mjs: ${passed} assertions passed`);
