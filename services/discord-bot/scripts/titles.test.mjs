// Unit tests for the living-titles announcer: seed-silent, announce-on-change,
// no-op on same, graceful degrade when the registry column is missing. Run:
//   node scripts/titles.test.mjs   (from services/discord-bot)
import { createTitlesAnnouncer } from '../src/titles.js';
import assert from 'node:assert';

const silentLog = { info() {}, warn() {}, error() {} };

// A tiny fake supabase client that records writes and can inject a read result.
function fakeDb({ players, readError = null }) {
  const writes = { updates: [], history: [], voice: [] };
  const client = {
    writes,
    from(table) {
      return {
        select() {
          if (table === 'players') return Promise.resolve({ data: players, error: readError });
          return Promise.resolve({ data: [], error: null });
        },
        update(obj) {
          return { eq(_c, id) { writes.updates.push({ id, ...obj }); return Promise.resolve({ error: null }); } };
        },
        insert(obj) {
          if (table === 'title_history') writes.history.push(obj);
          if (table === 'voice_lines') writes.voice.push(obj);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return client;
}

function fakeApi(map) {
  const players = [...map.entries()].map(([name, title]) => ({ name, title }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ players }) });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// ── 1. Seed-silent: NULL current_title -> record, no announcement ─────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p1', character_name: 'Testman', current_title: null },
    { id: 'p2', character_name: 'Testmantwo', current_title: null },
  ] });
  fakeApi(new Map([['Testman', 'the Provider'], ['Testmantwo', 'Bane of Beasts']]));
  const ann = createTitlesAnnouncer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    apiUrl: 'http://x', log: silentLog,
  });
  const r = await ann.tick();
  ok(r.seeded === 2 && r.announced === 0, `seed pass seeds silently, got ${JSON.stringify(r)}`);
  ok(posts.length === 0, 'no #server posts on seed');
  ok(writeDb.writes.updates.length === 2, 'both current_title columns seeded');
  ok(writeDb.writes.history.length === 0 && writeDb.writes.voice.length === 0, 'no history/voice on seed');
}

// ── 2. Announce on a real change: post + history + voice, exact formats ────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p2', character_name: 'Testmantwo', current_title: 'the Steady Oar' },
  ] });
  fakeApi(new Map([['Testmantwo', 'Bane of Beasts']]));
  const ann = createTitlesAnnouncer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    apiUrl: 'http://x', log: silentLog,
  });
  const r = await ann.tick();
  ok(r.announced === 1 && r.seeded === 0, `change announced, got ${JSON.stringify(r)}`);
  ok(posts.length === 1 && posts[0].ch === 'server', 'posts to #server');
  ok(posts[0].p.content === '⚔️ **Testmantwo** has earned a new title: **Bane of Beasts**',
    `exact discord format, got: ${posts[0].p.content}`);
  ok(posts[0].p.mentionEveryone !== true, 'never pings @everyone');
  ok(writeDb.writes.history.length === 1 && writeDb.writes.history[0].title === 'Bane of Beasts',
    'title_history row inserted');
  ok(writeDb.writes.voice.length === 1 &&
     writeDb.writes.voice[0].text === 'Let the hall know Testmantwo — Bane of Beasts.' &&
     writeDb.writes.voice[0].kind === 'event' && writeDb.writes.voice[0].status === 'queued',
    `exact voice line queued, got: ${writeDb.writes.voice[0]?.text}`);
}

// ── 3. No-op when the computed title already matches ──────────────────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p1', character_name: 'Testman', current_title: 'the Provider' },
  ] });
  fakeApi(new Map([['Testman', 'the Provider']]));
  const ann = createTitlesAnnouncer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    apiUrl: 'http://x', log: silentLog,
  });
  const r = await ann.tick();
  ok(r.unchanged === 1 && r.announced === 0 && r.seeded === 0, `no-op on match, got ${JSON.stringify(r)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0, 'no writes/posts on no-op');
}

// ── 4. Graceful degrade: registry column missing -> skip, no throw ────────
{
  const posts = [];
  const writeDb = fakeDb({ players: null, readError: { code: '42703', message: 'column players.current_title does not exist' } });
  fakeApi(new Map([['Testman', 'the Provider']]));
  const ann = createTitlesAnnouncer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    apiUrl: 'http://x', log: silentLog,
  });
  const r = await ann.tick();
  ok(r.seeded === 0 && r.announced === 0 && posts.length === 0, 'missing column -> clean skip');
}

// ── 5. Dry-run: announce path posts/writes nothing ────────────────────────
{
  const posts = [];
  const writeDb = fakeDb({ players: [
    { id: 'p2', character_name: 'Testmantwo', current_title: 'the Steady Oar' },
  ] });
  fakeApi(new Map([['Testmantwo', 'Bane of Beasts']]));
  const ann = createTitlesAnnouncer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    apiUrl: 'http://x', log: silentLog, dryRun: true,
  });
  const r = await ann.tick();
  ok(r.announced === 1, 'dry-run counts the change');
  ok(posts.length === 0 && writeDb.writes.updates.length === 0 && writeDb.writes.voice.length === 0,
    'dry-run performs no side effects');
}

console.log(`titles.test: ${passed} assertions passed`);
