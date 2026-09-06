// Unit tests for the Performance tab's pure computations.
// Run: npx tsx lib/ops/performance.test.mjs
import assert from 'node:assert';
import {
  lagSeconds,
  lagAudit,
  lagSummary,
  withoutBackfilled,
  lagHistogram,
  worstLagRows,
  percentilePerBucket,
  lagPerBucket,
  producerOf,
  producerTotals,
  producerCountsPerBucket,
  lagByProducer,
  relayBacklog,
  RELAY_BEHIND_SEC,
  RELAY_BEHIND_ROWS,
  announceLatency,
  voiceQueueHealth,
  spokenSince,
  VOICE_STALLED_AFTER_SEC,
  heartbeatPressure,
  estimateTableBytes,
  projectGrowth,
  rowsPerDay,
  peakConcurrencyPerBucket,
  playedHoursInWindow,
  deathsPerHourPlayed,
  bossRevRows,
  freshnessLadder,
  renderCostFraction,
  ROW_BYTES,
  DEFAULT_ROW_BYTES,
  BASELINE_DB_BYTES,
  FREE_PLAN_DB_BYTES,
  FREE_PLAN_STORAGE_BYTES,
  INSERTED_AT_BACKFILL_MS,
  LAG_BINS_SEC,
} from './performance.ts';
import { hourBuckets, dayBuckets } from './window.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };
const near = (a, b, tol, msg) => {
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${msg} (got ${JSON.stringify(a)}, wanted ~${b})`);
  passed++;
};

const NOW = Date.parse('2026-09-06T14:37:12.000Z');
const iso = (ms) => new Date(ms).toISOString();

// ── lagSeconds ──────────────────────────────────────────────────────────────
{
  const rows = [
    { created_at: '2026-09-06T14:00:00Z', inserted_at: '2026-09-06T14:00:20Z' }, // 20 s
    { created_at: '2026-09-06T14:00:00Z', inserted_at: '2026-09-06T14:01:00Z' }, // 60 s
    { created_at: '2026-09-06T14:00:00Z', inserted_at: null },                   // dropped
    { created_at: null, inserted_at: '2026-09-06T14:00:00Z' },                   // dropped
    { created_at: '2026-09-06T14:00:30Z', inserted_at: '2026-09-06T14:00:00Z' }, // clamped to 0
  ];
  assert.deepStrictEqual(lagSeconds(rows), [20, 60, 0]);
  passed++;
  eq(lagSeconds([]).length, 0, 'no rows means no lag values, not a zero');

  const a = lagAudit(rows, INSERTED_AT_BACKFILL_MS);
  eq(a.total, 5, 'audit counts every row it was given');
  eq(a.measured, 3, 'three rows carried both stamps');
  eq(a.missingInsertedAt, 1, 'one row predates the inserted_at column');
  eq(a.clamped, 1, 'one row had a producer clock ahead of the database');
  eq(a.backfilled, 0, 'rows inserted after the backfill are not backfilled rows');

  const old = lagAudit([{ created_at: '2026-08-01T00:00:00Z', inserted_at: '2026-08-01T00:00:00Z' }]);
  eq(old.backfilled, 1, 'a row inserted before the backfill instant is flagged');
  ok(INSERTED_AT_BACKFILL_MS > Date.parse('2026-09-05T00:00:00Z'), 'the backfill instant is the migration night');
}

// ── withoutBackfilled ───────────────────────────────────────────────────────
{
  const mixed = [
    { created_at: '2026-08-01T00:00:00Z', inserted_at: '2026-08-01T00:00:00Z' }, // backfilled
    { created_at: '2026-09-06T10:00:00Z', inserted_at: '2026-09-06T10:00:20Z' }, // real
    { created_at: '2026-09-06T10:00:00Z', inserted_at: null },                   // no stamp
  ];
  const kept = withoutBackfilled(mixed);
  eq(kept.length, 1, 'only rows inserted after the backfill survive');
  eq(kept[0].inserted_at, '2026-09-06T10:00:20Z', 'and it is the real one');
  eq(withoutBackfilled([]).length, 0, 'an empty set stays empty');

  // The case that made this function necessary: every row in the window is a
  // backfilled one, so the honest answer is "no data" and not a confident 0.
  const allBackfilled = [
    { created_at: '2026-09-01T14:44:49Z', inserted_at: '2026-09-01T14:44:49Z' },
    { created_at: '2026-09-01T14:43:40Z', inserted_at: '2026-09-01T14:43:40Z' },
  ];
  eq(lagSummary(lagSeconds(allBackfilled)).p50, 0, 'unfiltered, a whole window of backfill reads as 0 s');
  eq(
    lagSummary(lagSeconds(withoutBackfilled(allBackfilled))).p50,
    null,
    'filtered, the same window correctly reports no data',
  );
  eq(lagAudit(allBackfilled).backfilled, 2, 'and the audit still counts what was set aside');
}

// ── lagSummary ──────────────────────────────────────────────────────────────
{
  const s = lagSummary([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  eq(s.n, 10, 'n counts the values');
  near(s.p50, 55, 0.001, 'p50 interpolates between the middle pair');
  near(s.p90, 91, 0.001, 'p90 interpolates');
  near(s.p95, 95.5, 0.001, 'p95 interpolates');
  eq(s.max, 100, 'max is the largest value');

  const empty = lagSummary([]);
  eq(empty.n, 0, 'an empty set has no values');
  eq(empty.p50, null, 'an empty set reports null, never 0');
  eq(empty.p90, null, 'an empty p90 is null');
  eq(empty.max, null, 'an empty max is null');

  const one = lagSummary([42]);
  eq(one.p50, 42, 'a single value is its own median');
  eq(one.max, 42, 'a single value is its own max');

  eq(lagSummary([NaN, Infinity]).n, 0, 'non-finite values are dropped, not counted');
}

// ── lagHistogram ────────────────────────────────────────────────────────────
{
  const bins = lagHistogram([0, 1, 4.9, 5, 14, 15, 29, 30, 59, 60, 119, 120, 299, 300, 5000]);
  eq(bins.length, LAG_BINS_SEC.length, 'one bin per edge');
  eq(bins[0].label, '0 to 5 s', 'first bin names its range with units');
  eq(bins[bins.length - 1].toSec, null, 'the last bin is open ended');
  eq(bins[bins.length - 1].label, '300 s and over', 'the open bin says so');
  eq(bins[0].count, 3, '0, 1 and 4.9 fall in the first bin');
  eq(bins[1].count, 2, '5 and 14 fall in the second');
  eq(bins[bins.length - 1].count, 2, '300 and 5000 fall in the open bin');
  eq(bins.reduce((a, b) => a + b.count, 0), 15, 'every value lands in exactly one bin');

  eq(lagHistogram([]).every((b) => b.count === 0), true, 'no values means every bin is empty');
  eq(lagHistogram([1], []).length, 0, 'no edges means no bins');
}

// ── worstLagRows ────────────────────────────────────────────────────────────
{
  const rows = [
    { type: 'join', character_name: 'Lóa', created_at: '2026-09-06T10:00:00Z', inserted_at: '2026-09-06T10:00:05Z' },
    { type: 'death', character_name: 'ChÆrleif', created_at: '2026-09-06T11:00:00Z', inserted_at: '2026-09-06T11:04:00Z' },
    { type: 'leave', character_name: 'Bren', created_at: '2026-09-06T12:00:00Z', inserted_at: '2026-09-06T12:00:40Z' },
    { type: 'join', character_name: null, created_at: '2026-09-06T13:00:00Z', inserted_at: null },
  ];
  const worst = worstLagRows(rows, 2);
  eq(worst.length, 2, 'the limit is honoured');
  eq(worst[0].lagSec, 240, 'the worst row comes first');
  eq(worst[0].type, 'death', 'the row keeps its type');
  eq(worst[0].characterName, 'ChÆrleif', 'the row keeps its viking');
  eq(worst[1].lagSec, 40, 'the second worst follows');
  eq(worstLagRows(rows, 0).length, 0, 'a zero limit returns nothing');

  // Deterministic tie-break: equal lags order newest-inserted first.
  const ties = worstLagRows([
    { type: 'a', created_at: '2026-09-06T10:00:00Z', inserted_at: '2026-09-06T10:00:10Z' },
    { type: 'b', created_at: '2026-09-06T12:00:00Z', inserted_at: '2026-09-06T12:00:10Z' },
  ]);
  eq(ties[0].type, 'b', 'equal lags break the tie by the newer insertion');
}

// ── per-bucket lag ──────────────────────────────────────────────────────────
{
  const buckets = hourBuckets(NOW, 3); // 12:00, 13:00, 14:00 UTC
  const rows = [
    { created_at: '2026-09-06T12:00:00Z', inserted_at: '2026-09-06T12:00:10Z' },
    { created_at: '2026-09-06T12:30:00Z', inserted_at: '2026-09-06T12:30:30Z' },
    // nothing at 13:00 on purpose: the gap must survive as a gap
    { created_at: '2026-09-06T14:00:00Z', inserted_at: '2026-09-06T14:00:05Z' },
  ];
  const groups = lagPerBucket(rows, buckets);
  eq(groups[0].length, 2, 'two rows landed in the 12:00 hour');
  eq(groups[1].length, 0, 'the 13:00 hour is empty');
  const p = percentilePerBucket(groups, 90);
  near(p[0], 28, 0.001, 'the 12:00 p90 interpolates its two values');
  eq(p[1], null, 'an empty hour is null, so the sparkline breaks rather than drawing zero');
  eq(p[2], 5, 'the current hour carries its single value');
}

// ── producer attribution ────────────────────────────────────────────────────
{
  eq(producerOf({ type: 'join', created_at: null }), 'log-poller', 'a join is the poller');
  eq(producerOf({ type: 'leave', created_at: null }), 'log-poller', 'a leave is the poller');
  eq(producerOf({ type: 'raid', created_at: null }), 'log-poller', 'a raid is the poller');
  eq(producerOf({ type: 'death', created_at: null }), 'log-poller', 'a bare death is the poller reading the log');
  eq(
    producerOf({ type: 'death', created_at: null, metadata: { source: 'eilif' } }),
    'gs-ingest',
    "a death stamped source 'eilif' came from the Companion through gs-ingest",
  );
  eq(
    producerOf({ type: 'death', created_at: null, metadata: { gsDeathId: 'Lóa|2026-09-01T00:00:00Z' } }),
    'gs-ingest',
    'a death carrying a gsDeathId came from the stats snapshot',
  );
  eq(producerOf({ type: 'milestone', created_at: null }), 'gs-ingest', 'the deeds evaluator runs inside gs-ingest');
  eq(
    producerOf({ type: 'boss', created_at: null, metadata: { source: 'gs-milestone' } }),
    'gs-ingest',
    'an automatic boss flip is gs-ingest',
  );
  eq(producerOf({ type: 'boss', created_at: null, metadata: { boss: 'Eikthyr' } }), 'bot', 'a hand-marked boss is the bot');
  eq(producerOf({ type: 'chat', created_at: null }), 'unknown', 'an unrecognised type is unknown, never guessed');
  eq(producerOf({ type: null, created_at: null }), 'unknown', 'a null type is unknown');
  eq(producerOf({ type: 'death', created_at: null, metadata: 'not an object' }), 'log-poller', 'a non-object metadata is ignored safely');
  eq(producerOf({ type: 'death', created_at: null, metadata: null }), 'log-poller', 'a null metadata is ignored safely');

  const rows = [
    { type: 'join', created_at: iso(NOW - 1000) },
    { type: 'join', created_at: iso(NOW - 2000) },
    { type: 'death', created_at: iso(NOW - 3000), metadata: { source: 'eilif' } },
    { type: 'chat', created_at: iso(NOW - 4000) },
  ];
  const totals = producerTotals(rows);
  eq(totals['log-poller'], 2, 'two poller rows');
  eq(totals['gs-ingest'], 1, 'one ingest row');
  eq(totals.bot, 0, 'a producer with nothing is 0, not missing');
  eq(totals.unknown, 1, 'one unattributed row');

  const buckets = hourBuckets(NOW, 2);
  const split = producerCountsPerBucket(
    [
      { type: 'join', created_at: '2026-09-06T13:10:00Z', inserted_at: '2026-09-06T13:10:00Z' },
      { type: 'join', created_at: '2026-09-06T14:10:00Z', inserted_at: '2026-09-06T14:10:00Z' },
      { type: 'milestone', created_at: '2026-09-06T14:20:00Z', inserted_at: '2026-09-06T14:20:00Z' },
    ],
    buckets,
  );
  assert.deepStrictEqual(split['log-poller'], [1, 1]);
  passed++;
  assert.deepStrictEqual(split['gs-ingest'], [0, 1]);
  passed++;
  assert.deepStrictEqual(split.bot, [0, 0]);
  passed++;

  const byProducer = lagByProducer([
    { type: 'join', created_at: '2026-09-06T14:00:00Z', inserted_at: '2026-09-06T14:00:20Z' },
    { type: 'milestone', created_at: '2026-09-06T14:00:00Z', inserted_at: '2026-09-06T14:00:01Z' },
  ]);
  eq(byProducer['log-poller'].p50, 20, 'the poller half keeps its own median');
  eq(byProducer['gs-ingest'].p50, 1, 'the ingest half keeps its own median');
  eq(byProducer.bot.n, 0, 'a producer with no rows reports n 0 and null percentiles');
  eq(byProducer.bot.p50, null, 'and its median is null, not 0');
}

// ── relay backlog ───────────────────────────────────────────────────────────
{
  const rows = [
    { created_at: iso(NOW - 600_000), inserted_at: iso(NOW - 600_000) },
    { created_at: iso(NOW - 60_000), inserted_at: iso(NOW - 60_000) },
    { created_at: iso(NOW - 10_000), inserted_at: iso(NOW - 10_000) },
  ];

  const unknown = relayBacklog(null, rows, NOW);
  eq(unknown.state, 'unknown', 'no cursor means unknown, never idle');
  eq(unknown.pending, 0, 'an unknown cursor reports no pending count');
  eq(unknown.cursorIso, null, 'the cursor is echoed as null');

  const idle = relayBacklog(iso(NOW), rows, NOW);
  eq(idle.state, 'idle', 'a cursor at now has nothing pending');
  eq(idle.behindSec, null, 'an idle relay is not behind by any number of seconds');

  const working = relayBacklog(iso(NOW - 30_000), rows, NOW);
  eq(working.state, 'working', 'one recent row waiting is working, not behind');
  eq(working.pending, 1, 'exactly the rows newer than the cursor are pending');
  near(working.behindSec, 10, 0.01, 'behindSec is the age of the OLDEST pending row');

  const behind = relayBacklog(iso(NOW - 900_000), rows, NOW);
  eq(behind.state, 'behind', 'a cursor older than the threshold reads behind');
  eq(behind.pending, 3, 'every newer row counts');
  near(behind.behindSec, 600, 0.01, 'behindSec follows the oldest pending row');

  // Exactly at the boundary is not yet behind.
  const boundary = relayBacklog(iso(NOW - RELAY_BEHIND_SEC * 1000 - 1000), [
    { created_at: iso(NOW - RELAY_BEHIND_SEC * 1000), inserted_at: iso(NOW - RELAY_BEHIND_SEC * 1000) },
  ], NOW);
  eq(boundary.state, 'working', 'exactly at the seconds threshold is still working');

  const many = relayBacklog(iso(NOW - 1000), Array.from({ length: RELAY_BEHIND_ROWS + 1 }, () => ({
    created_at: iso(NOW - 500),
    inserted_at: iso(NOW - 500),
  })), NOW);
  eq(many.state, 'behind', 'too many pending rows reads behind even when they are seconds old');
  eq(many.boundedByWindow, true, 'the count is flagged as bounded by the page window');
  eq(relayBacklog(iso(NOW), [], NOW, { windowBounded: false }).boundedByWindow, false, 'the flag can be cleared');
}

// ── announce latency ────────────────────────────────────────────────────────
{
  const rows = [
    { achieved_at: iso(NOW - 3_600_000), announced_at: iso(NOW - 3_540_000) }, // 60 s
    { achieved_at: iso(NOW - 7_200_000), announced_at: iso(NOW - 7_080_000) }, // 120 s
    { achieved_at: iso(NOW - 1_800_000), announced_at: null },                 // pending 30 min
    { achieved_at: null, announced_at: null },                                 // never happened
  ];
  const s = announceLatency(rows, (r) => r.achieved_at, (r) => r.announced_at, NOW);
  eq(s.n, 2, 'only announced rows contribute to the latency');
  eq(s.p50, 90, 'the median of 60 s and 120 s is 90 s');
  eq(s.max, 120, 'the worst announce took 120 s');
  eq(s.pending, 1, 'a row with no announce stamp is pending');
  near(s.oldestPendingSec, 1800, 1, 'the oldest pending row is half an hour old');

  const none = announceLatency([], (r) => r.a, (r) => r.b, NOW);
  eq(none.p50, null, 'no rows means a null median');
  eq(none.pending, 0, 'no rows means nothing pending');
  eq(none.oldestPendingSec, null, 'and no pending age');

  // An announce stamped BEFORE the event (clock skew) clamps to 0, never negative.
  const skew = announceLatency([{ a: iso(NOW), b: iso(NOW - 5000) }], (r) => r.a, (r) => r.b, NOW);
  eq(skew.p50, 0, 'an announce before its event clamps to 0 s');
}

// ── voice queue ─────────────────────────────────────────────────────────────
{
  const queued = [
    { kind: 'ambient', status: 'queued', queued_at: iso(NOW - 30_000) },
    { kind: 'event', status: 'queued', queued_at: iso(NOW - (VOICE_STALLED_AFTER_SEC + 60) * 1000) },
  ];
  const window = [
    { kind: 'ambient', status: 'spoken', queued_at: iso(NOW - 120_000), spoken_at: iso(NOW - 118_000) }, // 2 s
    { kind: 'event', status: 'spoken', queued_at: iso(NOW - 600_000), spoken_at: iso(NOW - 540_000) },   // 60 s
    { kind: 'event', status: 'queued', queued_at: iso(NOW - 30_000), spoken_at: null },
  ];
  const h = voiceQueueHealth(queued, window, NOW);
  eq(h.queued, 2, 'the queue depth is every queued row, regardless of age');
  eq(h.stalled, 1, 'only the line past the stall threshold counts as stalled');
  near(h.oldestQueuedSec, VOICE_STALLED_AFTER_SEC + 60, 1, 'the oldest queued age is the oldest row');
  eq(h.spokenInWindow, 2, 'two lines were spoken in the window');
  eq(h.speakLatency.p50, 31, 'the median speak latency is between the two');
  eq(h.speakLatency.max, 60, 'the worst speak took a minute');

  const ambient = h.byKind.find((k) => k.kind === 'ambient');
  eq(ambient.spoken, 1, 'the ambient kind spoke once');
  eq(ambient.latency.p50, 2, 'and did it in two seconds');
  const event = h.byKind.find((k) => k.kind === 'event');
  eq(event.queued, 1, 'one event line is still queued');
  eq(h.byKind.map((k) => k.kind).join(','), 'ambient,event', 'kinds are sorted so the table cannot reshuffle');

  const empty = voiceQueueHealth([], [], NOW);
  eq(empty.queued, 0, 'an empty queue is 0 lines');
  eq(empty.oldestQueuedSec, null, 'an empty queue has no oldest age, and it is not 0');
  eq(empty.speakLatency.p50, null, 'no spoken lines means a null latency, not a fast one');
  eq(empty.byKind.length, 0, 'no rows means no kind breakdown');

  const unknownKind = voiceQueueHealth([{ kind: null, status: 'queued', queued_at: iso(NOW) }], [], NOW);
  eq(unknownKind.byKind[0].kind, 'unknown', 'a missing kind is labelled unknown, not blank');

  // spokenSince: the short-window count, taken in memory off the same rows.
  const dayAgo = NOW - 24 * 3600 * 1000;
  const spread = [
    { status: 'spoken', queued_at: iso(NOW - 3600_000), spoken_at: iso(NOW - 3599_000) },     // inside 24 h
    { status: 'spoken', queued_at: iso(dayAgo - 60_000), spoken_at: iso(dayAgo - 30_000) },   // older
    { status: 'queued', queued_at: iso(NOW - 60_000), spoken_at: null },                      // never spoken
    { status: 'spoken', queued_at: iso(dayAgo - 5000), spoken_at: iso(dayAgo) },              // exactly on the edge
  ];
  eq(spokenSince(spread, dayAgo), 2, 'a line spoken exactly at the window start is inside it');
  eq(spokenSince(spread, NOW - 3600_000), 1, 'a narrower window keeps only the recent line');
  eq(spokenSince(spread, NOW + 1000), 0, 'a window that has not started yet counts nothing');
  eq(spokenSince([], dayAgo), 0, 'no rows means no lines spoken');
  eq(
    spokenSince([{ status: 'spoken', queued_at: iso(NOW), spoken_at: 'not a time' }], dayAgo),
    0,
    'an unparseable spoken stamp is not counted',
  );
}

// ── heartbeat pressure ──────────────────────────────────────────────────────
{
  const quiet = heartbeatPressure(NOW, iso(NOW - 60_000), 300);
  eq(quiet.ageSec, 60, 'the age is measured in seconds');
  near(quiet.fraction, 0.2, 0.001, 'the fraction is age over threshold');
  eq(quiet.band, 'quiet', 'a fifth of the window used is quiet');

  eq(heartbeatPressure(NOW, iso(NOW - 210_000), 300).band, 'tightening', '70% of the window is tightening');
  eq(heartbeatPressure(NOW, iso(NOW - 209_000), 300).band, 'quiet', 'just under 70% is still quiet');
  eq(heartbeatPressure(NOW, iso(NOW - 301_000), 300).band, 'over', 'past the threshold is over');
  eq(heartbeatPressure(NOW, iso(NOW - 300_000), 300).band, 'tightening', 'exactly at the threshold is not yet over');

  const never = heartbeatPressure(NOW, null, 300);
  eq(never.ageSec, null, 'a component that never reported has no age');
  eq(never.fraction, null, 'and no fraction');
  eq(never.band, 'unknown', 'and reads unknown, never quiet');

  const noThreshold = heartbeatPressure(NOW, iso(NOW - 1000), 0);
  eq(noThreshold.band, 'unknown', 'a component with no stale threshold has no pressure to show');
  eq(noThreshold.ageSec, 1, 'but its age is still real');

  const future = heartbeatPressure(NOW, iso(NOW + 60_000), 300);
  eq(future.ageSec, 0, 'a stamp in the future floors at 0 s rather than going negative');
}

// ── byte estimate ───────────────────────────────────────────────────────────
{
  const e = estimateTableBytes({ events: 100, sessions: 10, made_up_table: 5, broken: null });
  eq(e.estimated, true, 'the estimate says it is an estimate in its own type');
  eq(e.tables.length, 4, 'one row per table asked for');
  eq(e.tables[0].table, 'broken', 'tables are sorted so the panel cannot reshuffle');
  const events = e.tables.find((t) => t.table === 'events');
  eq(events.bytes, 100 * ROW_BYTES.events, 'a known table uses its own per-row constant');
  eq(events.assumedRowSize, false, 'and is not flagged as assumed');
  const madeUp = e.tables.find((t) => t.table === 'made_up_table');
  eq(madeUp.bytesPerRow, DEFAULT_ROW_BYTES, 'an unknown table falls back to the default');
  eq(madeUp.assumedRowSize, true, 'and is flagged so the panel can say so');
  const broken = e.tables.find((t) => t.table === 'broken');
  eq(broken.rows, null, 'an unreadable count survives as null');
  eq(broken.bytes, null, 'and contributes no bytes rather than 0 rows of them');
  assert.deepStrictEqual(e.unreadable, ['broken']);
  passed++;
  eq(e.tableBytes, 100 * ROW_BYTES.events + 10 * ROW_BYTES.sessions + 5 * DEFAULT_ROW_BYTES, 'the table total sums the readable rows');
  eq(e.totalBytes, e.tableBytes + BASELINE_DB_BYTES, 'the reported total adds the empty-project baseline');
  ok(BASELINE_DB_BYTES > 0 && BASELINE_DB_BYTES < FREE_PLAN_DB_BYTES, 'the baseline is a real fraction of the ceiling');
  eq(FREE_PLAN_DB_BYTES, 500 * 1024 * 1024, 'the free plan database ceiling is 500 MB');
  eq(FREE_PLAN_STORAGE_BYTES, 1024 * 1024 * 1024, 'the free plan storage ceiling is 1 GB');
}

// ── growth projection ───────────────────────────────────────────────────────
{
  const g = projectGrowth([1000, 2000, 3000], 100_000, 400_000);
  eq(g.bytesPerDay, 2000, 'the rate is the mean of the samples');
  eq(g.daysToCeiling, 150, '300000 bytes of headroom at 2000 a day is 150 days');
  eq(g.overCeiling, false, 'and it is not over the ceiling');

  const flat = projectGrowth([0, 0], 100, 1000);
  eq(flat.daysToCeiling, null, 'no growth means no projection, never Infinity');
  eq(flat.bytesPerDay, 0, 'and a rate of 0');

  const shrinking = projectGrowth([-500], 100, 1000);
  eq(shrinking.daysToCeiling, null, 'negative growth projects nothing');
  eq(shrinking.bytesPerDay, 0, 'and never reports a negative rate');

  const over = projectGrowth([1000], 2000, 1000);
  eq(over.overCeiling, true, 'past the ceiling is flagged');
  eq(over.daysToCeiling, null, 'and there is nothing left to project');

  eq(projectGrowth([], 0, 100).bytesPerDay, 0, 'no samples means no rate');

  const days = dayBuckets(NOW, 3);
  const counts = rowsPerDay(
    [iso(NOW), iso(NOW - 86_400_000), iso(NOW - 86_400_000), iso(NOW - 30 * 86_400_000), null, 'not a date'],
    days,
  );
  assert.deepStrictEqual(counts, [0, 2, 1]);
  passed++;
}

// ── session concurrency ─────────────────────────────────────────────────────
{
  const day = dayBuckets(Date.parse('2026-09-06T12:00:00Z'), 1);
  // Three overlapping sessions, peak of 3 between 12:00 and 12:30.
  const sessions = [
    { joined_at: '2026-09-06T11:00:00Z', left_at: '2026-09-06T13:00:00Z' },
    { joined_at: '2026-09-06T12:00:00Z', left_at: '2026-09-06T12:30:00Z' },
    { joined_at: '2026-09-06T12:15:00Z', left_at: '2026-09-06T12:20:00Z' },
    { joined_at: '2026-09-06T14:00:00Z', left_at: '2026-09-06T14:10:00Z' },
  ];
  eq(peakConcurrencyPerBucket(sessions, day, Date.parse('2026-09-06T15:00:00Z'))[0], 3, 'the peak is the deepest overlap');

  // A handover: one leaves exactly as the next joins. That is 1, not 2.
  const handover = [
    { joined_at: '2026-09-06T10:00:00Z', left_at: '2026-09-06T11:00:00Z' },
    { joined_at: '2026-09-06T11:00:00Z', left_at: '2026-09-06T12:00:00Z' },
  ];
  eq(peakConcurrencyPerBucket(handover, day, NOW)[0], 1, 'a leave at the same instant as a join is not two vikings');

  // A session that spans midnight counts in both days, not neither.
  const twoDays = dayBuckets(Date.parse('2026-09-06T12:00:00Z'), 2);
  const spanning = [{ joined_at: '2026-09-05T23:00:00Z', left_at: '2026-09-06T01:00:00Z' }];
  assert.deepStrictEqual(peakConcurrencyPerBucket(spanning, twoDays, NOW), [1, 1]);
  passed++;

  // An open session runs to now.
  const open = [{ joined_at: '2026-09-06T09:00:00Z', left_at: null }];
  eq(peakConcurrencyPerBucket(open, day, Date.parse('2026-09-06T15:00:00Z'))[0], 1, 'an open session is still on the server');

  // A leave before its join is not a session at all.
  eq(peakConcurrencyPerBucket([{ joined_at: '2026-09-06T12:00:00Z', left_at: '2026-09-06T11:00:00Z' }], day, NOW)[0], 0, 'a leave before its join is discarded');
  eq(peakConcurrencyPerBucket([{ joined_at: null, left_at: null }], day, NOW)[0], 0, 'a session with no join is discarded');
  eq(peakConcurrencyPerBucket(sessions, [], NOW).length, 0, 'no buckets means no series');
}

// ── played hours and deaths per hour ────────────────────────────────────────
{
  const start = Date.parse('2026-09-06T00:00:00Z');
  const end = Date.parse('2026-09-07T00:00:00Z');
  const sessions = [
    { joined_at: '2026-09-06T10:00:00Z', left_at: '2026-09-06T12:00:00Z' }, // 2 h
    { joined_at: '2026-09-06T11:00:00Z', left_at: '2026-09-06T11:30:00Z' }, // 0.5 h, overlapping
    { joined_at: '2026-09-05T23:00:00Z', left_at: '2026-09-06T01:00:00Z' }, // 1 h inside the window
    { joined_at: '2026-09-08T00:00:00Z', left_at: '2026-09-08T01:00:00Z' }, // entirely outside
  ];
  near(playedHoursInWindow(sessions, start, end, end), 3.5, 0.0001, 'viking-hours add up across overlapping sessions');
  eq(playedHoursInWindow([], start, end, end), 0, 'nobody played means zero hours');

  const openToNow = [{ joined_at: '2026-09-06T10:00:00Z', left_at: null }];
  near(playedHoursInWindow(openToNow, start, end, Date.parse('2026-09-06T12:00:00Z')), 2, 0.0001, 'an open session counts up to now');

  near(deathsPerHourPlayed(7, 3.5), 2, 0.0001, 'seven deaths in three and a half hours is two an hour');
  eq(deathsPerHourPlayed(0, 3.5), 0, 'no deaths in real playtime is a real zero');
  eq(deathsPerHourPlayed(4, 0), null, 'no playtime means null, never a division by zero');
  eq(deathsPerHourPlayed(4, -1), null, 'negative playtime is refused too');
}

// ── boss revision counters ──────────────────────────────────────────────────
{
  const rows = bossRevRows([
    { name: 'Bonemass', sort_order: 3, is_killed: false, killed_at: null, fight_stats: null },
    { name: 'Eikthyr', sort_order: 1, is_killed: true, killed_at: '2026-08-28T03:49:34Z', fight_stats: { fighters: ['a', 'b'], topDamageFrom: 'client' } },
    { name: 'The Elder', sort_order: 2, is_killed: true, killed_at: '2026-09-01T00:00:00Z', fight_stats: { rev: 4, fighters: ['a'] } },
    { name: 'Moder', sort_order: 4, is_killed: false, killed_at: null, fight_stats: { rev: '7' } },
  ]);
  eq(rows.map((r) => r.name).join(','), 'Eikthyr,The Elder,Bonemass,Moder', 'rows come back in boss order');
  eq(rows[0].revKind, 'absent', 'fight_stats with no rev reads absent, not zero');
  eq(rows[0].rev, null, 'and carries no number');
  eq(rows[0].fighters, 2, 'the fighter count is read off the blob');
  eq(rows[0].topDamageFrom, 'client', 'the damage source is carried through');
  eq(rows[1].revKind, 'number', 'a numeric rev is a real counter');
  eq(rows[1].rev, 4, 'and its value is kept');
  eq(rows[2].revKind, 'none', 'a null fight_stats has never been written to');
  eq(rows[2].fighters, null, 'and has no fighters');
  eq(rows[3].revKind, 'odd', 'a string rev is odd: the compare-and-swap cannot match it');
  eq(rows[3].rev, null, 'and yields no usable number');
  eq(bossRevRows([]).length, 0, 'no bosses means no rows');
}

// ── freshness ladder ────────────────────────────────────────────────────────
{
  const rungs = freshnessLadder([
    { surface: 'Roster', source: 'players.last_seen_at', ageSec: 60, staleAfterSec: 900 },
    { surface: 'Stats', source: 'server_status.updated_at', ageSec: 700, staleAfterSec: 900 },
    { surface: 'Map', source: 'map/status.json', ageSec: 100_000, staleAfterSec: 21_600 },
    { surface: 'Gallery', source: 'gallery_photos.posted_at', ageSec: null, staleAfterSec: 900 },
    { surface: 'Forced', source: 'lib/data.ts mapFreshness()', ageSec: 1, staleAfterSec: 900, staleOverride: true },
  ]);
  eq(rungs[0].state, 'fresh', 'well inside the threshold is fresh');
  eq(rungs[1].state, 'aging', 'past 70% and not yet over is aging');
  eq(rungs[2].state, 'stale', 'past the threshold is stale');
  eq(rungs[3].state, 'unknown', 'an unknown age is unknown, never fresh');
  eq(rungs[4].state, 'stale', 'an override from lib/data.ts wins over the arithmetic');
  eq(rungs[0].surface, 'Roster', 'the input fields survive');
  eq(freshnessLadder([{ surface: 'x', source: 'y', ageSec: 5, staleAfterSec: 0 }])[0].state, 'unknown', 'no threshold means no verdict');
}

// ── render cost ─────────────────────────────────────────────────────────────
{
  near(renderCostFraction({ fetchMs: 1250, queries: 10, rows: 300, storageRequests: 6, budgetMs: 2500 }), 0.5, 0.0001, 'half the budget');
  eq(renderCostFraction({ fetchMs: 100, queries: 1, rows: 1, storageRequests: 0, budgetMs: 0 }), 0, 'a zero budget cannot divide');
  ok(renderCostFraction({ fetchMs: 3000, queries: 1, rows: 1, storageRequests: 0, budgetMs: 2500 }) > 1, 'over budget reads over 1');
}

console.log(`performance.test.mjs: ${passed} assertions passed`);
