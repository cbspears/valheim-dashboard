// The PROFILE-ONLY post — EilifCompanionClient ≥0.4.x — and the fish total.
//
// THE BUG THIS FILE EXISTS FOR (2026-09-12). Since pack v14 two posters share
// `source:'client'` for the same viking, five minutes apart:
//
//   • GsValheimStatsClient  — weapons[], skills[], creatureKills[], boss[],
//     materials[]; per-WORLD files. On Valheim 1.0 it carries no `stats` map,
//     no kills counter and no pickups[] at all.
//   • EilifCompanionClient  — a `stats` map of PROFILE counters (vh_Builds,
//     vh_Crafts, vh_Distance*, vh_ItemsPickedUp, vh_FishCaught) and NOTHING
//     else.
//
// lib/gs-client deliberately makes the two disjoint, so the profile post parses
// with `killsSource:'none'`. lib/gs-baseline's capture gate then refused it —
// on a fresh row AND on an existing baseline — and `defer` writes nothing at
// all: no zero-point, no row, no gs_updated_at, no Great Deeds. Builds, crafts,
// distance, pickups and catches were therefore invisible for every viking, for
// as long as they played. That is rule 6 ("a viking is NEVER muted") failing in
// the exact way rule 6 was written to stop.
//
// Run: npx tsx scripts/gs-profile-post.test.mjs
import assert from 'node:assert';
import { parseSelfSnapshot, parseSelfDistances } from '../lib/gs-client.ts';
import {
  applyBaseline,
  captureQualification,
  profileOnlyCaptured,
  snapshotHoles,
  mergeIntoRow,
  GS_BASELINE_VERSION,
} from '../lib/gs-baseline.ts';

let checks = 0;
const eq = (a, b, m) => {
  checks++;
  assert.equal(a, b, m);
};
const ok = (v, m) => {
  checks++;
  assert.ok(v, m);
};

// ── fixtures ─────────────────────────────────────────────────────────────────

/** An EilifCompanionClient 0.4.x profile post: a `stats` map and nothing else. */
function profilePost({
  reporter = 'Charleif',
  world = 'Eilif',
  builds = 1200,
  crafts = 800,
  walk = 30000,
  run = 20000,
  sail = 4000,
  air = 0,
  pickedUp = 9000,
  fishCaught,
} = {}) {
  const stats = {
    vh_Builds: builds,
    vh_Crafts: crafts,
    vh_DistanceTraveled: walk + run + sail + air,
    vh_DistanceWalk: walk,
    vh_DistanceRun: run,
    vh_DistanceSail: sail,
    vh_DistanceAir: air,
    vh_ItemsPickedUp: pickedUp,
  };
  if (fishCaught !== undefined) stats.vh_FishCaught = fishCaught;
  return { schemaVersion: 1, game: 'valheim', source: 'client', reporter, world, players: [{ name: reporter, stats }] };
}

/** A GsValheimStatsClient 0.2.12 post on Valheim 1.0: lists, no `stats` map. */
function gsPost({
  reporter = 'Charleif',
  world = 'Eilif',
  weaponKills = 40,
  weaponDamage = 12000,
  greydwarfKills = 30,
  fishingLevel = 12,
  fish,
} = {}) {
  // On Valheim 1.0 the mod carries no pickups[] at all — pass `fish` explicitly
  // to model the day it comes back (and, with it, the two-source pickup hazard).
  const self = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter,
    world,
    name: reporter,
    platformId: 'Steam_765',
    weapons: [{ weapon: 'Axes', damageDealt: weaponDamage, kills: weaponKills, hardestHit: 90, biggestSwing: 110 }],
    creatureKills: [{ creature: 'Greydwarf', kills: greydwarfKills }],
    skills: [{ skill: 'Fishing', level: fishingLevel }],
    materials: [{ material: 'Wood', amount: 500 }],
    boss: [],
  };
  if (fish !== undefined) self.pickups = fish;
  return { schemaVersion: 1, game: 'valheim', source: 'client', reporter, world, players: [self] };
}

const ingest = (body, stored, at = '2026-09-12T12:00:00.000Z') =>
  applyBaseline(parseSelfSnapshot(body), parseSelfDistances(body), stored, at);

/**
 * A player_stats row over time, exactly as /api/gs-ingest keeps it: the STORED
 * zero-point only moves when `nextBaseline` is non-null (a null means "leave the
 * stored one alone"), and the row is GREATEST-merged every cycle. Threading this
 * by hand is how a test accidentally hands each post a fresh baseline and proves
 * nothing.
 */
function world(stored = null) {
  let base = stored;
  let r = null;
  return {
    post(body, at) {
      const res = ingest(body, base, at);
      if (!res.deferred) {
        r = row(r, res.effective, res.nextBaseline);
        if (res.nextBaseline) base = res.nextBaseline;
      }
      return res;
    },
    get baseline() {
      return base;
    },
    get row() {
      return r;
    },
  };
}

const row = (prev, effective, nextBaseline) =>
  mergeIntoRow(prev, effective, {
    playerId: 'player-1',
    reporter: 'Charleif',
    world: 'Eilif',
    now: '2026-09-12T12:00:00.000Z',
    nextBaseline,
  }).row;

// ── 1. fresh row + profile-only post → CAPTURE, not defer ────────────────────

{
  const body = profilePost();
  const s = parseSelfSnapshot(body);
  const dist = parseSelfDistances(body);

  eq(s.provenance.profileOnly, true, 'the parser recognizes a profile-only post');
  eq(s.provenance.killsSource, 'none', 'and it still speaks for no kills');
  eq(s.provenance.pickupsSource, 'vh_ItemsPickedUp', 'pickups come from the profile counter');
  eq(captureQualification(s, dist).ok, true, 'which no longer defers the whole post');

  const cap = ingest(body, null);
  eq(cap.deferred, false, 'a fresh row captures instead of writing nothing');
  eq(cap.change, 'capture');

  // The groups it CARRIED take a zero-point…
  eq(cap.nextBaseline.counters.structuresBuilt, 1200);
  eq(cap.nextBaseline.counters.itemsCrafted, 800);
  eq(cap.nextBaseline.counters.resourcesHarvested, 9000);
  eq(cap.nextBaseline.counters.distanceTraveled, 54000);
  eq(cap.nextBaseline.counterMaps.distances.walk, 30000);
  eq(cap.nextBaseline.pickupsSource, 'vh_ItemsPickedUp', 'and the pickup source is recorded with the number');
  eq(cap.nextBaseline.craftsSource, 'vh_Crafts');

  // …and the ones it cannot speak for are HOLES, never a filler 0.
  for (const path of [
    'counters.kills',
    'counters.deaths',
    'counters.bossKills',
    'counters.damageDealt',
    'counterMaps.weaponKills',
    'counterMaps.creatureKills',
    'counterMaps.fish',
    'recordMaps.skills',
  ]) {
    ok(cap.nextBaseline.holes.includes(path), `${path} is holed on a profile post`);
  }
  eq(cap.nextBaseline.counters.kills, undefined, 'no filler 0 is stored for kills');
  eq(cap.nextBaseline.killsSource, undefined, 'nor a kills source it cannot claim');

  // This post credits nothing — it IS the zero-point.
  eq(cap.effective.structuresBuilt, 0, '1,200 imported builds credit nothing');
  eq(cap.effective.distanceTraveled, 0);
  eq(cap.effective.resourcesHarvested, 0);
  eq(cap.effective.itemsCrafted, 0);

  // But a row IS written, which is the whole point: gs_updated_at advances and
  // the zero-point is persisted, so post 2 can credit.
  const r = row(null, cap.effective, cap.nextBaseline);
  ok(r.gs_updated_at, 'gs_updated_at advances on a profile post');
  ok(r.gs_baseline, 'and the zero-point is persisted');

  // The log helper says what the post actually spoke for.
  const said = profileOnlyCaptured(s, dist).join(', ');
  for (const frag of ['builds 1200', 'crafts 800', 'pickups 9000', 'distance 54000m']) {
    ok(said.includes(frag), `the ingest log line names ${frag}`);
  }
}

// ── 2. an EXISTING baseline whose profile groups are holes → repaired ────────
//
// The post-reset shape that was live in production: a zero-point taken from a
// GsValheimStatsClient post, so every profile-derived group is a hole. Before
// the fix this deferred exactly like a fresh row, so those holes could never be
// filled by the only poster that carries them.

{
  const holed = {
    v: GS_BASELINE_VERSION,
    capturedAt: '2026-09-10T00:00:00.000Z',
    reporter: 'Charleif',
    world: 'Eilif',
    killsSource: 'weapons',
    counters: { kills: 50, deaths: 3, bossKills: 0, damageDealt: 12000 },
    counterMaps: { weaponKills: { Axes: 40 }, weaponDamage: { Axes: 12000 }, creatureKills: {}, bossDamage: {}, bossFightSec: {}, materials: {}, fish: {} },
    records: { longestLifeSec: 0, bestKillsBeforeDeath: 0 },
    recordMaps: { weaponHardestHit: {}, weaponBiggestSwing: {}, skills: {} },
    holes: [
      'counters.structuresBuilt',
      'counters.itemsCrafted',
      'counters.distanceTraveled',
      'counters.resourcesHarvested',
      'counters.fishCaught',
      'counterMaps.distances',
      'counterMaps.distancesRaw',
    ],
  };

  const w = world(holed);

  const r1 = w.post(profilePost());
  eq(r1.deferred, false, 'a profile post against a holed baseline is no longer deferred');
  eq(r1.change, 'repair');
  ok(/first sighting of/.test(r1.reason), 'the holes are filled, not re-holed');
  eq(w.baseline.counters.structuresBuilt, 1200, 'the hole takes its zero-point from THIS snapshot');
  eq(w.baseline.counters.resourcesHarvested, 9000);
  eq(w.baseline.counters.distanceTraveled, 54000);
  eq(w.baseline.pickupsSource, 'vh_ItemsPickedUp', 'a fill brings the source across with the number');
  eq(r1.effective.structuresBuilt, 0, 'and the filling post itself credits nothing');
  eq(r1.effective.resourcesHarvested, 0);

  // The kills zero-point it could not speak for is untouched.
  eq(w.baseline.counters.kills, 50, 'kills keeps the zero-point the GS post gave it');
  eq(w.baseline.killsSource, 'weapons');
  ok(!(w.baseline.holes ?? []).includes('counters.structuresBuilt'), 'the builds hole is gone once filled');
  ok((w.baseline.holes ?? []).includes('counters.fishCaught'), 'a group nobody carried stays holed');

  // ── 3. a LATER profile post with higher counters is credited the delta ─────
  const grew = w.post(
    profilePost({ builds: 1260, crafts: 845, walk: 31500, run: 20000, sail: 4000, pickedUp: 9400 }),
    '2026-09-12T12:05:00.000Z',
  );
  eq(grew.deferred, false);
  eq(grew.effective.structuresBuilt, 60, '60 pieces placed HERE are credited');
  eq(grew.effective.itemsCrafted, 45);
  eq(grew.effective.resourcesHarvested, 400);
  eq(grew.effective.distanceTraveled, 1500);
  eq(grew.effective.distances.walk, 1500);
  eq(grew.effective.kills, 0, 'and kills still credits nothing from a profile post');
  eq(grew.effective.deaths, 0);
  eq(w.row.structures_built, 60);
  eq(w.row.resources_harvested, 400);

  // ── 4. a GsValheimStatsClient post in between changes nothing about that ───
  const gs = w.post(gsPost({ weaponKills: 55, weaponDamage: 15000 }), '2026-09-12T12:07:00.000Z');
  eq(gs.deferred, false, 'the GS post is not deferred either');
  eq(gs.effective.kills, 5, 'and it still credits its own kills against its own zero-point');
  eq(gs.effective.damageDealt, 3000);
  eq(gs.effective.structuresBuilt, 0, 'it has no builds reading, so it credits none');

  eq(w.row.structures_built, 60, 'and it does NOT zero the profile-derived columns');
  eq(w.row.resources_harvested, 400);
  eq(w.row.distance_traveled, 1500);
  eq(w.row.kills, 5);
  eq(w.baseline.counters.structuresBuilt, 1200, 'nor disturb the profile zero-points');
  eq(w.baseline.counters.resourcesHarvested, 9000);

  // …and the NEXT profile post still credits from where it left off.
  const after = w.post(
    profilePost({ builds: 1300, crafts: 845, walk: 31500, run: 20000, sail: 4000, pickedUp: 9400 }),
    '2026-09-12T12:10:00.000Z',
  );
  eq(after.deferred, false, 'a profile post after a GS post is still not deferred');
  eq(after.effective.structuresBuilt, 100, 'the builds delta is measured from the original zero-point');
  eq(w.row.kills, 5, 'and the GS-derived kills column survives the profile post');
  eq(w.row.structures_built, 100);
}

// ── 5. the bystander deferral is UNTOUCHED ──────────────────────────────────

{
  const bystander = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Charleif',
    world: 'Eilif',
    players: [{ name: 'Rosir', stats: { vh_Builds: 500, vh_Crafts: 20, vh_ItemsPickedUp: 900 } }],
  };
  const s = parseSelfSnapshot(bystander);
  eq(s.provenance.ownEntry, false);
  eq(captureQualification(s, parseSelfDistances(bystander)).ok, false, 'no own entry is still no career');
  eq(ingest(bystander, null).deferred, true, 'a bystander profile entry never seeds a zero-point');
}

// ── 6. a GS-shaped post with no kills reading STILL defers ──────────────────
//
// The exception is for a payload that was never going to carry a combat
// reading, not for one that should have and didn't. A `stats` map alongside the
// breakdown lists is a GsValheimStatsClient post, so `profileOnly` is false and
// the old gate stands.

{
  const broken = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Charleif',
    world: 'Eilif',
    players: [
      {
        name: 'Charleif',
        stats: { vh_Builds: 1200, vh_Crafts: 800 },
        skills: [{ skill: 'Fishing', level: 12 }],
        materials: [],
        // no kills counter and no weapons[]
      },
    ],
  };
  const s = parseSelfSnapshot(broken);
  eq(s.provenance.profileOnly, false, 'a breakdown list means this is not a profile-only post');
  eq(s.provenance.killsSource, 'none');
  eq(captureQualification(s, parseSelfDistances(broken)).ok, false, 'so it still defers');
  eq(ingest(broken, null).deferred, true);

  // …and so does a profile post carrying a `stats` map with nothing accountable.
  const empty = {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Charleif',
    world: 'Eilif',
    players: [{ name: 'Charleif', stats: { vh_SomethingElse: 3 } }],
  };
  eq(captureQualification(parseSelfSnapshot(empty), parseSelfDistances(empty)).ok, false, 'an empty profile map is not a report');
}

// ── 7. FISH: the catch total from vh_FishCaught ─────────────────────────────
//
// GsValheimStatsClient 0.2.12 reports `fish: []` for everyone on Valheim 1.0,
// so the Anglers board's tie-break (total catches) has been a row of zeros since
// launch. The profile counter is the only reading that exists — and it is a
// LIFETIME one, so it is baselined and hole-gated like every other counter.

{
  // A payload with no vh_FishCaught holes the group rather than baselining 0.
  const without = profilePost();
  const sWithout = parseSelfSnapshot(without);
  eq(sWithout.provenance.hasFishCaught, false);
  ok(
    snapshotHoles(sWithout, parseSelfDistances(without)).includes('counters.fishCaught'),
    'an absent vh_FishCaught is a hole, never a zero-point of 0',
  );

  // First post carrying it: 420 lifetime catches become the zero-point.
  const w = world(null);
  const cap = w.post(profilePost({ fishCaught: 420 }));
  eq(w.baseline.counters.fishCaught, 420);
  eq(cap.effective.fishCaught, 0, '420 catches landed on another world credit nothing');
  eq(w.row.gs_stats.fishCaught, undefined, 'and nothing is written into the blob yet');

  // Nine caught here.
  const grew = w.post(profilePost({ fishCaught: 429 }), '2026-09-12T12:05:00.000Z');
  eq(grew.effective.fishCaught, 9, 'only the nine caught HERE are credited');
  eq(w.row.gs_stats.fishCaught, 9, 'and they land in gs_stats where the Anglers board reads them');

  // A post that carries no vh_FishCaught leaves the stored total alone rather
  // than blanking it (GREATEST, like every other counter).
  const quiet = w.post(profilePost(), '2026-09-12T12:07:00.000Z');
  eq(quiet.effective.fishCaught, 0);
  eq(w.row.gs_stats.fishCaught, 9, 'the tally survives a post that omits it');

  // The GS post does not blank it either, and if fish[] ever returns the two
  // merge sensibly (species detail alongside the total, readers take the max).
  w.post(gsPost({ fish: [{ item: 'Fish1', count: 6 }, { item: 'Wood', count: 40 }] }), '2026-09-12T12:09:00.000Z');
  eq(w.row.gs_stats.fishCaught, 9, 'a GS post never zeroes the profile catch total');
  // That GS post FILLS the fish-species hole, so it credits 0 species this cycle
  // and everything after it is real — the same lifecycle as every other hole.
  eq(w.row.gs_stats.fish.length, 0, 'the filling GS post credits no species');
  w.post(gsPost({ fish: [{ item: 'Fish1', count: 8 }, { item: 'Wood', count: 40 }] }), '2026-09-12T12:11:00.000Z');
  eq(w.row.gs_stats.fish[0].count, 2, 'two perch caught here after the hole filled');
  eq(w.row.gs_stats.fishCaught, 9, 'and the profile total is still there beside it');
}

// ── 8. resourcesHarvested is never differenced across its two sources ────────
//
// `sum(pickups[].count)` is world-scoped; `vh_ItemsPickedUp` is the profile's
// LIFETIME total. Two posters, five minutes apart. Differencing one against the
// other's zero-point credits every item the viking has ever picked up anywhere.

{
  // Zero-point taken from a GS post's pickups[] (50 items).
  const w = world(null);
  w.post(gsPost({ fish: [{ item: 'Wood', count: 50 }] }));
  eq(w.baseline.counters.resourcesHarvested, 50);
  eq(w.baseline.pickupsSource, 'pickups');

  // The profile post then arrives with a lifetime 9,000.
  const profile = w.post(profilePost({ pickedUp: 9000 }), '2026-09-12T12:05:00.000Z');
  eq(profile.deferred, false);
  eq(profile.effective.resourcesHarvested, 0, '8,950 foreign pickups are not a delta, they are another world');
  eq(w.baseline.counters.resourcesHarvested, 50, 'and the zero-point is not re-taken from the other source');

  // The source that WAS baselined keeps crediting normally.
  const more = w.post(gsPost({ fish: [{ item: 'Wood', count: 62 }] }), '2026-09-12T12:07:00.000Z');
  eq(more.effective.resourcesHarvested, 12, 'the matching source still credits its 12');
}

// ── 9. the reset detector must not read "two posters" as a wiped character ──
//
// THE INCIDENT THIS PREVENTS (found while writing case 4). The career signature
// summed kills + deaths + crafts + builds + pickups blind. Once profile posts
// started capturing, the zero-point held 1,200 builds / 800 crafts / 9,000
// pickups at LIFETIME scale — and every GsValheimStatsClient post, which speaks
// for none of those, collapsed the signature from 11,053 to 55. That is
// `reset-pending` on every second post (crediting nothing) and a full
// RE-BASELINE after three, for a character that had not changed at all.

{
  const w = world(null);
  w.post(profilePost({ builds: 1200, crafts: 800, pickedUp: 9000 }));
  w.post(gsPost({ weaponKills: 40 }), '2026-09-12T12:02:00.000Z');

  let last;
  for (let i = 1; i <= 4; i++) {
    last = w.post(gsPost({ weaponKills: 40 + i }), `2026-09-12T12:${String(2 + i * 2).padStart(2, '0')}:00.000Z`);
    ok(last.change !== 'reset-pending', `GS post ${i} is not read as a collapsing career`);
    ok(last.change !== 'rebaseline', `GS post ${i} never re-zeroes the profile counters`);
  }
  eq(last.effective.kills, 4, 'and kills are credited normally throughout');
  eq(w.baseline.counters.structuresBuilt, 1200, 'the profile zero-point is never re-taken by a GS post');
  eq(w.row.structures_built, 0, 'no profile growth yet, and nothing invented');

  // A genuine wipe still shows up on the post that carries the collapsed
  // counters: the profile poster comes back at ~0.
  const wiped = w.post(profilePost({ builds: 2, crafts: 1, pickedUp: 5 }), '2026-09-12T13:00:00.000Z');
  eq(wiped.change, 'reset-pending', 'a real profile collapse is still detected');
}

console.log(`OK — profile-only post + fish total: ${checks} checks. A stats-only own-entry post captures what it`);
console.log('carries (builds, crafts, distance, pickups, catches) and holes what it does not, an existing');
console.log('holed baseline is repaired from it, later posts are credited the delta, interleaved');
console.log('GsValheimStatsClient posts neither defer nor zero any of it, and the bystander deferral stands.');
