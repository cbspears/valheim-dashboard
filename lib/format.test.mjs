// Tests for the date/number formatters, with the emphasis on the one thing
// that keeps biting us: Vercel renders in UTC, but the community plays in
// Central. An evening game session runs past 00:00 UTC, so anything dated
// naively lands on tomorrow. Every date shown on the site must be a CT date.
//
//   npx tsx lib/format.test.mjs

import {
  shortDate,
  centralDayIndex,
  centralDayKey,
  formatPlaytime,
  formatDistance,
  formatPercent,
} from './format.ts';

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

console.log('\nshortDate (always Central, never the render machine)');
// Eikthyr's real kill: 2026-08-28 03:49:34Z = Aug 27, 10:49 PM CDT.
eq(
  shortDate('2026-08-28T03:49:34Z'),
  'Aug 27, 2026',
  'a 10:49 PM CT kill stays on Aug 27, not the UTC Aug 28'
);
eq(shortDate('2026-08-28T05:00:00Z'), 'Aug 28, 2026', 'after midnight CT it rolls to Aug 28');
eq(shortDate('2026-08-28T04:59:59Z'), 'Aug 27, 2026', 'one second before midnight CT');
// CST (winter, UTC-6): 05:59Z is still 11:59 PM the previous day.
eq(shortDate('2026-01-15T05:59:00Z'), 'Jan 14, 2026', 'standard time honours the -6 offset');
eq(shortDate('2026-01-15T06:00:00Z'), 'Jan 15, 2026', 'and rolls over an hour later than CDT');
eq(shortDate(null), '—', 'null is a dash, not a crash');
eq(shortDate(undefined), '—', 'undefined is a dash');
eq(shortDate('not a date'), '—', 'garbage is a dash');

console.log('\ncentralDayKey (the Chronicle groups by this)');
eq(
  centralDayKey('2026-08-28T03:49:34Z'),
  '2026-08-27',
  'the same evening as shortDate says, in sortable form'
);
eq(centralDayKey('2026-08-28T05:00:00Z'), '2026-08-28', 'past midnight CT is the next key');
eq(centralDayKey(null), 'unknown', 'no timestamp -> unknown bucket');
eq(centralDayKey('nope'), 'unknown', 'unparseable -> unknown bucket');

console.log('\ncentralDayIndex (Today / Yesterday dividers)');
const evening = new Date('2026-08-28T03:49:34Z'); // Aug 27 CT
const nextMorning = new Date('2026-08-28T14:00:00Z'); // Aug 28 CT
eq(centralDayIndex(nextMorning) - centralDayIndex(evening), 1, 'the evening before is Yesterday');
eq(
  centralDayIndex(new Date('2026-08-28T02:00:00Z')) - centralDayIndex(evening),
  0,
  'two moments the same CT evening share a day'
);

console.log('\nformatPlaytime / formatDistance / formatPercent');
eq(formatPlaytime(0), '0m', 'no playtime');
eq(formatPlaytime(45), '45m', 'under an hour');
eq(formatPlaytime(120), '2h', 'a whole number of hours drops the minutes');
eq(formatPlaytime(2530), '42h 10m', 'hours and minutes');
eq(formatDistance(920), '920 m', 'under a kilometre stays in metres');
eq(formatDistance(84200), '84.2 km', 'kilometres get one decimal');
eq(formatPercent(31.9), '31.9%', 'a fractional percent keeps its decimal');
eq(formatPercent(32), '32%', 'a whole percent drops the ".0"');

console.log(failures === 0 ? '\nformat: all checks passed\n' : `\nformat: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
