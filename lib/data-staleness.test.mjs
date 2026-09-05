// Tests for the two "is this feed still alive?" helpers in lib/data.ts.
//
// Both exist because two of the server's mods are expected to break quietly on
// Valheim 1.0 (audit mods-7 and mods-8): the closed-source GsValheimStats
// Emitter, which is the only thing that refreshes `server_status` on a cadence,
// and the dormant WebMap plugin, which the map composite is rendered from. When
// either stops, the last values keep sitting in Supabase / Storage looking
// perfectly current — so the site has to date them itself and say so.
//
//   npx tsx lib/data-staleness.test.mjs

import {
  mapFreshness,
  statsFreshness,
  MAP_STALE_AFTER_MS,
  STATS_STALE_AFTER_MS,
} from './data.ts';

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

// Fixed clock so every case is deterministic: 2026-09-09 20:00:00Z (launch day).
const NOW = Date.parse('2026-09-09T20:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** An ISO timestamp `ms` before NOW. */
const ago = (ms) => new Date(NOW - ms).toISOString();

console.log('\nconstants');
eq(MAP_STALE_AFTER_MS, 6 * HOUR, 'the map composite may be six hours old');
eq(STATS_STALE_AFTER_MS, 15 * MIN, 'server_status may be fifteen minutes old');

console.log('\nmapFreshness — the /map composite (uploaded every 5 minutes)');
{
  const missing = mapFreshness(null, NOW);
  eq(missing.stale, true, 'no last-modified header at all reads as stale');
  eq(missing.ageMs, null, 'and reports no age, so the page prints no "last charted" time');

  const junk = mapFreshness('not a date', NOW);
  eq(junk.stale, true, 'an unparseable last-modified reads as stale');
  eq(junk.ageMs, null, 'and reports no age');

  const fresh = mapFreshness(ago(4 * MIN), NOW);
  eq(fresh.stale, false, 'a four-minute-old composite is live');
  eq(fresh.ageMs, 4 * MIN, 'age is measured in ms');

  eq(
    mapFreshness(ago(5 * HOUR + 59 * MIN), NOW).stale,
    false,
    '5h59m is still live (one minute inside the window)'
  );
  eq(
    mapFreshness(ago(6 * HOUR + MIN), NOW).stale,
    true,
    '6h01m is stale (one minute past the window)'
  );
  eq(mapFreshness(ago(6 * HOUR), NOW).stale, false, 'exactly 6h is the last live minute, not stale');
  eq(
    mapFreshness(ago(3 * 24 * HOUR), NOW).ageMs,
    3 * 24 * HOUR,
    'a three-day-old chart still reports its real age',
  );

  // A clock skew between Vercel and Supabase Storage must never read as "aged".
  const future = mapFreshness(new Date(NOW + 30 * 1000).toISOString(), NOW);
  eq(future.ageMs, 0, 'a timestamp in the future clamps to age 0');
  eq(future.stale, false, 'and is not stale');
}

console.log('\nstatsFreshness — server_status (rewritten by the Emitter every 120s)');
const status = (is_online, updated_at) => ({
  id: 1,
  is_online,
  player_count: 0,
  current_players: [],
  world_day: 12,
  updated_at,
});
{
  const none = statsFreshness(null, NOW);
  eq(none.statsStale, false, 'no server_status row at all is not a stats alarm');
  eq(none.statsAgeMs, null, 'and has no age');

  const fresh = statsFreshness(status(true, ago(2 * MIN)), NOW);
  eq(fresh.statsStale, false, 'online with a two-minute-old row is healthy');
  eq(fresh.statsAgeMs, 2 * MIN, 'age is measured in ms');

  eq(
    statsFreshness(status(true, ago(15 * MIN)), NOW).statsStale,
    false,
    'exactly 15 minutes is the last healthy minute'
  );
  const dead = statsFreshness(status(true, ago(16 * MIN)), NOW);
  eq(dead.statsStale, true, 'online but 16 minutes quiet = Emitter dead, server alive');
  eq(dead.statsAgeMs, 16 * MIN, 'and the Hall can print how long it has been quiet');

  eq(
    statsFreshness(status(false, ago(9 * 24 * HOUR)), NOW).statsStale,
    false,
    'offline with a nine-day-old row is NOT stale — the Hearth already says the hall sleeps'
  );
  eq(
    statsFreshness(status(false, ago(9 * 24 * HOUR)), NOW).statsAgeMs,
    9 * 24 * HOUR,
    'an offline row still reports its age for anyone who wants it'
  );

  const never = statsFreshness(status(true, null), NOW);
  eq(never.statsStale, true, 'online with a never-written timestamp is stale — no evidence of life');
  eq(never.statsAgeMs, null, 'and prints no age, so the Hearth omits the "last update" clause');
  eq(
    statsFreshness(status(true, 'nonsense'), NOW).statsStale,
    true,
    'an unreadable timestamp is treated the same way'
  );
}

console.log(
  failures === 0 ? '\ndata-staleness: all checks passed\n' : `\ndata-staleness: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
