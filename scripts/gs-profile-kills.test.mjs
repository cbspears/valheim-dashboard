// The KILLS COLUMN changes hands — EilifCompanionClient ≥0.4.5's vh_EnemyKills.
//
// THE PROBLEM THIS FILE EXISTS FOR. Two posters report every viking a couple of
// minutes apart, both as `source:'client'`:
//
//   • GsValheimStatsClient — a weapons[] breakdown read from its own per-WORLD
//     TSV. On Valheim 1.0 it is the only kills reading there is (summed as
//     `killsSource:'weapons'`), and it is a bad one: the file RESETS when a
//     player rebuilds their profile or changes PC (the column stalls) and it
//     LEAKS across characters on a shared PC (the column inflates).
//   • EilifCompanionClient — a `stats` map of profile counters. Since 0.4.5 it
//     carries `vh_EnemyKills`, Valheim's own PlayerStatType.EnemyKills from the
//     LIFETIME bucket: monotonic, per character, immune to a mod reinstall.
//
// So the profile counter takes the column. The danger is the 2026-09-10 incident
// in a new costume: if BOTH readings kept re-taking the zero-point on every
// source change, it would flip twice a cycle forever and the column would jump
// around (Kætiløy 183 → 97). Hence the one-way rule proved below — weapons →
// profile re-takes ONCE, and from then on a weapons/client post is NOT CARRIED
// for kills: it credits nothing, re-takes nothing, and lowers nothing, while
// still contributing its damage, weapons and skills.
//
// Run: npx tsx scripts/gs-profile-kills.test.mjs
import assert from 'node:assert';
import { parseSelfSnapshot, parseSelfDistances } from '../lib/gs-client.ts';
import {
  applyBaseline,
  captureQualification,
  mergeIntoRow,
  readBaseline,
  withProfileKillsZeroPoint,
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

/** An EilifCompanionClient profile post. `enemyKills` omitted = the 0.4.4 shape. */
function profilePost({ reporter = 'Kætiløy', world = 'Eilif', builds = 9, crafts = 4, walk = 180, pickedUp = 120, enemyKills } = {}) {
  const stats = {
    vh_Builds: builds,
    vh_Crafts: crafts,
    vh_DistanceTraveled: walk,
    vh_DistanceWalk: walk,
    vh_ItemsPickedUp: pickedUp,
  };
  if (enemyKills !== undefined) stats.vh_EnemyKills = enemyKills;
  return { schemaVersion: 1, game: 'valheim', source: 'client', reporter, world, players: [{ name: reporter, stats }] };
}

/** A GsValheimStatsClient 0.2.12 post on Valheim 1.0: lists only, no `stats`. */
function gsPost({ reporter = 'Kætiløy', world = 'Eilif', weaponKills = 1, weaponDamage = 3100 } = {}) {
  return {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter,
    world,
    players: [
      {
        name: reporter,
        platformId: 'Steam_765',
        weapons: [{ weapon: 'Axes', damageDealt: weaponDamage, kills: weaponKills, hardestHit: 92, biggestSwing: 110 }],
        creatureKills: [],
        crafts: [],
        pickups: [],
        materials: [{ material: 'Wood', amount: 500 }],
        skills: [{ skill: 'Axes', level: 12 }],
        boss: [],
      },
    ],
  };
}

const ingest = (body, stored, at = '2026-09-13T12:00:00.000Z') =>
  applyBaseline(parseSelfSnapshot(body), parseSelfDistances(body), stored, at);

/** A player_stats row over time, exactly as /api/gs-ingest keeps it. */
function world(stored = null) {
  let base = stored;
  let r = null;
  return {
    post(body, at) {
      const res = ingest(body, base, at);
      if (!res.deferred) {
        r = mergeIntoRow(r, res.effective, {
          playerId: 'player-1',
          reporter: 'Kætiløy',
          world: 'Eilif',
          now: at ?? '2026-09-13T12:00:00.000Z',
          nextBaseline: res.nextBaseline,
        }).row;
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

// ── (a) the parse: vh_EnemyKills is the kills reading ────────────────────────

{
  const body = profilePost({ enemyKills: 224 });
  const s = parseSelfSnapshot(body);

  eq(s.provenance.profileOnly, true, 'it is still a profile-only post');
  eq(s.provenance.killsSource, 'profile', 'and it now speaks for kills');
  eq(s.kills, 224, 'valued at the profile counter, never summed from anything');
  eq(s.provenance.hasKills, true);

  // Deaths stay exactly where they were: with our own `events` rows.
  eq(s.provenance.hasDeaths, false, 'deaths are still a hole on a profile post');
  eq(s.deaths, 0);

  // The profile counter OUTRANKS the entry's own counter and the weapons sum.
  const both = profilePost({ enemyKills: 224 });
  both.players[0].kills = 11;
  both.players[0].weapons = [{ weapon: 'Axes', damageDealt: 100, kills: 7, hardestHit: 9, biggestSwing: 9 }];
  const p = parseSelfSnapshot(both);
  eq(p.provenance.killsSource, 'profile', 'profile > client > weapons');
  eq(p.kills, 224);
  eq(p.damageDealt, 100, 'damageDealt still comes from weapons[] — unchanged');

  const cap = ingest(body, null);
  eq(cap.deferred, false, 'and it qualifies on kills alone');
  eq(captureQualification(s, parseSelfDistances(body)).ok, true);
  eq(cap.nextBaseline.counters.kills, 224, 'the zero-point is the counter itself');
  eq(cap.nextBaseline.killsSource, 'profile', 'recorded with the number');
  ok(!(cap.nextBaseline.holes ?? []).includes('counters.kills'), 'kills is no longer holed on a profile post');
  ok((cap.nextBaseline.holes ?? []).includes('counters.deaths'), 'deaths still is');
  eq(cap.effective.kills, 0, 'the capturing post credits nothing');
}

// ── (b) weapons → profile: ONE re-take, then real growth ─────────────────────
//
// The live shape on 2026-09-13: every zero-point on the server was taken from a
// GS post, so the first 0.4.5 profile post is a source change. It re-takes (this
// post credits 0) rather than differencing a lifetime 224 against a 1-kill
// weapons zero-point and handing the viking 223 foreign kills.

const w = world();

{
  const first = w.post(gsPost({ weaponKills: 1 }), '2026-09-13T12:00:00.000Z');
  eq(first.change, 'capture');
  eq(w.baseline.counters.kills, 1);
  eq(w.baseline.killsSource, 'weapons');

  const flip = w.post(profilePost({ enemyKills: 224 }), '2026-09-13T12:02:00.000Z');
  eq(flip.change, 'repair', 'the source change is a repair, not a defer');
  ok(/kills source changed weapons → profile/.test(flip.reason), flip.reason);
  eq(w.baseline.counters.kills, 224, 'the zero-point is re-taken from THIS snapshot');
  eq(w.baseline.killsSource, 'profile');
  eq(flip.effective.kills, 0, 'so the transition credits 0 kills, not 223');
  eq(w.row.kills, 0);

  const grew = w.post(profilePost({ enemyKills: 230 }), '2026-09-13T12:04:00.000Z');
  eq(grew.effective.kills, 6, 'six kills earned HERE are credited in full');
  eq(w.row.kills, 6);
  eq(w.baseline.counters.kills, 224, 'and the zero-point stays put — no re-take on a matching source');
}

// ── (c) …and the GS post never takes it back ─────────────────────────────────

{
  const gs = w.post(gsPost({ weaponKills: 198, weaponDamage: 5000 }), '2026-09-13T12:06:00.000Z');

  ok(gs.change !== 'reset-pending', `a GS post is not a collapsed career (got ${gs.change})`);
  ok(gs.change !== 'rebaseline');
  eq(gs.effective.kills, 0, 'a weapons sum credits nothing against a profile zero-point');
  eq(w.row.kills, 6, 'and the column keeps what the profile post earned');
  eq(w.baseline.counters.kills, 224, 'the zero-point is not re-taken…');
  eq(w.baseline.killsSource, 'profile', '…nor handed back to the weapons sum');
  ok(!(w.baseline.holes ?? []).includes('counters.kills'), 'and kills is NOT re-holed — only this post is blind to it');

  // Everything else on the GS post merges exactly as before.
  eq(gs.effective.damageDealt, 1900, 'damage from weapons[] is still credited');
  eq(w.row.damage_dealt, 1900);
  const axes = gs.effective.gsStats.weapons.find((x) => x.weapon === 'Axes');
  eq(axes.kills, 197, 'the per-weapon Feats of Arms breakdown is untouched by any of this');
  eq(axes.damageDealt, 1900);

  // The profile post still credits on the very next cycle.
  const after = w.post(profilePost({ enemyKills: 236 }), '2026-09-13T12:08:00.000Z');
  eq(after.effective.kills, 12, 'the profile poster keeps crediting from its own zero-point');
  eq(w.row.kills, 12);
}

// ── (d) the rollout shape: kills 0 + 'profile' credits the whole counter ─────
//
// Launch-fresh characters rolled on this world: the lifetime counter IS the
// career earned here, so the operator may zero the zero-point instead of
// re-taking at it. `{ killsSource:'profile', counters:{ kills: 0 } }` has to be
// a legal STORED shape — 0 is a real reading, not a hole.

{
  const stored = {
    v: GS_BASELINE_VERSION,
    capturedAt: '2026-09-13T00:00:00.000Z',
    reporter: 'Kætiløy',
    world: 'Eilif',
    killsSource: 'profile',
    counters: { kills: 0 },
    counterMaps: {},
    records: {},
    recordMaps: {},
  };
  const res = ingest(profilePost({ enemyKills: 224 }), stored);
  eq(res.deferred, false);
  eq(res.effective.kills, 224, 'the full lifetime counter is credited');
  eq(res.nextBaseline?.counters?.kills ?? 0, 0, 'and the zero-point stays at 0 (no re-take, the source matches)');

  // The helper produces exactly that shape from a zero-point already in flight,
  // ceiling and hole included, so a rollout needs no hand-edited jsonb.
  const rolled = withProfileKillsZeroPoint({
    ...readBaseline(w.baseline),
    holes: ['counters.kills', 'counters.deaths'],
    superseded: { ...readBaseline(w.baseline), counters: { kills: 900, deaths: 4 } },
  });
  eq(rolled.counters.kills, 0);
  eq(rolled.killsSource, 'profile');
  ok(!rolled.holes.includes('counters.kills'), 'a hole would credit nothing at all');
  ok(rolled.holes.includes('counters.deaths'), 'every other hole is left alone');
  eq(rolled.superseded.counters.kills, undefined, 'a weapons-era ceiling would floor the credit at its old sum');
  eq(rolled.superseded.counters.deaths, 4);
  eq(ingest(profilePost({ enemyKills: 230 }), rolled).effective.kills, 230, 'so the whole counter lands');
}

// ── (e) the stored source round-trips ────────────────────────────────────────

{
  const round = readBaseline({
    v: GS_BASELINE_VERSION,
    capturedAt: '2026-09-13T00:00:00.000Z',
    killsSource: 'profile',
    counters: { kills: 224 },
  });
  eq(round.killsSource, 'profile', "readBaseline accepts 'profile'");
  eq(readBaseline({ v: GS_BASELINE_VERSION, killsSource: 'weapons', counters: {} }).killsSource, 'weapons');
  eq(
    readBaseline({ v: GS_BASELINE_VERSION, killsSource: 'vh_EnemyKills', counters: {} }).killsSource,
    undefined,
    'and still refuses a source it does not know',
  );
}

// ── (f) a 0.4.4 client (no vh_EnemyKills) behaves exactly as it did ──────────

{
  const body = profilePost();
  const s = parseSelfSnapshot(body);
  eq(s.provenance.killsSource, 'none', 'no counter, no lists — no kills reading');
  eq(s.provenance.hasKills, false);
  eq(s.kills, 0);

  const cap = ingest(body, null);
  eq(cap.deferred, false, 'the profile-only exception still carries it past the gate');
  eq(cap.change, 'capture');
  ok(cap.nextBaseline.holes.includes('counters.kills'), 'kills is a HOLE, never a filler 0');
  eq(cap.nextBaseline.counters.kills, undefined);
  eq(cap.nextBaseline.killsSource, undefined, 'and no source it cannot claim');
  eq(cap.effective.kills, 0);

  // …and a GS post still fills that hole and owns the column, as today.
  const w2 = world(cap.nextBaseline);
  const gs = w2.post(gsPost({ weaponKills: 42 }), '2026-09-13T12:02:00.000Z');
  eq(gs.change, 'repair');
  eq(w2.baseline.counters.kills, 42, 'the hole takes its zero-point from the GS post');
  eq(w2.baseline.killsSource, 'weapons');
  eq(w2.post(gsPost({ weaponKills: 50 }), '2026-09-13T12:04:00.000Z').effective.kills, 8);
}

console.log(`OK — profile kills counter: ${checks} checks. vh_EnemyKills outranks the client counter and the`);
console.log('weapons sum, a profile post now carries kills (deaths stay a hole), the weapons → profile');
console.log('transition re-takes the zero-point exactly once, and from then on a GsValheimStatsClient post');
console.log('credits, lowers and re-takes nothing on kills while its damage and weapon breakdown still merge.');
