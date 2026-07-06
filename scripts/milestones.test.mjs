// Pure-function tests for the Collective Milestones evaluator (no network).
// Exercises the aggregate maths (incl. the sail vs walk/run distance split and
// the sessions-derived playtime), threshold crossing, and idempotency. Run:
//   npx tsx scripts/milestones.test.mjs
import {
  computeAggregates,
  evaluateMilestones,
  summarizeMilestones,
  renderLine,
  formatMetricValue,
} from '../lib/milestones.ts';
import assert from 'node:assert';

// ── aggregate maths ──────────────────────────────────────────────────────────
const stats = [
  {
    deaths: 5, kills: 600, boss_kills: 2, damage_dealt: 100000,
    resources_harvested: 40000, items_crafted: 50, structures_built: 4000,
    map_explored_pct: 20,
    gs_stats: { distances: { walk: 1000, run: 2000, sail: 60000, air: 10 } },
  },
  {
    deaths: 9, kills: 500, boss_kills: 1, damage_dealt: 80000,
    resources_harvested: 70000, items_crafted: 60, structures_built: 7000,
    map_explored_pct: 30,
    gs_stats: { distances: { walk: 500, run: 500, sail: 70000, air: 5 } },
  },
  // A viking with no gs_stats/explored yet — must not break the sums or the avg.
  { deaths: 0, kills: 0, resources_harvested: 0, gs_stats: null, map_explored_pct: null },
];

const sessions = [
  // Closed session — counts its duration verbatim.
  { character_name: 'Alice', joined_at: '2026-07-01T10:00:00Z', left_at: '2026-07-01T12:00:00Z', duration_minutes: 120 },
  // Open session for a viking NOT currently online — dropped (never guessed).
  { character_name: 'Bob', joined_at: '2026-07-01T10:00:00Z', left_at: null, duration_minutes: null },
];
const onlineNames = new Set(); // nobody online → Bob's open session is dropped → deterministic

const agg = computeAggregates({ stats, sessions, onlineNames });

// Distance split: sail is its own mode; walk_run is walk + run (air excluded).
assert.equal(agg.sail_total, 130000, 'sail_total = 60000 + 70000');
assert.equal(agg.walk_run_total, 4000, 'walk_run_total = (1000+2000) + (500+500)');
// Straight column sums.
assert.equal(agg.deaths_total, 14);
assert.equal(agg.kills_total, 1100);
assert.equal(agg.boss_kills_total, 3);
assert.equal(agg.damage_total, 180000);
assert.equal(agg.resources_total, 110000);
assert.equal(agg.crafts_total, 110);
assert.equal(agg.builds_total, 11000);
// Explored average over rows that HAVE a reading (null row ignored).
assert.equal(agg.explored_avg_pct, 25, 'explored_avg_pct = (20 + 30) / 2');
// Playtime: only Alice's closed 120 min counts (Bob offline → dropped).
assert.equal(agg.playtime_total_hours, 2, 'playtime_total_hours = 120 min / 60');

// ── threshold crossing ───────────────────────────────────────────────────────
const defs = [
  { id: 'sail-a', metric: 'sail_total', threshold: 122000, sort: 10, achieved_at: null, line: '', title: 'Sail A', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'sail-b', metric: 'sail_total', threshold: 1750000, sort: 20, achieved_at: null, line: '', title: 'Sail B', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'walk-a', metric: 'walk_run_total', threshold: 42195, sort: 30, achieved_at: null, line: '', title: 'Walk A', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'builds', metric: 'builds_total', threshold: 10000, sort: 5, achieved_at: null, line: '', title: 'Builds', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'explored', metric: 'explored_avg_pct', threshold: 25, sort: 40, achieved_at: null, line: '', title: 'Explored', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  // Already achieved — must be excluded even though 1100 >= 1000.
  { id: 'kills', metric: 'kills_total', threshold: 1000, sort: 15, achieved_at: '2026-07-01T00:00:00Z', achieved_value: 1000, line: '', title: 'Kills', equivalence: null, announced_at: null, meta: {} },
  // Unknown metric — never fires.
  { id: 'ghost', metric: 'not_a_metric', threshold: 1, sort: 99, achieved_at: null, line: '', title: 'Ghost', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
];

const crossed = evaluateMilestones(defs, agg);
const crossedIds = crossed.map((c) => c.def.id);
// builds (sort 5), sail-a (10), explored (40): sail-b/walk-a below threshold,
// kills already achieved, ghost unknown metric. Sorted by `sort` ascending.
assert.deepEqual(crossedIds, ['builds', 'sail-a', 'explored'], 'crossed set + sort order');
// achieved_value candidates carry the live aggregate.
assert.equal(crossed.find((c) => c.def.id === 'sail-a').value, 130000);
// Boundary: value == threshold crosses (explored: 25 >= 25).
assert.ok(crossedIds.includes('explored'), 'value == threshold crosses');

// ── idempotency ──────────────────────────────────────────────────────────────
// Simulate the orchestrator having stamped the crossed rows: re-evaluating with
// achieved_at set returns nothing new.
const afterRecord = defs.map((d) =>
  crossedIds.includes(d.id) ? { ...d, achieved_at: '2026-07-02T00:00:00Z' } : d,
);
assert.equal(evaluateMilestones(afterRecord, agg).length, 0, 'already-achieved rows never re-fire');

// ── summary (dashboard) ──────────────────────────────────────────────────────
const summary = summarizeMilestones(afterRecord, agg);
// latest = most-recently achieved by achieved_at (the three just-recorded, dated
// 07-02, beat kills dated 07-01). All three share the timestamp; any is fine —
// assert it's one of them and count is right.
assert.equal(summary.achieved.length, 4, '3 newly recorded + the pre-achieved kills');
assert.ok(summary.latest && summary.latest.achieved_at === '2026-07-02T00:00:00Z');
// next = nearest unachieved by pct. walk-a: 4000/42195 ≈ 9%; sail-b: 130000/1750000 ≈ 7%.
assert.equal(summary.next.milestone.id, 'walk-a', 'nearest unachieved by percentage');
assert.ok(summary.next.pct >= summary.upcoming[summary.upcoming.length - 1].pct, 'upcoming sorted by pct desc');

// ── formatting helpers ───────────────────────────────────────────────────────
assert.equal(renderLine('We have sailed {value} m.', 130000), 'We have sailed 130,000 m.');
assert.equal(renderLine('No placeholder here.', 42), 'No placeholder here.');
assert.equal(formatMetricValue('sail_total', 130000), '130.0 km');
assert.equal(formatMetricValue('kills_total', 1100), '1,100');
assert.equal(formatMetricValue('explored_avg_pct', 25), '25%');
assert.equal(formatMetricValue('playtime_total_hours', 2), '2 h');

console.log('OK — all milestone evaluator assertions passed');
