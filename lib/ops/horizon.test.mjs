// Unit tests for the "coming up" maths behind /admin/ops/horizon.
// Run: npx tsx lib/ops/horizon.test.mjs
import assert from 'node:assert';
import {
  zoneOffsetMs,
  zoneDateParts,
  zonedTimeToMs,
  nextDailyRun,
  nextCronRun,
  nextOfDailyHours,
  clockInZone,
  stampInZone,
  nextDawnWorldDay,
  ambientCadence,
  relayDrain,
  upcomingDeeds,
  formatDeedValue,
  titleContests,
  expiringSoon,
  nextWatchdogAlertAt,
  cadenceEta,
  nextBoss,
  mergeSchedule,
  LAUNCH_STEPS,
  launchStepStates,
  nextOpenSteps,
  launchCountdownSec,
  daysUntilInZone,
  launchMomentMs,
  ymdStartMs,
  maskClaimCode,
  resolveSchedule,
  minGapRemainingSec,
  LOOP_INTERVAL_DEFAULTS_MS,
  RELAY_BATCH,
  RELAY_TICK_MS,
  DAWN_EVERY_DAYS_DEFAULT,
  VOICE_CADENCE_MINUTES_DEFAULT,
  VOICE_MIN_GAP_MS_DEFAULT,
  RECAP_HOUR_DEFAULT,
  RECAP_TZ_DEFAULT,
} from './horizon.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); passed++; };
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, wanted ${b} +/- ${tol})`); passed++; };

const TZ = 'America/Chicago';
const HOUR = 3_600_000;

// ── zoneOffsetMs: the DST-correct offset, with no library ───────────────────
{
  // Winter: America/Chicago is CST, UTC-6.
  eq(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), TZ), -6 * HOUR, 'CST is UTC-6');
  // Summer: CDT, UTC-5.
  eq(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), TZ), -5 * HOUR, 'CDT is UTC-5');
  eq(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'UTC'), 0, 'UTC is its own offset');
  // A half-hour zone, because an implementation that only handles whole hours
  // passes every test above and still gets India wrong.
  eq(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kolkata'), 5.5 * HOUR, 'a half-hour zone');
  eq(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Not/AZone'), null, 'a bad zone is null, not a throw');
  eq(zoneOffsetMs(Number.NaN, TZ), null, 'a non-finite instant is null');
}

// ── zoneDateParts ───────────────────────────────────────────────────────────
{
  // 02:30 UTC on the 7th is still the evening of the 6th in Chicago.
  const p = zoneDateParts(Date.parse('2026-09-07T02:30:00Z'), TZ);
  eq(p.y, 2026, 'year in zone');
  eq(p.m, 9, 'month in zone');
  eq(p.d, 6, 'the date in Chicago is still the previous day');
  eq(p.hour, 21, 'hour in zone');
  eq(p.minute, 30, 'minute in zone');
  eq(zoneDateParts(0, 'Not/AZone'), null, 'a bad zone is null');
}

// ── zonedTimeToMs ───────────────────────────────────────────────────────────
{
  // 23:00 CDT on 2026-09-08 is 04:00 UTC on the 9th.
  eq(
    zonedTimeToMs(2026, 9, 8, 23, 0, TZ),
    Date.parse('2026-09-09T04:00:00Z'),
    'a summer evening resolves through CDT',
  );
  // 23:00 CST on 2026-01-15 is 05:00 UTC on the 16th.
  eq(
    zonedTimeToMs(2026, 1, 15, 23, 0, TZ),
    Date.parse('2026-01-16T05:00:00Z'),
    'a winter evening resolves through CST',
  );
  eq(zonedTimeToMs(2026, 9, 8, 23, 0, 'Not/AZone'), null, 'a bad zone is null');
}

// ── nextDailyRun: the ordinary cases ────────────────────────────────────────
{
  // 20:00 local, the 23:00 recap is still to come today.
  const now = Date.parse('2026-09-06T01:00:00Z'); // 20:00 CDT on the 5th
  const next = nextDailyRun(now, 23, 0, TZ);
  eq(next, Date.parse('2026-09-06T04:00:00Z'), 'the run later today');
  eq(clockInZone(next, TZ), '23:00', 'and it reads 23:00 on the wall clock');

  // 23:30 local, today's run has passed, so it is tomorrow's.
  const after = Date.parse('2026-09-06T04:30:00Z'); // 23:30 CDT on the 5th
  eq(nextDailyRun(after, 23, 0, TZ), Date.parse('2026-09-07T04:00:00Z'), 'the run rolls to tomorrow');

  // Exactly on the hour counts as past: a cron that just fired does not fire again.
  const exact = Date.parse('2026-09-06T04:00:00Z');
  eq(nextDailyRun(exact, 23, 0, TZ), Date.parse('2026-09-07T04:00:00Z'), 'the boundary rolls forward');

  eq(nextCronRun(now, 23, TZ), next, 'nextCronRun is nextDailyRun at :00');
  eq(nextDailyRun(now, 24, 0, TZ), null, 'hour 24 is rejected');
  eq(nextDailyRun(now, -1, 0, TZ), null, 'a negative hour is rejected');
  eq(nextDailyRun(now, 23, 60, TZ), null, 'minute 60 is rejected');
  eq(nextDailyRun(now, 23, 0, 'Not/AZone'), null, 'a bad zone is null, so the page prints text instead');
  eq(nextDailyRun(Number.NaN, 23, 0, TZ), null, 'a non-finite now is null');
}

// ── nextDailyRun across BOTH DST boundaries in America/Chicago ──────────────
//
// This is the whole reason the zone maths is hand-rolled rather than assumed.
// Spring forward 2026: Sunday 2026-03-08, 02:00 CST becomes 03:00 CDT.
// Fall back 2026:      Sunday 2026-11-01, 02:00 CDT becomes 01:00 CST.
{
  // The 23:00 recap on the evening BEFORE spring forward.
  const beforeSpring = Date.parse('2026-03-08T01:00:00Z'); // 19:00 CST on the 7th
  const springEve = nextDailyRun(beforeSpring, 23, 0, TZ);
  eq(springEve, Date.parse('2026-03-08T05:00:00Z'), 'the recap on 03-07 fires at 05:00 UTC (CST)');
  eq(clockInZone(springEve, TZ), '23:00', 'and reads 23:00 locally');

  // The next one is the evening of the day the clocks moved: 23:00 CDT.
  const springNight = nextDailyRun(springEve + 60_000, 23, 0, TZ);
  eq(springNight, Date.parse('2026-03-09T04:00:00Z'), 'the recap on 03-08 fires at 04:00 UTC (CDT)');
  eq(clockInZone(springNight, TZ), '23:00', 'still 23:00 locally, one hour earlier in UTC');
  eq(springNight - springEve, 23 * HOUR, 'the spring gap between two daily runs is 23 h, not 24');

  // Fall back: the two evenings around 2026-11-01.
  const beforeFall = Date.parse('2026-10-31T22:00:00Z'); // 17:00 CDT
  const fallEve = nextDailyRun(beforeFall, 23, 0, TZ);
  eq(fallEve, Date.parse('2026-11-01T04:00:00Z'), 'the recap on 10-31 fires at 04:00 UTC (CDT)');
  const fallNight = nextDailyRun(fallEve + 60_000, 23, 0, TZ);
  eq(fallNight, Date.parse('2026-11-02T05:00:00Z'), 'the recap on 11-01 fires at 05:00 UTC (CST)');
  eq(clockInZone(fallNight, TZ), '23:00', 'still 23:00 locally after the clocks go back');
  eq(fallNight - fallEve, 25 * HOUR, 'the autumn gap between two daily runs is 25 h, not 24');

  // 03:30, the db-snapshot timer's hour, on the morning the clocks spring
  // forward. 02:30 would not exist; 03:30 does, and must resolve to CDT.
  const preDawn = Date.parse('2026-03-08T07:00:00Z'); // 01:00 CST on the 8th
  const snapshot = nextDailyRun(preDawn, 3, 30, TZ);
  eq(clockInZone(snapshot, TZ), '03:30', 'the 03:30 snapshot still lands on 03:30 local');
  ok(snapshot > preDawn, 'and it is in the future');
}

// ── nextOfDailyHours: the world-backup timer's 00/06/12/18 ──────────────────
{
  const now = Date.parse('2026-09-06T14:37:00Z'); // 09:37 CDT
  const next = nextOfDailyHours(now, [0, 6, 12, 18], 0, TZ);
  eq(clockInZone(next, TZ), '12:00', 'the next six-hour slot is noon local');
  ok(next > now, 'and it is in the future');
  eq(nextOfDailyHours(now, [], 0, TZ), null, 'no hours means no answer');
  eq(nextOfDailyHours(now, [0], 0, 'Not/AZone'), null, 'a bad zone is null');
  ok(stampInZone(next, TZ).includes('12:00'), 'the printable stamp carries the local time');
  eq(stampInZone(next, 'Not/AZone'), '', 'a bad zone stamps as empty, not as a crash');
}

// ── resolveSchedule ─────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T14:37:00Z');

  // Nothing reported: configured values fall back, MEASURED values stay null.
  const none = resolveSchedule(null, now);
  eq(none.reported, false, 'no block means not reported');
  eq(none.recapHour, 23, 'the recap hour falls back to the code default');
  eq(none.recapTz, 'America/Chicago', 'and so does the zone');
  eq(none.nextRecapSource, 'computed', 'the countdown is computed here');
  eq(none.nextRecapAtMs, Date.parse('2026-09-07T04:00:00Z'), 'and it is tonight at 23:00 CDT');
  eq(none.voiceCadenceMinutes, 120, 'cadence falls back');
  eq(none.voiceMinGapMs, 1_800_000, 'min gap falls back');
  eq(none.dawnEveryDays, 3, 'dawn cycle falls back');
  eq(none.ambientOnlineMinutes, null, 'banked minutes do NOT fall back to zero');
  eq(none.lastDawnDay, null, 'nor does the last dawn day');
  eq(none.relayCursor, null, 'nor does the relay cursor');
  eq(none.loopsEnabled, null, 'nor the loop gates');
  eq(none.intervalsReported, false, 'intervals are flagged as defaults, not as reported');
  eq(none.intervalsMs.relay, 15000, 'and the relay default is index.js POLL_INTERVAL_MS');
  eq(none.intervalsMs.milestones, 120000, 'and the milestones default is its own');
  eq(Object.keys(LOOP_INTERVAL_DEFAULTS_MS).length, 10, 'ten loop intervals are transcribed');
  eq(none.reportedAtMs, null, 'and there is no report time');

  // A full block: every value comes from the bot, and its own nextRecapAt wins.
  const full = resolveSchedule(
    {
      reportedAt: '2026-09-06T14:36:00Z',
      recapHour: 21,
      recapTz: 'Europe/Oslo',
      recapChannel: 'server',
      recapsStart: '2026-09-09',
      nextRecapAt: '2026-09-06T19:00:00Z',
      voiceCadenceMinutes: 90,
      voiceMinGapMs: 600000,
      dawnEveryDays: 2,
      ambientOnlineMinutes: 42.5,
      lastDawnDay: 15,
      relayCursor: '2026-09-01T14:44:49Z',
      loopsEnabled: { voice: true },
      intervalsMs: { relay: 15000 },
    },
    now,
  );
  eq(full.reported, true, 'a block means reported');
  eq(full.recapHour, 21, "the bot's hour wins");
  eq(full.recapTz, 'Europe/Oslo', "the bot's zone wins");
  eq(full.nextRecapSource, 'bot', "the bot's own next-recap instant is preferred");
  eq(full.nextRecapAtMs, Date.parse('2026-09-06T19:00:00Z'), 'and used verbatim');
  eq(full.ambientOnlineMinutes, 42.5, 'the measured accumulator comes through');
  eq(full.recapsStart, '2026-09-09', 'the launch gate comes through');
  eq(full.loopsEnabled.voice, true, 'the loop gates come through');
  eq(full.intervalsReported, true, 'and the intervals are flagged as the bot\'s own');
  eq(full.intervalsMs.relay, 15000, 'the reported relay interval wins');
  eq(full.intervalsMs.titles, 600000, 'and unreported keys still fall back to the defaults');
  eq(full.reportedAtMs, Date.parse('2026-09-06T14:36:00Z'), 'and the report time');

  // A block with a bad hour and an unusable next-recap stamp: fall back to the
  // default hour and recompute here rather than printing nothing.
  const partial = resolveSchedule({ recapHour: 99, nextRecapAt: 'not a date' }, now);
  eq(partial.recapHour, 23, 'an out-of-range hour falls back');
  eq(partial.nextRecapSource, 'computed', 'an unreadable bot stamp is recomputed');
  eq(partial.nextRecapAtMs, Date.parse('2026-09-07T04:00:00Z'), 'to the right instant');

  // An unusable zone: no countdown at all rather than a wrong one.
  const badZone = resolveSchedule({ recapTz: 'Not/AZone' }, now);
  eq(badZone.nextRecapSource, 'none', 'an unusable zone yields no source');
  eq(badZone.nextRecapAtMs, null, 'and no instant');

  // Zero and negative configured values fall back rather than meaning "instant".
  eq(resolveSchedule({ voiceCadenceMinutes: 0 }, now).voiceCadenceMinutes, 120, 'a zero cadence falls back');
  eq(resolveSchedule({ dawnEveryDays: -1 }, now).dawnEveryDays, 3, 'a negative dawn cycle falls back');
  // A min gap of zero is legitimate (VOICE_MIN_GAP_MS=0 disables the gap).
  eq(resolveSchedule({ voiceMinGapMs: 0 }, now).voiceMinGapMs, 0, 'a zero min gap is honoured, not overridden');
  eq(resolveSchedule({ voiceMinGapMs: -5 }, now).voiceMinGapMs, 1_800_000, 'a negative min gap falls back');
  eq(resolveSchedule({ ambientOnlineMinutes: 0 }, now).ambientOnlineMinutes, 0, 'a reported zero IS zero');
}

// ── minGapRemainingSec ──────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T14:00:00Z');
  eq(minGapRemainingSec('2026-09-06T13:50:00Z', 1_800_000, now), 1200, '20 minutes still owed');
  eq(minGapRemainingSec('2026-09-06T13:00:00Z', 1_800_000, now), 0, 'an old line owes nothing');
  eq(minGapRemainingSec(null, 1_800_000, now), 0, 'never having spoken is a clear gap');
  eq(minGapRemainingSec('2026-09-06T13:59:00Z', 0, now), 0, 'a disabled gap owes nothing');
  eq(minGapRemainingSec('not a date', 1_800_000, now), 0, 'an unreadable stamp is a clear gap');
  // A line queued in the future (clock skew) must not owe more than the gap.
  eq(minGapRemainingSec('2026-09-06T14:10:00Z', 1_800_000, now), 2400, 'a future stamp still bounded by the gap plus skew');
}

// ── nextDawnWorldDay ────────────────────────────────────────────────────────
{
  eq(DAWN_EVERY_DAYS_DEFAULT, 3, 'dawn fires every third world day');

  // Day 17 is not a dawn day: 18 is.
  const d17 = nextDawnWorldDay(17, null);
  eq(d17.day, 18, 'day 17 looks ahead to 18');
  eq(d17.isToday, false, 'and it is not today');
  eq(d17.daysAway, 1, 'one world day away');
  eq(d17.spokenToday, false, 'nothing was spoken today');

  // Day 18 with no dawn spoken: it is due now.
  const due = nextDawnWorldDay(18, 15);
  eq(due.day, 18, 'day 18 is itself the dawn day');
  eq(due.isToday, true, 'due today');
  eq(due.daysAway, 0, 'zero days away');

  // Day 18 already spoken: the next one is 21.
  const spoken = nextDawnWorldDay(18, 18);
  eq(spoken.day, 21, 'already spoken today, so the next is three days on');
  eq(spoken.spokenToday, true, 'and the page can say it already spoke');
  eq(spoken.isToday, false, 'not due again today');

  // A wipe puts the counter back to 1, which must restart the cycle.
  eq(nextDawnWorldDay(1, 18).day, 3, 'after a wipe the next dawn is day 3');
  // Day 0 never fires.
  eq(nextDawnWorldDay(0, null).day, 3, 'day 0 looks ahead to day 3');
  eq(nextDawnWorldDay(0, null).isToday, false, 'day 0 is never a dawn day itself');

  eq(nextDawnWorldDay(null, null), null, 'an unknown world day is null, not day 3');
  eq(nextDawnWorldDay(17, null, 0), null, 'a zero cycle is null rather than a divide by zero');
  eq(nextDawnWorldDay(17, null, 5).day, 20, 'the cycle length is configurable');
}

// ── ambientCadence ──────────────────────────────────────────────────────────
{
  eq(VOICE_CADENCE_MINUTES_DEFAULT, 120, 'one ambient line per 120 online minutes');
  eq(VOICE_MIN_GAP_MS_DEFAULT, 1_800_000, 'the global min gap defaults to 30 minutes');

  const unknown = ambientCadence(null);
  eq(unknown.state, 'unknown', 'no reported online minutes is unknown, never zero');
  eq(unknown.minutesAccumulated, null, 'and the accumulator is null');
  eq(unknown.minutesOwed, null, 'and nothing is claimed about what is owed');
  eq(unknown.ready, false, 'unknown is never ready');

  const mid = ambientCadence(45, 120, 0);
  eq(mid.state, 'accumulating', 'banked under the cadence is accumulating');
  eq(mid.minutesOwed, 75, '75 minutes still owed');
  eq(mid.ready, false, 'not ready');

  const held = ambientCadence(130, 120, 240);
  eq(held.state, 'held-by-gap', 'cadence met but the min gap is not clear');
  eq(held.minutesOwed, 0, 'nothing owed on the cadence');
  eq(held.blockedByGapSec, 240, 'and the gap seconds are carried through');

  const ready = ambientCadence(120, 120, 0);
  eq(ready.state, 'ready', 'exactly at the cadence with a clear gap is ready');
  eq(ready.ready, true, 'and says so');

  eq(ambientCadence(30, 0, 0).minutesOwed, 90, 'a zero cadence falls back to the default 120');
  eq(ambientCadence(-5, 120, -9).minutesAccumulated, 0, 'negative banked time floors at zero');
  eq(ambientCadence(-5, 120, -9).blockedByGapSec, 0, 'a negative gap floors at zero');
}

// ── relayDrain ────────────────────────────────────────────────────────────
{
  eq(RELAY_BATCH, 50, 'the relay reads 50 rows a tick');
  eq(RELAY_TICK_MS, 15_000, 'and ticks every 15 s');
  const now = Date.parse('2026-09-06T14:00:00Z');

  const noCursor = relayDrain(null, '2026-09-06T13:59:00Z', 3, now);
  eq(noCursor.state, 'unknown', 'no cursor is unknown, not idle');
  eq(noCursor.pending, null, 'and claims no pending count');

  const idle = relayDrain('2026-09-06T13:59:00Z', '2026-09-06T13:59:00Z', 0, now);
  eq(idle.state, 'idle', 'nothing pending is idle');
  eq(idle.behindSec, 0, 'and zero behind');

  const working = relayDrain('2026-09-06T13:58:00Z', '2026-09-06T13:59:00Z', 4, now);
  eq(working.state, 'working', 'a small backlog inside the window is working');
  eq(working.behindSec, 60, 'behind by the gap between cursor and newest row');
  eq(working.drainSec, 15, 'one batch drains in one 15 s tick');

  const bigBatch = relayDrain('2026-09-06T13:59:50Z', '2026-09-06T13:59:59Z', 51, now);
  eq(bigBatch.state, 'behind', 'more than one batch waiting is behind even when recent');
  eq(bigBatch.drainSec, 30, '51 rows is two ticks');

  const stale = relayDrain('2026-09-06T13:50:00Z', '2026-09-06T13:59:00Z', 2, now);
  eq(stale.state, 'behind', 'more than five minutes behind is behind');
  eq(stale.behindSec, 540, 'nine minutes behind');

  // A quiet hall: the cursor is old because nothing has been written, not
  // because the relay is late. Zero pending has to win over an old cursor.
  const quiet = relayDrain('2026-09-01T14:44:49Z', '2026-09-01T14:44:49Z', 0, now);
  eq(quiet.state, 'idle', 'a quiet hall is idle, not behind');
  near(quiet.cursorAgeSec, 429311, 60, 'and the cursor age says how long the hall has been quiet');
  eq(quiet.behindSec, 0, 'while behind-ness stays zero, because the two are different facts');
  eq(noCursor.cursorAgeSec, null, 'no cursor means no cursor age either');

  const noCount = relayDrain('2026-09-06T13:50:00Z', '2026-09-06T13:59:00Z', null, now);
  eq(noCount.state, 'behind', 'without a count the timestamps still say behind');
  eq(noCount.pending, null, 'and the count stays null rather than becoming zero');
  const noCountFresh = relayDrain('2026-09-06T13:59:30Z', '2026-09-06T13:59:59Z', null, now);
  eq(noCountFresh.state, 'working', 'without a count a fresh cursor is working, never idle');

  const noNewest = relayDrain('2026-09-06T13:50:00Z', null, null, now);
  eq(noNewest.state, 'unknown', 'a cursor with nothing to compare against is unknown');

  // The cursor can legitimately sit AHEAD of the newest row by a hair (the
  // relay stores a high-water mark verbatim). That must never be negative.
  const ahead = relayDrain('2026-09-06T14:00:05Z', '2026-09-06T14:00:00Z', 0, now);
  eq(ahead.behindSec, 0, 'a cursor ahead of the newest row is zero behind, never negative');
}

// ── upcomingDeeds ───────────────────────────────────────────────────────────
{
  const defs = [
    { id: 'kills-thousand', metric: 'kills_total', threshold: 1000, title: 'A Thousand Foes', line: '', sort: 40, achieved_at: null, announced_at: null, achieved_value: null, equivalence: null, meta: {} },
    { id: 'deaths-hundred', metric: 'deaths_total', threshold: 100, title: 'A Hundred Falls', line: '', sort: 10, achieved_at: null, announced_at: null, achieved_value: null, equivalence: null, meta: {} },
    { id: 'already', metric: 'kills_total', threshold: 10, title: 'First Blood', line: '', sort: 1, achieved_at: '2026-09-01T00:00:00Z', announced_at: null, achieved_value: 10, equivalence: null, meta: {} },
  ];
  const aggregates = { kills_total: 950, deaths_total: 12 };
  const out = upcomingDeeds(defs, aggregates, 8);
  eq(out.length, 2, 'achieved deeds are not upcoming');
  eq(out[0].id, 'kills-thousand', 'nearest the threshold comes first');
  eq(out[0].pct, 95, '95 percent of the way there');
  eq(out[0].remaining, 50, 'and needs 50 more');
  eq(out[0].remainingLabel, '50', 'the remainder is formatted for its metric');
  eq(out[0].metricLabel, 'Foes slain', 'the plain metric label rides along');
  eq(out[0].valueLabel, '950', 'the current value is formatted');
  eq(out[0].thresholdLabel, '1,000', 'and so is the threshold');
  eq(out[1].id, 'deaths-hundred', 'the further one comes second');
  eq(upcomingDeeds(defs, aggregates, 1).length, 1, 'the limit is honoured');
  eq(upcomingDeeds(defs, aggregates, 0).length, 0, 'a zero limit returns nothing');
  eq(upcomingDeeds([], {}, 8).length, 0, 'no definitions is an empty list, not a throw');

  // A metric with no aggregate scores zero rather than vanishing: a deed nobody
  // is measuring must still be visible as a deed nobody is measuring.
  const orphan = upcomingDeeds(
    [{ id: 'x', metric: 'not_a_metric', threshold: 5, title: 'X', line: '', sort: 1, achieved_at: null, announced_at: null, achieved_value: null, equivalence: null, meta: {} }],
    {},
    8,
  );
  eq(orphan.length, 1, 'an unmeasured deed is still listed');
  eq(orphan[0].pct, 0, 'at zero percent');
  eq(orphan[0].remaining, 5, 'needing the whole threshold');

  // A percent-typed deed: the live "The First Mile" case, where the hall average
  // is 0.3 percent of the map against a threshold of 1. Rounded to whole percent
  // (which is what the shared formatter does, correctly, for the Hall card) all
  // three numbers in the sentence collapse onto each other and the panel reads
  // "needs 1% more to reach 1%. Now at 0%".
  const pctDeed = upcomingDeeds(
    [{ id: 'first-mile', metric: 'explored_avg_pct', threshold: 1, title: 'The First Mile', line: '', sort: 1, achieved_at: null, announced_at: null, achieved_value: null, equivalence: null, meta: {} }],
    { explored_avg_pct: 0.3 },
    8,
  );
  eq(pctDeed[0].valueLabel, '0.3%', 'a fraction of a percent survives as a fraction');
  eq(pctDeed[0].thresholdLabel, '1.0%', 'the threshold is printed in the same register');
  eq(pctDeed[0].remainingLabel, '0.7%', 'and what is still owed is the real remainder');
  assert.notStrictEqual(
    pctDeed[0].remainingLabel,
    pctDeed[0].thresholdLabel,
    'what is needed never reads as the whole threshold when it is not',
  );
  eq(pctDeed[0].pct, 30, 'the percentage of the way there is unchanged');
}

// ── formatDeedValue ─────────────────────────────────────────────────────────
{
  // Percent metrics get one decimal here and nowhere else.
  eq(formatDeedValue('explored_avg_pct', 0), '0.0%', 'zero percent is still a percent');
  eq(formatDeedValue('explored_avg_pct', 0.25), '0.3%', 'rounded to one decimal, not to zero');
  eq(formatDeedValue('explored_avg_pct', 28.04), '28.0%', 'a whole-ish percent keeps its decimal');
  eq(formatDeedValue('explored_avg_pct', 50), '50.0%', 'and so does an exact one, for one register');

  // Everything else is left to lib/milestones, so a count, an hour total and a
  // distance read identically here and on the Hall card.
  eq(formatDeedValue('kills_total', 1000), '1,000', 'counts are unchanged');
  eq(formatDeedValue('playtime_total_hours', 82.4), '82 h', 'hours are unchanged');
  eq(formatDeedValue('walk_run_total', 250000), '250.0 km', 'distances are unchanged');
  eq(formatDeedValue('not_a_metric', 7), '7', 'an unknown metric still formats as a plain count');

  // A NaN can only arrive from a corrupt aggregate; it must not print "NaN%".
  eq(formatDeedValue('explored_avg_pct', Number.NaN), '0%', 'a NaN percent falls back, never prints NaN');
  eq(formatDeedValue('kills_total', Number.NaN), '0', 'and neither does a NaN count');
}

// ── titleContests ───────────────────────────────────────────────────────────
{
  const rows = [
    { name: 'Settled', incumbent: 'the Contented', stable: 'the Contented', raw: 'the Contented' },
    { name: 'Flipper', incumbent: 'Stonewright', stable: 'Bane of Beasts', raw: 'Bane of Beasts' },
    { name: 'Pushed', incumbent: 'the Far-Strider', stable: 'the Far-Strider', raw: 'Warden of the Longfire' },
    { name: 'Fresh', incumbent: null, stable: 'the Ever-Present', raw: 'the Ever-Present' },
    { name: 'Nothing', incumbent: null, stable: null, raw: null },
  ];
  const out = titleContests(rows);
  eq(out.length, 3, 'settled vikings and empty rows are dropped');
  eq(out[0].name, 'Flipper', 'flips sort first');
  eq(out[0].kind, 'flipping', 'a changed stable title is a flip');
  eq(out[1].name, 'Pushed', 'contests come after flips');
  eq(out[1].kind, 'contested', 'hysteresis holding the title is a contest');
  eq(out[2].kind, 'seed', 'a viking with no incumbent is a seed');

  // Whitespace-only titles are the same as absent, or a stray space would read
  // as a title change and the bot would appear to be about to announce nothing.
  const blank = titleContests([{ name: 'A', incumbent: '   ', stable: 'the Bold', raw: 'the Bold' }]);
  eq(blank[0].kind, 'seed', 'a blank incumbent is no incumbent');
  const same = titleContests([{ name: 'A', incumbent: 'the Bold', stable: '  the Bold  ', raw: 'the Bold' }]);
  eq(same.length, 0, 'padding does not make a title change');

  // Two flips sort alphabetically, so the strip does not reshuffle per render.
  const two = titleContests([
    { name: 'Zed', incumbent: 'a', stable: 'b', raw: 'b' },
    { name: 'Ann', incumbent: 'a', stable: 'b', raw: 'b' },
  ]);
  eq(two[0].name, 'Ann', 'ties break alphabetically');
}

// ── expiringSoon ────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T14:00:00Z');
  const rows = [
    { code: 'past', expires_at: '2026-09-06T13:00:00Z' },
    { code: 'soon', expires_at: '2026-09-06T15:00:00Z' },
    { code: 'sooner', expires_at: '2026-09-06T14:30:00Z' },
    { code: 'far', expires_at: '2026-09-09T00:00:00Z' },
    { code: 'broken', expires_at: 'not a date' },
    { code: 'missing', expires_at: null },
  ];
  const out = expiringSoon(rows, (r) => r.expires_at, now, 24 * 3_600_000);
  eq(out.length, 2, 'expired, unreadable and far-off rows are all dropped');
  eq(out[0].code, 'sooner', 'soonest first');
  eq(out[1].code, 'soon', 'then the next');
  // Exactly at the boundary counts as inside: a claim expiring in exactly 24 h
  // is the one an operator most wants to see.
  const edge = expiringSoon(rows, (r) => r.expires_at, now, Date.parse('2026-09-09T00:00:00Z') - now);
  eq(edge.length, 3, 'the far edge of the window is inclusive');
  eq(expiringSoon([], (r) => r.expires_at, now, 3600_000).length, 0, 'no rows is an empty list');
}

// ── nextWatchdogAlertAt ─────────────────────────────────────────────────────
{
  eq(
    nextWatchdogAlertAt('2026-09-06T13:40:41Z'),
    Date.parse('2026-09-06T19:40:41Z'),
    'six hours after the last alert',
  );
  eq(nextWatchdogAlertAt(null), null, 'a watchdog that has never posted has no window');
  eq(nextWatchdogAlertAt('not a date'), null, 'an unreadable stamp is null');
  eq(
    nextWatchdogAlertAt('2026-09-06T13:00:00Z', 1),
    Date.parse('2026-09-06T14:00:00Z'),
    'the re-alert window is configurable',
  );
  eq(
    nextWatchdogAlertAt('2026-09-06T13:00:00Z', 0),
    Date.parse('2026-09-06T19:00:00Z'),
    'a zero window falls back to six hours rather than saying "now"',
  );
}

// ── cadenceEta ──────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T14:16:00Z');
  const on = cadenceEta('2026-09-06T14:13:04Z', 300, now);
  eq(on.nextAtMs, Date.parse('2026-09-06T14:18:04Z'), 'five minutes after the last frame');
  near(on.untilSec, 124, 1, 'about two minutes out');
  eq(on.state, 'due-soon', 'a frame still inside its period is due soon');

  const late = cadenceEta('2026-09-06T13:00:00Z', 300, now);
  eq(late.state, 'overdue', 'more than one whole period late is overdue');
  ok(late.untilSec < 0, 'and the countdown has gone negative');

  // Exactly one period late is still jitter, not an outage.
  const edge = cadenceEta('2026-09-06T14:06:00Z', 300, now);
  eq(edge.state, 'due-soon', 'exactly one period late is not yet overdue');

  eq(cadenceEta(null, 300, now).state, 'unknown', 'no last run is unknown, not overdue');
  eq(cadenceEta('2026-09-06T14:13:04Z', 0, now).state, 'unknown', 'a zero cadence is unknown');
  eq(cadenceEta('2026-09-06T14:13:04Z', 300, now).untilSec > 0, true, 'a future frame counts down');
}

// ── nextBoss ────────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-09-06T14:00:00Z');
  const rows = [
    { name: 'Bonemass', sort_order: 3, is_killed: false, killed_at: null },
    { name: 'Eikthyr', sort_order: 1, is_killed: true, killed_at: '2026-08-28T03:49:34Z' },
    { name: 'The Elder', sort_order: 2, is_killed: false, killed_at: null },
  ];
  const out = nextBoss(rows, now);
  eq(out.next.name, 'The Elder', 'the lowest-ordered boss still standing is next');
  eq(out.lastFelled.name, 'Eikthyr', 'the most recent fall is named');
  eq(out.felled, 1, 'one felled');
  eq(out.total, 3, 'of three');
  near(out.sinceLastSec, 814226, 60, 'seconds since that fall');

  const allDown = nextBoss([{ name: 'A', sort_order: 1, is_killed: true, killed_at: '2026-09-01T00:00:00Z' }], now);
  eq(allDown.next, null, 'nothing standing means no next boss');
  const noneDown = nextBoss([{ name: 'A', sort_order: 1, is_killed: false, killed_at: null }], now);
  eq(noneDown.lastFelled, null, 'nothing felled means no last fall');
  eq(noneDown.sinceLastSec, null, 'and no elapsed time to print');
  eq(nextBoss([], now).total, 0, 'an empty table is zero of zero');
}

// ── mergeSchedule ───────────────────────────────────────────────────────────
{
  const items = [
    { id: 'c', label: 'C', atMs: 300, detail: '' },
    { id: 'a', label: 'A', atMs: null, detail: '' },
    { id: 'b', label: 'B', atMs: 100, detail: '' },
    { id: 'z', label: 'Z', atMs: null, detail: '' },
  ];
  const out = mergeSchedule(items);
  eq(out.map((i) => i.id).join(''), 'bcaz', 'timed items first in order, untimed last by id');
  eq(items[0].id, 'c', 'the input array is not mutated');
  const tie = mergeSchedule([
    { id: 'z', label: '', atMs: 100, detail: '' },
    { id: 'a', label: '', atMs: 100, detail: '' },
  ]);
  eq(tie[0].id, 'a', 'equal times break by id so the rail is stable');
}

// ── launch day ──────────────────────────────────────────────────────────────
{
  eq(LAUNCH_STEPS.length, 23, 'step 0 plus steps 1 to 22');
  eq(LAUNCH_STEPS[0].n, 0, 'the list starts at step 0');
  eq(LAUNCH_STEPS[22].n, 22, 'and ends at step 22');
  eq(LAUNCH_STEPS.filter((s) => s.checkedHere).length, 1, 'exactly one step is checkable here');

  // Nothing reported: every step is honestly not-visible, and step 20 says why.
  const dark = launchStepStates({ pilotOverridesReverted: null, preLaunchEventRows: null });
  eq(dark.length, 23, 'every step is graded');
  eq(dark.filter((s) => s.status === 'done').length, 0, 'nothing is claimed done on no evidence');
  eq(dark[20].status, 'not-visible', 'step 20 with no signal at all is not visible');

  // Pre-launch: the pilot world is still in the table and the overrides are set.
  const before = launchStepStates({ pilotOverridesReverted: false, preLaunchEventRows: 1234 });
  eq(before[20].status, 'open', 'step 20 is open before the cutover');
  ok(before[20].evidence.includes('1,234'), 'and the evidence carries the row count');
  ok(before[20].evidence.includes('channel overrides are still set'), 'and names the overrides');

  // After: reverted and wiped.
  const after = launchStepStates({ pilotOverridesReverted: true, preLaunchEventRows: 0 });
  eq(after[20].status, 'done', 'step 20 is done once both signals agree');

  // Half done is open, not done.
  const half = launchStepStates({ pilotOverridesReverted: true, preLaunchEventRows: 900 });
  eq(half[20].status, 'open', 'a reverted bot over an unwiped table is still open');

  const next3 = nextOpenSteps(dark, 3);
  eq(next3.length, 3, 'three steps come back');
  eq(next3[0].step.n, 0, 'starting with step 0');
  eq(next3[2].step.n, 2, 'through step 2');
  eq(nextOpenSteps(after, 3)[0].step.n, 0, 'a done step 20 does not change what is next at the top');
  eq(nextOpenSteps(dark, 0).length, 0, 'a zero limit returns nothing');
  // Done steps are skipped rather than shown greyed out in the "next" list.
  const nearlyDone = launchStepStates({ pilotOverridesReverted: true, preLaunchEventRows: 0 });
  ok(!nextOpenSteps(nearlyDone, 23).some((s) => s.step.n === 20), 'a done step is not listed as next');
}

// ── the countdown itself ────────────────────────────────────────────────────
{
  const launch = Date.parse('2026-09-09T22:30:00Z'); // 17:30 CDT, Session Zero
  const now = Date.parse('2026-09-06T14:37:00Z');
  near(launchCountdownSec(now, launch), 287580, 1, 'seconds to launch');
  ok(launchCountdownSec(launch + 1000, launch) < 0, 'past launch the countdown goes negative');

  eq(daysUntilInZone(now, launch, TZ), 3, 'three sleeps, counted on the calendar');
  // The naive division would say 2 here, which is the whole point: 23:00 on the
  // 8th to 01:00 on the 9th is 2 hours and one sleep, not zero days.
  eq(
    daysUntilInZone(Date.parse('2026-09-09T04:00:00Z'), Date.parse('2026-09-10T04:30:00Z'), TZ),
    1,
    'a two-hour gap that crosses local midnight is one day',
  );
  eq(daysUntilInZone(now, launch, 'Not/AZone'), null, 'a bad zone is null');
  eq(daysUntilInZone(launch, launch, TZ), 0, 'launch day itself is zero days out');
}

// ── launchMomentMs ──────────────────────────────────────────────────────────
{
  const runbook = Date.parse('2026-09-09T22:00:00Z'); // 17:00 CDT
  const gathering = '2026-09-09T22:30:00+00:00';      // the real Discord event

  const withEvent = launchMomentMs(gathering);
  eq(withEvent.source, 'gathering', 'a gathering on launch day wins');
  eq(withEvent.atMs, Date.parse(gathering), 'and is counted down to exactly');

  const none = launchMomentMs(null);
  eq(none.source, 'runbook', 'with no gathering the runbook hour is used');
  eq(none.atMs, runbook, "and that is 17:00 in the runbook's own zone");

  // A gathering on some other day is a raid night, not launch.
  const other = launchMomentMs('2026-09-12T23:00:00Z');
  eq(other.source, 'runbook', 'a gathering on another date is ignored');
  eq(other.atMs, runbook, 'and the runbook hour stands');

  eq(launchMomentMs('not a date').source, 'runbook', 'an unreadable stamp falls back');
  eq(launchMomentMs(gathering, 'Not/AZone').source, 'runbook', 'a bad zone cannot date-match');
  eq(launchMomentMs(null, 'Not/AZone').atMs, null, 'and then there is no instant at all');

  // The boundary: 23:59 local on launch day still counts, 00:00 the next day does not.
  eq(launchMomentMs('2026-09-10T04:59:00Z').source, 'gathering', '23:59 CDT on the 9th is launch day');
  eq(launchMomentMs('2026-09-10T05:00:00Z').source, 'runbook', '00:00 CDT on the 10th is not');

  // ── THE WHOLE LIST, NOT THE SOONEST ROW (regression, 2026-09-06) ──────────
  // getUpcomingEvents sorts ascending by start, so a rehearsal night scheduled
  // before the 9th used to push the launch gathering off index 0 and the panel
  // fell back to the runbook while claiming nothing was on the calendar.
  const rehearsal = '2026-09-08T23:00:00+00:00';
  const later = '2026-09-19T02:00:00+00:00';

  const scanned = launchMomentMs([rehearsal, gathering, later]);
  eq(scanned.source, 'gathering', 'the launch-day row is found behind an earlier one');
  eq(scanned.atMs, Date.parse(gathering), 'and it is the launch gathering that is counted down to');
  assert.notStrictEqual(scanned.atMs, Date.parse(rehearsal), 'never the rehearsal night');
  passed++;

  eq(launchMomentMs([rehearsal, later]).source, 'runbook', 'nothing on the 9th still falls back');
  eq(launchMomentMs([]).source, 'runbook', 'an empty list falls back');
  eq(launchMomentMs([null, undefined, 'not a date']).source, 'runbook', 'junk entries are skipped');

  // Several rows ON launch day: the earliest of them is the moment, because the
  // countdown is to the door opening, not to whatever was added last.
  const early = '2026-09-09T21:00:00+00:00';
  const twoOnTheDay = launchMomentMs([gathering, early]);
  eq(twoOnTheDay.atMs, Date.parse(early), 'the earliest launch-day row wins');
  eq(twoOnTheDay.source, 'gathering', 'and it is still sourced from the calendar');

  // A single string still works: the page passed one for its whole first life.
  eq(launchMomentMs(gathering).atMs, Date.parse(gathering), 'a bare string is still accepted');
}

// ── ymdStartMs: the recap launch gate, in the bot's zone and not in UTC ─────
{
  // services/discord-bot/src/index.js parses RECAPS_START as
  // `new Date(\`${RECAPS_START}T00:00:00\`)` with NO trailing Z, so Node reads it
  // in the host's local zone. The cockpit used to parse the same string with an
  // explicit Z, five to six hours earlier, and on the boundary day (which is
  // launch day) the page would have called the gate open while the bot still
  // held the recap silent.
  const chicagoMidnight = Date.parse('2026-09-09T05:00:00Z'); // 00:00 CDT, UTC-5
  eq(ymdStartMs('2026-09-09', TZ), chicagoMidnight, 'midnight is read in the zone, not in UTC');
  assert.notStrictEqual(
    ymdStartMs('2026-09-09', TZ),
    Date.parse('2026-09-09T00:00:00Z'),
    'and it is NOT the UTC midnight the old code used',
  );
  passed++;
  eq(
    ymdStartMs('2026-09-09', TZ) - Date.parse('2026-09-09T00:00:00Z'),
    5 * 3_600_000,
    'the skew the old code carried was five hours in September',
  );

  // Winter, so the other offset: America/Chicago is UTC-6 on standard time.
  eq(ymdStartMs('2026-01-15', TZ), Date.parse('2026-01-15T06:00:00Z'), 'CST midnight is UTC-6');

  // The DST days themselves. Spring forward 2026-03-08 (02:00 -> 03:00) and fall
  // back 2026-11-01 both start at a normal midnight; the shift is later in the day.
  eq(ymdStartMs('2026-03-08', TZ), Date.parse('2026-03-08T06:00:00Z'), 'spring-forward day starts at CST midnight');
  eq(ymdStartMs('2026-11-01', TZ), Date.parse('2026-11-01T05:00:00Z'), 'fall-back day starts at CDT midnight');

  eq(ymdStartMs('2026-09-09', 'UTC'), Date.parse('2026-09-09T00:00:00Z'), 'in UTC it is UTC midnight');

  // Everything that is not a date is null, never a number, so the caller shows
  // the configured string as text instead of a wrong comparison.
  eq(ymdStartMs(null, TZ), null, 'null is null');
  eq(ymdStartMs(undefined, TZ), null, 'undefined is null');
  eq(ymdStartMs('', TZ), null, 'an empty string is null');
  eq(ymdStartMs('2026-9-9', TZ), null, 'an unpadded date is rejected rather than guessed at');
  eq(ymdStartMs('2026-09-09T00:00:00Z', TZ), null, 'a full timestamp is not a bare date');
  eq(ymdStartMs('2026-13-01', TZ), null, 'month 13 is rejected');
  eq(ymdStartMs('2026-02-30', TZ), null, 'a day that does not exist does not roll into March');
  eq(ymdStartMs('2026-09-09', 'Not/AZone'), null, 'a bad zone is null');
  eq(ymdStartMs('  2026-09-09  ', TZ), chicagoMidnight, 'surrounding whitespace is trimmed');

  // The gate comparison itself, which is the only thing the panel does with it.
  const noonBefore = Date.parse('2026-09-08T17:00:00Z');
  const noonAfter = Date.parse('2026-09-09T17:00:00Z');
  ok(ymdStartMs('2026-09-09', TZ) > noonBefore, 'the day before, the gate is shut');
  ok(!(ymdStartMs('2026-09-09', TZ) > noonAfter), 'on the day itself, the gate is open');
  // The window the old UTC parse got wrong: 00:30 UTC on the 9th is still the
  // 8th in Chicago, so the gate must still read shut.
  const utcEarly = Date.parse('2026-09-09T00:30:00Z');
  ok(ymdStartMs('2026-09-09', TZ) > utcEarly, 'still shut at 00:30 UTC, which is 19:30 on the 8th in Chicago');
  ok(!(Date.parse('2026-09-09T00:00:00Z') > utcEarly), 'where the old UTC parse would have called it open');
}

// ── the defaults are the ones the bot actually uses ─────────────────────────
{
  eq(RECAP_HOUR_DEFAULT, 23, 'the evening recap defaults to 23:00');
  eq(RECAP_TZ_DEFAULT, 'America/Chicago', "and to the bot's own zone");
}

// ── maskClaimCode ───────────────────────────────────────────────────────────
{
  eq(maskClaimCode('K7QM2X'), 'K7****', 'a six-character rune keeps two and stars four');
  eq(maskClaimCode('AB'), '**', 'a two-character code keeps nothing');
  eq(maskClaimCode('A'), '*', 'a one-character code keeps nothing');
  eq(maskClaimCode(''), '(no code)', 'an empty code says so rather than rendering blank');
  eq(maskClaimCode(null), '(no code)', 'null says so');
  eq(maskClaimCode(undefined), '(no code)', 'and so does undefined');
  eq(maskClaimCode('ABCDEFGHIJ'), 'AB********', 'the mask length follows the code length');
  // The point of the whole exercise: the secret half must not survive.
  ok(!maskClaimCode('K7QM2X').includes('QM2X'), 'the redeemable half never appears');
  eq(maskClaimCode('K7QM2X').length, 6, 'the length is preserved, so a truncated code still looks wrong');
}

// ── the bot's own metrics.schedule block ────────────────────────────────────
//
// WHY A BOT FILE IS TESTED FROM lib/. This track's one bot change is
// services/discord-bot/src/heartbeat.js, and the bot's own `npm test` script
// names fifteen suites, none of them a heartbeat suite. Its package.json belongs
// to another track and is already carrying that track's uncommitted changes, so
// wiring a sixteenth suite there is out of bounds. The code is plain ESM whose
// only import is node:fs/promises, so it loads cleanly here and `npm test` picks
// it up with no wiring. Two hundred and forty new lines that run on every
// heartbeat of a live bot do not get to ship untested because of a file boundary.
//
// scheduleBlock() is READ ONLY: it reads a state file and process.env and
// returns an object. Nothing below writes anything or touches the network.
{
  const { scheduleBlock } = await import('../../services/discord-bot/src/heartbeat.js');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'eilif-heartbeat-'));
  const statePath = join(dir, 'state.json');
  const saved = { ...process.env };
  const setEnv = (vars) => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    // ── a fully populated state, the shape the live bot writes ──
    await writeFile(
      statePath,
      JSON.stringify({
        voice: { onlineMinutes: 42, ambientCount: 7, lastDawnDay: 15 },
        relay: {
          lastInsertedAt: '2026-09-01T14:44:49.449+00:00',
          lastEventAt: '2026-09-01T14:40:00.000+00:00',
          insertionFloor: '2026-08-01T00:00:00.000+00:00',
          lastInsertedIds: [1, 2, 3],
        },
      }),
      'utf8',
    );

    setEnv({
      TZ: 'America/Chicago',
      RECAP_EVENING_HOUR: '23',
      RECAP_CHANNEL: 'server',
      RECAPS_START: '2026-09-09',
      VOICE_MIN_GAP_MS: '1800000',
      VOICE_ENGINE: '1',
      EVENTS_SYNC: '1',
      BOSS_POLLS: undefined,
      WEEKLY_CHRONICLE: undefined,
      TITLES_INTERVAL_MS: '600000',
      MILESTONES_INTERVAL_MS: '60000',
    });

    const now = Date.parse('2026-09-06T15:00:00Z');
    const b = await scheduleBlock(now, statePath);

    ok(b !== null, 'a readable state yields a block');
    eq(b.reportedAt, new Date(now).toISOString(), 'the block stamps when it was computed');
    eq(b.recapHour, 23, 'the recap hour comes from RECAP_EVENING_HOUR');
    eq(b.recapTz, 'America/Chicago', 'and the zone from TZ');
    eq(b.recapChannel, 'server', 'the pilot channel override is reported so step 20b is checkable');
    eq(b.recapsStart, '2026-09-09', 'RECAPS_START is reported verbatim');
    eq(b.ambientOnlineMinutes, 42, 'the banked ambient minutes come out of state.json');
    eq(b.ambientCount, 7, 'so does the ambient counter');
    eq(b.lastDawnDay, 15, 'and the last dawn world day');
    eq(b.relayCursor, '2026-09-01T14:44:49.449+00:00', 'the cursor prefers lastInsertedAt');
    eq(b.relayLastEventAt, '2026-09-01T14:40:00.000+00:00', 'lastEventAt is reported alongside it');
    eq(b.relayHeldIds, 3, 'held ids are counted, never listed');
    eq(b.voiceCadenceMinutes, VOICE_CADENCE_MINUTES_DEFAULT, 'the cadence matches the constant the cockpit falls back to');
    eq(b.voiceMinGapMs, VOICE_MIN_GAP_MS_DEFAULT, 'so does the min gap');
    eq(b.dawnEveryDays, DAWN_EVERY_DAYS_DEFAULT, 'and the dawn cycle');
    eq(b.loopsEnabled.voice, true, 'VOICE_ENGINE=1 reads as on');
    eq(b.loopsEnabled.bossPolls, false, 'an unset BOSS_POLLS reads as off');
    eq(b.loopsEnabled.titles, true, 'TITLES_ANNOUNCE defaults to on');
    eq(b.intervalsMs.milestones, 60000, 'an env interval overrides the repo default');
    eq(b.intervalsMs.titles, LOOP_INTERVAL_DEFAULTS_MS.titles, 'and an unset one matches it');
    eq(b.chronicleEnabled, false, 'the weekly chronicle is off unless WEEKLY_CHRONICLE=1');

    // NO SECRETS. Every string in the block is a name, a zone or a stamp.
    const flat = JSON.stringify(b);
    ok(!/eyJ/.test(flat), 'no JWT-shaped string reaches the block');
    ok(!/[A-Za-z0-9+/_-]{40,}/.test(flat), 'and no long opaque token either');

    // ── the cursor falls back to lastEventAt when the newer field is absent ──
    await writeFile(statePath, JSON.stringify({ relay: { lastEventAt: '2026-09-01T14:40:00.000+00:00' } }), 'utf8');
    const b2 = await scheduleBlock(now, statePath);
    eq(b2.relayCursor, '2026-09-01T14:40:00.000+00:00', 'the cursor falls back to lastEventAt');
    eq(b2.relayLastInsertedAt, null, 'and says so by leaving lastInsertedAt null');

    // ── ABSENCE IS NULL, NEVER ZERO. This is the rule the whole tab rests on ──
    await writeFile(statePath, JSON.stringify({}), 'utf8');
    const b3 = await scheduleBlock(now, statePath);
    eq(b3.ambientOnlineMinutes, null, 'a state with no voice section reports null minutes, not 0');
    eq(b3.lastDawnDay, null, 'and null for the last dawn day');
    eq(b3.relayCursor, null, 'and null for the cursor');
    eq(b3.ambientCount, null, 'and null for the ambient count');

    // ── a torn, missing or hostile state file never breaks the heartbeat ──
    await writeFile(statePath, '{not json at all', 'utf8');
    const torn = await scheduleBlock(now, statePath);
    ok(torn !== null, 'a corrupt state file still produces a block');
    eq(torn.ambientOnlineMinutes, null, 'with nulls where the file should have been');
    eq(torn.recapHour, 23, 'and the env-derived half intact');

    const missing = await scheduleBlock(now, join(dir, 'no-such-file.json'));
    ok(missing !== null, 'a missing state file still produces a block');
    eq(missing.relayCursor, null, 'with a null cursor');

    await writeFile(statePath, JSON.stringify([1, 2, 3]), 'utf8');
    const arr = await scheduleBlock(now, statePath);
    eq(arr.lastDawnDay, null, 'a JSON array where an object belongs is ignored, not indexed');

    await writeFile(statePath, JSON.stringify({ voice: 'not an object', relay: 42 }), 'utf8');
    const wrongTypes = await scheduleBlock(now, statePath);
    eq(wrongTypes.ambientOnlineMinutes, null, 'a string where the voice object belongs yields null');
    eq(wrongTypes.relayCursor, null, 'a number where the relay object belongs yields null');

    await writeFile(
      statePath,
      JSON.stringify({ voice: { onlineMinutes: 'lots', lastDawnDay: null }, relay: { lastInsertedAt: 17 } }),
      'utf8',
    );
    const wrongFields = await scheduleBlock(now, statePath);
    eq(wrongFields.ambientOnlineMinutes, null, 'a non-numeric minute count is null, never NaN');
    eq(wrongFields.relayCursor, null, 'a non-string cursor is null');

    // ── an out-of-range or unparseable RECAP_EVENING_HOUR falls back to 23 ──
    await writeFile(statePath, JSON.stringify({}), 'utf8');
    setEnv({ TZ: 'America/Chicago', RECAP_EVENING_HOUR: '99' });
    eq((await scheduleBlock(now, statePath)).recapHour, 23, 'hour 99 falls back to 23');
    setEnv({ TZ: 'America/Chicago', RECAP_EVENING_HOUR: 'evening' });
    eq((await scheduleBlock(now, statePath)).recapHour, 23, 'an unparseable hour falls back to 23');
    setEnv({ TZ: 'America/Chicago', RECAP_EVENING_HOUR: '0' });
    eq((await scheduleBlock(now, statePath)).recapHour, 0, 'but midnight is a real hour and survives');

    // ── a zone Intl rejects yields no instant rather than a wrong one ──
    setEnv({ TZ: 'Not/AZone', RECAP_EVENING_HOUR: '23' });
    const badZone = await scheduleBlock(now, statePath);
    eq(badZone.nextRecapAt, null, 'an unusable zone gives no next-recap instant');
    eq(badZone.recapTz, 'Not/AZone', 'and reports the zone it was given, so the cockpit can say why');

    // ── THE DST SWEEP ────────────────────────────────────────────────────────
    // The bot computes nextRecapAt with its own private copy of the daily-cron
    // maths (nextDailyIso, not exported). nextCronRun in this file is the tested
    // one. Sweep them against each other across both 2026 transitions in
    // America/Chicago: every result must be identical, strictly in the future,
    // and land on the requested wall-clock hour.
    setEnv({ TZ: 'America/Chicago', RECAP_EVENING_HOUR: '23' });
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    });
    let sweep = 0;
    let mismatches = 0;
    const start = Date.parse('2026-02-01T00:00:00Z');
    for (const hour of [0, 3, 17, 23]) {
      process.env.RECAP_EVENING_HOUR = String(hour);
      for (let d = 0; d < 400; d++) {
        for (const h of [1, 7, 13, 19]) {
          const at = start + d * 86_400_000 + h * 3_600_000;
          const mine = nextCronRun(at, hour, TZ);
          const bots = (await scheduleBlock(at, statePath)).nextRecapAt;
          sweep++;
          if (mine === null || bots === null || Date.parse(bots) !== mine) { mismatches++; continue; }
          if (mine <= at) { mismatches++; continue; }
          if (fmt.format(new Date(mine)) !== `${String(hour).padStart(2, '0')}:00`) mismatches++;
        }
      }
    }
    eq(mismatches, 0, `the bot's private cron maths matches the tested one across ${sweep} instants including both 2026 DST transitions`);
    ok(sweep === 6400, 'and the sweep really ran every case');
  } finally {
    setEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`horizon.test.mjs: ${passed} assertions passed`);
