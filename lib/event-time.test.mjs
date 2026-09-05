// Tests for the producer-timestamp clamp (lib/event-time.ts) and for the two
// unauthenticated death paths that now go through it.
//
// THE BUG THIS GUARDS AGAINST (red-team, 2026-09-05). /api/gs-ingest accepts
// `source:'client'` and `source:'eilif-death'` with NO token — the mod runs on
// players' PCs and cannot hold a secret, and the POST URL ships in the public
// Thunderstore pack. The only gates are the world name (public) and a presence
// check on a character name (also public: /api/status currentPlayers, /players).
// Both death parsers then validated `tsUtc` with nothing but `Date.parse`, and
// the value went verbatim into `events.created_at`. One anonymous POST dated
// 2999-01-01, naming any online viking, therefore:
//
//   • froze the #server Discord relay forever — its cursor IS created_at and
//     only moves forward, so `.gt(created_at, cursor)` never matched again;
//   • counted in every daily recap from then on (the death query was gte-only),
//     inflating the Fallen board and the "The Bold" Player-of-the-Day tally.
//
// Recovery needed hand-editing the bot's state.json AND deleting the row.
//
// Run: npx tsx lib/event-time.test.mjs
import assert from 'node:assert';
import {
  FUTURE_EVENT_TOLERANCE_MS,
  clampEventTime,
  clampEventTimeIso,
  isFutureBeyondTolerance,
} from './event-time.ts';
import { parseEilifDeath, ingestEilifDeath, ingestDeathEvents } from './deaths.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed++; };

const NOW = Date.parse('2026-09-09T20:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

// ── 1. the clamp itself ──────────────────────────────────────────────────────
{
  // A past time is honest data and is left exactly alone: backfills, replayed
  // log batches and late reports are all legitimate, and a past-dated row can
  // only ever be skipped by a cursor, never freeze one.
  const past = '2026-09-09T19:00:00.000Z';
  const c = clampEventTime(past, NOW);
  eq(c.iso, past, 'a past timestamp is stored verbatim');
  eq(c.clamped, false, 'and is not reported as clamped');
  eq(c.claimedIso, null, 'with nothing to log');
}
{
  // Inside the tolerance: an ordinary PC clock running a minute fast is still
  // telling the truth about a death that really happened.
  const near = new Date(NOW + 60_000).toISOString();
  const c = clampEventTime(near, NOW);
  eq(c.iso, near, 'a clock a minute fast is believed');
  eq(c.clamped, false, 'and not flagged');
}
{
  // The boundary, from both sides.
  eq(clampEventTime(new Date(NOW + FUTURE_EVENT_TOLERANCE_MS).toISOString(), NOW).clamped, false,
    'exactly at the tolerance is still accepted');
  eq(clampEventTime(new Date(NOW + FUTURE_EVENT_TOLERANCE_MS + 1).toISOString(), NOW).clamped, true,
    'one millisecond past it is not');
}
{
  // THE ATTACK.
  const c = clampEventTime('2999-01-01T00:00:00.000Z', NOW);
  eq(c.iso, NOW_ISO, 'a far-future timestamp is pulled back to now');
  eq(c.clamped, true, 'and reported as clamped');
  eq(c.claimedIso, '2999-01-01T00:00:00.000Z', 'with what the producer actually claimed, for the log');
}
{
  // Junk is "now", not a throw and not a NaN date that Postgres would 22007 on.
  for (const bad of [null, undefined, '', 'not-a-date', NaN, {}, []]) {
    eq(clampEventTime(bad, NOW).iso, NOW_ISO, `unparseable input ${JSON.stringify(bad) ?? 'undefined'} → now`);
  }
  eq(clampEventTime(new Date(NOW - 1000), NOW).iso, new Date(NOW - 1000).toISOString(), 'a Date is accepted');
  eq(clampEventTime(NOW - 1000, NOW).iso, new Date(NOW - 1000).toISOString(), 'so are epoch milliseconds');
  eq(clampEventTimeIso('2999-01-01T00:00:00.000Z', NOW), NOW_ISO, 'the ISO-only helper clamps identically');
  eq(isFutureBeyondTolerance(NOW + FUTURE_EVENT_TOLERANCE_MS + 1, NOW), true, 'the predicate agrees');
  eq(isFutureBeyondTolerance(NOW, NOW), false, 'and "now" is not the future');
}

// ── 2. parseEilifDeath refuses to date a death in the future ─────────────────
{
  const body = { player: 'Bren', reporter: 'Bren', tsUtc: '2999-01-01T00:00:00Z', hitType: 'Fall' };
  const p = parseEilifDeath(body);
  ok(p !== null, 'the report is still accepted — a skewed clock must not cost a real death');
  ok(Date.parse(p.occurredIso) <= Date.now() + FUTURE_EVENT_TOLERANCE_MS, 'but it is not stored in the future');
  eq(p.clampedFromIso, '2999-01-01T00:00:00.000Z', 'and the claim is carried for the ops log');
  // The dedupe key stays the RAW tsUtc — it is what the other two producers key
  // on, and clamping it would make every ~120s re-post look like a new death.
  eq(p.key, 'Bren|2999-01-01T00:00:00Z', 'the cross-producer dedupe key is unchanged');
  eq(p.metadata.eilifDeathId, 'Bren|2999-01-01T00:00:00Z', 'and so is the stored id');

  // parseEilifDeath clamps against the real clock, so the honest case is dated
  // a minute ago rather than at a fixed calendar date this test would outlive.
  const honestIso = new Date(Date.now() - 60_000).toISOString();
  const honest = parseEilifDeath({ ...body, tsUtc: honestIso });
  eq(honest.clampedFromIso, null, 'an honest report is not flagged');
  eq(honest.occurredIso, honestIso, 'and keeps its own time exactly');
}

// ── 3. …end to end, through the real ingest ──────────────────────────────────
// A minimal Supabase stub: enough of the builder chain for ingestEilifDeath and
// ingestDeathEvents to run, recording the rows they insert.
function makeDb() {
  const inserted = [];
  const chain = (result) => {
    const c = {
      select: () => c, eq: () => c, in: () => c, gte: () => c, lte: () => c,
      is: () => c, not: () => c, or: () => c, neq: () => c,
      order: () => c, limit: () => c, maybeSingle: async () => ({ data: null }),
      then: (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return c;
  };
  return {
    inserted,
    // No ingest_death() function here, so both paths take the documented
    // select-then-insert fallback — the same rows, one more round trip.
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }),
    from(table) {
      if (table === 'players') return chain({ data: [{ id: 'p1', character_name: 'Bren' }] });
      return {
        select: () => chain({ data: [] }),
        // Both paths insert; the gs one batches, so flatten to "rows written".
        insert: async (row) => {
          for (const r of Array.isArray(row) ? row : [row]) inserted.push(r);
          return { data: null, error: null };
        },
        update: () => chain({ data: [] }),
        // The gs path sweeps superseded poller rows after inserting.
        delete: () => chain({ data: [] }),
      };
    },
  };
}

{
  const db = makeDb();
  const res = await ingestEilifDeath(db, {
    player: 'Bren', reporter: 'Bren', tsUtc: '2999-01-01T00:00:00Z', hitType: 'Fall',
  });
  ok(res.ok, 'the forged-clock death is still recorded');
  eq(db.inserted.length, 1, 'exactly one row');
  ok(Date.parse(db.inserted[0].created_at) <= Date.now() + FUTURE_EVENT_TOLERANCE_MS,
    'and created_at — the relay cursor and the recap window key — is NOT in the future');
}
{
  const db = makeDb();
  await ingestDeathEvents(
    db,
    [{ playerName: 'Bren', tsUtc: '2999-01-01T00:00:00Z', killer: 'Greydwarf' }],
    'Bren',
  );
  eq(db.inserted.length, 1, 'the gs deathEvents path inserts its row too');
  ok(Date.parse(db.inserted[0].created_at) <= Date.now() + FUTURE_EVENT_TOLERANCE_MS,
    'and it is clamped by the same rule — a fix on one path only would leave this door open');
}

console.log(`event-time.test: ${passed} assertions passed`);
