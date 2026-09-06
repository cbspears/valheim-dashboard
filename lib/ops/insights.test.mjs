// Unit tests for the insights strip's pure core.
// Run: npx tsx lib/ops/insights.test.mjs
//
// THE DISCIPLINE HERE. Every rule on the strip gets at least two fixtures: one
// that makes it fire and one that keeps it silent, and where the rule has a
// numeric threshold, the pair sits either side of that threshold. A card that
// cannot be shown to stay quiet is a card that will eventually fire on a normal
// night and teach the owner to ignore the strip.
import assert from 'node:assert';
import {
  buildInsights,
  rankInsights,
  checksNotFlagged,
  peakConcurrency,
  identityMismatchSummary,
  componentHeadroom,
  relayState,
  deedsWithinReach,
  eventsInWindow,
  newestEventMs,
  newestInsertedMs,
  stampUtc,
  SEVERITY_RANK,
  SILENT_HALL_SEC,
  RELAY_BEHIND_SEC,
  RELAY_BEHIND_ROWS,
  ANNOUNCE_BACKLOG_SEC,
  DEED_IMMINENT_FRACTION,
  DEATH_SPIKE_FACTOR,
  DEATH_SPIKE_MIN_DEATHS,
  COMPONENT_HEADROOM_FRACTION,
  SERVER_STATUS_FRESH_SEC,
  MAX_CARDS,
  DEED_METRICS_NOT_EVALUATED,
  READ_LABELS,
  WEIGHT_FORWARD,
  WEIGHT_DEFAULT,
} from './insights.ts';
import { WINDOW_7D_MS } from './window.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };

const NOW = Date.parse('2026-09-06T14:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const iso = (ms) => new Date(ms).toISOString();

/** One events row. created_at and inserted_at coincide unless told otherwise. */
function ev(type, name, atMs, meta = {}, insertedMs = atMs) {
  return {
    type,
    character_name: name,
    created_at: iso(atMs),
    inserted_at: iso(insertedMs),
    metadata: meta,
  };
}

/** A bot heartbeat carrying a relay loop timestamp, and optionally a cursor. */
function botHeartbeat({ relayRunMs = null, cursorMs = null } = {}) {
  const metrics = {};
  if (relayRunMs !== null) metrics.subLoops = { relay: { enabled: true, lastSuccessAt: iso(relayRunMs) } };
  if (cursorMs !== null) metrics.schedule = { relayCursor: iso(cursorMs) };
  return { component: 'discord-bot', status: 'ok', last_success: iso(NOW - 30 * SEC), metrics };
}

function milestone(over) {
  return {
    id: 'deed', metric: 'kills_total', threshold: 100, title: 'A Hundred Felled',
    line: '{value} felled.', equivalence: null, sort: 10,
    achieved_at: null, achieved_value: null, announced_at: null, meta: {},
    ...over,
  };
}

/**
 * Every read returned. This is the honest default for a fixture: an empty array
 * in these tests means an empty TABLE, and a test that wants a failed read says
 * so with `reads: { events: false }`.
 */
const ALL_READ = {
  events: true,
  heartbeats: true,
  serverStatus: true,
  milestones: true,
  playerStats: true,
  newPlayers: true,
};

/** The neutral input: nothing fires except the fallback and the quiet window. */
function base(over = {}) {
  const { reads, ...rest } = over;
  return {
    nowMs: NOW,
    supabaseOk: true,
    events: [],
    eventsTruncated: false,
    eventsWindowMs: WINDOW_7D_MS,
    heartbeats: [],
    serverStatus: null,
    milestones: [],
    playerStats: [],
    newPlayers: [],
    newPlayersTruncated: false,
    ...rest,
    reads: { ...ALL_READ, ...(reads ?? {}) },
  };
}

const ids = (input) => buildInsights(input).map((i) => i.id);
const card = (input, id) => buildInsights(input).find((i) => i.id === id) ?? null;

// ── helpers: window slicing ─────────────────────────────────────────────────
{
  const rows = [ev('join', 'A', NOW - 2 * HOUR), ev('join', 'B', NOW - 3 * DAY), ev('join', 'C', NOW - 30 * DAY)];
  eq(eventsInWindow(rows, NOW, 24 * HOUR).length, 1, '24 h window keeps only the recent row');
  eq(eventsInWindow(rows, NOW, WINDOW_7D_MS).length, 2, '7 d window keeps two');
  eq(newestEventMs(rows), NOW - 2 * HOUR, 'newest created_at');
  eq(newestEventMs([]), null, 'no rows means no newest, not zero');
  eq(newestInsertedMs(rows), NOW - 2 * HOUR, 'newest inserted_at');
  eq(eventsInWindow([{ ...rows[0], created_at: 'not a date' }], NOW, DAY).length, 0, 'unparseable rows are dropped');
  ok(stampUtc(Date.parse('2026-09-06T21:10:00Z')) === 'Sep 06 21:10 UTC', 'stamps are UTC and say so');
  eq(stampUtc(null), 'an unknown time', 'a null stamp is said plainly');
}

// ── peakConcurrency ─────────────────────────────────────────────────────────
{
  const rows = [
    ev('join', 'A', NOW - 5 * HOUR),
    ev('join', 'B', NOW - 4 * HOUR),
    ev('join', 'C', NOW - 3 * HOUR),
    ev('leave', 'A', NOW - 2 * HOUR),
    ev('leave', 'B', NOW - 1 * HOUR),
  ];
  const p = peakConcurrency(rows, NOW - WINDOW_7D_MS, NOW);
  eq(p.peak, 3, 'three overlapping joins peak at three');
  eq(p.atMs, NOW - 3 * HOUR, 'the peak is stamped at the join that reached it');
  eq(p.joins, 3, 'joins counted');
  eq(p.leaves, 2, 'leaves counted');

  // A leave with no matching join in the window must not drive the count negative.
  const orphan = peakConcurrency([ev('leave', 'Z', NOW - 2 * HOUR), ev('join', 'A', NOW - 1 * HOUR)], NOW - WINDOW_7D_MS, NOW);
  eq(orphan.peak, 1, 'an orphan leave cannot push the peak below the real one');

  // The same viking joining twice without a leave is still one person.
  const dupe = peakConcurrency([ev('join', 'A', NOW - 2 * HOUR), ev('join', 'A', NOW - 1 * HOUR)], NOW - WINDOW_7D_MS, NOW);
  eq(dupe.peak, 1, 'a duplicate join for one name does not double the count');

  // THE LEAVE MUST ACTUALLY DECREMENT, and only an INTERLEAVED fixture proves
  // it. Every case above puts all the joins before all the leaves, so the peak
  // is reached before a single leave is processed and a `leave` that did nothing
  // at all would still pass. Here A leaves before C arrives, so the true peak is
  // 2; a broken leave makes this a cumulative count of distinct names and
  // returns 3. That is the difference between "peak concurrency 6" and "peak
  // concurrency 20" on a launch night, which is the number the capacity question
  // turns on.
  const interleaved = peakConcurrency(
    [
      ev('join', 'A', NOW - 5 * HOUR),
      ev('join', 'B', NOW - 4 * HOUR),
      ev('leave', 'A', NOW - 3 * HOUR),
      ev('join', 'C', NOW - 2 * HOUR),
    ],
    NOW - WINDOW_7D_MS,
    NOW,
  );
  eq(interleaved.peak, 2, 'a viking who left before the next arrived is not counted twice over');
  eq(interleaved.atMs, NOW - 4 * HOUR, 'and the peak is stamped at the join that reached it, not the last one');

  // The same shape, out of order in the array: the replay sorts by time first.
  const shuffled = peakConcurrency(
    [
      ev('join', 'C', NOW - 2 * HOUR),
      ev('leave', 'A', NOW - 3 * HOUR),
      ev('join', 'A', NOW - 5 * HOUR),
      ev('join', 'B', NOW - 4 * HOUR),
    ],
    NOW - WINDOW_7D_MS,
    NOW,
  );
  eq(shuffled.peak, 2, 'rows arriving out of order are replayed in time order, not array order');

  eq(peakConcurrency([], NOW - WINDOW_7D_MS, NOW).peak, 0, 'no rows means no peak');
  eq(peakConcurrency([ev('death', 'A', NOW - HOUR)], NOW - WINDOW_7D_MS, NOW).peak, 0, 'deaths do not move concurrency');
  eq(peakConcurrency([ev('join', null, NOW - HOUR)], NOW - WINDOW_7D_MS, NOW).peak, 0, 'a nameless join cannot be tracked and is skipped');
  eq(peakConcurrency([ev('join', 'A', NOW - 30 * DAY)], NOW - WINDOW_7D_MS, NOW).peak, 0, 'rows before the window are out of it');
}

// ── identityMismatchSummary ────────────────────────────────────────────────
{
  const mm = { identity: 'steam_mismatch', seenSteamIdHash: 'aaaaaaaaaaaa' };
  const rows = [
    ev('join', 'Lóa', NOW - 2 * DAY, mm),
    ev('join', 'Bren', NOW - 1 * DAY, mm),
    ev('join', 'Clean', NOW - 1 * HOUR, {}),
  ];
  const s = identityMismatchSummary(rows, NOW - WINDOW_7D_MS, NOW);
  eq(s.count, 2, 'only annotated rows count');
  eq(s.accounts.length, 1, 'the same fingerprint twice is one account');
  eq(s.names.length, 2, 'two character names affected');
  eq(s.newestMs, NOW - 1 * DAY, 'newest mismatch stamped');
  eq(identityMismatchSummary([rows[2]], NOW - WINDOW_7D_MS, NOW).count, 0, 'an unannotated join is not a mismatch');
  eq(identityMismatchSummary(rows, NOW - 12 * HOUR, NOW).count, 0, 'mismatches outside the window are dropped');
}

// ── componentHeadroom ──────────────────────────────────────────────────────
{
  // log-poller: staleAfterSec 300.
  const at = (sec) => [{ component: 'log-poller', status: 'ok', last_success: iso(NOW - sec * SEC), metrics: {} }];
  eq(componentHeadroom(at(60), NOW).length, 0, '20% of the window is not worth a card');
  eq(componentHeadroom(at(209), NOW).length, 0, 'just under 70% stays quiet');
  eq(componentHeadroom(at(211), NOW).length, 1, 'just over 70% raises one');
  eq(componentHeadroom(at(400), NOW).length, 0, 'already stale is the state chip\'s job, not this one');
  eq(componentHeadroom([{ component: 'log-poller', status: 'ok', last_success: null, metrics: {} }], NOW).length, 0,
    'never reported is unknown, never "nearly stale"');
  eq(componentHeadroom([], NOW).length, 0, 'no heartbeats, no cards');
  eq(componentHeadroom([{ component: 'not-a-component', status: 'ok', last_success: iso(NOW - 290 * SEC), metrics: {} }], NOW).length, 0,
    'a component with no registry entry has no threshold to be near');
  const h = componentHeadroom(at(280), NOW)[0];
  eq(h.key, 'log-poller', 'the card names the component');
  ok(Math.abs(h.used - 280 / 300) < 1e-9, 'used is the fraction of the stale window');
}

// ── relayState ─────────────────────────────────────────────────────────────
{
  eq(relayState([], [], NOW).state, 'unknown', 'no bot heartbeat means no relay verdict at all');
  eq(relayState([{ component: 'discord-bot', status: 'ok', last_success: iso(NOW), metrics: {} }], [], NOW).state,
    'unknown', 'a heartbeat with no loop timestamp is still unknown');

  // Loop-timestamp fallback.
  const r1 = relayState([botHeartbeat({ relayRunMs: NOW - 30 * SEC })], [ev('join', 'A', NOW - 10 * SEC)], NOW);
  eq(r1.state, 'current', 'one row written ten seconds ago is not a backlog');
  eq(r1.pending, 1, 'that row is counted as pending');
  eq(r1.fromCursor, false, 'the fallback says it is not reading a cursor');

  const r2 = relayState([botHeartbeat({ relayRunMs: NOW - 20 * MIN })], [ev('join', 'A', NOW - 15 * MIN)], NOW);
  eq(r2.state, 'behind', 'a row waiting longer than the threshold is a backlog');
  ok(r2.waitingSec > RELAY_BEHIND_SEC, 'the waiting time is what crossed the threshold');

  // An old mark with nothing waiting is a quiet hall, not a broken relay.
  const r3 = relayState([botHeartbeat({ relayRunMs: NOW - 6 * HOUR })], [], NOW);
  eq(r3.state, 'current', 'an old cursor with no pending rows is caught up');
  eq(r3.pending, 0, 'nothing pending');
  ok(r3.markAgeSec > RELAY_BEHIND_SEC, 'and the mark really is old, so this is the case that matters');

  // Row count alone can trip it even when every row is seconds old. The rule is
  // STRICTLY more than RELAY_BEHIND_ROWS: the bot relays in batches of exactly
  // that many, so a full batch waiting is one tick's work, not a backlog, and
  // lib/ops/performance.ts draws the line in the same place.
  const many = Array.from({ length: RELAY_BEHIND_ROWS + 1 }, (_, i) => ev('join', `V${i}`, NOW - 5 * SEC));
  eq(relayState([botHeartbeat({ relayRunMs: NOW - 10 * SEC })], many, NOW).state, 'behind',
    `${RELAY_BEHIND_ROWS + 1} fresh rows at once is a backlog by volume`);
  eq(relayState([botHeartbeat({ relayRunMs: NOW - 10 * SEC })], many.slice(0, RELAY_BEHIND_ROWS), NOW).state, 'current',
    `exactly ${RELAY_BEHIND_ROWS} rows is one relay batch and not yet a backlog`);
  eq(relayState([botHeartbeat({ relayRunMs: NOW - 10 * SEC })], many.slice(0, RELAY_BEHIND_ROWS - 1), NOW).state, 'current',
    'and one under that is certainly not');

  // The cursor wins over the loop timestamp when the bot reports one.
  const r4 = relayState(
    [botHeartbeat({ relayRunMs: NOW - 10 * SEC, cursorMs: NOW - 30 * MIN })],
    [ev('join', 'A', NOW - 20 * MIN)],
    NOW,
  );
  eq(r4.fromCursor, true, 'a reported cursor is preferred');
  eq(r4.state, 'behind', 'and the row past it has been waiting twenty minutes');
}

// ── deedsWithinReach ───────────────────────────────────────────────────────
{
  const stats = [{ kills: 95 }];
  const close = deedsWithinReach([milestone({})], stats);
  eq(close.length, 1, '95 of 100 is within reach');
  eq(close[0].title, 'A Hundred Felled', 'the closest deed is named');
  ok(close[0].fraction >= DEED_IMMINENT_FRACTION, 'and it is above the threshold fraction');

  eq(deedsWithinReach([milestone({ threshold: 1000 })], stats).length, 0, '95 of 1000 is not');
  // summarizeMilestones rounds the percentage to a whole number before this
  // module compares it, so the boundary is the rounded 90, not the raw 0.9.
  eq(deedsWithinReach([milestone({ threshold: 107 })], stats).length, 0, 'a deed that rounds to 89% stays quiet');
  eq(deedsWithinReach([milestone({ threshold: 106 })], stats).length, 1, 'a deed that rounds to 90% fires');
  eq(deedsWithinReach([milestone({ achieved_at: iso(NOW - DAY) })], stats).length, 0, 'an achieved deed is not upcoming');
  eq(deedsWithinReach([], stats).length, 0, 'no definitions, no deeds');
  eq(deedsWithinReach([milestone({})], []).length, 0, 'no player_stats means no aggregate and no claim');

  // The two metrics this strip cannot compute must never claim imminence, even
  // when their threshold is trivially small.
  for (const metric of DEED_METRICS_NOT_EVALUATED) {
    eq(deedsWithinReach([milestone({ metric, threshold: 1 })], stats).length, 0,
      `${metric} is not evaluated here and never fires`);
  }
}

// ── silent hall ────────────────────────────────────────────────────────────
{
  const online = { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - 60 * SEC) };
  const quiet = base({ serverStatus: online, events: [ev('join', 'A', NOW - (SILENT_HALL_SEC + 600) * SEC)] });
  ok(ids(quiet).includes('silent-hall'), 'somebody online and hours of silence fires the card');
  ok(card(quiet, 'silent-hall').evidence.includes('Threshold'), 'and the evidence names its threshold');

  const busy = base({ serverStatus: online, events: [ev('join', 'A', NOW - 30 * MIN)] });
  ok(!ids(busy).includes('silent-hall'), 'a row half an hour ago keeps it quiet');

  const justUnder = base({ serverStatus: online, events: [ev('join', 'A', NOW - (SILENT_HALL_SEC - 60) * SEC)] });
  ok(!ids(justUnder).includes('silent-hall'), 'just inside the threshold stays quiet');

  const empty = base({
    serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 60 * SEC) },
    events: [ev('join', 'A', NOW - 5 * DAY)],
  });
  ok(!ids(empty).includes('silent-hall'), 'an empty hall is silent by design and never fires this');

  const stale = base({
    serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - (SERVER_STATUS_FRESH_SEC + 60) * SEC) },
    events: [ev('join', 'A', NOW - 5 * DAY)],
  });
  ok(!ids(stale).includes('silent-hall'), 'a stale roster is not evidence anybody is online');
}

// ── relay cards on the strip ───────────────────────────────────────────────
{
  const behind = base({
    heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * MIN })],
    events: [ev('join', 'A', NOW - 15 * MIN)],
  });
  ok(ids(behind).includes('relay-behind'), 'a backlog renders the warning card');
  ok(!ids(behind).includes('relay-current'), 'and never both relay cards at once');
  eq(card(behind, 'relay-behind').severity, 'warn', 'a relay backlog is a Watch, not an Info');

  const current = base({ heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC })], events: [] });
  ok(ids(current).includes('relay-current'), 'a caught-up relay says so out loud');
  eq(card(current, 'relay-current').severity, 'good', 'and it is a Good card');
  eq(card(current, 'relay-current').headline, 'The relay is 0 rows behind.', 'zero pending is stated as zero');

  // A GOOD CARD MUST NOT ARGUE WITH ITS OWN CHIP. Since "behind" is strictly more
  // than RELAY_BEHIND_ROWS, this card can carry a non-zero count, and it used to
  // render "Good | The relay is 50 rows behind."
  const inFlight = base({
    heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC })],
    events: Array.from({ length: RELAY_BEHIND_ROWS }, (_, i) => ev('join', `V${i}`, NOW - 5 * SEC)),
  });
  const flightCard = card(inFlight, 'relay-current');
  eq(flightCard.severity, 'good', `exactly ${RELAY_BEHIND_ROWS} rows in flight is still a Good card`);
  ok(!flightCard.headline.includes('behind'), 'and it does not call itself behind while chipped Good');
  ok(flightCard.headline.includes('still in flight'), 'it says the rows are in flight instead');
  ok(flightCard.evidence.includes(`more than ${RELAY_BEHIND_ROWS} rows waiting`),
    'and carries the threshold it is still inside');

  const noBot = base({ heartbeats: [] });
  ok(!ids(noBot).includes('relay-current') && !ids(noBot).includes('relay-behind'),
    'with no bot heartbeat the strip says nothing about the relay rather than guessing');
}

// ── announce backlog ───────────────────────────────────────────────────────
{
  const late = base({ milestones: [milestone({ achieved_at: iso(NOW - (ANNOUNCE_BACKLOG_SEC + 300) * SEC) })] });
  ok(ids(late).includes('announce-backlog'), 'a deed achieved and unannounced past the threshold fires');
  ok(card(late, 'announce-backlog').headline.includes('1 Great Deed has'), 'the headline agrees with itself on number');

  const fresh = base({ milestones: [milestone({ achieved_at: iso(NOW - 5 * MIN) })] });
  ok(!ids(fresh).includes('announce-backlog'), 'a deed achieved five minutes ago is not a backlog yet');

  const done = base({ milestones: [milestone({ achieved_at: iso(NOW - DAY), announced_at: iso(NOW - DAY) })] });
  ok(!ids(done).includes('announce-backlog'), 'an announced deed is not a backlog');

  const two = base({
    milestones: [
      milestone({ id: 'a', achieved_at: iso(NOW - 2 * HOUR) }),
      milestone({ id: 'b', achieved_at: iso(NOW - HOUR) }),
    ],
  });
  ok(card(two, 'announce-backlog').headline.includes('2 Great Deeds have'), 'two deeds pluralise');
}

// ── busiest hour / quiet window ────────────────────────────────────────────
{
  const busy = base({ events: [ev('join', 'A', NOW - 2 * HOUR), ev('leave', 'A', NOW - 2 * HOUR)] });
  ok(ids(busy).includes('busiest-hour'), 'events in the last 24 h produce the peak-hour card');
  ok(!ids(busy).includes('quiet-window'), 'and the quiet-window card stays away');
  ok(card(busy, 'busiest-hour').evidence.includes('per hour'), 'the comparison carries its unit');
  ok(card(busy, 'busiest-hour').evidence.includes('2 events fell across those 24 UTC hour buckets'),
    'and the total counts the bucketed rows, so it and the peak describe the same set');

  // THE BUCKETS AND THE ROLLING DAY ARE NOT THE SAME SET, which is the whole
  // reason the total is summed from the buckets. hourBuckets(now, 24) starts at
  // the top of the hour 23 h back, so with NOW on the hour a row 23 h 30 m old
  // is inside the rolling 24 h and outside every bucket. Quoting the rolling
  // count beside a bucketed peak compared the peak against rows that could never
  // have been in it.
  const edge = base({ events: [ev('join', 'A', NOW - 23 * HOUR - 30 * MIN), ev('join', 'B', NOW - 2 * HOUR)] });
  const edgeCard = card(edge, 'busiest-hour');
  ok(edgeCard.evidence.includes('1 events fell across those 24 UTC hour buckets'),
    'a row inside the rolling day but before the oldest bucket is not counted in the bucket total');
  ok(!edgeCard.evidence.includes('2 events fell'), 'and the card does not quote a total its buckets never saw');

  // The other edge of the same boundary, and the reason the buckets are fed the
  // whole read rather than the rolling window: the newest bucket runs to the top
  // of the CURRENT hour, which is a few minutes ahead of `now`. A row stamped
  // inside it (event-time.ts clamps producer stamps at ingest, but a row written
  // microseconds after this render took its clock is not clamped away) belongs to
  // that bucket. Feeding the buckets `last24` instead would silently drop it from
  // a card whose whole claim is that it counts what is in the buckets.
  const ahead = base({ events: [ev('join', 'A', NOW - 2 * HOUR), ev('join', 'B', NOW + 30 * SEC)] });
  ok(card(ahead, 'busiest-hour').evidence.includes('2 events fell across those 24 UTC hour buckets'),
    'a row stamped just past the render clock is still inside the current bucket and is counted there');

  const quiet = base({ events: [ev('join', 'A', NOW - 3 * DAY)] });
  ok(ids(quiet).includes('quiet-window'), 'nothing in 24 h says so plainly');
  ok(!ids(quiet).includes('busiest-hour'), 'and there is no peak hour to report');
  eq(card(quiet, 'quiet-window').severity, 'info', 'a quiet night is information, not a fault');

  const nothing = base({ events: [] });
  ok(ids(nothing).includes('quiet-window'), 'an empty read still renders the quiet-window card');
  ok(card(nothing, 'quiet-window').evidence.includes('read window'), 'and says the window it looked in');
}

// ── peak concurrency card ──────────────────────────────────────────────────
{
  const withJoins = base({ events: [ev('join', 'A', NOW - 2 * DAY), ev('join', 'B', NOW - 2 * DAY)] });
  ok(ids(withJoins).includes('peak-concurrency'), 'joins in the window give a peak');
  ok(card(withJoins, 'peak-concurrency').headline.includes('2 vikings'), 'and it names the number');
  const noJoins = base({ events: [ev('death', 'A', NOW - 2 * HOUR)] });
  ok(!ids(noJoins).includes('peak-concurrency'), 'with no join rows there is no peak to claim');
}

// ── deed imminent card ─────────────────────────────────────────────────────
{
  const close = base({ milestones: [milestone({})], playerStats: [{ kills: 95 }] });
  ok(ids(close).includes('deed-imminent'), 'a deed at 95% fires');
  ok(card(close, 'deed-imminent').evidence.includes('player_stats'), 'and the evidence says what it was computed from');
  // Every number on these pages carries a unit, and a ceremonial deed title
  // never says what it counts: "95 of 100" alone could be kills, deaths or
  // builds. The metric registry supplies the word.
  ok(card(close, 'deed-imminent').evidence.includes('foes slain: 95 of 100'),
    'the number carries the metric it counts, not a bare integer');
  const deaths = base({
    milestones: [milestone({ metric: 'deaths_total', threshold: 25, title: 'The First Bench' })],
    playerStats: [{ deaths: 24 }],
  });
  ok(card(deaths, 'deed-imminent').evidence.includes('deaths: 24 of 25'),
    'and a different metric gets its own word');
  eq(card(deaths, 'deed-imminent').weight, WEIGHT_FORWARD,
    'a countdown declares itself forward-looking so recency cannot bury it');
  const far = base({ milestones: [milestone({ threshold: 10000 })], playerStats: [{ kills: 95 }] });
  ok(!ids(far).includes('deed-imminent'), 'a deed at 1% does not');
}

// ── death spike ────────────────────────────────────────────────────────────
{
  const deaths = (n, atMs) => Array.from({ length: n }, (_, i) => ev('death', `V${i}`, atMs));
  const spike = base({ events: [...deaths(6, NOW - 2 * HOUR), ...deaths(1, NOW - 5 * DAY)] });
  ok(ids(spike).includes('death-spike'), 'six deaths today against one all week fires');
  ok(card(spike, 'death-spike').evidence.includes('per day'), 'and the average carries its unit');

  const belowMin = base({ events: [...deaths(DEATH_SPIKE_MIN_DEATHS - 1, NOW - 2 * HOUR)] });
  ok(!ids(belowMin).includes('death-spike'), 'under the minimum death count it never fires, whatever the ratio');

  const steady = base({ events: [...deaths(3, NOW - 2 * HOUR), ...deaths(28, NOW - 4 * DAY)] });
  ok(!ids(steady).includes('death-spike'), 'three today against four a day is not a spike');

  const truncated = base({ events: [...deaths(6, NOW - 2 * HOUR), ...deaths(1, NOW - 5 * DAY)], eventsTruncated: true });
  ok(!ids(truncated).includes('death-spike'), 'a truncated read cannot support a comparison against the weekly average');

  // The factor threshold, either side.
  const perDay = 7 / 7; // seven deaths across the week is one a day
  const week = deaths(7, NOW - 4 * DAY);
  const under = base({ events: [...deaths(Math.floor(perDay * DEATH_SPIKE_FACTOR), NOW - 2 * HOUR), ...week] });
  ok(!ids(under).includes('death-spike'), 'exactly at the factor is not over it');
}

// ── new viking ─────────────────────────────────────────────────────────────
{
  const arrived = base({ newPlayers: [{ character_name: 'Bren', first_seen_at: iso(NOW - 2 * HOUR), is_online: false, last_seen_at: iso(NOW - HOUR) }] });
  ok(ids(arrived).includes('new-viking'), 'a first_seen_at inside 24 h fires');
  eq(card(arrived, 'new-viking').severity, 'good', 'a new player is good news');
  ok(card(arrived, 'new-viking').evidence.includes('Bren'), 'and the name is on the card');

  const older = base({ newPlayers: [{ character_name: 'Bren', first_seen_at: iso(NOW - 3 * DAY), is_online: false, last_seen_at: null }] });
  ok(!ids(older).includes('new-viking'), 'three days ago is not the last 24 h');

  const many = base({
    newPlayers: Array.from({ length: 6 }, (_, i) => ({
      character_name: `V${i}`, first_seen_at: iso(NOW - (i + 1) * HOUR), is_online: false, last_seen_at: null,
    })),
  });
  ok(card(many, 'new-viking').evidence.includes('2 more'), 'past four names the rest are counted, not listed');
}

// ── new viking, when the read was cut ──────────────────────────────────────
{
  const many = Array.from({ length: 50 }, (_, i) => ({
    character_name: `V${i}`, first_seen_at: iso(NOW - (i + 1) * MIN), is_online: false, last_seen_at: iso(NOW),
  }));
  const cut = base({ newPlayers: many, newPlayersTruncated: true });
  const cutCard = card(cut, 'new-viking');
  ok(cutCard.headline.startsWith('At least 50 new vikings'),
    'a full read whose rows are all inside the window is reported as a floor');
  ok(cutCard.evidence.includes('so the count is a floor'), 'and the card says why');

  const notCut = base({ newPlayers: many, newPlayersTruncated: false });
  ok(card(notCut, 'new-viking').headline.startsWith('50 new vikings'),
    'a read that was not cut states the count flat');

  // The read was cut, but some of the rows it returned are older than 24 h, so
  // the limit cannot have removed a newer one: the count is exact after all.
  const cutButOld = base({
    newPlayers: [...many.slice(0, 49), { character_name: 'Old', first_seen_at: iso(NOW - 3 * DAY), is_online: false, last_seen_at: iso(NOW) }],
    newPlayersTruncated: true,
  });
  ok(card(cutButOld, 'new-viking').headline.startsWith('49 new vikings'),
    'a cut read that still reaches past the window is not a floor: the limit removed nothing newer');

  const noRead = base({ newPlayers: many, reads: { newPlayers: false } });
  ok(!ids(noRead).includes('new-viking'), 'a failed roster read claims no new vikings at all');
}

// ── identity mismatch card ─────────────────────────────────────────────────
{
  const mm = { identity: 'steam_mismatch', seenSteamIdHash: 'abc123abc123' };
  const bad = base({ events: [ev('join', 'Lóa', NOW - 2 * DAY, mm), ev('join', 'Lóa', NOW - DAY, mm)] });
  ok(ids(bad).includes('identity-mismatch'), 'annotated joins fire the card');
  ok(card(bad, 'identity-mismatch').evidence.includes('all the same account'), 'one fingerprint twice is called out');
  const clean = base({ events: [ev('join', 'Lóa', NOW - 2 * DAY)] });
  ok(!ids(clean).includes('identity-mismatch'), 'ordinary joins do not');
}

// ── component headroom card ────────────────────────────────────────────────
{
  const hb = (sec) => [{ component: 'log-poller', status: 'ok', last_success: iso(NOW - sec * SEC), metrics: {} }];
  const near = base({ heartbeats: hb(280) });
  ok(ids(near).includes('component-headroom'), '93% of the stale window is worth a card');
  ok(card(near, 'component-headroom').evidence.includes('slack left'), 'and it says how much room is left');
  ok(!ids(base({ heartbeats: hb(60) })).includes('component-headroom'), '20% of the window is not');

  // The Companion stops polling with an empty hall, so its headroom is expected.
  const voice = [{ component: 'companion-voice', status: 'ok', last_success: iso(NOW - 280 * SEC), metrics: {} }];
  const emptyHall = base({
    heartbeats: voice,
    serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 30 * SEC) },
  });
  ok(!ids(emptyHall).includes('component-headroom'), 'the in-game voice going quiet in an empty hall is not a signal');
  const fullHall = base({
    heartbeats: voice,
    serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - 30 * SEC) },
    events: [ev('join', 'A', NOW - 30 * MIN)],
  });
  ok(ids(fullHall).includes('component-headroom'), 'with somebody online the same age is worth saying');
}

// ── world clock and emitter freshness ──────────────────────────────────────
{
  const fresh = base({ serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - 60 * SEC) } });
  ok(ids(fresh).includes('world-clock'), 'a fresh emitter gives the world clock card');
  ok(!ids(fresh).includes('emitter-quiet'), 'and never both');
  ok(card(fresh, 'world-clock').headline.includes('day 17'), 'the day is on the headline');

  const stale = base({ serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 30 * MIN) } });
  ok(ids(stale).includes('emitter-quiet'), 'a stale emitter is a warning');
  eq(card(stale, 'emitter-quiet').severity, 'warn', 'and it is a Watch card');

  const none = base({ serverStatus: null });
  ok(!ids(none).includes('world-clock') && !ids(none).includes('emitter-quiet'),
    'with no server_status row the strip says nothing about the world rather than guessing');
}

// ── the all-clear, and the unavailable card ────────────────────────────────
{
  const calm = base({ events: [ev('join', 'A', NOW - 2 * HOUR)] });
  ok(ids(calm).includes('nothing-to-report'), 'with nothing to act on the all-clear renders');
  ok(card(calm, 'nothing-to-report').evidence.includes('events in the last 24 h'), 'and it carries the numbers behind it');

  const alarming = base({
    events: [ev('join', 'A', NOW - 2 * HOUR)],
    serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 30 * MIN) },
  });
  ok(!ids(alarming).includes('nothing-to-report'), 'one Watch card is enough to withdraw the all-clear');

  const down = base({ supabaseOk: false });
  const downCards = buildInsights(down);
  eq(downCards.length, 1, 'an unreadable database renders exactly one card');
  eq(downCards[0].id, 'insights-unavailable', 'and it says so rather than an all-clear');
  eq(downCards[0].severity, 'critical', 'it is an Act card');
}

// ── a read that failed is never reported as an empty table ─────────────────
//
// THE FAILURE THIS BLOCK EXISTS FOR. `safeRead` gives a query that errored the
// same empty array an empty table gives, so before the reads flags existed a
// PostgREST 400 or a statement timeout on `events` rendered as: "The relay is 0
// rows behind", "0 in the last 7 d", and "The last 24 h look normal" over a
// database holding 20 rows the page could not see. Partial failure is likelier
// under load than total failure and it is the dangerous half, because total
// failure already had a card.
{
  // Every other read returns; only the event log is dark. This is the exact
  // shape that produced the false all-clear.
  const eventsDark = base({
    reads: { events: false },
    heartbeats: [botHeartbeat({ cursorMs: NOW - 5 * DAY })],
    serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 22 * SEC) },
  });
  const dark = ids(eventsDark);
  ok(dark.includes('read-failed'), 'a failed read is stated on its own card');
  ok(!dark.includes('nothing-to-report'), 'and the all-clear is withdrawn: absence is not health');
  ok(!dark.includes('relay-current'), 'the relay cannot claim to be caught up on rows it never read');
  ok(!dark.includes('relay-behind'), 'nor can it claim a backlog');
  ok(!dark.includes('quiet-window'), '"no events" and "no events read" are different facts');
  ok(!dark.includes('busiest-hour'), 'there is no busiest hour without the event log');
  ok(!dark.includes('peak-concurrency'), 'and no concurrency replay');
  ok(dark.includes('world-clock'), 'the cards that do not need the failed read still render');
  ok(!card(eventsDark, 'world-clock').evidence.includes('events in the last 24 h'),
    'and the ones that survive do not quote counts from the read that failed');
  ok(card(eventsDark, 'world-clock').evidence.includes('could not be read'),
    'they say so instead');
  eq(card(eventsDark, 'read-failed').severity, 'warn', 'an incomplete strip is a Watch');
  ok(card(eventsDark, 'read-failed').evidence.includes('the event log (events)'),
    'and it names which read failed');

  const clearDark = checksNotFlagged(eventsDark, buildInsights(eventsDark));
  ok(!clearDark.includes('the Discord relay backlog'),
    'a check whose read failed is never listed as checked and clear');
  ok(!clearDark.includes('Steam identity mismatches'), 'nor is the identity check');
  ok(!clearDark.includes('the death rate against the weekly average'), 'nor the death rate');

  // The silent-hall rule is the one that would fire a FALSE WARNING rather than
  // a false all-clear: with people online and no rows read it would announce
  // that nothing is being recorded.
  const onlineDark = base({
    reads: { events: false },
    serverStatus: { current_players: ['A', 'B'], player_count: 2, world_day: 17, updated_at: iso(NOW - 20 * SEC) },
  });
  ok(!ids(onlineDark).includes('silent-hall'),
    'an unread event log is not evidence that the hall has gone silent');

  // Each of the other five reads, one at a time.
  const perRead = {
    heartbeats: ['relay-current', 'relay-behind', 'component-headroom'],
    serverStatus: ['world-clock', 'emitter-quiet', 'silent-hall'],
    milestones: ['announce-backlog', 'deed-imminent'],
    playerStats: ['deed-imminent'],
    newPlayers: ['new-viking'],
  };
  for (const [key, suppressed] of Object.entries(perRead)) {
    const input = base({
      reads: { [key]: false },
      events: [ev('join', 'A', NOW - 2 * HOUR)],
      heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC })],
      serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 20 * SEC) },
      milestones: [milestone({ achieved_at: iso(NOW - HOUR) })],
      playerStats: [{ kills: 95 }],
      newPlayers: [{ character_name: 'Bren', first_seen_at: iso(NOW - 2 * HOUR), is_online: true, last_seen_at: iso(NOW) }],
    });
    const got = ids(input);
    ok(got.includes('read-failed'), `a failed ${key} read is stated`);
    ok(!got.includes('nothing-to-report'), `and no all-clear is printed over a failed ${key} read`);
    for (const id of suppressed) {
      ok(!got.includes(id), `${id} does not fire without the ${key} read`);
    }
  }

  // All six down is still the single "unavailable" card, not six warnings.
  const allDown = base({ supabaseOk: false, reads: Object.fromEntries(READ_LABELS.map((r) => [r.key, false])) });
  eq(buildInsights(allDown).length, 1, 'a total outage is one card, not one per read');
  eq(buildInsights(allDown)[0].id, 'insights-unavailable', 'and it is the unavailable card');

  // And the healthy case: six reads back, no card.
  ok(!ids(base({ events: [ev('join', 'A', NOW - 2 * HOUR)] })).includes('read-failed'),
    'six good reads produce no read-failure card at all');
}

// ── every card is well formed ──────────────────────────────────────────────
{
  const everything = base({
    events: [
      ev('join', 'A', NOW - 2 * HOUR),
      ev('join', 'B', NOW - 2 * HOUR),
      ev('death', 'A', NOW - HOUR),
      ev('death', 'B', NOW - HOUR),
      ev('death', 'A', NOW - 30 * MIN),
      ev('join', 'C', NOW - 3 * DAY, { identity: 'steam_mismatch', seenSteamIdHash: 'ffffffffffff' }),
    ],
    heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC }), { component: 'log-poller', status: 'ok', last_success: iso(NOW - 280 * SEC), metrics: {} }],
    serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - 30 * SEC) },
    milestones: [milestone({}), milestone({ id: 'late', achieved_at: iso(NOW - HOUR) })],
    playerStats: [{ kills: 95 }],
    newPlayers: [{ character_name: 'Bren', first_seen_at: iso(NOW - 2 * HOUR), is_online: true, last_seen_at: iso(NOW) }],
  });
  const all = buildInsights(everything);
  ok(all.length >= 6, `a busy render produces at least six candidates (got ${all.length})`);
  ok(all.length <= 12, 'and never more than twelve');

  // The sweep runs over every card this module can produce, not only the ones a
  // healthy render reaches: the read-failure and total-outage cards are the two
  // that appear on the worst night, which is the worst possible time to discover
  // a missing caption.
  const everyCard = [
    ...all,
    ...buildInsights(base({ reads: { events: false }, heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC })] })),
    ...buildInsights(base({ supabaseOk: false })),
  ];
  const coveredIds = new Set(everyCard.map((c) => c.id));
  ok(coveredIds.has('read-failed'), 'the sweep covers the read-failure card');
  ok(coveredIds.has('insights-unavailable'), 'and the total-outage card');

  const seen = new Set();
  for (const i of all) {
    ok(typeof i.id === 'string' && i.id.length > 0, `${i.id}: has an id`);
    ok(!seen.has(i.id), `${i.id}: appears only once`);
    seen.add(i.id);
    ok(i.headline.length > 0 && i.headline.length < 160, `${i.id}: headline is one short sentence`);
    ok(i.evidence.length > 0, `${i.id}: carries evidence`);
    ok(i.explain && i.explain.what && i.explain.why && i.explain.healthy && i.explain.whenRed,
      `${i.id}: ships a complete caption`);
    eq(i.glossaryId, i.explain.id, `${i.id}: the caption id matches the card`);
    ok(i.severity in SEVERITY_RANK, `${i.id}: severity is one of the four`);
  }

  // Copy rules, over every card including the failure ones. The em-dash check
  // covers the CAPTION fields too: they are the longest prose on the strip and
  // the likeliest place for one to slip in, and they were unchecked until now.
  for (const i of everyCard) {
    const prose = [i.headline, i.evidence, i.explain.title, i.explain.what, i.explain.why, i.explain.healthy, i.explain.whenRed].join(' ');
    ok(!prose.includes('—'), `${i.id}: no em dashes anywhere in its copy or caption`);
    ok(!prose.includes('–'), `${i.id}: no en dashes either`);
    ok(i.explain && i.explain.what && i.explain.why && i.explain.healthy && i.explain.whenRed,
      `${i.id}: ships a complete caption even on a failed render`);
    eq(i.glossaryId, i.explain.id, `${i.id}: the caption id matches the card`);
  }
}

// ── ranking ────────────────────────────────────────────────────────────────
{
  const mk = (id, severity, atMs = null) => ({
    id, severity, headline: id, evidence: id, glossaryId: id,
    explain: { id, title: id, what: 'w', why: 'y', healthy: 'h', whenRed: 'r' }, atMs,
  });
  const ranked = rankInsights(
    [mk('i', 'info'), mk('g', 'good'), mk('c', 'critical'), mk('w', 'warn')],
    4,
  );
  assert.deepStrictEqual(ranked.map((r) => r.id), ['c', 'w', 'g', 'i'], 'severity orders the strip');
  passed++;

  const byTime = rankInsights([mk('old', 'warn', NOW - HOUR), mk('new', 'warn', NOW)], 2);
  assert.deepStrictEqual(byTime.map((r) => r.id), ['new', 'old'], 'inside a severity the newer evidence wins');
  passed++;

  const timedFirst = rankInsights([mk('none', 'warn', null), mk('timed', 'warn', NOW - DAY)], 2);
  assert.deepStrictEqual(timedFirst.map((r) => r.id), ['timed', 'none'], 'an insight with a time beats one without');
  passed++;

  // WEIGHT OUTRANKS RECENCY, INSIDE A SEVERITY. Recency is the right rule for a
  // card about something that happened and the wrong one for a countdown, which
  // has no timestamp and so lost every tie to ambient context that had one. On
  // the live quiet render that pushed the one forward-looking card, a deed at
  // 96 percent, below two cards restating that nothing had happened.
  const forward = { ...mk('deed', 'info', null), weight: WEIGHT_FORWARD };
  const ranked2 = rankInsights([mk('context', 'info', NOW), forward], 2);
  assert.deepStrictEqual(ranked2.map((r) => r.id), ['deed', 'context'],
    'a forward-looking card outranks timestamped context of the same severity');
  passed++;

  // But severity still wins outright: a countdown never outranks a warning.
  const ranked3 = rankInsights([{ ...mk('deed2', 'info', null), weight: WEIGHT_FORWARD }, mk('alarm', 'warn', NOW - DAY)], 2);
  assert.deepStrictEqual(ranked3.map((r) => r.id), ['alarm', 'deed2'], 'severity still outranks weight');
  passed++;

  eq(WEIGHT_FORWARD < WEIGHT_DEFAULT, true, 'forward-looking sorts before the default weight');

  const stable = [mk('a', 'info'), mk('b', 'info'), mk('c', 'info')];
  assert.deepStrictEqual(rankInsights(stable, 3).map((r) => r.id), ['a', 'b', 'c'], 'ties keep source order, so the strip does not reshuffle');
  passed++;
  assert.deepStrictEqual(rankInsights(stable, 3).map((r) => r.id), rankInsights(stable, 3).map((r) => r.id), 'and it is deterministic');
  passed++;

  eq(rankInsights(stable, 2).length, 2, 'limit cuts the list');
  eq(rankInsights(stable, 99).length, 3, 'a limit above the candidate count returns them all');
  eq(rankInsights(Array.from({ length: 20 }, (_, i) => mk(`x${i}`, 'info')), 99).length, MAX_CARDS,
    `no limit renders more than ${MAX_CARDS} cards`);
  eq(rankInsights(stable, 0).length, 1, 'a zero limit still renders one card rather than an empty strip');
  eq(rankInsights([], 4).length, 0, 'ranking nothing returns nothing');
  const original = [mk('a', 'info'), mk('b', 'critical')];
  rankInsights(original, 2);
  eq(original[0].id, 'a', 'ranking does not mutate its input');
}

// ── what was checked ───────────────────────────────────────────────────────
{
  const input = base({
    events: [ev('join', 'A', NOW - 2 * HOUR)],
    heartbeats: [botHeartbeat({ relayRunMs: NOW - 20 * SEC })],
    serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - 30 * SEC) },
    milestones: [milestone({})],
  });
  const clear = checksNotFlagged(input, buildInsights(input));
  ok(clear.includes('the roster against the event log'),
    'with somebody online and rows read, the presence check really did run');
  ok(clear.includes('the Discord relay backlog'), 'a relay that ran and did not flag is listed as checked');
  ok(clear.includes('Steam identity mismatches'), 'so is the identity check');
  ok(clear.length >= 5, `most checks come back clear on a calm render (got ${clear.length})`);

  const noData = base({});
  const clearEmpty = checksNotFlagged(noData, buildInsights(noData));
  ok(!clearEmpty.includes('the Discord relay backlog'),
    'a check with no data behind it is never claimed as clear');
  ok(!clearEmpty.includes('server emitter freshness'), 'nor is one with no server_status row');

  // THE PRESENCE CHECK SHORT-CIRCUITS ON AN EMPTY HALL. silent-hall is only
  // evaluated while server_status is fresh AND somebody is on it, so with nobody
  // online the rule never touches the event log and the check did not run. It
  // was listed as clear anyway until 2026-09-06, on what is the ordinary state
  // of a weeknight render.
  const emptyHall = base({
    events: [ev('join', 'A', NOW - 2 * HOUR)],
    serverStatus: { current_players: [], player_count: 0, world_day: 17, updated_at: iso(NOW - 20 * SEC) },
  });
  ok(!checksNotFlagged(emptyHall, buildInsights(emptyHall)).includes('the roster against the event log'),
    'with nobody online the presence check did not run and is not claimed as clear');

  const staleStatus = base({
    events: [ev('join', 'A', NOW - 2 * HOUR)],
    serverStatus: { current_players: ['A'], player_count: 1, world_day: 17, updated_at: iso(NOW - (SERVER_STATUS_FRESH_SEC + 60) * SEC) },
  });
  ok(!checksNotFlagged(staleStatus, buildInsights(staleStatus)).includes('the roster against the event log'),
    'a stale roster is not a roster the check could compare anything against');

  const flagged = base({
    events: [ev('join', 'A', NOW - 2 * HOUR), ev('join', 'B', NOW - DAY, { identity: 'steam_mismatch', seenSteamIdHash: 'aaaaaaaaaaaa' })],
  });
  ok(!checksNotFlagged(flagged, buildInsights(flagged)).includes('Steam identity mismatches'),
    'a check that flagged is not also reported as clear');

  eq(checksNotFlagged(base({ supabaseOk: false }), []).length, 0,
    'with the database unreadable nothing is claimed to have been checked');
}

// ── thresholds are exported and sane ───────────────────────────────────────
{
  ok(SILENT_HALL_SEC === 3 * 60 * 60, 'silent hall is three hours');
  ok(RELAY_BEHIND_SEC === 300 && RELAY_BEHIND_ROWS === 50, 'relay thresholds');
  ok(ANNOUNCE_BACKLOG_SEC === 900, 'announce backlog is fifteen minutes');
  ok(DEED_IMMINENT_FRACTION === 0.9, 'a deed is imminent at 90 percent');
  ok(DEATH_SPIKE_FACTOR === 2 && DEATH_SPIKE_MIN_DEATHS === 3, 'death spike thresholds');
  ok(COMPONENT_HEADROOM_FRACTION === 0.7, 'headroom is flagged at 70 percent of the window');
  ok(MAX_CARDS === 6, 'the strip is capped at six cards, per the frozen contract');
}

console.log(`insights.test.mjs: ${passed} assertions passed`);
