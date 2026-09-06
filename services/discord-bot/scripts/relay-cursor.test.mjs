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
function fakeEvents(rows, { hasInsertedAt = true } = {}) {
  const migrated = () => (typeof hasInsertedAt === 'function' ? hasInsertedAt() : hasInsertedAt);
  const seen = { limits: [], queries: 0 };
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
        gt: (c, v) => { cols.push(c); filters.push((r) => String(r[c] ?? '') > String(v)); return q; },
        gte: (c, v) => { cols.push(c); filters.push((r) => String(r[c] ?? '') >= String(v)); return q; },
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
          .sort((a, b) => {
            for (const [c, asc] of keys) {
              const d = String(a[c] ?? '').localeCompare(String(b[c] ?? ''));
              if (d) return asc ? d : -d;
            }
            return 0;
          })
          .slice(0, lim);
        return Promise.resolve({ data, error: null }).then(onOk, onErr);
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
  let failNext = true;
  const post = async (ch, payload) => {
    const s = lineOf(payload);
    if (failNext && s.includes('Bjorn')) throw Object.assign(new Error('rate limited'), { status: 429 });
    posted.push(s);
  };
  const state = { relay: { lastEventAt: at(0), lastInsertedAt: at(0), lastInsertedIds: [] } };
  const relay = createRelay({ db, post, state, saveState: async () => {}, log: quiet });

  await relay.tick().catch(() => {});
  eq(posted.length, 1, 'the first of the pair posts, the second is held by the 429');
  eq(state.relay.lastInsertedAt, shared, 'the cursor is ON the shared timestamp, not past it');
  eq(state.relay.lastInsertedIds.length, 1, 'and remembers the one id it already relayed');

  failNext = false;
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
  eq(String(state.relay.lastInsertedIds), 'p2', 'including the id of the boundary row');
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

console.log(`relay-cursor.test: ${passed} assertions passed`);
