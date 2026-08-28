// Tests for the nav bar's next-gathering pill helpers:
// the calendar-aware countdown, the "within a day" flag, name shortening,
// and the mapper that turns an UpcomingEvent row into pill props.
//
//   npx tsx lib/next-gathering.test.mjs

import { gatheringCountdown, isGatheringImminent } from './format.ts';
import { shortenName, toNextGathering } from './next-gathering.ts';

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

// All times below are anchored to a fixed "now" so the suite never depends on
// the wall clock. 2026-08-27 14:00 CT = 19:00 UTC (CDT, UTC-5).
const NOW = Date.parse('2026-08-27T19:00:00Z');

console.log('\ngatheringCountdown');
eq(gatheringCountdown(null, NOW), '', 'no date -> empty string');
eq(gatheringCountdown('2026-08-27T18:00:00Z', NOW), 'happening now', 'already started');
eq(gatheringCountdown('2026-08-27T19:00:00Z', NOW), 'happening now', 'starting this second');
eq(gatheringCountdown('2026-08-27T19:40:00Z', NOW), 'in 40 min', 'under an hour -> minutes');
eq(gatheringCountdown('2026-08-28T00:00:00Z', NOW), 'tonight', '7pm CT the same day -> tonight');
eq(
  gatheringCountdown('2026-08-27T21:30:00Z', NOW),
  'later today',
  '4:30pm CT the same day is not yet "tonight"'
);
eq(
  gatheringCountdown('2026-08-28T14:00:00Z', NOW),
  'tomorrow',
  'next calendar morning -> tomorrow'
);
eq(
  gatheringCountdown('2026-08-28T02:00:00Z', NOW),
  'tonight',
  '9pm CT is still "tonight" even though it is past midnight UTC'
);
eq(gatheringCountdown('2026-09-09T00:00:00Z', NOW), 'in 12 days', 'a fortnight out -> days');
eq(gatheringCountdown('2026-09-24T19:00:00Z', NOW), 'in 4 weeks', 'past 14 days -> weeks');
eq(gatheringCountdown('not-a-date', NOW), '', 'garbage input -> empty string');

console.log('\nisGatheringImminent');
ok(isGatheringImminent('2026-08-28T00:00:00Z', NOW), 'five hours out is imminent');
ok(!isGatheringImminent('2026-08-29T19:00:00Z', NOW), 'two days out is not imminent');
ok(isGatheringImminent('2026-08-27T18:00:00Z', NOW), 'already under way counts as imminent');
ok(!isGatheringImminent(null, NOW), 'no date is not imminent');

console.log('\nshortenName');
eq(shortenName('Raid Night'), 'Raid Night', 'short names pass through untouched');
eq(shortenName('  Raid Night  '), 'Raid Night', 'names are trimmed');
eq(
  shortenName('Deep North Launch Night'),
  'Deep North Launch Night',
  '23 chars still fits the 24-char budget'
);
ok(shortenName('Deep North Launch Night, Bring Mead').length <= 24, 'long names fit the budget');
eq(
  shortenName('Deep North Launch Night, Bring Mead'),
  'Deep North Launch…',
  'breaks on a word boundary when one is close enough to the cut'
);
eq(
  shortenName('Supercalifragilisticexpialidocious'),
  'Supercalifragilisticexp…',
  'a single long word is cut mid-word rather than vanishing'
);

console.log('\ntoNextGathering');
const row = {
  id: '1',
  name: 'Deep North Launch Night',
  next_at: '2026-09-09T00:00:00Z',
  url: 'https://discord.com/events/1/2',
};
eq(toNextGathering(null, NOW), null, 'nothing scheduled -> null (nav renders no pill)');
eq(toNextGathering({ ...row, name: '   ' }, NOW), null, 'a nameless row -> null');
eq(toNextGathering({ ...row, next_at: null }, NOW), null, 'a row with no next occurrence -> null');

const mapped = toNextGathering(row, NOW);
eq(mapped.name, 'Deep North Launch Night', 'full name is kept for the hover label');
eq(mapped.href, 'https://discord.com/events/1/2', 'links to the Discord event when there is one');
ok(mapped.external, 'a Discord link is external');
eq(mapped.label, 'in 12 days', 'label is the countdown at render time');
ok(!mapped.imminent, 'twelve days out is not imminent');

const noLink = toNextGathering({ ...row, url: null }, NOW);
eq(noLink.href, '/world#gatherings', "falls back to the World page's gatherings");
ok(!noLink.external, 'the fallback is an internal link');

console.log(
  failures === 0 ? '\nnext-gathering: all checks passed\n' : `\nnext-gathering: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
