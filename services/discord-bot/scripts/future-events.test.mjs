// The future-dated event row, and the two loops it used to kill.
//
// THE BUG (red-team, 2026-09-05). /api/gs-ingest accepts `source:'client'` and
// `source:'eilif-death'` with NO token — the mod runs on players' PCs and cannot
// hold a secret, and the POST URL ships in the public Thunderstore pack. Both
// death parsers validated `tsUtc` with nothing but Date.parse, and the value
// became `events.created_at`. One anonymous POST naming any online viking
// (character names are public on /api/status and /players), dated 2999-01-01:
//
//   • FROZE #server FOREVER. The relay's cursor IS created_at and only moves
//     forward, so after that row `.gt('created_at', cursor)` never matched
//     again — and silently, because a tick that posts nothing is a success and
//     every health signal stayed green.
//   • COUNTED IN EVERY RECAP. The death query was gte(windowStart) with no upper
//     bound, so the forged row inflated the Fallen board and the "The Bold"
//     Player-of-the-Day tally every day, forever.
//
// The real fix is the clamp at ingest (lib/event-time.ts, lib/event-time.test.mjs).
// These are the second locks on the same door, in the two loops that consumed
// the row: the relay refuses to step onto it (and repairs a cursor already
// poisoned by one), and the recap bounds its window at both ends.
//
// Run:
//   node scripts/future-events.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { createRelay } from '../src/relay.js';
import { createRecap } from '../src/recap.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();
const FORGED = '2999-01-01T00:00:00+00:00';

// A fake events table that actually APPLIES the created_at filters, so a missing
// bound is a failing test rather than a stub that answers the same either way.
function eventsDb(rows) {
  return {
    from(table) {
      const filters = [];
      const q = {};
      const pass = () => (...args) => { void args; return q; };
      for (const m of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit']) q[m] = pass();
      q.gt = (col, v) => { filters.push((r) => r[col] > v); return q; };
      q.gte = (col, v) => { filters.push((r) => r[col] >= v); return q; };
      q.lte = (col, v) => { filters.push((r) => r[col] <= v); return q; };
      q.lt = (col, v) => { filters.push((r) => r[col] < v); return q; };
      q.maybeSingle = () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
      q.single = q.maybeSingle;
      q.then = (onOk, onErr) => {
        const data = (rows[table] ?? [])
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
        return Promise.resolve({ data, error: null }).then(onOk, onErr);
      };
      return q;
    },
  };
}

const joinEvent = (name, created_at, id) => ({
  id, type: 'join', character_name: name, created_at, metadata: {},
});

// ── 1. the relay steps over a future-dated row instead of onto it ────────────
{
  const posts = [];
  const joinAt = ago(600_000);
  const state = { relay: { lastEventAt: ago(3600_000), lastDeathByName: {} } };
  const db = eventsDb({
    events: [
      joinEvent('Bren', joinAt, 'e1'),
      { id: 'poison', type: 'death', character_name: 'TrollX', created_at: FORGED, metadata: {} },
    ],
  });
  const relay = createRelay({
    db,
    post: async (ch, payload) => { posts.push({ ch, payload }); },
    state,
    saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  eq(await relay.tick(), 1, 'the honest event before the forged one still posts');
  ok(state.relay.lastEventAt < FORGED, 'and the cursor did NOT jump to the year 2999');
  eq(state.relay.lastEventAt, joinAt, 'it sits on the last real event');

  // The whole point: a genuinely new death AFTER the forged row still reaches
  // #server. Before the guard this returned 0 and the feed was dead for good.
  db.from = eventsDb({
    events: [
      joinEvent('Bren', joinAt, 'e1'),
      { id: 'real', type: 'death', character_name: 'Loa', created_at: ago(60_000), metadata: {} },
      { id: 'poison', type: 'death', character_name: 'TrollX', created_at: FORGED, metadata: {} },
    ],
  }).from;
  eq(await relay.tick(), 1, 'the next real death still posts — the feed is alive');
}

// ── 2. a cursor already poisoned repairs itself on construction ──────────────
// Recovery used to mean hand-editing state.json at 11pm on launch night.
{
  const state = { relay: { lastEventAt: FORGED, lastDeathByName: {} } };
  const errors = [];
  createRelay({
    db: eventsDb({ events: [] }),
    post: async () => {},
    state,
    saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
  });
  ok(state.relay.lastEventAt < FORGED, 'a year-2999 cursor is pulled back to now');
  ok(errors.some((m) => m.includes('2999')), 'and the repair is logged loudly, not silently');
}
{
  // A sane cursor is never touched, and neither is an ordinary clock skew.
  const sane = ago(120_000);
  const state = { relay: { lastEventAt: sane, lastDeathByName: {} } };
  createRelay({ db: eventsDb({ events: [] }), post: async () => {}, state, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} } });
  eq(state.relay.lastEventAt, sane, 'a normal cursor is left exactly alone');

  const skewed = ahead(60_000); // one minute ahead: inside the tolerance
  const state2 = { relay: { lastEventAt: skewed, lastDeathByName: {} } };
  createRelay({ db: eventsDb({ events: [] }), post: async () => {}, state: state2, saveState: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} } });
  eq(state2.relay.lastEventAt, skewed, 'a minute of clock skew is not treated as poison');
}

// ── 3. the recap window is bounded at BOTH ends ──────────────────────────────
{
  const nowIso = new Date().toISOString();
  const hourAgo = ago(3600_000);
  const build = (deathRows) =>
    createRecap({
      db: eventsDb({
        sessions: [{ character_name: 'Loa', joined_at: hourAgo, left_at: nowIso }],
        events: deathRows,
        bosses: [],
        players: [],
        player_stats: [],
        server_status: [{ player_count: 0, world_day: 12 }],
      }),
      post: async () => {},
      state: {},
      saveState: async () => {},
    }).buildStats('evening');

  const real = { character_name: 'Loa', type: 'death', created_at: ago(600_000), metadata: {} };
  const forged = { character_name: 'TrollX', type: 'death', created_at: FORGED, metadata: {} };

  const clean = await build([real]);
  eq(clean.deaths, 1, 'one real fall in the window counts once');

  const poisoned = await build([real, forged]);
  eq(poisoned.deaths, 1, 'the year-2999 row is OUTSIDE the window and is not counted');
  eq(poisoned.fallenToday.length, 1, 'the Fallen board holds only the real viking');
  eq(poisoned.fallenToday[0].name, 'Loa', 'and it is her, not the forged name');
}

console.log(`future-events.test: ${passed} assertions passed`);
