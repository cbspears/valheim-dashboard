// Tests for the Collective Milestones engine (no network).
//
// Two halves, mirroring lib/milestones.ts itself:
//   • the PURE core — aggregate maths (incl. the sail vs walk/run distance
//     split, the sessions-derived playtime, and the fish breakdown), threshold
//     crossing, idempotency, the dashboard summary, formatting helpers;
//   • the ORCHESTRATOR — evaluateAndRecord() driven against a hand-rolled
//     Supabase stub, asserting what it writes and (just as importantly, since
//     2026-08-22) what it no longer writes: NO voice_lines.
//
// Run: npx tsx scripts/milestones.test.mjs
import {
  computeAggregates,
  evaluateMilestones,
  evaluateAndRecord,
  summarizeMilestones,
  renderLine,
  formatMetricValue,
  metricInfo,
} from '../lib/milestones.ts';
import assert from 'node:assert';

// ── aggregate maths ──────────────────────────────────────────────────────────
const stats = [
  {
    deaths: 5, kills: 600, boss_kills: 2, damage_dealt: 100000,
    resources_harvested: 40000, items_crafted: 50, structures_built: 4000,
    map_explored_pct: 20,
    gs_stats: {
      distances: { walk: 1000, run: 2000, sail: 60000, air: 10 },
      // Canonical fish shape: the pickups[] breakdown filtered to config/fish.ts.
      fish: [{ item: 'Fish1', count: 6 }, { item: 'Fish3', count: 4 }],
    },
  },
  {
    deaths: 9, kills: 500, boss_kills: 1, damage_dealt: 80000,
    resources_harvested: 70000, items_crafted: 60, structures_built: 7000,
    map_explored_pct: 30,
    gs_stats: {
      distances: { walk: 500, run: 500, sail: 70000, air: 5 },
      fish: [{ item: 'Fish2', count: 5 }],
    },
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
// Fish: summed across every viking's per-species breakdown; the gs_stats-less
// row contributes nothing rather than throwing.
assert.equal(agg.fish_total, 15, 'fish_total = (6 + 4) + 5');
// Explored average over rows that HAVE a reading (null row ignored).
assert.equal(agg.explored_avg_pct, 25, 'explored_avg_pct = (20 + 30) / 2');
// Playtime: only Alice's closed 120 min counts (Bob offline → dropped).
assert.equal(agg.playtime_total_hours, 2, 'playtime_total_hours = 120 min / 60');

// ── fish_total, defensively ──────────────────────────────────────────────────
// gs_stats is jsonb fed by a third-party mod's payload. Every plausible way the
// blob can be malformed must degrade to a number, never throw — a throw here
// would take out the whole ingest cycle's milestone evaluation.
const fishAgg = computeAggregates({
  stats: [
    { gs_stats: {} },                                            // no fish key
    { gs_stats: { fish: null } },                                // explicit null
    { gs_stats: { fish: 'nope' } },                              // wrong type
    { gs_stats: { fish: [] } },                                  // empty
    { gs_stats: { fish: [{ item: 'Fish1' }, null, { item: 'Fish2', count: '3' }, { item: 'Fish3', count: 7 }] } },
    { gs_stats: { fish: { Fish1: 2, Fish2: 3 } } },              // bare map fallback
    {},                                                          // no gs_stats at all
  ],
  sessions: [],
  onlineNames: new Set(),
});
// 7 (the only well-formed numeric count) + 5 (the map fallback). A missing
// count, a null entry and a stringified count each contribute 0.
assert.equal(fishAgg.fish_total, 12, 'fish_total tolerates every malformed shape');

// ── threshold crossing ───────────────────────────────────────────────────────
const defs = [
  { id: 'sail-a', metric: 'sail_total', threshold: 122000, sort: 10, achieved_at: null, line: '', title: 'Sail A', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'sail-b', metric: 'sail_total', threshold: 1750000, sort: 20, achieved_at: null, line: '', title: 'Sail B', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'walk-a', metric: 'walk_run_total', threshold: 42195, sort: 30, achieved_at: null, line: '', title: 'Walk A', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'builds', metric: 'builds_total', threshold: 10000, sort: 5, achieved_at: null, line: '', title: 'Builds', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'explored', metric: 'explored_avg_pct', threshold: 25, sort: 40, achieved_at: null, line: '', title: 'Explored', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  { id: 'fish', metric: 'fish_total', threshold: 10, sort: 8, achieved_at: null, line: '', title: 'Fish', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
  // Already achieved — must be excluded even though 1100 >= 1000.
  { id: 'kills', metric: 'kills_total', threshold: 1000, sort: 15, achieved_at: '2026-07-01T00:00:00Z', achieved_value: 1000, line: '', title: 'Kills', equivalence: null, announced_at: null, meta: {} },
  // Unknown metric — never fires.
  { id: 'ghost', metric: 'not_a_metric', threshold: 1, sort: 99, achieved_at: null, line: '', title: 'Ghost', equivalence: null, achieved_value: null, announced_at: null, meta: {} },
];

const crossed = evaluateMilestones(defs, agg);
const crossedIds = crossed.map((c) => c.def.id);
// builds (sort 5), fish (8), sail-a (10), explored (40): sail-b/walk-a below
// threshold, kills already achieved, ghost unknown metric. Sorted by `sort` asc.
assert.deepEqual(crossedIds, ['builds', 'fish', 'sail-a', 'explored'], 'crossed set + sort order');
// achieved_value candidates carry the live aggregate.
assert.equal(crossed.find((c) => c.def.id === 'sail-a').value, 130000);
assert.equal(crossed.find((c) => c.def.id === 'fish').value, 15);
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
// latest = most-recently achieved by achieved_at (the four just-recorded, dated
// 07-02, beat kills dated 07-01). All four share the timestamp; any is fine —
// assert it's one of them and count is right.
assert.equal(summary.achieved.length, 5, '4 newly recorded + the pre-achieved kills');
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
assert.equal(formatMetricValue('fish_total', 1500), '1,500', 'fish are a plain count');

// Every metric the evaluator can compute needs a plain-language label (copy
// doctrine) — a new METRICS entry without a METRIC_INFO entry would render the
// raw key in the /world ledger.
for (const metric of Object.keys(agg)) {
  assert.notEqual(metricInfo(metric).label, metric, `metric "${metric}" has a plain label`);
  assert.ok(metricInfo(metric).description, `metric "${metric}" has a description`);
}
assert.equal(metricInfo('fish_total').label, 'Fish caught');

// ── orchestrator: evaluateAndRecord ──────────────────────────────────────────
//
// Minimal Supabase stub covering exactly the chains evaluateAndRecord uses:
//   milestones .select('*').is(...)                            → unachieved defs
//   milestones .update(...).eq('id',…).is(…).select('id')      → guarded flip
//   player_stats/sessions/players .select(...)                 → the aggregates
//   <anything>.insert(row)                                     → recorded
// Every insert is captured by table name, so an accidental voice_lines write
// would show up rather than pass silently.
function makeStubDb(state) {
  const inserts = {};
  const db = {
    inserts,
    from(table) {
      if (table === 'milestones') {
        return {
          select: () => ({
            is: () =>
              Promise.resolve({
                data: state.milestones.filter((m) => !m.achieved_at).map((m) => ({ ...m })),
                error: null,
              }),
          }),
          update(patch) {
            let id = null;
            const b = {
              eq(col, val) {
                if (col === 'id') id = val;
                return b;
              },
              is: () => b,
              select() {
                const row = state.milestones.find((m) => m.id === id);
                // The guard the real query expresses as `.is('achieved_at', null)`:
                // an already-flipped row returns zero rows, so the caller skips it.
                if (!row || row.achieved_at) return Promise.resolve({ data: [], error: null });
                Object.assign(row, patch);
                return Promise.resolve({ data: [{ id }], error: null });
              },
            };
            return b;
          },
        };
      }
      if (table === 'player_stats') return { select: () => Promise.resolve({ data: state.stats, error: null }) };
      if (table === 'sessions') return { select: () => Promise.resolve({ data: state.sessions, error: null }) };
      if (table === 'players') return { select: () => Promise.resolve({ data: state.players, error: null }) };
      return {
        insert(row) {
          (inserts[table] ??= []).push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return db;
}

const silent = { info() {}, warn() {}, error() {} };

// Four deeds cross in ONE cycle (the "busy evening" case). All four must be
// recorded — no silencing, no per-cycle cap — and none may be announced here.
const orchState = {
  milestones: [
    { id: 'kills-thousand', metric: 'kills_total', threshold: 1000, sort: 40, title: 'A Thousand Foes', line: 'A thousand corpses mark the road. ({value})', equivalence: null, achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    { id: 'deaths-bench', metric: 'deaths_total', threshold: 10, sort: 80, title: 'The First Bench', line: "Ten of Eilif's own have supped at Odin's table.", equivalence: 'one full mead-bench', achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    { id: 'fish-hundred', metric: 'fish_total', threshold: 10, sort: 370, title: 'The First Hundred Fish', line: 'The nets have paid for themselves.', equivalence: null, achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    { id: 'sail-far', metric: 'sail_total', threshold: 120000, sort: 240, title: 'The Skagerrak Crossing', line: 'The Skagerrak crossed.', equivalence: null, achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    // Nowhere near — must stay untouched.
    { id: 'walk-ten-thousand', metric: 'walk_run_total', threshold: 10000000, sort: 300, title: 'The Ten Thousand', line: 'Ten thousand kilometers marched.', equivalence: null, achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
    // Unknown metric — never fires, never errors.
    { id: 'ghost', metric: 'not_a_metric', threshold: 1, sort: 999, title: 'Ghost', line: '', equivalence: null, achieved_at: null, achieved_value: null, announced_at: null, meta: {} },
  ],
  stats,
  sessions,
  players: [],
};

const orchDb = makeStubDb(orchState);
const first = await evaluateAndRecord(orchDb, silent);

assert.equal(first.crossed, 4, 'all four deeds crossing in one cycle are recorded');
const byId = Object.fromEntries(orchState.milestones.map((m) => [m.id, m]));
for (const id of ['kills-thousand', 'deaths-bench', 'fish-hundred', 'sail-far']) {
  assert.ok(byId[id].achieved_at, `${id} stamped achieved_at`);
  assert.equal(byId[id].announced_at, null, `${id} left UNANNOUNCED for the bot to drain`);
}
assert.equal(byId['kills-thousand'].achieved_value, 1100, 'achieved_value = the live aggregate, rounded');
assert.equal(byId['fish-hundred'].achieved_value, 15);
assert.equal(byId['walk-ten-thousand'].achieved_at, null, 'a far-off deed is untouched');
assert.equal(byId['ghost'].achieved_at, null, 'an unknown metric never fires');

// One Saga event per deed, carrying the rendered line.
assert.equal((orchDb.inserts.events ?? []).length, 4, 'one Saga event per recorded deed');
assert.ok(orchDb.inserts.events.every((e) => e.type === 'milestone'), 'events are type=milestone');
const killsEvent = orchDb.inserts.events.find((e) => e.metadata.milestone === 'kills-thousand');
assert.equal(killsEvent.metadata.line, 'A thousand corpses mark the road. (1,100)', '{value} interpolated');
assert.equal(killsEvent.character_name, null, 'collective deeds have no character');

// THE POINT OF THIS BLOCK: the evaluator must not queue in-game voice. Voice and
// the Discord embed fire together from the bot at announce time; queueing here
// would make Eilif speak the deed minutes before the embed AND bypass the bot's
// sequential MILESTONE_MIN_GAP_MS pacing when several deeds land at once.
assert.equal(orchDb.inserts.voice_lines, undefined, 'evaluator queues NO voice line');

// Re-run against the same state — the ~120s re-POST. Nothing new is recorded and
// nothing new is written (the guarded UPDATE returns no rows for flipped deeds).
const eventsBefore = orchDb.inserts.events.length;
const second = await evaluateAndRecord(orchDb, silent);
assert.equal(second.crossed, 0, 'a re-POST of the same snapshot records nothing');
assert.equal(orchDb.inserts.events.length, eventsBefore, 're-POST inserts no duplicate Saga events');
assert.equal(orchDb.inserts.voice_lines, undefined, 'still no voice line on the re-POST');

// Every deed already earned → the cheap first query short-circuits before the
// stats/session reads (a stub with no stats tables at all would throw otherwise).
const allDone = makeStubDb({
  milestones: [{ id: 'done', metric: 'kills_total', threshold: 1, sort: 1, title: 'Done', line: '', equivalence: null, achieved_at: '2026-08-01T00:00:00Z', achieved_value: 1, announced_at: '2026-08-01T00:01:00Z', meta: {} }],
  stats: null,
  sessions: null,
  players: null,
});
assert.deepEqual(await evaluateAndRecord(allDone, silent), { crossed: 0 }, 'nothing unachieved → early bail');

// Missing table (pre-migration) is swallowed, not thrown — ingest is never blocked.
const noTable = {
  from: () => ({
    select: () => ({
      is: () => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "public.milestones" does not exist' } }),
    }),
  }),
};
assert.deepEqual(
  await evaluateAndRecord(noTable, silent),
  { crossed: 0, skipped: 'missing-table' },
  'a missing milestones table skips instead of throwing',
);

console.log('OK — all milestone evaluator assertions passed');
