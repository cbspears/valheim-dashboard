// Unit tests for the living-titles announcer.
//
// Covers the old contract (seed-silent, exact Discord/voice formats, no-op on a
// match, graceful degrade, dry-run) AND the "sticky and rare" policy Charlie
// asked for on 2026-09-10: never demote an earned title, silent placeholder
// reshuffles, two-pass confirmation 15 min apart, 24 h tenure between earned
// titles, and a 3-per-day proclamation budget with a deterministic ranking.
//
// Run: node scripts/titles.test.mjs   (from services/discord-bot)
import { createTitlesAnnouncer, isEarnedTitle } from '../src/titles.js';
import assert from 'node:assert';

const silentLog = { info() {}, warn() {}, error() {} };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-10T20:00:00.000Z');
const ago = (ms) => new Date(T0 - ms).toISOString();

// A tiny fake supabase client that records writes and can inject a read result.
function fakeDb({ players, readError = null, history = [] }) {
  const writes = { updates: [], history: [], voice: [] };
  const client = {
    writes,
    from(table) {
      if (table === 'title_history') {
        return {
          // .select(...).gte('awarded_at', iso) — the rolling-24h budget read.
          select() {
            return { gte: () => Promise.resolve({ data: history, error: null }) };
          },
          insert(obj) { writes.history.push(obj); return Promise.resolve({ error: null }); },
        };
      }
      return {
        select() {
          if (table === 'players') return Promise.resolve({ data: players, error: readError });
          return Promise.resolve({ data: [], error: null });
        },
        update(obj) {
          return { eq(_c, id) { writes.updates.push({ id, ...obj }); return Promise.resolve({ error: null }); } };
        },
        insert(obj) {
          if (table === 'voice_lines') writes.voice.push(obj);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return client;
}

// [name, title, source] -> a fetch impl returning that /api/titles payload.
function fakeApi(rows) {
  const players = rows.map(([name, title, source = 'flavor']) => ({ name, title, source }));
  return async () => ({ ok: true, json: async () => ({ players }) });
}

// A clock the tests drive by hand.
function clock(start = T0) {
  const c = { t: start };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

function announcer(opts) {
  return createTitlesAnnouncer({ log: silentLog, apiUrl: 'http://x', ...opts });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// ── 0. The earned/placeholder classifier ──────────────────────────────────
{
  ok(isEarnedTitle('Bane of Beasts') && isEarnedTitle('Treefoe') && isEarnedTitle('the Ever-Present'),
    'dimension epithets and Treefoe classify as earned');
  ok(!isEarnedTitle('of the Quiet Fjord') && !isEarnedTitle('') && !isEarnedTitle(null),
    'placeholders and empties classify as not earned');
}

// ── 1. Seed-silent: NULL current_title -> record, no announcement ─────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p1', character_name: 'Testman', current_title: null },
    { id: 'p2', character_name: 'Testmantwo', current_title: null },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Testman', 'the Provider', 'resources'], ['Testmantwo', 'Bane of Beasts', 'kills']]),
    now: () => T0,
  });
  const r = await ann.tick();
  ok(r.seeded === 2 && r.announced === 0, `seed pass seeds silently, got ${JSON.stringify(r)}`);
  ok(posts.length === 0, 'no #server posts on seed');
  ok(writeDb.writes.updates.length === 2, 'both current_title columns seeded');
  ok(writeDb.writes.history.length === 0 && writeDb.writes.voice.length === 0, 'no history/voice on seed');
}

// ── 2. A real change is CONFIRMED over two passes, then announced ─────────
{
  const posts = [];
  const c = clock();
  const writeDb = fakeDb({ players: [
    { id: 'p2', character_name: 'Testmantwo', current_title: 'of the Quiet Fjord', title_updated_at: ago(3 * DAY) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Testmantwo', 'Bane of Beasts', 'kills']]),
    now: c.now,
  });

  const first = await ann.tick();
  ok(first.announced === 0 && first.confirming === 1, `first sighting only confirms, got ${JSON.stringify(first)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0, 'nothing written while confirming');

  c.advance(14 * MIN);
  const early = await ann.tick();
  ok(early.announced === 0 && early.confirming === 1, '14 min later is still inside the confirm window');

  c.advance(2 * MIN); // 16 min after the first offer
  const r = await ann.tick();
  ok(r.announced === 1 && r.seeded === 0, `confirmed change announced, got ${JSON.stringify(r)}`);
  ok(posts.length === 1 && posts[0].ch === 'server', 'posts to #server');
  ok(posts[0].p.content === '⚔️ **Testmantwo** has earned a new title: **Bane of Beasts**',
    `exact discord format, got: ${posts[0].p.content}`);
  ok(posts[0].p.mentionEveryone !== true, 'never pings @everyone');
  ok(writeDb.writes.history.length === 1 && writeDb.writes.history[0].title === 'Bane of Beasts',
    'title_history row inserted');
  ok(writeDb.writes.voice.length === 1 &&
     writeDb.writes.voice[0].text === 'From tonight, Testmantwo goes by Bane of Beasts.' &&
     writeDb.writes.voice[0].kind === 'event' && writeDb.writes.voice[0].status === 'queued',
    `exact voice line queued, got: ${writeDb.writes.voice[0]?.text}`);
  // Copy guard: zero em-dashes in anything a player reads or hears.
  ok(!posts[0].p.content.includes('—') && !writeDb.writes.voice[0].text.includes('—'),
    'no em-dash in the proclamation or its voice line');
}

// ── 2b. A DIFFERENT offer restarts the confirmation clock ─────────────────
{
  const posts = [];
  const c = clock();
  const players = [{ id: 'p2', character_name: 'Testmantwo', current_title: 'of the Quiet Fjord', title_updated_at: ago(3 * DAY) }];
  const writeDb = fakeDb({ players });
  let payload = fakeApi([['Testmantwo', 'Bane of Beasts', 'kills']]);
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: (...a) => payload(...a),
    now: c.now,
  });
  await ann.tick();
  c.advance(20 * MIN);
  payload = fakeApi([['Testmantwo', 'the Heavy-Handed', 'damage']]); // the engine changed its mind
  const second = await ann.tick();
  ok(second.announced === 0 && second.confirming === 1, 'a new offer starts confirming again, it does not inherit');
  c.advance(20 * MIN);
  const third = await ann.tick();
  ok(third.announced === 1 && posts[0].p.content.includes('the Heavy-Handed'),
    'the second offer announces only once it has itself stood 15 min');
}

// ── 3. No-op when the computed title already matches ──────────────────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p1', character_name: 'Testman', current_title: 'the Provider' },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Testman', 'the Provider', 'resources']]), now: () => T0,
  });
  const r = await ann.tick();
  ok(r.unchanged === 1 && r.announced === 0 && r.seeded === 0, `no-op on match, got ${JSON.stringify(r)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0, 'no writes/posts on no-op');
}

// ── 4. Graceful degrade: registry column missing -> skip, no throw ────────
{
  const posts = [];
  const writeDb = fakeDb({ players: null, readError: { code: '42703', message: 'column players.current_title does not exist' } });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Testman', 'the Provider', 'resources']]), now: () => T0,
  });
  const r = await ann.tick();
  ok(r.seeded === 0 && r.announced === 0 && posts.length === 0, 'missing column -> clean skip');
}

// ── 5. Dry-run: announce path posts/writes nothing ────────────────────────
{
  const posts = [];
  const c = clock();
  const writeDb = fakeDb({ players: [
    { id: 'p2', character_name: 'Testmantwo', current_title: 'of the Quiet Fjord', title_updated_at: ago(3 * DAY) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Testmantwo', 'Bane of Beasts', 'kills']]), now: c.now, dryRun: true,
  });
  await ann.tick();
  c.advance(16 * MIN);
  const r = await ann.tick();
  ok(r.announced === 1, 'dry-run counts the confirmed change');
  ok(posts.length === 0 && writeDb.writes.updates.length === 0 && writeDb.writes.voice.length === 0,
    'dry-run performs no side effects');
}

// ── 6. NEVER DEMOTE an earned title to a placeholder ──────────────────────
{
  const posts = [];
  const c = clock();
  const writeDb = fakeDb({ players: [
    // Earned long ago — the old 60 min TITLE_HOLD_MS would have let this through.
    { id: 'p3', character_name: 'Rosir', current_title: 'the Ever-Present', title_updated_at: ago(30 * DAY) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Rosir', 'of the Quiet Fjord', 'flavor']]), now: c.now,
  });
  let held = 0;
  for (let i = 0; i < 6; i++) { held = (await ann.tick()).held; c.advance(HOUR); }
  ok(held === 1, 'the earned title is held, pass after pass');
  ok(posts.length === 0 && writeDb.writes.updates.length === 0 && writeDb.writes.history.length === 0,
    'a demotion to a placeholder is never written or announced, however long it stands');
}

// ── 7. Placeholder -> placeholder is recorded SILENTLY ────────────────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p4', character_name: 'Rosir', current_title: 'of the Quiet Fjord', title_updated_at: ago(2 * HOUR) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Rosir', 'the Quiet Flame', 'flavor']]), now: () => T0,
  });
  const r = await ann.tick();
  ok(r.reshuffled === 1 && r.announced === 0, `placeholder reshuffle counted, got ${JSON.stringify(r)}`);
  ok(writeDb.writes.updates.length === 1 && writeDb.writes.updates[0].current_title === 'the Quiet Flame',
    'the registry is updated so it stays unique');
  ok(posts.length === 0 && writeDb.writes.history.length === 0 && writeDb.writes.voice.length === 0,
    'no proclamation, no history row, no voice line');
}

// ── 8. TENURE blocks earned -> earned under 24 h, then lets it through ────
{
  const posts = [];
  const c = clock();
  const writeDb = fakeDb({ players: [
    { id: 'p5', character_name: 'Ræginál', current_title: 'the Provider', title_updated_at: ago(3 * HOUR) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Ræginál', 'Bane of Beasts', 'kills']]), now: c.now,
  });
  const first = await ann.tick();
  ok(first.held === 1 && first.announced === 0, `under tenure the title holds, got ${JSON.stringify(first)}`);
  c.advance(6 * HOUR);
  ok((await ann.tick()).announced === 0, 'still held nine hours in');
  ok(posts.length === 0, 'nothing announced inside the tenure window');
  // Cross 24 h: the offer has stood the whole time, so it is already confirmed.
  c.advance(16 * HOUR);
  const r = await ann.tick();
  ok(r.announced === 1 && posts.length === 1, `announced once tenure clears, got ${JSON.stringify(r)}`);
}

// ── 8b. Placeholder -> earned has NO tenure requirement ───────────────────
{
  const posts = [];
  const c = clock();
  const writeDb = fakeDb({ players: [
    { id: 'p6', character_name: 'Newcomer', current_title: 'the Unhurried', title_updated_at: ago(5 * MIN) },
  ] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    fetchImpl: fakeApi([['Newcomer', 'Stonewright', 'builds']]), now: c.now,
  });
  await ann.tick();
  c.advance(16 * MIN);
  const r = await ann.tick();
  ok(r.announced === 1, 'a first earned title needs confirmation but no tenure');
}

// ── 9. DAILY BUDGET caps the pass, in a deterministic order ───────────────
{
  const roster = [
    // earned -> earned, non-combat (rank last)
    { id: 'c', character_name: 'Charleif', current_title: 'the Forgehand', title_updated_at: ago(5 * DAY) },
    // placeholder -> earned (rank first)
    { id: 'z', character_name: 'Zulf', current_title: 'the Unhurried', title_updated_at: ago(5 * DAY) },
    // earned -> earned, combat
    { id: 'd', character_name: 'Dvalinn', current_title: 'Stonewright', title_updated_at: ago(5 * DAY) },
    // placeholder -> earned (rank first)
    { id: 'a', character_name: 'Alfvin', current_title: 'the Quiet Flame', title_updated_at: ago(5 * DAY) },
    // earned -> earned, combat
    { id: 'b', character_name: 'Bjorn', current_title: 'the Provider', title_updated_at: ago(5 * DAY) },
  ];
  const offers = fakeApi([
    ['Charleif', 'the Far-Seer', 'map'],
    ['Zulf', 'the Forgehand', 'crafts'],
    ['Dvalinn', 'the Heavy-Handed', 'damage'],
    ['Alfvin', 'Bane of Beasts', 'kills'],
    ['Bjorn', 'Bane of the Forsaken', 'bossdmg'],
  ]);

  // 9a. Fresh budget: exactly 3 of the 5 go out, in rank order.
  {
    const posts = [];
    const c = clock();
    const writeDb = fakeDb({ players: roster, history: [] });
    const ann = announcer({
      db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
      fetchImpl: offers, now: c.now,
    });
    await ann.tick();
    c.advance(16 * MIN);
    const r = await ann.tick();
    ok(r.announced === 3 && r.deferred === 2, `budget caps the pass at 3, got ${JSON.stringify(r)}`);
    const named = posts.map((p) => p.split('**')[1]);
    ok(JSON.stringify(named) === JSON.stringify(['Alfvin', 'Zulf', 'Bjorn']),
      `ranking = first titles (alphabetical), then combat crowns, got ${JSON.stringify(named)}`);
    ok(writeDb.writes.history.length === 3, 'one title_history row per proclamation, and only those');
  }

  // 9b. Two already spent in the last 24 h: only one more goes out.
  {
    const posts = [];
    const c = clock();
    const writeDb = fakeDb({ players: roster, history: [{ id: 1 }, { id: 2 }] });
    const ann = announcer({
      db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
      fetchImpl: offers, now: c.now,
    });
    await ann.tick();
    c.advance(16 * MIN);
    const r = await ann.tick();
    ok(r.announced === 1 && r.deferred === 4, `rolling-24h history spends the budget, got ${JSON.stringify(r)}`);
    ok(posts.length === 1 && posts[0].includes('Alfvin'), 'the top-ranked candidate is the one that goes out');
  }

  // 9c. Deferred candidates are still pending: they go out on a later pass.
  {
    const posts = [];
    const c = clock();
    const writeDb = fakeDb({ players: roster, history: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const ann = announcer({
      db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
      fetchImpl: offers, now: c.now,
    });
    await ann.tick();
    c.advance(16 * MIN);
    const spent = await ann.tick();
    ok(spent.announced === 0 && spent.deferred === 5, 'a used-up budget announces nothing');
    // Next day the history read comes back empty and the same offers stand.
    const fresh = fakeDb({ players: roster, history: [] });
    const ann2 = announcer({
      db: fresh, writeDb: fresh, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
      fetchImpl: offers, now: c.now,
    });
    await ann2.tick();
    c.advance(16 * MIN);
    ok((await ann2.tick()).announced === 3, 'the deferred changes are re-evaluated and go out when the budget frees up');
  }
}

console.log(`titles.test: ${passed} assertions passed`);
