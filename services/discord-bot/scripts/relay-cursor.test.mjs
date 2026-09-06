// The #server relay's cursor: insertion order, not producer time.
//
// THE BUG (found by the launch rehearsal, 2026-09-06 — `join 20/20 · leave 0/20
// · death 2/3 — 21 of 43 feed rows NEVER POSTED, silently`).
//
// The relay cursored on `events.created_at`, which is PRODUCER-supplied and is
// not insertion order:
//
//   • the log poller stamps a join/leave with the LOG LINE's time and ships it
//     on its next 20 s SFTP poll, so its rows land 20-30 s after the instant
//     they claim;
//   • gs-ingest (client deaths, boss kills, Great Deeds) and the bot's own rows
//     land with created_at = real now.
//
// A client death at 12:00:00 relayed at 12:00:05 parked the cursor at 12:00:00.
// The poller then wrote a leave stamped 11:59:50 at 12:00:08.
// `.gt('created_at', '12:00:00')` never matched it. Gone from #server forever,
// and silently — a tick that posts nothing is a success, so every health signal
// stayed green. The rehearsal saw twenty joins and zero leaves.
//
// The fix is db/2026-09-06_events_inserted_at.sql plus src/relay.js: cursor on
// `inserted_at` (the database's own now() at INSERT, which no producer can
// supply), tie-break on created_at, and carry the ids already relayed at the
// cursor's exact timestamp so a shared `now()` inside one transaction cannot
// skip the second row of a pair.
//
// Run:
//   node scripts/relay-cursor.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { createRelay } from '../src/relay.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const iso = (ms) => new Date(ms).toISOString();
// One evening, anchored a day in the PAST so nothing here trips the relay's
// own future-cursor repair, and so every ISO string sorts lexicographically the
// way PostgREST orders them.
const T = Date.now() - 24 * 3600 * 1000;
const atMs = (ms) => iso(T + ms);
const at = (secs) => atMs(secs * 1000);
const ago = (ms) => iso(Date.now() - ms);

const row = (o) => ({ metadata: {}, ...o });
const join = (id, name, created_at, inserted_at) =>
  row({ id, type: 'join', character_name: name, created_at, inserted_at });
const leave = (id, name, created_at, inserted_at) =>
  row({ id, type: 'leave', character_name: name, created_at, inserted_at });
const death = (id, name, created_at, inserted_at) =>
  row({ id, type: 'death', character_name: name, created_at, inserted_at, metadata: { cause: 'Neck' } });

// A fake `events` table that applies the filters, the ordering AND the limit
// literally, so a wrong query is a failing test rather than a stub that answers
// the same either way. Every fixture timestamp comes from toISOString(), so
// lexicographic order is chronological order.
//
// `hasInsertedAt: false` models the database BEFORE the migration: PostgREST
// answers any reference to the column with SQLSTATE 42703.
// Postgres compares timestamptz as a POINT IN TIME at microsecond resolution,
// which is not what `String(a) < String(b)` does once a fixture carries the
// microseconds and the `+00:00` offset PostgREST actually sends. Comparing on
// this key is what lets the fixtures below use real PostgREST-shaped values.
function micros(ts) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(String(ts));
  if (!m) throw new Error(`fixture is not a PostgREST timestamp: ${ts}`);
  return BigInt(Date.parse(`${m[1]}${m[3]}`)) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0').slice(0, 6));
}
const cmpTs = (a, b) => (micros(a) < micros(b) ? -1 : micros(a) > micros(b) ? 1 : 0);

function fakeEvents(rows, { hasInsertedAt = true, tieBreak = 'reverse' } = {}) {
  const migrated = () => (typeof hasInsertedAt === 'function' ? hasInsertedAt() : hasInsertedAt);
  const seen = { limits: [], queries: 0, cursors: [] };
  const db = {
    seen,
    from(table) {
      if (table !== 'events') throw new Error(`unexpected table ${table}`);
      const filters = [];
      const orders = [];
      const cols = [];
      let lim = Infinity;
      const q = {
        select: () => q,
        gt: (c, v) => { cols.push(c); filters.push((r) => cmpTs(r[c], v) > 0); return q; },
        gte: (c, v) => { cols.push(c); seen.cursors.push(v); filters.push((r) => cmpTs(r[c], v) >= 0); return q; },
        order: (c, opts) => { cols.push(c); orders.push([c, opts?.ascending !== false]); return q; },
        limit: (n) => { lim = n; seen.limits.push(n); return q; },
      };
      q.then = (onOk, onErr) => {
        seen.queries++;
        if (!migrated() && cols.includes('inserted_at')) {
          return Promise.resolve({
            data: null,
            error: {
              code: '42703',
              message: 'column events.inserted_at does not exist',
              details: null,
              hint: null,
            },
          }).then(onOk, onErr);
        }
        const keys = orders.length ? orders : [['created_at', true]];
        const data = rows
          .filter((r) => filters.every((f) => f(r)))
          .map((r, i) => [r, i])
          .sort(([a, ai], [b, bi]) => {
            for (const [c, asc] of keys) {
              const d = cmpTs(a[c], b[c]);
              if (d) return asc ? d : -d;
            }
            // PostgREST promises NOTHING about the order of rows that tie on
            // every ORDER BY key, so the fake picks the awkward one on purpose.
            return tieBreak === 'reverse' ? bi - ai : ai - bi;
          })
          .map(([r]) => r)
          .slice(0, lim);
        // A column that does not exist cannot come back in the payload either.
        // Returning it anyway hid a real bug: the relay can tell the migration
        // landed by looking at what the LEGACY query answered with.
        const shaped = migrated() ? data : data.map(({ inserted_at, ...rest }) => rest);
        return Promise.resolve({ data: shaped, error: null }).then(onOk, onErr);
      };
      return q;
    },
  };
  return db;
}

// formatFeedEvent returns { content }, which is what post() is handed.
const lineOf = (payload) => String(payload?.content ?? payload);

function recorder() {
  const posted = [];
  return { posted, post: async (ch, payload) => { posted.push(lineOf(payload)); } };
}

// ── 1. THE BUG: a back-dated row written AFTER a newer one is still posted ───
{
  const rows = [death('d1', 'Loa', at(0), at(5))];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const state = { relay: { lastEventAt: at(-60), lastInsertedAt: at(-60), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  eq(await relay.tick(), 1, 'the client death posts');
  eq(state.relay.lastEventAt, at(0), 'the legacy cursor sits on its created_at');
  eq(state.relay.lastInsertedAt, at(5), 'the insertion cursor sits on when it was WRITTEN');

  // The poller now writes a leave that HAPPENED ten seconds before that death
  // and is written three seconds after it. This is the row the old cursor lost.
  rows.push(leave('l1', 'Bren', at(-10), at(8)));
  ok(at(-10) < state.relay.lastEventAt,
    'the leave is dated BEFORE the cursor a created_at relay would be holding');

  eq(await relay.tick(), 1, 'and it still reaches #server — this is the whole fix');
  ok(posted.some((p) => p.includes('Bren')), 'the leave really is the line that posted');
  eq(state.relay.lastInsertedAt, at(8), 'the insertion cursor advanced onto it');
  eq(state.relay.lastEventAt, at(0), 'the legacy cursor is monotone and did NOT rewind');

  eq(await relay.tick(), 0, 'a third tick has nothing to do');
  eq(posted.length, 2, 'and nothing was posted twice');
}

// ── 2. two rows sharing one inserted_at both post exactly once ──────────────
//
// `now()` is fixed for a whole transaction, so one statement writing two events
// rows gives them the SAME inserted_at to microsecond precision. A `.gt` on
// that value skips the second row — the same silent loss, one row at a time. So
// the query is `.gte` and the ids already relayed at that exact timestamp are
// carried in state. This forces the pair to straddle two ticks by failing the
// post of the second one with a 429.
{
  const shared = at(20);
  const rows = [join('a1', 'Astrid', at(19), shared), join('a2', 'Bjorn', at(19), shared)];
  const db = fakeEvents(rows);
  const posted = [];
  // Fail whichever row the database hands over SECOND. Naming one of them would
  // quietly assume an order PostgREST does not promise for rows that tie on
  // every ORDER BY key — and the fake deliberately hands them over reversed.
  let attempts = 0;
  let failSecond = true;
  const post = async (ch, payload) => {
    attempts++;
    if (failSecond && attempts === 2) throw Object.assign(new Error('rate limited'), { status: 429 });
    posted.push(lineOf(payload));
  };
  const state = { relay: { lastEventAt: at(0), lastInsertedAt: at(0), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  await relay.tick().catch(() => {});
  eq(posted.length, 1, 'the first of the pair posts, the second is held by the 429');
  eq(state.relay.lastInsertedAt, shared, 'the cursor is ON the shared timestamp, not past it');
  eq(state.relay.lastInsertedIds.length, 1, 'and remembers the one id it already relayed');

  failSecond = false;
  eq(await relay.tick(), 1, 'the second row of the pair posts on the next tick');
  eq(posted.length, 2, 'both rows posted');
  ok(posted.some((p) => p.includes('Astrid')) && posted.some((p) => p.includes('Bjorn')),
    'and they are the two different vikings');
  eq(state.relay.lastInsertedIds.length, 2, 'both ids are now remembered at that timestamp');

  eq(await relay.tick(), 0, 'a third tick posts nothing');
  eq(posted.length, 2, 'neither row is ever posted twice');

  // The re-read rows must not eat into the batch window, so the query asks for
  // BATCH plus however many ids are being skipped.
  eq(db.seen.limits[0], 50, 'the first query asks for the plain 50-row batch');
  eq(db.seen.limits[1], 51, 'the next asks for 50 PLUS the one row it will skip');
}

// ── 3. a restart mid-batch re-posts nothing already posted ──────────────────
{
  const rows = [
    join('r1', 'Ulf', at(30), at(31)),
    join('r2', 'Sigrid', at(30), at(31)), // same statement, same inserted_at
    death('r3', 'Ulf', at(40), at(41)),
  ];
  const db = fakeEvents(rows);
  const posted = [];
  const state = { relay: { lastEventAt: at(0), lastInsertedAt: at(0), lastInsertedIds: [] } };
  // Die after two rows, the way a kill -9 mid-batch does. state.json has been
  // written after every row, so what survives is what the next process reads.
  const dying = createRelay({
    db,
    post: async (ch, p) => {
      if (posted.length === 2) throw Object.assign(new Error('boom'), { status: 500 });
      posted.push(lineOf(p));
    },
    state,
    saveState: async () => {},
    log: quiet,
  });
  await dying.tick().catch(() => {});
  eq(posted.length, 2, 'two rows made it out before the process died');

  const survived = JSON.parse(JSON.stringify(state)); // exactly what state.json holds
  const after = recorder();
  const restarted = createRelay({
    db, post: after.post, state: survived, saveState: async () => {}, log: quiet,
  });
  eq(await restarted.tick(), 1, 'the restart posts only the row that never went out');
  ok(after.posted[0].includes('💀'), 'and it is the death, not either join');
  eq(await restarted.tick(), 0, 'and then it is caught up');
  eq(after.posted.length, 1, 'nothing already posted was posted again');
}

// ── 4. pre-migration fallback: relay by created_at, and say so ONCE ─────────
//
// The bot may restart before db/2026-09-06_events_inserted_at.sql is applied.
// It must keep running rather than throw on every tick, and it must say in the
// journal why the feed is on the lossy cursor.
{
  const rows = [join('p1', 'Magnus', at(50), at(51)), leave('p2', 'Magnus', at(60), at(61))];
  const db = fakeEvents(rows, { hasInsertedAt: false });
  const { posted, post } = recorder();
  const errors = [];
  const state = { relay: { lastEventAt: at(0), lastInsertedAt: at(0), lastInsertedIds: [] } };
  const relay = createRelay({
    db, post, state, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) },
  });

  eq(await relay.tick(), 2, 'the feed still runs with the migration unapplied');
  eq(state.relay.lastEventAt, at(60), 'on the old created_at cursor');
  const pending = errors.filter((m) => m.includes('inserted_at does not exist'));
  eq(pending.length, 1, 'and one line names the unapplied migration');
  ok(pending[0].includes('2026-09-06_events_inserted_at.sql'), 'by filename');

  eq(await relay.tick(), 0, 'the next tick has nothing to do');
  eq(errors.filter((m) => m.includes('inserted_at does not exist')).length, 1,
    'and does not repeat the migration line every 15 seconds');
  eq(posted.length, 2, 'nothing was posted twice across the fallback');

  // THE FLIP BACK. The fallback path must keep the insertion cursor in step, or
  // the moment the column appears `.gte(stale cursor)` re-reads the whole legacy
  // window and posts every line of it again.
  eq(state.relay.lastInsertedAt, at(60), 'the fallback kept the insertion cursor in step');
  ok(state.relay.lastInsertedIds.includes('p2'), 'including the id of the boundary row');
}

// ── 4b. applying the migration under a relay that was on the fallback ───────
{
  let migrated = false;
  // The backfill sets inserted_at = created_at for every row that already
  // existed, which is exactly what these rows are.
  const rows = [
    { ...join('q1', 'Revna', at(70), at(70)) },
    { ...leave('q2', 'Revna', at(80), at(80)) },
  ];
  const db = fakeEvents(rows, { hasInsertedAt: () => migrated });
  const { posted, post } = recorder();
  const state = { relay: { lastEventAt: at(0), lastInsertedAt: at(0), lastInsertedIds: [] } };
  const fallback = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  eq(await fallback.tick(), 2, 'both rows relay on the legacy cursor');

  // Charlie applies db/2026-09-06_events_inserted_at.sql and the bot restarts.
  migrated = true;
  const survived = JSON.parse(JSON.stringify(state));
  const after = recorder();
  const restarted = createRelay({
    db, post: after.post, state: survived, saveState: async () => {}, log: quiet,
  });
  eq(await restarted.tick(), 0, 'the migration does NOT replay the legacy window');
  eq(after.posted.length, 0, 'not one line is posted twice');
  eq(posted.length, 2, 'and the evening still only ever went out once');
}

// ── 5. the transition from lastEventAt to lastInsertedAt ────────────────────
//
// An upgraded bot's state.json holds only the created_at cursor. The migration
// backfills inserted_at = created_at for every row that already existed, so
// lastEventAt is the right seed for the new one.
{
  const seed = at(100);
  const state = { relay: { lastEventAt: seed, lastDeathByName: {} } };
  const rows = [
    join('t0', 'Old', at(90), at(90)), // backfilled history, before the seed
    join('t1', 'Thora', at(110), at(115)),
  ];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  eq(state.relay.lastInsertedAt, seed, 'lastInsertedAt is seeded from lastEventAt');
  ok(Array.isArray(state.relay.lastInsertedIds) && state.relay.lastInsertedIds.length === 0,
    'with an empty tie list');
  eq(await relay.tick(), 1, 'only the row written after the seed is relayed');
  ok(posted[0].includes('Thora'), 'history before the cursor is not replayed');
  eq(state.relay.lastInsertedAt, at(115), 'and the cursor moves onto the insert time');

  // A corrupt or missing value never crashes the loop, and never silently
  // resumes from the epoch.
  const broken = { relay: { lastEventAt: at(100), lastInsertedAt: 'nonsense', lastInsertedIds: 'no' } };
  const errs = [];
  createRelay({
    db, post: async () => {}, state: broken, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: (m) => errs.push(String(m)) },
  });
  eq(broken.relay.lastInsertedAt, at(100), 'an unusable insertion cursor is re-seeded from lastEventAt');
  ok(Array.isArray(broken.relay.lastInsertedIds), 'and the tie list is repaired to an array');
  ok(errs.some((m) => m.includes('not a usable time')), 'loudly');
}

// ── 6. a future-dated row is SKIPPED and the cursor steps past it ───────────
//
// Chosen deliberately over the old "stop the batch" (see src/relay.js): with an
// insertion-order cursor the forged row is no longer last in the scan, so
// stalling on it would hold the cursor in front of every honest row behind it —
// the very loss this file exists for. It cannot move the cursor any more, so
// skipping costs exactly one line and nothing else.
{
  const FORGED = '2999-01-01T00:00:00.000Z';
  const rows = [
    death('f1', 'TrollX', FORGED, at(200)),
    join('f2', 'Ingrid', at(201), at(202)),
  ];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const errors = [];
  const state = { relay: { lastEventAt: at(100), lastInsertedAt: at(100), lastInsertedIds: [] } };
  const relay = createRelay({
    db, post, state, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) },
  });

  eq(await relay.tick(), 1, 'the honest row BEHIND the forged one still posts');
  ok(posted[0].includes('Ingrid'), 'and it is the honest one');
  ok(!posted.some((p) => p.includes('TrollX')), 'the forged row never reaches #server');
  eq(state.relay.lastInsertedAt, at(202), 'the cursor stepped past the forged row');
  ok(Date.parse(state.relay.lastEventAt) < Date.parse(FORGED), 'and the legacy cursor is not poisoned');
  eq(errors.filter((m) => m.includes('in the future')).length, 1, 'one error line for the row');

  eq(await relay.tick(), 0, 'the forged row is not re-read forever');
  eq(errors.filter((m) => m.includes('in the future')).length, 1, 'so it is not warned about again');

  // Pre-migration the cursor IS created_at, so there the old stall is still the
  // only safe move: stepping over the forged row would burn everything behind it.
  const legacyRows = [join('g1', 'Bren', at(210), at(210)), death('g2', 'TrollX', FORGED, at(211))];
  const legacyDb = fakeEvents(legacyRows, { hasInsertedAt: false });
  const legacyState = { relay: { lastEventAt: at(100), lastInsertedAt: at(100), lastInsertedIds: [] } };
  const legacyPosts = recorder();
  const legacy = createRelay({
    db: legacyDb, post: legacyPosts.post, state: legacyState, saveState: async () => {}, log: quiet,
  });
  eq(await legacy.tick(), 1, 'the honest row posts on the legacy path');
  eq(legacyState.relay.lastEventAt, at(210), 'and the created_at cursor STOPS in front of the forged row');
}

// ── 7. the duplicate-death collapse still works over the new cursor ─────────
//
// Two producers write the same death milliseconds apart, in two transactions,
// so the rows have different inserted_at values and both reach the loop.
{
  const rows = [
    death('x1', 'Bjorn', atMs(300_000), atMs(300_000)),
    death('x2', 'Bjorn', atMs(300_002), atMs(300_100)),  // the twin: same death
    death('x3', 'Bjorn', atMs(390_000), atMs(390_000)),  // a real corpse-run death
  ];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const collapsed = [];
  const state = { relay: { lastEventAt: at(200), lastInsertedAt: at(200), lastInsertedIds: [] } };
  const relay = createRelay({
    db, post, state, saveState: async () => {},
    log: { info: (m) => collapsed.push(String(m)), warn: () => {}, error: () => {} },
  });
  eq(await relay.tick(), 2, 'the twin collapses, the 90 s corpse run still posts');
  eq(posted.length, 2, 'two lines in #server');
  eq(collapsed.filter((m) => m.includes('collapsed a duplicate death')).length, 1, 'and the collapse is logged');
}

// ── 8. a poisoned insertion cursor repairs itself instead of freezing ───────
//
// inserted_at is the database's own now(), so a future value means a bad
// Postgres clock or a hand-edited state.json. Either way the feed is dead until
// something pulls it back, and nobody hand-edits state.json at 23:00.
{
  const state = { relay: { lastEventAt: ago(60_000), lastInsertedAt: '2999-01-01T00:00:00.000Z', lastInsertedIds: ['x'] } };
  const errors = [];
  createRelay({
    db: fakeEvents([]), post: async () => {}, state, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) },
  });
  ok(state.relay.lastInsertedAt < '2999', 'a year-2999 insertion cursor is pulled back to now');
  eq(state.relay.lastInsertedIds.length, 0, 'and its stale tie list is dropped');
  ok(errors.some((m) => m.includes('in the future')), 'loudly');
}

// ── 9. a MICROSECOND cursor round-trips through state.json verbatim ─────────
//
// PostgREST sends `2026-09-05T23:00:00.123456+00:00`, not the millisecond `Z`
// form `new Date().toISOString()` produces. If the cursor were ever re-derived
// through a Date the microseconds would be gone, and `.gte` would sit up to
// 999 us EARLIER than the row it is meant to be standing on — silently
// re-reading rows for as long as the value survived. So: stored verbatim,
// compared verbatim.
{
  const usec = (secs, micros) =>
    new Date(T + secs * 1000).toISOString().replace(/\.\d{3}Z$/, `.${String(micros).padStart(6, '0')}+00:00`);
  const a = usec(400, 123456);
  const b = usec(400, 123999); // SAME millisecond, 543 us later
  const rows = [join('u1', 'Hilde', usec(399, 500000), a), join('u2', 'Orm', usec(399, 900000), b)];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  let state = { relay: { lastEventAt: at(300), lastInsertedAt: usec(300, 0), lastInsertedIds: [] } };
  let relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  eq(await relay.tick(), 2, 'both microsecond-apart rows post');
  eq(state.relay.lastInsertedAt, b,
    'the cursor is the PostgREST string byte for byte — no Date round-trip, no lost microseconds');
  ok(state.relay.lastInsertedAt.endsWith('+00:00'), 'offset form preserved');
  ok(/\.\d{6}\+/.test(state.relay.lastInsertedAt), 'six fractional digits preserved');

  // …and it survives state.json.
  state = JSON.parse(JSON.stringify(state));
  eq(state.relay.lastInsertedAt, b, 'and state.json gives it back unchanged');
  relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  eq(await relay.tick(), 0, 'so the next tick re-reads them and posts neither again');
  eq(posted.length, 2, 'exactly two lines in #server');
  // The lag means the read really did cover both rows: this is not a pass by
  // virtue of a filter that excluded them.
  ok(db.seen.cursors.some((c) => cmpTs(c, a) <= 0),
    'the query reached back far enough to re-read both, and dropped them by id');
}

// ── 10. COMMIT ORDER: a late-committing, earlier-stamped row still posts ─────
//
// `inserted_at` defaults to now(), which Postgres fixes at TRANSACTION START,
// and a row appears at COMMIT. Two overlapping writers can therefore commit in
// the opposite order to their stamps. A cursor parked exactly on the high-water
// mark loses the late one for good — bug 1 again, one row at a time.
{
  const A = leave('c1', 'Bren', at(510), at(510));   // txn starts first, commits slowly
  const B = join('c2', 'Astrid', at(511), at(511));  // starts later, commits first
  const visible = [B];
  const db = fakeEvents(visible);
  const { posted, post } = recorder();
  const state = { relay: { lastEventAt: at(500), lastInsertedAt: at(500), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  eq(await relay.tick(), 1, 'the row that committed first posts');
  eq(state.relay.lastInsertedAt, at(511), 'and the high-water mark is past the other row stamp');

  visible.push(A); // the slow transaction commits
  eq(await relay.tick(), 1, 'the late-committing row is NOT lost behind the cursor');
  ok(posted.some((p) => p.includes('Bren')), 'and it is the one that committed second');
  eq(await relay.tick(), 0, 'and it does not keep re-posting');
  eq(posted.length, 2, 'two lines, each exactly once');
}

// ── 11. the lag never reaches back before the seed ──────────────────────────
//
// Everything at or after the floor that was already relayed is in
// lastInsertedIds. Everything BEFORE it was relayed by the old created_at
// cursor, whose ids nobody kept — so reaching back there would repost history
// with nothing able to recognise it.
{
  const seed = at(600);
  const rows = [
    join('h1', 'Ghost', at(598), at(598)),   // 2 s of history the lag would otherwise touch
    join('h2', 'Runa', at(601), at(601)),
  ];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const state = { relay: { lastEventAt: seed, lastDeathByName: {} } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  eq(state.relay.insertionFloor, seed, 'the floor is planted where the cursor was seeded');
  eq(await relay.tick(), 1, 'only the row after the seed posts');
  ok(!posted.some((p) => p.includes('Ghost')), 'history before the seed is never re-read');
  ok(db.seen.cursors.every((c) => cmpTs(c, seed) >= 0), 'no query ever asked for anything older');
}

// ── 12. the seed boundary row posts ONCE, not once per restart ──────────────
//
// `.gte` at the seeded cursor deliberately re-reads the single row the old
// created_at cursor last landed on. That costs one duplicate line at the moment
// of the switch — but only one, ever: the id is recorded on the first pass and
// a restart with both cursors present skips the seed path entirely.
{
  const seed = at(700);
  const rows = [
    join('n0', 'Boundary', seed, seed),     // the row the old cursor stopped on
    join('n1', 'Sten', at(702), at(702)),
  ];
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  let state = { relay: { lastEventAt: seed, lastDeathByName: {} } };
  let relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  eq(await relay.tick(), 2, 'the boundary row is re-read once at the switch');
  eq(posted.filter((p) => p.includes('Boundary')).length, 1, 'one duplicate line, by design');
  ok(state.relay.lastInsertedIds.includes('n0'), 'and its id is recorded');

  for (const restart of [1, 2, 3]) {
    state = JSON.parse(JSON.stringify(state));
    relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
    eq(await relay.tick(), 0, `restart ${restart} posts nothing`);
  }
  eq(posted.filter((p) => p.includes('Boundary')).length, 1,
    'the boundary row is still at exactly one line after three restarts');
  eq(posted.length, 2, 'and the evening is two lines total');
}

// ── 13. a tie group split by the 50-row batch limit loses nothing ───────────
{
  const rows = [];
  for (let i = 0; i < 46; i++) rows.push(join(`w${i}`, `Solo${i}`, at(800 + i * 10), at(800 + i * 10)));
  const shared = at(1400);
  for (let i = 0; i < 8; i++) rows.push(join(`s${i}`, `Tied${i}`, at(1399), shared)); // one statement
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  const state = { relay: { lastEventAt: at(700), lastInsertedAt: at(700), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  eq(await relay.tick(), 50, 'the first tick consumes exactly the batch');
  eq(db.seen.limits[0], 50, 'asking for 50 with nothing to skip');
  const second = await relay.tick();
  eq(second, 4, 'the four rows past the limit, all on the timestamp the batch ended ON');
  ok(db.seen.limits[1] > 50, 'the second query asked for 50 PLUS the ids it would skip');
  eq(await relay.tick(), 0, 'and then it is caught up');
  eq(posted.length, 54, 'every row posted');
  eq(new Set(posted).size, 54, 'and not one of them twice');
}

// ── 14. a transient failure mid-tie-group keeps the ids of what already posted ─
{
  const shared = at(1500);
  const rows = [0, 1, 2].map((i) => join(`k${i}`, `Kettil${i}`, at(1499), shared));
  const db = fakeEvents(rows);
  const posted = [];
  let attempts = 0;
  let failThird = true;
  const post = async (ch, p) => {
    attempts++;
    if (failThird && attempts === 3) throw Object.assign(new Error('gateway'), { status: 502 });
    posted.push(lineOf(p));
  };
  let state = { relay: { lastEventAt: at(1400), lastInsertedAt: at(1400), lastInsertedIds: [] } };
  let relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  await relay.tick().catch(() => {});
  eq(posted.length, 2, 'two of the three went out before the throw');
  eq(state.relay.lastInsertedIds.length, 2,
    'and BOTH ids were persisted before the throw, not just the last one');

  failThird = false;
  state = JSON.parse(JSON.stringify(state)); // the throw could equally have been a crash
  relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });
  eq(await relay.tick(), 1, 'the restart posts only the row that never went out');
  eq(posted.length, 3, 'three lines');
  eq(new Set(posted).size, 3, 'none of them twice');
}

// ── 15. a PERMANENT rejection inside a tie group burns only that row ────────
{
  const shared = at(1600);
  const rows = [join('m1', 'Frida', at(1599), shared), join('m2', 'Gunnar', at(1599), shared)];
  const db = fakeEvents(rows);
  const posted = [];
  let attempts = 0;
  const rejected = [];
  const post = async (ch, p) => {
    attempts++;
    if (attempts === 1) { rejected.push(lineOf(p)); throw Object.assign(new Error('Invalid Form Body'), { status: 400 }); }
    posted.push(lineOf(p));
  };
  let state = { relay: { lastEventAt: at(1500), lastInsertedAt: at(1500), lastInsertedIds: [] } };
  let relay = createRelay({ db, post, state, saveState: async () => {}, log: { info(){}, warn(){}, error(){} } });
  eq(await relay.tick(), 1, 'the poison row is stepped over and the other one posts');
  eq(state.relay.lastInsertedIds.length, 2, 'both ids are on the cursor, including the burned one');

  state = JSON.parse(JSON.stringify(state));
  relay = createRelay({ db, post, state, saveState: async () => {}, log: { info(){}, warn(){}, error(){} } });
  eq(await relay.tick(), 0, 'neither row is retried after a restart');
  eq(posted.length, 1, 'one line in #server');
  eq(rejected.length, 1, 'and the rejected row was attempted exactly once');
}

// ── 16. the migration landing MID-RUN does not double-post ─────────────────
//
// Between the ALTER TABLE and the 5-minute re-probe the relay is still on the
// legacy cursor, but its rows now carry a REAL inserted_at. Copying created_at
// into the insertion cursor there mis-set it, and the flip re-posted any row
// whose insert time ran ahead of the last relayed row's created_at — the poller
// leave / client join pairing that happens constantly.
{
  let migrated = false;
  const rows = [join('z0', 'Before', at(1700), at(1700))]; // pre-migration: backfilled
  const db = fakeEvents(rows, { hasInsertedAt: () => migrated });
  const posted = [];
  const post = async (ch, p) => posted.push(lineOf(p));
  const state = { relay: { lastEventAt: at(1690), lastInsertedAt: at(1690), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: { info(){}, warn(){}, error(){} } });
  eq(await relay.tick(), 1, 'the fallback relays the pre-migration row');

  // Charlie applies the migration. The relay has NOT re-probed yet.
  migrated = true;
  rows.push(leave('z1', 'Bren', at(1720), at(1735)));   // poller, written 15 s late
  rows.push(join('z2', 'Astrid', at(1730), at(1731)));  // client, written at once

  eq(await relay.tick(), 2, 'both new rows post');
  eq(await relay.tick(), 0, 'and the next tick has nothing left');
  eq(posted.length, 3, 'three lines total');
  eq(new Set(posted).size, 3, 'not one of them posted twice by the flip');

  // …and the relay really is back on the insertion cursor: a back-dated row
  // written after all of them still reaches #server.
  rows.push(leave('z3', 'Astrid', at(1600), at(1740)));
  eq(await relay.tick(), 1, 'a back-dated row written last still posts — the insertion cursor is live');
}

// ── 17. saveState failing mid-batch neither loses nor duplicates a row ──────
{
  const rows = [0, 1, 2].map((i) => join(`v${i}`, `Vidar${i}`, at(1800 + i), at(1800 + i)));
  const db = fakeEvents(rows);
  const { posted, post } = recorder();
  let saves = 0;
  const saveState = async () => { saves++; if (saves === 2) throw new Error('ENOSPC'); };
  const state = { relay: { lastEventAt: at(1790), lastInsertedAt: at(1790), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState, log: quiet });
  await relay.tick().catch(() => {});
  eq(posted.length, 2, 'the batch aborted after the failed save');
  eq(await relay.tick(), 1, 'the next tick resumes from the in-memory cursor');
  eq(posted.length, 3, 'every row posted');
  eq(new Set(posted).size, 3, 'and none of them twice');
}

console.log(`relay-cursor.test: ${passed} assertions passed`);
