// Tests for the map image addressing introduced after the 2026-10-02 Supabase
// egress incident (lib/map-image): the version key that replaced the
// `?t=<Date.now()>`-shaped cache-buster, the two same-origin paths built from
// it, and the day parser that is the only place a caller-supplied string gets
// anywhere near a storage object path.
//
//   npx tsx lib/map-image.test.mjs

import {
  MAP_BUCKET_PATH,
  MAP_FRAME_PREFIX,
  framePad,
  mapCurrentSrc,
  mapFrameSrc,
  mapStorageUrl,
  mapVersionKey,
  parseFrameDay,
} from './map-image.ts';

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

// A real status.json capturedAt, from the snapshot that was live when the
// quota blew (scripts/map-snapshot.mjs writes one of these every 5 minutes).
const CAPTURED = '2026-10-02T22:49:56.302Z';

console.log('\nmapVersionKey');
{
  eq(mapVersionKey(CAPTURED), '1790981396', 'epoch SECONDS of the snapshot capture time');

  // THE WHOLE POINT. A key that moves on its own is a cache-buster, which is
  // what the old `?t=` was and what put the bucket on the bill.
  eq(
    mapVersionKey(CAPTURED),
    mapVersionKey(CAPTURED),
    'stable: the same capture time always yields the same key',
  );
  eq(
    mapVersionKey('2026-10-02T22:49:56.999Z'),
    mapVersionKey(CAPTURED),
    'sub-second jitter inside one capture does not split the cache',
  );
  ok(
    mapVersionKey('2026-10-02T22:54:56.302Z') !== mapVersionKey(CAPTURED),
    'but the next snapshot five minutes later is a different key',
  );
  ok(
    mapVersionKey(CAPTURED) < mapVersionKey('2026-10-02T22:54:56.302Z'),
    'and keys sort the way the snapshots do',
  );

  // Supabase `last-modified` is the documented fallback when status.json is
  // missing (older snapshot loops wrote none), so it has to parse too.
  eq(
    mapVersionKey('Fri, 02 Oct 2026 22:49:56 GMT'),
    '1790981396',
    'an HTTP last-modified header parses to the same second',
  );

  eq(mapVersionKey(null), '0', 'an absent timestamp is a constant, not a crash');
  eq(mapVersionKey(undefined), '0', 'and so is undefined');
  eq(mapVersionKey('not a date'), '0', 'and so is garbage');
  eq(mapVersionKey(12345), '0', 'and so is a non-string');
}

console.log('\nmapCurrentSrc / mapFrameSrc');
{
  eq(
    mapCurrentSrc(CAPTURED),
    '/api/map/current?v=1790981396',
    'the live composite is addressed same-origin, with the version as the key',
  );
  ok(
    mapCurrentSrc(CAPTURED).startsWith('/'),
    'same-origin: no Supabase host reaches the browser for the live map',
  );
  ok(
    !mapCurrentSrc(CAPTURED).includes('supabase'),
    'and the bucket is not named in the markup either',
  );

  eq(framePad(7), '0007', 'day numbers pad to four digits, as the snapshotter names them');
  eq(framePad(951), '0951', 'and a three-digit day pads the same way');
  eq(mapFrameSrc(412), '/api/map/frame/0412', 'an archived frame is addressed by its padded day');
  ok(
    !mapFrameSrc(412).includes('?'),
    'a frame carries no version query: its day number IS its version',
  );
  eq(
    mapFrameSrc(412),
    mapFrameSrc(412),
    'stable, so a second press of play is served by the edge',
  );
}

console.log('\nmapStorageUrl');
{
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  eq(
    mapStorageUrl('current.webp'),
    `${base}${MAP_BUCKET_PATH}/current.webp`,
    'upstream object URLs are built off the public bucket path',
  );
  eq(MAP_FRAME_PREFIX, 'frames-by-day/day-', 'the frame prefix matches scripts/map-snapshot.mjs');
}

console.log('\nparseFrameDay');
{
  eq(parseFrameDay('0412'), 412, 'a padded day parses to its number');
  eq(parseFrameDay('1'), 1, 'and so does an unpadded one');
  eq(parseFrameDay('9999'), 9999, 'the top of the range is accepted');

  // The route rebuilds the object path from the NUMBER, so nothing below could
  // escape frames-by-day/ even if it parsed — but it must not parse.
  eq(parseFrameDay('0'), null, 'day 0 does not exist; Valheim world days start at 1');
  eq(parseFrameDay('10000'), null, 'five digits is out of range');
  eq(parseFrameDay('-1'), null, 'negatives are refused');
  eq(parseFrameDay('1.5'), null, 'so are decimals');
  eq(parseFrameDay('+1'), null, 'so is a signed number');
  eq(parseFrameDay(' 12'), null, 'so is anything with whitespace in it');
  eq(parseFrameDay('12e2'), null, 'so is exponent notation');
  eq(parseFrameDay('0x10'), null, 'so is hex');
  eq(parseFrameDay('../../status.json'), null, 'so is a traversal attempt');
  eq(parseFrameDay('0412.webp'), null, 'so is a filename');
  eq(parseFrameDay('current'), null, 'so is another object name');
  eq(parseFrameDay(''), null, 'an empty segment is refused');
  eq(parseFrameDay(undefined), null, 'and so is a missing one');
  eq(parseFrameDay(null), null, 'and so is null');
}

console.log(
  failures === 0 ? '\nAll map-image tests passed.' : `\n${failures} map-image test(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
