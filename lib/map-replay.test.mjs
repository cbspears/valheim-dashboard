// Tests for the map replay timeline: which archived frame each /pin first
// appears on, and whether it reads as freshly-named or already-established.
//
//   npx tsx lib/map-replay.test.mjs

import { pinAppearanceByFrame, pinPhaseAt } from './map-replay.ts';

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

// A sparse archive: no frame for day 4 (server was down), so positions are
// 0→day 1, 1→day 2, 2→day 3, 3→day 5, and 4 = "Now".
const FRAMES = [{ day: 1 }, { day: 2 }, { day: 3 }, { day: 5 }];
const NOW = FRAMES.length; // 4

console.log('\npinAppearanceByFrame');
{
  const pins = [
    { id: 'first', day: 1 }, // named on the very first archived day
    { id: 'mid', day: 3 },
    { id: 'gap', day: 4 }, // no day-4 frame → surfaces on the day-5 frame
    { id: 'future', day: 9 }, // named after the last archived day → Now only
    { id: 'ancient', day: 0 }, // predates the archive → visible from frame 0
    { id: 'undated', day: null }, // no world day recorded → off the timeline
  ];
  const a = pinAppearanceByFrame(FRAMES, pins);

  eq(a.get('first'), 0, 'a day-1 pin appears on the first frame');
  eq(a.get('mid'), 2, 'a day-3 pin appears on the day-3 frame');
  eq(a.get('gap'), 3, 'a day-4 pin appears on the next archived frame (day 5)');
  eq(a.get('future'), NOW, 'a pin newer than every frame is held back to Now');
  eq(a.get('ancient'), 0, 'a pin older than the archive shows from the first frame');
  eq(a.get('undated'), undefined, 'a pin with no day is left off the timeline');
  eq(a.size, 5, 'exactly the dated pins are placed');
}

console.log('\nno frames / no pins');
{
  eq(pinAppearanceByFrame([], [{ id: 'p', day: 2 }]).get('p'), 0, 'with no archive, Now is position 0');
  eq(pinAppearanceByFrame(FRAMES, []).size, 0, 'no pins → nothing on the timeline');
}

console.log('\npinPhaseAt');
{
  const a = pinAppearanceByFrame(FRAMES, [
    { id: 'mid', day: 3 },
    { id: 'future', day: 9 },
    { id: 'undated', day: null },
  ]);

  eq(pinPhaseAt(a, 'mid', 0), null, 'not yet named on an earlier frame');
  eq(pinPhaseAt(a, 'mid', 1), null, 'still not named on the frame before');
  eq(pinPhaseAt(a, 'mid', 2), 'new', 'reads as new on the frame it was named');
  eq(pinPhaseAt(a, 'mid', 3), 'established', 'reads as established afterwards');
  eq(pinPhaseAt(a, 'mid', NOW), 'established', 'still established at Now');
  eq(pinPhaseAt(a, 'future', 3), null, 'a Now-only pin stays hidden on archived frames');
  eq(pinPhaseAt(a, 'future', NOW), 'new', 'a Now-only pin lands on the Now position');
  eq(pinPhaseAt(a, 'undated', 2), null, 'an undated pin never appears on a frame');
  eq(pinPhaseAt(a, 'nope', 2), null, 'an unknown id never appears');
}

console.log(
  failures === 0 ? '\nAll map-replay tests passed.' : `\n${failures} map-replay test(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
