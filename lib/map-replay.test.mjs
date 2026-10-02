// Tests for the map replay timeline: which archived frame each /pin first
// appears on, and whether it reads as freshly-named or already-established.
//
//   npx tsx lib/map-replay.test.mjs

import {
  MAX_REPLAY_FRAMES,
  pinAppearanceByFrame,
  pinPhaseAt,
  sampleReplayFrames,
} from './map-replay.ts';

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

// ── sampleReplayFrames ───────────────────────────────────────────────────────
//
// The cap added after the 2026-10-02 egress incident: the manifest had grown to
// 951 archived days and one press of play fetched every one of them. What these
// assert, in order of how much they would cost if they broke:
//
//   • the ends survive (a replay that loses day 1 or the last archived day
//     reads wrong, which is the only failure a viewer would actually notice);
//   • the sample is STABLE — the same input always yields the same days, which
//     is what lets the edge cache serve a second press of play for free;
//   • the cap is honoured and nothing is invented.
console.log('\nsampleReplayFrames');
{
  const days = (n) => Array.from({ length: n }, (_, i) => ({ day: i + 1 }));

  const short = days(12);
  eq(sampleReplayFrames(short, 120).length, 12, 'a short archive is left whole');
  ok(
    sampleReplayFrames(short, 120).every((f, i) => f === short[i]),
    'and element-for-element identical, in order',
  );
  ok(sampleReplayFrames(short, 120) !== short, 'returned as a copy, not the caller’s array');

  const long = days(951); // the real manifest on the day of the incident
  const sampled = sampleReplayFrames(long, 120);
  eq(sampled.length, 120, '951 archived days thin down to the 120-frame cap');
  eq(sampled[0].day, 1, 'the first archived day is kept');
  eq(sampled[sampled.length - 1].day, 951, 'and so is the last');
  ok(
    sampled.every((f, i) => i === 0 || f.day > sampled[i - 1].day),
    'strictly ascending — no day repeats and the order is preserved',
  );
  ok(
    sampled.every((f) => long.includes(f)),
    'every sampled frame is one of the real frames (nothing synthesised)',
  );
  const gaps = sampled.slice(1).map((f, i) => f.day - sampled[i].day);
  ok(
    Math.max(...gaps) - Math.min(...gaps) <= 1,
    `evenly spaced: gaps are ${Math.min(...gaps)}–${Math.max(...gaps)} days`,
  );
  ok(
    JSON.stringify(sampleReplayFrames(long, 120)) === JSON.stringify(sampled),
    'STABLE: the same manifest samples to the same days every time',
  );

  eq(sampleReplayFrames(days(121), 120).length, 120, 'one over the cap still caps');
  eq(sampleReplayFrames(days(120), 120).length, 120, 'exactly the cap is left whole');
  eq(sampleReplayFrames([], 120).length, 0, 'an empty archive samples to nothing');
  eq(sampleReplayFrames(days(5), 1)[0].day, 5, 'a cap of one keeps the latest day');
  eq(sampleReplayFrames(days(5), 0).length, 0, 'a cap of zero yields nothing');
  eq(sampleReplayFrames(days(5), -3).length, 0, 'a negative cap is not a crash');

  eq(MAX_REPLAY_FRAMES, 120, 'the default cap is 120 frames per play');
  eq(
    sampleReplayFrames(long).length,
    MAX_REPLAY_FRAMES,
    'and is what sampleReplayFrames uses when no cap is passed',
  );
}

console.log(
  failures === 0 ? '\nAll map-replay tests passed.' : `\n${failures} map-replay test(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
