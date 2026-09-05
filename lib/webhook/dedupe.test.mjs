// Tests for the death dedupe window lifted out of /api/webhook (§2i).
//
//   npx tsx lib/webhook/dedupe.test.mjs

import { DEATH_DEDUPE_WINDOW_MS, shouldDedupeDeath, deathDedupeBounds } from './dedupe.ts';

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

const T0 = Date.parse('2026-09-09T20:00:00.000Z');

console.log('\nDEATH_DEDUPE_WINDOW_MS');
eq(DEATH_DEDUPE_WINDOW_MS, 180_000, 'three minutes, matching the handler it came from');

console.log('\nshouldDedupeDeath - which events are checked');
ok(shouldDedupeDeath('death', 'Loa'), 'a named death is checked');
ok(!shouldDedupeDeath('death', null), 'an unnamed death cannot be matched, so it is not');
ok(!shouldDedupeDeath('death', ''), 'nor an empty name');
ok(!shouldDedupeDeath('join', 'Loa'), 'a join is not a death');
ok(!shouldDedupeDeath('boss_kill', 'Loa'), 'nor a boss kill');

console.log('\ndeathDedupeBounds - the search window');
const b = deathDedupeBounds(T0);
eq(b.lowerBound, '2026-09-09T19:57:00.000Z', 'three minutes before');
eq(b.upperBound, '2026-09-09T20:03:00.000Z', 'three minutes after');
ok(
  Date.parse(b.lowerBound) < T0 && Date.parse(b.upperBound) > T0,
  'the window straddles the event: a twin can arrive either side of it'
);
eq(
  Date.parse(b.upperBound) - Date.parse(b.lowerBound),
  2 * DEATH_DEDUPE_WINDOW_MS,
  'the window is symmetric, six minutes wide in total'
);

const tight = deathDedupeBounds(T0, 10_000);
eq(tight.lowerBound, '2026-09-09T19:59:50.000Z', 'the width is tunable (lower)');
eq(tight.upperBound, '2026-09-09T20:00:10.000Z', 'the width is tunable (upper)');

console.log(
  failures === 0
    ? '\nwebhook/dedupe: all checks passed\n'
    : `\nwebhook/dedupe: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
