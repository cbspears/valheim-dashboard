// Unit tests for the DURABLE playtime helper that the title engine ranks the
// "hours" superlative on. Run: npx tsx lib/data.playtime.test.mjs
//
// The point of the durable value (vs the live-elapsed playtimeMinutesByCharacter)
// is that it is MONOTONIC and ONLINE-INDEPENDENT: it sums only closed sessions
// (those with a recorded duration_minutes) and never credits an open session with
// joined_at->now, so the hours leader can't churn as people log on and off — the
// root of the "the Ever-Present" flip on launch night.
import { durablePlaytimeMinutesByCharacter } from './data.ts';
import assert from 'node:assert';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// ── The value does NOT decrease when a player logs off ────────────────────────
{
  // WHILE ONLINE: two closed sessions (100 + 58) plus one still-open session
  // (duration_minutes null — the live session). Durable counts only the closed
  // ones; the open session contributes nothing, so there is no live-elapsed jitter.
  const online = [
    { character_name: 'Rosir', joined_at: iso(600), left_at: iso(500), duration_minutes: 100 },
    { character_name: 'Rosir', joined_at: iso(300), left_at: iso(242), duration_minutes: 58 },
    { character_name: 'Rosir', joined_at: iso(760), left_at: null, duration_minutes: null },
  ];
  const whileOnline = durablePlaytimeMinutesByCharacter(online).get('Rosir');
  ok(whileOnline === 158, `durable = sum of CLOSED sessions only, ignoring the open one, got ${whileOnline}`);

  // AFTER LOGOFF: the poller closes that session, stamping its duration (760 min).
  // Durable now steps UP by the session's length — it never ticks down at logoff.
  const afterLogoff = online.map((s) =>
    s.duration_minutes == null ? { ...s, left_at: iso(0), duration_minutes: 760 } : s
  );
  const afterValue = durablePlaytimeMinutesByCharacter(afterLogoff).get('Rosir');
  ok(afterValue === 918, `closing the live session adds its full duration, got ${afterValue}`);
  ok(afterValue >= whileOnline, `durable playtime is monotonic across a logoff (${afterValue} >= ${whileOnline})`);
}

// ── Online-independent: the same rows yield the same number regardless of who is
// "online", because the helper takes no online set at all. ─────────────────────
{
  const rows = [
    { character_name: 'A', joined_at: iso(200), left_at: iso(140), duration_minutes: 60 },
    { character_name: 'A', joined_at: iso(100), left_at: null, duration_minutes: null }, // open
    { character_name: 'B', joined_at: iso(300), left_at: iso(220), duration_minutes: 80 },
  ];
  const m = durablePlaytimeMinutesByCharacter(rows);
  ok(m.get('A') === 60, `A's open session never inflates the total, got ${m.get('A')}`);
  ok(m.get('B') === 80, `B counts its one closed session, got ${m.get('B')}`);
  // Rows with no closed session at all simply don't appear (the caller falls back
  // to the persisted column / 0).
  const onlyOpen = durablePlaytimeMinutesByCharacter([
    { character_name: 'C', joined_at: iso(50), left_at: null, duration_minutes: null },
  ]);
  ok(!onlyOpen.has('C'), `a viking with only an open session yields no durable minutes, got ${onlyOpen.get('C')}`);
}

console.log(`data.playtime.test: ${passed} assertions passed`);
