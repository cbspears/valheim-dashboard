// Unit tests for the "what fired" computations.
// Run: npx tsx lib/ops/activity.test.mjs
import assert from 'node:assert';
import {
  attributeProducer,
  mergeTimeline,
  countByType,
  compareWindows,
  countsByKind,
  producerSplit,
  loudestBucket,
  deathCauses,
  deathsByViking,
  longestQuietGap,
  mergeIntervals,
  onlineIntervals,
  longestSilenceWhileOnline,
  voiceBreakdown,
  unannouncedItems,
  queueBacklog,
  filterTimeline,
  isFiredKind,
  KIND_ORDER,
  PRODUCER_LABELS,
} from './activity.ts';
import { hourBuckets, HOUR_MS } from './window.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };
const deep = (a, b, msg) => { assert.deepStrictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };

const NOW = Date.parse('2026-09-06T14:37:12.000Z');
const iso = (ms) => new Date(ms).toISOString();
const minsAgo = (m) => iso(NOW - m * 60_000);
const hoursAgo = (h) => iso(NOW - h * 3_600_000);

// ── attributeProducer ───────────────────────────────────────────────────────
// The rules are derived from real production row shapes (verified 2026-09-06),
// so the tests use those exact shapes rather than invented ones.
{
  eq(attributeProducer({ type: 'join', created_at: minsAgo(1), metadata: {} }), 'log-poller', 'a join is the poller');
  eq(attributeProducer({ type: 'leave', created_at: minsAgo(1), metadata: {} }), 'log-poller', 'a leave is the poller');
  eq(attributeProducer({ type: 'raid', created_at: minsAgo(1), metadata: { key: 'army_eikthyr' } }), 'log-poller', 'a raid is the poller');
  eq(attributeProducer({ type: 'chat', created_at: minsAgo(1), metadata: {} }), 'log-poller', 'chat is the poller');

  eq(
    attributeProducer({ type: 'death', created_at: minsAgo(1), metadata: { source: 'eilif', cause: 'fall' } }),
    'gs-ingest',
    'an eilif-reported death comes through gs-ingest',
  );
  eq(
    attributeProducer({ type: 'death', created_at: minsAgo(1), metadata: { source: 'gs' } }),
    'gs-ingest',
    'a gs-reported death comes through gs-ingest',
  );
  eq(
    attributeProducer({ type: 'death', created_at: minsAgo(1), metadata: {} }),
    'log-poller',
    'a death with no source is the poller reading a ZDOID line',
  );
  eq(
    attributeProducer({ type: 'death', created_at: minsAgo(1), metadata: { source: 'something-new' } }),
    'unknown',
    'a death from an unrecognised source is unattributed, never folded into a known writer',
  );

  eq(
    attributeProducer({ type: 'boss', created_at: minsAgo(1), metadata: { source: 'gs-milestone', boss: 'Eikthyr' } }),
    'gs-ingest',
    'a boss kill comes through gs-ingest',
  );
  eq(
    attributeProducer({ type: 'milestone', created_at: minsAgo(1), metadata: { title: 'First of the Forsaken' } }),
    'gs-ingest',
    'a Great Deed row is written inside the gs-ingest request',
  );
  eq(attributeProducer({ type: 'some_new_type', created_at: minsAgo(1) }), 'unknown', 'an unseen type is unattributed');
  eq(attributeProducer({ type: 'JOIN', created_at: minsAgo(1) }), 'log-poller', 'type matching is case-insensitive');
  eq(Object.keys(PRODUCER_LABELS).length, 5, 'every producer has a label');
}

// ── mergeTimeline ───────────────────────────────────────────────────────────
{
  const rows = mergeTimeline({
    events: [
      { type: 'join', character_name: 'Lóa', created_at: minsAgo(10), metadata: {} },
      { type: 'death', character_name: 'ChÆrleif', created_at: minsAgo(5), metadata: { cause: 'fall', source: 'eilif', causeSource: 'eilif', biome: 'Meadows' } },
      { type: 'boss', created_at: minsAgo(61), metadata: { boss: 'Eikthyr', players: '3 vikings', source: 'gs-milestone' } },
    ],
    voiceLines: [
      { id: 'v1', kind: 'ambient', status: 'spoken', queued_at: minsAgo(20), spoken_at: minsAgo(19), meta: { source: 'dawn' } },
      { id: 'v2', kind: 'event', status: 'queued', queued_at: minsAgo(3), spoken_at: null, meta: { source: 'milestone' } },
    ],
    milestones: [{ id: 'boss-first', title: 'First of the Forsaken', achieved_at: minsAgo(60), announced_at: minsAgo(59) }],
    titles: [{ title: 'Bane of Beasts', awarded_at: minsAgo(30), player_id: 'p1', players: { character_name: 'ChÆrleif' } }],
    poty: [{ character_name: 'Lóa', award_label: '🌟 Unsung Hero', award_category: 'underdog', awarded_at: minsAgo(90), world_day: 17 }],
    oaths: [{ character_name: 'Bren', source: 'ingame', sworn_at: minsAgo(120), announced_at: minsAgo(119), match_status: 'exact' }],
    pins: [{ name: 'Rando Tree', kind: 'poi', by_character_name: 'Bren', created_at: minsAgo(150), day: 13 }],
    photos: [{ posted_by: 'Charlie', posted_at: minsAgo(180), content_type: 'image/webp' }],
    alerts: [{ key: 'watchdog', state: 'ok', signature: null, since: minsAgo(200), last_alert_at: minsAgo(200), alert_count: 0 }],
  });

  ok(rows.length >= 12, 'every source contributes at least one row');
  for (let i = 1; i < rows.length; i++) {
    ok(rows[i - 1].atMs >= rows[i].atMs, `row ${i} is not newer than the one before it`);
  }
  eq(rows[0].kind, 'voice', 'the newest row here is the queued voice line');
  ok(rows[0].label.includes('queued'), 'a line that has not been spoken says so');

  const death = rows.find((r) => r.kind === 'death');
  eq(death.label, 'ChÆrleif died: fall', 'a death names its cause');
  eq(death.producer, 'gs-ingest', 'the death carries its derived producer');
  ok(death.detail.includes('Meadows'), 'the death detail carries the biome');
  eq(death.raw.cause, 'fall', 'the raw metadata rides along for the details element');

  // A deed contributes TWO rows, one per moment, and the announce row measures
  // the lag. Collapsing them would hide the announce backlog entirely.
  const deeds = rows.filter((r) => r.kind === 'deed');
  eq(deeds.length, 2, 'a deed produces an achieved row and an announced row');
  eq(deeds.filter((d) => d.producer === 'gs-ingest').length, 1, 'the achieved row is attributed to gs-ingest');
  eq(deeds.filter((d) => d.producer === 'bot').length, 1, 'the announced row is attributed to the bot');
  ok(deeds.find((d) => d.label.startsWith('Great Deed announced')).detail.includes('60 s'), 'the announce row prints its own lag');

  const title = rows.find((r) => r.kind === 'title');
  eq(title.label, 'ChÆrleif became "Bane of Beasts"', 'an embedded player name is used when present');
  eq(title.who, 'ChÆrleif', 'the title row carries who it is about');

  const oath = rows.find((r) => r.kind === 'oath');
  eq(oath.producer, 'log-poller', 'an in-game oath is captured by the poller');
  eq(oath.raw.oath_text, undefined, 'the oath text is never carried into the ops feed');

  const boss = rows.find((r) => r.kind === 'boss_kill');
  eq(boss.label, 'Eikthyr fell', 'a boss row reads as a sentence');
  eq(boss.detail, '3 vikings', 'the boss row carries the war party size the bosses table does not');

  const alert = rows.find((r) => r.kind === 'alert');
  eq(alert.producer, 'watchdog', 'the ops_alerts row is attributed to the watchdog route');
  eq(rows.filter((r) => r.kind === 'alert').length, 1, 'since and last_alert_at at the same instant yield one row, not two');
}

// A discord-sourced oath is the bot's row, not the poller's.
{
  const rows = mergeTimeline({ oaths: [{ character_name: 'X', source: 'discord', sworn_at: minsAgo(5), announced_at: null }] });
  eq(rows[0].producer, 'bot', 'a Discord oath is written by the bot');
  ok(rows[0].detail.includes('not announced yet'), 'an unannounced oath says so in the feed');
}

// Two ops_alerts instants produce two rows when they differ.
{
  const rows = mergeTimeline({
    alerts: [{ key: 'watchdog', state: 'alerting', signature: 'log-poller:stale', since: hoursAgo(3), last_alert_at: hoursAgo(1), alert_count: 2 }],
  });
  eq(rows.length, 2, 'an episode start and a later message are two separate rows');
  ok(rows[0].label.includes('most recent message'), 'the newer row is the last message posted');
  ok(rows[1].label.includes('log-poller:stale'), 'the episode row carries the signature');
}

// Unparseable and missing timestamps are dropped rather than sorted to the epoch.
{
  const rows = mergeTimeline({
    events: [
      { type: 'join', character_name: 'A', created_at: 'not a date', metadata: {} },
      { type: 'join', character_name: 'B', created_at: minsAgo(1), metadata: {} },
    ],
    milestones: [{ id: 'm1', title: 'Never', achieved_at: null, announced_at: null }],
  });
  eq(rows.length, 1, 'rows with no usable timestamp are dropped, not stamped 1970');
  eq(rows[0].who, 'B', 'the surviving row is the one with a real timestamp');
}

// Ordering is stable: two rows at the same instant keep the same order.
{
  const same = minsAgo(4);
  const build = () =>
    mergeTimeline({
      events: [
        { type: 'join', character_name: 'Zed', created_at: same, metadata: {} },
        { type: 'leave', character_name: 'Abe', created_at: same, metadata: {} },
      ],
    }).map((r) => r.id);
  deep(build(), build(), 'two renders of the same data produce the same order');
  eq(new Set(build()).size, 2, 'same-instant rows keep distinct ids');
}

// ── countByType and compareWindows ──────────────────────────────────────────
{
  const rows = [
    { type: 'join', created_at: minsAgo(1) },
    { type: 'join', created_at: minsAgo(2) },
    { type: 'death', created_at: minsAgo(3) },
    { type: 'DEATH', created_at: minsAgo(4) },
  ];
  deep(countByType(rows), { join: 2, death: 2 }, 'types are counted case-insensitively');
  deep(
    countByType(rows, ['join', 'leave', 'death']),
    { join: 2, leave: 0, death: 2 },
    'a fixed type list keeps a zero row rather than dropping it',
  );
  deep(countByType(rows, ['join']), { join: 2 }, 'types outside the fixed list are dropped');
  deep(countByType([]), {}, 'no rows means no keys');
}

{
  const deltas = compareWindows({ death: 8, join: 3 }, { death: 28, join: 35 }, 7);
  const death = deltas.find((d) => d.type === 'death');
  eq(death.baselinePerDay, 4, '28 deaths over 7 d is 4 per day');
  eq(death.delta, 4, '8 today against 4 per day is plus 4');
  eq(death.ratio, 2, 'today is exactly double the 7 d daily average');
  const join = deltas.find((d) => d.type === 'join');
  eq(join.baselinePerDay, 5, '35 joins over 7 d is 5 per day');
  eq(join.delta, -2, 'a quieter type reports a negative delta');
  eq(deltas[0].type, 'death', 'the biggest move sorts first');

  const first = compareWindows({ boss: 1 }, { boss: 0 }, 7);
  eq(first[0].ratio, null, 'a zero baseline yields a null ratio, never Infinity');
  eq(first[0].delta, 1, 'and still reports the raw delta');

  const missing = compareWindows({}, { death: 7 }, 7);
  eq(missing[0].recent, 0, 'a type absent from the short window counts zero, not undefined');
  eq(missing[0].ratio, 0, 'zero over a real baseline is a real ratio of zero');

  eq(compareWindows({ a: 2 }, { a: 2 }, 0)[0].baselinePerDay, 2, 'a zero day span falls back to one day rather than dividing by zero');
}

// ── countsByKind and producerSplit ──────────────────────────────────────────
{
  const rows = mergeTimeline({
    events: [
      { type: 'join', character_name: 'A', created_at: minsAgo(1), metadata: {} },
      { type: 'join', character_name: 'B', created_at: minsAgo(2), metadata: {} },
      { type: 'death', character_name: 'A', created_at: minsAgo(3), metadata: { source: 'gs' } },
      { type: 'weird_new_type', created_at: minsAgo(4), metadata: {} },
    ],
    photos: [{ posted_by: 'Charlie', posted_at: minsAgo(5), content_type: 'image/webp' }],
  });
  const kinds = countsByKind(rows);
  deep(
    kinds.map((k) => [k.kind, k.count]),
    [['join', 2], ['death', 1], ['photo', 1], ['other', 1]],
    'kinds are counted and ordered by KIND_ORDER, empty kinds dropped',
  );

  const split = producerSplit(rows);
  eq(split[0].producer, 'log-poller', 'the largest producer sorts first');
  eq(split[0].count, 2, 'two poller rows');
  eq(split[split.length - 1].producer, 'unknown', 'unattributed rows are pinned last');
  eq(Math.round(split[0].share * 100), 40, 'shares are a fraction of the whole window');
  eq(producerSplit([]).length, 0, 'no rows means no producers, not a fake zero bar');
}

// ── loudestBucket ───────────────────────────────────────────────────────────
{
  const buckets = hourBuckets(NOW, 24);
  const counts = new Array(24).fill(0);
  counts[3] = 5;
  counts[17] = 9;
  const loud = loudestBucket(counts, buckets);
  eq(loud.index, 17, 'the fullest bucket wins');
  eq(loud.count, 9, 'and reports its count');
  eq(loud.label, buckets[17].label, 'and its axis label');

  counts[3] = 9;
  eq(loudestBucket(counts, buckets).index, 17, 'a tie goes to the later bucket, which is the more useful answer');
  eq(loudestBucket(new Array(24).fill(0), buckets), null, 'a silent window has no loudest hour, and says null rather than inventing 00:00');
  eq(loudestBucket([], buckets), null, 'no counts at all is also null');
}

// ── deaths ──────────────────────────────────────────────────────────────────
{
  const rows = [
    { type: 'death', character_name: 'A', created_at: minsAgo(1), metadata: { cause: 'fall' } },
    { type: 'death', character_name: 'A', created_at: minsAgo(2), metadata: { cause: 'fall' } },
    { type: 'death', character_name: 'B', created_at: minsAgo(3), metadata: { cause: 'drowning' } },
    { type: 'death', character_name: 'B', created_at: minsAgo(4), metadata: {} },
    { type: 'join', character_name: 'C', created_at: minsAgo(5), metadata: {} },
  ];
  deep(
    deathCauses(rows),
    [{ cause: 'fall', count: 2 }, { cause: 'cause not recorded', count: 1 }, { cause: 'drowning', count: 1 }],
    'causes are counted largest first and a missing cause is named, not dropped',
  );
  eq(
    deathCauses(rows).reduce((n, c) => n + c.count, 0),
    4,
    'the causes add up to the death count, which is the whole point of naming the missing one',
  );
  deep(deathsByViking(rows), [{ who: 'A', count: 2 }, { who: 'B', count: 2 }], 'deaths per viking, ties broken by name');
  deep(deathCauses([]), [], 'no deaths means an empty list');
  deep(
    deathsByViking([{ type: 'death', character_name: null, created_at: minsAgo(1), metadata: {} }]),
    [{ who: 'unnamed', count: 1 }],
    'a death with no character name is grouped under an explicit label',
  );
}

// ── longestQuietGap ─────────────────────────────────────────────────────────
{
  const start = NOW - 24 * 3_600_000;

  // The two edges the spec calls out by name.
  const empty = longestQuietGap([], start, NOW);
  eq(empty.sec, 24 * 3600, 'a window with no rows at all is one 24 h gap, not null');
  eq(empty.startMs, start, 'and it starts at the window edge');
  eq(empty.open, true, 'and it is still open');

  const stale = longestQuietGap([iso(start + 60_000)], start, NOW);
  eq(stale.open, true, 'a gap that runs to now is open');
  eq(stale.endMs, NOW, 'and ends at now, not at the last row');
  eq(Math.round(stale.sec), 24 * 3600 - 60, 'and is measured from the last row to now');

  const mid = longestQuietGap(
    [iso(start + 3_600_000), iso(start + 2 * 3_600_000), iso(start + 12 * 3_600_000), iso(NOW - 60_000)],
    start,
    NOW,
  );
  // Rows at +1 h, +2 h, +12 h and now-60 s. The gaps are 1 h, 1 h, 10 h,
  // 11 h 59 m and 60 s, so the winner is the one ending at the newest row.
  eq(Math.round(mid.sec), 12 * 3600 - 60, 'the longest interior gap wins over the shorter ones');
  eq(mid.open, false, 'an interior gap is closed');
  eq(mid.startMs, start + 12 * 3_600_000, 'the gap starts at the row before it');
  eq(mid.endMs, NOW - 60_000, 'and ends at the row that broke it');

  // Rows outside the window are ignored rather than extending it.
  const outside = longestQuietGap([iso(start - 3_600_000), iso(NOW + 3_600_000)], start, NOW);
  eq(outside.sec, 24 * 3600, 'rows before the window start and after now do not close the gap');

  eq(longestQuietGap([], NOW, NOW), null, 'a zero-length window is a caller bug and returns null');
  eq(longestQuietGap([], NOW + 1000, NOW), null, 'an inverted window returns null');
  eq(longestQuietGap(['nonsense', null, undefined], start, NOW).sec, 24 * 3600, 'unparseable stamps are ignored');
}

// ── intervals and silence while online ──────────────────────────────────────
{
  deep(
    mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 20 }, { startMs: 40, endMs: 50 }]),
    [{ startMs: 0, endMs: 20 }, { startMs: 40, endMs: 50 }],
    'overlapping intervals merge, disjoint ones stay apart',
  );
  deep(mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }]), [{ startMs: 0, endMs: 20 }], 'touching intervals merge');
  deep(mergeIntervals([{ startMs: 10, endMs: 5 }]), [], 'a backwards interval is dropped');
  deep(mergeIntervals([]), [], 'no sessions means no online time');
}

{
  const start = NOW - 24 * 3_600_000;
  const sessions = [
    // Closed session, four hours long, entirely inside the window.
    { character_name: 'A', joined_at: iso(start + 2 * HOUR_MS), left_at: iso(start + 6 * HOUR_MS) },
    // Overlapping session by a second viking.
    { character_name: 'B', joined_at: iso(start + 5 * HOUR_MS), left_at: iso(start + 7 * HOUR_MS) },
    // Open session, still running: it must run to now, not be dropped.
    { character_name: 'C', joined_at: iso(NOW - 2 * HOUR_MS), left_at: null },
    // A session that started before the window: clipped, not discarded.
    { character_name: 'D', joined_at: iso(start - 5 * HOUR_MS), left_at: iso(start + 1 * HOUR_MS) },
  ];
  const ivs = onlineIntervals(sessions, start, NOW);
  eq(ivs.length, 3, 'the two overlapping sessions merge into one stretch');
  eq(ivs[0].startMs, start, 'a session that began before the window is clipped to the window start');
  eq(ivs[2].endMs, NOW, 'an open session runs to now');
  eq(ivs[1].endMs - ivs[1].startMs, 5 * HOUR_MS, 'the merged stretch spans both sessions');

  // Nothing fired for three of the five hours anyone was on: that is the signal.
  const stamps = [iso(start + 2 * HOUR_MS + 60_000), iso(start + 6 * HOUR_MS), iso(NOW - 90 * 60_000)];
  const silence = longestSilenceWhileOnline(stamps, ivs, NOW);
  ok(silence !== null, 'a silence is found');
  eq(Math.round(silence.sec / 60), 239, 'the longest silence while somebody was online is just under four hours');
  eq(silence.duringStartMs, ivs[1].startMs, 'and it names the online stretch it happened in');

  eq(longestSilenceWhileOnline(stamps, [], NOW), null, 'nobody online means no silence to report, not a clean bill of health');

  // A silence that is still running comes back open.
  const openIv = [{ startMs: NOW - HOUR_MS, endMs: NOW }];
  const openSilence = longestSilenceWhileOnline([iso(NOW - 50 * 60_000)], openIv, NOW);
  eq(openSilence.open, true, 'a silence that reaches now is open');
  eq(Math.round(openSilence.sec / 60), 50, 'and is measured from the last row to now');

  // Rows outside the online stretches never count as breaking the silence.
  const noisyOffline = longestSilenceWhileOnline([iso(NOW - 30 * 60_000)], [{ startMs: NOW - 4 * HOUR_MS, endMs: NOW - 3 * HOUR_MS }], NOW);
  eq(Math.round(noisyOffline.sec / 60), 60, 'a row outside the online stretch does not break the silence inside it');
}

// ── voiceBreakdown ──────────────────────────────────────────────────────────
{
  const lines = [
    { id: '1', kind: 'ambient', status: 'spoken', queued_at: minsAgo(60), spoken_at: minsAgo(59), meta: { source: 'dawn' } },
    { id: '2', kind: 'event', status: 'spoken', queued_at: minsAgo(50), spoken_at: minsAgo(40), meta: { source: 'milestone' } },
    { id: '3', kind: 'event', status: 'spoken', queued_at: minsAgo(30), spoken_at: minsAgo(28), meta: { source: 'poty' } },
    { id: '4', kind: 'event', status: 'queued', queued_at: minsAgo(12), spoken_at: null, meta: { source: 'oath' } },
    { id: '5', kind: 'manual', status: 'queued', queued_at: minsAgo(5), spoken_at: null, meta: {} },
  ];
  const v = voiceBreakdown(lines, NOW);
  eq(v.total, 5, 'every line is counted');
  eq(v.spoken, 3, 'three were spoken');
  eq(v.queued, 2, 'two are still waiting');
  eq(Math.round(v.oldestQueuedSec / 60), 12, 'the oldest queued line is 12 minutes old');
  deep(v.byStatus, [{ status: 'spoken', count: 3 }, { status: 'queued', count: 2 }], 'statuses are reported by their own names');
  eq(v.byKind[0].kind, 'event', 'the commonest kind sorts first');
  eq(v.bySource.find((s) => s.source === 'unlabelled').count, 1, 'a line with no meta.source is labelled, not dropped');
  eq(Math.round(v.waitMedianSec), 120, 'the median wait is the middle of 60, 120 and 600 s');
  ok(v.waitP90Sec > 120 && v.waitP90Sec <= 600, 'the p90 wait sits between the median and the max');

  const none = voiceBreakdown([], NOW);
  eq(none.total, 0, 'no lines means zero total');
  eq(none.waitMedianSec, null, 'and a null median rather than a confident zero');
  eq(none.oldestQueuedSec, null, 'and no oldest queued age');

  // A status this code has never seen must survive as itself.
  const odd = voiceBreakdown([{ id: 'x', kind: 'event', status: 'expired', queued_at: minsAgo(9), spoken_at: null, meta: {} }], NOW);
  eq(odd.byStatus[0].status, 'expired', 'an unrecognised status is reported by name, not folded into "other"');
  eq(odd.queued, 1, 'anything without a spoken_at counts as still waiting');
}

// ── unannouncedItems ────────────────────────────────────────────────────────
{
  const items = unannouncedItems(
    {
      milestones: [
        { id: 'a', title: 'Achieved and told', achieved_at: hoursAgo(5), announced_at: hoursAgo(5) },
        { id: 'b', title: 'Achieved and silent', achieved_at: hoursAgo(3), announced_at: null },
        { id: 'c', title: 'Never achieved', achieved_at: null, announced_at: null },
      ],
      oaths: [
        { character_name: 'Bren', sworn_at: hoursAgo(9), announced_at: null, source: 'ingame' },
        { character_name: 'Lóa', sworn_at: hoursAgo(1), announced_at: hoursAgo(1), source: 'ingame' },
      ],
    },
    NOW,
  );
  eq(items.length, 2, 'only things that fired and were never announced are listed');
  eq(items[0].table, 'oaths', 'oldest first, so the worst case leads');
  eq(Math.round(items[0].ageSec / 3600), 9, 'and the age proves how long it has been broken');
  ok(items[1].what.includes('Achieved and silent'), 'the unannounced deed is named');
  deep(unannouncedItems({}, NOW), [], 'no input means nothing to report');
  deep(unannouncedItems({ milestones: [{ id: 'z', title: 'z', achieved_at: null, announced_at: null }] }, NOW), [], 'an unachieved deed is not a backlog');
}

// ── filterTimeline ──────────────────────────────────────────────────────────
{
  const rows = mergeTimeline({
    events: [
      { type: 'join', character_name: 'A', created_at: hoursAgo(1), metadata: {} },
      { type: 'join', character_name: 'B', created_at: hoursAgo(30), metadata: {} },
      { type: 'death', character_name: 'A', created_at: hoursAgo(2), metadata: { source: 'gs' } },
    ],
  });
  eq(filterTimeline(rows, { sinceMs: NOW - 24 * 3_600_000 }).length, 2, 'a 24 h window drops the 30 h old row');
  eq(filterTimeline(rows, { sinceMs: NOW - 7 * 86_400_000 }).length, 3, 'a 7 d window keeps everything');
  eq(filterTimeline(rows, { sinceMs: 0, kind: 'death' }).length, 1, 'a kind filter narrows to one kind');
  eq(filterTimeline(rows, { sinceMs: 0, kind: 'all' }).length, 3, '"all" is not a kind and filters nothing');
  eq(filterTimeline(rows, { sinceMs: 0, limit: 2 }).length, 2, 'the render limit is applied last');
  eq(filterTimeline(rows, { sinceMs: 0, nowMs: NOW - 90 * 60_000 }).length, 2, 'an upper bound excludes rows newer than it');
}

// ── isFiredKind ─────────────────────────────────────────────────────────────
{
  eq(isFiredKind('death'), true, 'a real kind validates');
  eq(isFiredKind('all'), false, '"all" is the absence of a filter, not a kind');
  eq(isFiredKind('; drop table events'), false, 'anything off the list is rejected before it reaches a query');
  eq(isFiredKind(undefined), false, 'undefined is not a kind');
  eq(KIND_ORDER.length, new Set(KIND_ORDER).size, 'KIND_ORDER has no duplicates');
  eq(isFiredKind('gathering'), false, 'gathering is gone: discord_events.updated_at is a sync stamp, not a firing');
}

// ── REGRESSIONS FROM REVIEW ─────────────────────────────────────────────────
// Each block below is a defect that shipped in the first cut, reproduced first
// and then pinned, so it cannot come back quietly.

// 1. discord_events is no longer a timeline source at all.
//    app/api/webhook/route.ts upserts every scheduled event on every
//    events_sync tick with updated_at = the tick time, changed or not, so a
//    single unchanged gathering used to mint a fresh "row fired" every few
//    minutes and then decide the producer split and the loudest hour.
{
  const rows = mergeTimeline({
    gatherings: [
      { name: 'Deep North Launch Night', starts_at: iso(NOW + 3 * 86_400_000), status: 'scheduled', user_count: 9, updated_at: minsAgo(2) },
    ],
  });
  eq(rows.length, 0, 'a gathering sync stamp contributes nothing to the timeline');
}

// 2. A boss kill is ONE row, not two.
//    app/api/gs-ingest/route.ts flips bosses.killed_at and inserts the events
//    row from the same `killedAt` variable in the same request, so merging both
//    tables put two identical rows on the feed at the same millisecond.
//    Verified against production 2026-09-06: events.created_at and
//    bosses.killed_at for Eikthyr are both 2026-08-28T03:49:34.419+00:00.
{
  const killedAt = minsAgo(45);
  const rows = mergeTimeline({
    events: [{ type: 'boss', created_at: killedAt, metadata: { boss: 'Eikthyr', players: '3 vikings', source: 'gs-milestone' } }],
    bosses: [{ name: 'Eikthyr', biome: 'Meadows', killed_at: killedAt, sort_order: 1 }],
  });
  eq(rows.filter((r) => r.kind === 'boss_kill').length, 1, 'one kill is one row even when the bosses table is passed in');
  eq(rows[0].label, 'Eikthyr fell', 'and the row kept is the events row');
}

// 3. The death detail must never contradict the death label.
//    lib/deaths.ts sets causeSource ONLY on the Eilif Companion path; the
//    GsValheimStats path sets cause and no causeSource, which is the normal
//    shape for a player running the emitter without the Companion plugin.
{
  const gs = mergeTimeline({
    events: [{ type: 'death', character_name: 'Ylva', created_at: minsAgo(3), metadata: { source: 'gs', cause: 'Greydwarf', biome: 'BlackForest' } }],
  })[0];
  eq(gs.label, 'Ylva died: Greydwarf', 'the headline names the cause the row carries');
  ok(!gs.detail.includes('no cause recorded'), 'and the subtitle does not deny it');
  ok(gs.detail.includes('gs'), 'the subtitle names the writer that recorded the cause');

  const eilif = mergeTimeline({
    events: [{ type: 'death', character_name: 'Ylva', created_at: minsAgo(3), metadata: { source: 'eilif', causeSource: 'eilif', cause: 'fall', biome: 'Meadows' } }],
  })[0];
  ok(eilif.detail.includes('reported by eilif'), 'a Companion-stamped cause names its reporter');

  const bare = mergeTimeline({
    events: [{ type: 'death', character_name: 'Ylva', created_at: minsAgo(3), metadata: {} }],
  })[0];
  eq(bare.label, 'Ylva died', 'a causeless death says only that');
  ok(bare.detail.includes('poller log line'), 'and only a row with no source at all blames the log line');

  const sourced = mergeTimeline({
    events: [{ type: 'death', character_name: 'Ylva', created_at: minsAgo(3), metadata: { source: 'gs' } }],
  })[0];
  ok(sourced.detail.includes('gs wrote the row'), 'a causeless death from a known writer names that writer instead');
}

// 4. The loudest bucket never crowns the current, incomplete bucket, which the
//    chart draws muted precisely so it is not compared with the full ones.
{
  const b = hourBuckets(NOW, 4);
  const counts = [1, 3, 2, 9];
  eq(loudestBucket(counts, b).index, 3, 'without the flag the partial bucket can still win');
  eq(loudestBucket(counts, b, { excludePartial: true }).index, 1, 'with it, the fullest COMPLETE bucket wins');
  eq(loudestBucket([0, 0, 0, 5], b, { excludePartial: true }), null, 'rows only in the partial bucket means no loudest bucket');
  eq(loudestBucket([0, 0, 0, 0], b, { excludePartial: true }), null, 'and a silent window still has none');
  eq(loudestBucket([2, 2, 0, 0], b, { excludePartial: true }).index, 1, 'ties still go to the later bucket');
}

// 5. A silence that runs a whole online stretch is flagged as such, because a
//    session's own join sits at the start of the stretch and its leave at the
//    end. Without the flag the panel banded an ordinary quiet solo session in
//    the danger tone and told the reader to go hunt a producer.
{
  const start = NOW - 3 * 3_600_000;
  const end = NOW - 2 * 3_600_000;
  const intervals = onlineIntervals([{ character_name: 'Loa', joined_at: iso(start), left_at: iso(end) }], NOW - 86_400_000, NOW);
  const quiet = longestSilenceWhileOnline([iso(start), iso(end)], intervals, NOW);
  eq(quiet.sec, 3600, 'a quiet hour-long session reports its whole length');
  eq(quiet.wholeStretch, true, 'and is flagged as the whole stretch, which is the normal reading');
  eq(quiet.stretchSec, 3600, 'the stretch length rides along so the page can compare the two');

  // Same session, one death halfway through: now the longest silence is an
  // interior gap and it is NOT the whole stretch.
  const busy = longestSilenceWhileOnline(
    [iso(start), iso(start + 10 * 60_000), iso(end)],
    intervals,
    NOW,
  );
  eq(busy.sec, 3000, 'the longest interior gap wins when a row splits the stretch');
  eq(busy.wholeStretch, false, 'and it is not the whole stretch');
}

// 6. producerSplit pins 'unknown' last even when it is the largest share, so an
//    unattributed tail never displaces a real writer from the top.
{
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, at: minsAgo(i), atMs: NOW, kind: 'other', label: '', who: null, producer: 'unknown' })),
    { id: 'p1', at: minsAgo(9), atMs: NOW, kind: 'join', label: '', who: null, producer: 'log-poller' },
    { id: 'b1', at: minsAgo(8), atMs: NOW, kind: 'voice', label: '', who: null, producer: 'bot' },
    { id: 'b2', at: minsAgo(7), atMs: NOW, kind: 'voice', label: '', who: null, producer: 'bot' },
  ];
  const split = producerSplit(rows);
  eq(split[split.length - 1].producer, 'unknown', 'unknown sorts last even with the most rows');
  eq(split[0].producer, 'bot', 'the biggest real writer sorts first');
  eq(split[1].producer, 'log-poller', 'and the rest follow by count');
  eq(split[0].count, 2, 'the counts themselves are untouched by the pinning');
  eq(Math.round(split[split.length - 1].share * 100), 63, 'unknown still reports its true share, it is only ordered last');
}

// 7. voiceBreakdown's p90 is the 90th percentile, not the 95th.
//    Eleven waits 0..100 put the exact p90 on a whole sample with no
//    interpolation, so p90 and p95 are different numbers here.
{
  const lines = Array.from({ length: 11 }, (_, i) => ({
    id: `v${i}`,
    kind: 'ambient',
    status: 'spoken',
    queued_at: iso(NOW - 3_600_000),
    spoken_at: iso(NOW - 3_600_000 + i * 10 * 1000),
    meta: { source: 'dawn' },
  }));
  const v = voiceBreakdown(lines, NOW);
  eq(v.waitP90Sec, 90, 'p90 of 0,10,...,100 is 90 s');
  eq(v.waitMedianSec, 50, 'and the median is 50 s');
}

// 8. The unspoken queue is read at ANY age, because a 7 d bound put a ceiling
//    on the one number whose job is to grow. The in-game plugin only polls
//    while a player is connected, so a line queued during a week nobody played
//    is exactly the line that gets stuck.
{
  const windowStart = NOW - 7 * 86_400_000;
  const lines = [
    { id: 'old', kind: 'ambient', status: 'queued', queued_at: iso(NOW - 9 * 86_400_000), spoken_at: null, meta: { source: 'dawn' } },
    { id: 'recent', kind: 'event', status: 'queued', queued_at: iso(NOW - 3_600_000), spoken_at: null, meta: { source: 'milestone' } },
    { id: 'done', kind: 'event', status: 'spoken', queued_at: iso(NOW - 7_200_000), spoken_at: iso(NOW - 7_100_000), meta: { source: 'poty' } },
  ];
  const b = queueBacklog(lines, NOW, windowStart);
  eq(b.waiting, 2, 'both unspoken lines are counted whatever their age');
  eq(b.olderThanWindow, 1, 'and the one queued before the window is named as such');
  eq(b.oldest.source, 'dawn', 'the oldest waiting line is the 9 d old one, which a 7 d bound could never see');
  eq(b.oldest.beforeWindow, true, 'and it is flagged as older than the window on show');
  eq(Math.round(b.oldest.ageSec), 9 * 86_400, 'its age is the real age, with no 7 d ceiling');

  const none = queueBacklog([lines[2]], NOW, windowStart);
  eq(none.waiting, 0, 'nothing waiting means nothing waiting');
  eq(none.oldest, null, 'and no oldest line to name');
}

console.log(`activity.test.mjs: ${passed} assertions passed`);
