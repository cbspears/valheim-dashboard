// Tests for the join/leave bookkeeping lifted out of /api/webhook (§2h, §5).
//
// The rule these encode: a REPLAY must be swallowed, a real re-join must not.
// The log poller redelivers its whole batch on any failed call, so both cases
// arrive on the same endpoint minutes apart during one bad tick.
//
//   npx tsx lib/webhook/presence.test.mjs

import {
  REJOIN_GRACE_MS,
  shouldReplayGuard,
  isSameJoin,
  sessionDurationMinutes,
  planJoinSession,
} from './presence.ts';

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

const T0 = Date.parse('2026-09-09T20:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

console.log('\nREJOIN_GRACE_MS - the near-miss window');
eq(REJOIN_GRACE_MS, 60_000, 'one minute, matching the handler it came from');

console.log('\nshouldReplayGuard - which events are checked at all');
ok(shouldReplayGuard('join', 'Loa'), 'a named join is guarded');
ok(shouldReplayGuard('leave', 'Loa'), 'a named leave is guarded');
ok(!shouldReplayGuard('death', 'Loa'), 'death is not - it has its own +/-3 min dedupe');
ok(!shouldReplayGuard('oath', 'Loa'), 'oath is not - it replaces by design');
ok(!shouldReplayGuard('chat', 'Loa'), 'chat is not');
ok(!shouldReplayGuard('join', null), 'an unnamed join cannot be matched, so it is not guarded');
ok(!shouldReplayGuard('join', ''), 'nor an empty name');

console.log('\nisSameJoin - is the open session this very join?');
ok(isSameJoin(T0, iso(T0)), 'the identical timestamp is the same join');
ok(isSameJoin(T0, iso(T0 - 59_000)), '59 s earlier is still the same join');
ok(isSameJoin(T0, iso(T0 + 59_000)), 'and 59 s later (a retry can drift either way)');
ok(isSameJoin(T0, iso(T0 - 60_000)), 'exactly 60 s is inside the grace (<=)');
ok(!isSameJoin(T0, iso(T0 - 61_000)), '61 s earlier is a REAL second arrival');
ok(
  !isSameJoin(T0, iso(T0 - 3600_000)),
  'an hour-old open session is a genuine re-join, never suppressed'
);
ok(!isSameJoin(T0, null), 'no open session at all is not the same join');
ok(!isSameJoin(T0, undefined), 'nor an absent one');
ok(!isSameJoin(T0, ''), 'nor an empty timestamp');
ok(
  !isSameJoin(T0, 'not a date'),
  'an unparseable joined_at opens a session rather than swallowing one'
);
ok(isSameJoin(T0, iso(T0 + 5000), 10_000), 'the grace is tunable for callers that want a tighter one');
ok(!isSameJoin(T0, iso(T0 + 5000), 1000), 'and a tighter grace really does reject');

console.log('\nsessionDurationMinutes - closing a session');
eq(sessionDurationMinutes(iso(T0), T0 + 90 * 60_000), 90, 'a 90 minute session');
eq(sessionDurationMinutes(iso(T0), T0), 0, 'a zero-length session is 0, not negative');
eq(sessionDurationMinutes(iso(T0), T0 + 29_000), 0, '29 s rounds down to 0 minutes');
eq(sessionDurationMinutes(iso(T0), T0 + 30_000), 1, '30 s rounds up to 1 minute');
eq(sessionDurationMinutes(iso(T0), T0 + 89_000), 1, '89 s is 1 minute');
eq(sessionDurationMinutes(iso(T0), T0 + 91_000), 2, '91 s is 2 minutes');
eq(
  sessionDurationMinutes(iso(T0), T0 - 10 * 60_000),
  0,
  'a leave that predates its join clamps to 0, never a negative playtime'
);
ok(
  Number.isNaN(sessionDurationMinutes('not a date', T0)),
  'an unparseable joined_at yields NaN, which the client stores as a null duration'
);

console.log('\nplanJoinSession - what the join branch does about sessions');
{
  const open = (joinedAtMs, id = 'sess-1') => ({ id, joined_at: iso(joinedAtMs) });
  const plan = (o) =>
    planJoinSession({ occurredAtMs: T0, openSession: o.openSession ?? null, identityMismatch: !!o.mismatch });

  // 1. Nothing open: the ordinary first join of the evening.
  eq(plan({}).action, 'open', 'no open session -> just open one');

  // 2. The replay guard's near-miss half still wins, and still touches nothing.
  const replay = plan({ openSession: open(T0 - 30_000) });
  eq(replay.action, 'skip', 'a join 30 s after an open session is the same join');
  eq(replay.reason, 'replay', 'and it is reported as a replay');

  // 3. THE BUG. A genuine second join while a session is still open used to
  //    insert a second one and abandon the first forever.
  const stale = plan({ openSession: open(T0 - 355 * 60_000, 'ulf-real') });
  eq(stale.action, 'close-then-open', 'a stale open session is CLOSED, then a new one opened');
  eq(stale.closeSessionId, 'ulf-real', 'the stale row is named');
  eq(stale.durationMinutes, 355, 'and closed with the leave branch arithmetic');

  eq(
    plan({ openSession: open(T0 - 61_000) }).action,
    'close-then-open',
    '61 s - one second past the grace - is a real second arrival, not a replay'
  );
  eq(
    plan({ openSession: open(T0 - 60_000) }).action,
    'skip',
    'and 60 s exactly is still inside it'
  );

  // 4. An impostor: presence is recorded by the caller, but no session is
  //    credited to the viking whose name was taken - and the real viking's own
  //    open session is NOT closed, because they are very likely still playing.
  const imp = plan({ openSession: open(T0 - 355 * 60_000, 'ulf-real'), mismatch: true });
  eq(imp.action, 'skip', 'a flagged join opens no session');
  eq(imp.reason, 'identity-mismatch', 'and says why');
  eq(
    plan({ mismatch: true }).action,
    'skip',
    'even with nothing open at all - an impostor never gets a session'
  );

  // 5. A replay of a flagged join is still a replay first: it must not be
  //    reported as an impostor decision the second time round.
  eq(
    plan({ openSession: open(T0 - 30_000), mismatch: true }).reason,
    'replay',
    'a redelivered flagged join is a replay, not a fresh impostor'
  );

  // 6. Garbage in the open row must not fabricate a close.
  eq(
    planJoinSession({ occurredAtMs: T0, openSession: { id: 'x', joined_at: '' }, identityMismatch: false }).action,
    'open',
    'an open row with no joined_at is not something we can close honestly'
  );
  ok(
    Number.isNaN(
      planJoinSession({
        occurredAtMs: T0,
        openSession: { id: 'x', joined_at: 'not a date' },
        identityMismatch: false,
      }).durationMinutes
    ),
    'an unparseable joined_at closes with a null duration, never an invented one'
  );
}

console.log(
  failures === 0
    ? '\nwebhook/presence: all checks passed\n'
    : `\nwebhook/presence: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
