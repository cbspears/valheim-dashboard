// Unit tests for the living-titles announcer.
//
// Covers the old contract (seed-silent, exact Discord/voice formats, no-op on a
// match, graceful degrade, dry-run), the "sticky and rare" policy Charlie asked
// for on 2026-09-10 (hold an earned title against a hall-name, silent
// placeholder reshuffles, two-pass confirmation 15 min apart, 24 h tenure
// between earned titles, a 3-per-day budget with a deterministic ranking), and
// the ONE HOLDER PER EARNED TITLE rule of 2026-09-16: a confirmed offer of a
// title somebody already wears is a HANDOVER — the challenger takes it and the
// wearer is carried to whatever the engine names them, in one proclamation of
// two lines, for one of the day's three. Tests 8c, 8d, 8e and 10.
//
// Tests 11a-11d cover the 2026-09-17 fix for the night the hall grew three more
// duplicates and a flip-flop: the handover target must be FREE (11a, landing on
// the /api/titles `placeholder`), EVERY holder is handed off (11b), a title
// cannot change hands twice inside 24 h (11c), and the whole production shape of
// 2026-09-17 11:55 CT replays to a registry with no title worn twice (11d).
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

// [name, title, source, placeholder] -> a fetch impl returning that /api/titles
// payload. `placeholder` is the hall-name the engine would give that viking if
// they earned nothing (lib/epithets.ts); rows that omit it mimic a dashboard
// deploy from before the field existed.
function fakeApi(rows) {
  const players = rows.map(([name, title, source = 'flavor', placeholder]) =>
    placeholder === undefined ? { name, title, source } : { name, title, source, placeholder },
  );
  return async () => ({ ok: true, json: async () => ({ players }) });
}

// A log that remembers every line, for the tests that assert on one.
function recordingLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

// Apply the registry writes the fake only RECORDS, so a multi-pass test reads
// back the hall the announcer actually wrote.
function applyWrites(roster, writeDb) {
  for (const u of writeDb.writes.updates) {
    const row = roster.find((r) => r.id === u.id);
    if (!row) continue;
    row.current_title = u.current_title;
    if (u.title_updated_at) row.title_updated_at = u.title_updated_at;
  }
  writeDb.writes.updates.length = 0;
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

// ── 8c. THE TAKEOVER: a confirmed offer moves the title AND its old wearer ──
//        The 2026-09-11 shape: Kætiløy wears "the Far-Seer" under tenure while the
//        engine has already given the map crown to Rosir. The old rules held both
//        and the hall ended up with two Far-Seers. Now the confirmed challenger
//        takes it and the wearer is carried to whatever the engine names them, in
//        ONE proclamation of two lines.
{
  const posts = [];
  const c = clock();
  // (2026-09-17) The wearer's stamp moved from 2 h to 2 DAYS: rule 7 now rests a
  // title for 24 h after it changes hands, and that stamp IS the title's last
  // change of holder, so a two-hour-old crown can no longer be taken at all —
  // test 11c owns that case. What this test still proves is that the wearer's own
  // TENURE never shields them once the cool-down is served.
  const roster = [
    { id: 'h1', character_name: 'Holder', current_title: 'the Far-Seer', title_updated_at: ago(2 * DAY) },
    { id: 'c1', character_name: 'Challenger', current_title: 'of the Quiet Fjord', title_updated_at: ago(3 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: fakeApi([['Holder', 'the Ever-Present', 'hours'], ['Challenger', 'the Far-Seer', 'map']]),
    now: c.now,
  });

  // Pass 1: nothing moves. The challenger waits because the wearer's own offer
  // has not proven itself yet (rule 4b), and the wearer is only confirming.
  const first = await ann.tick();
  ok(first.held === 1 && first.confirming === 1 && first.announced === 0,
    `first pass moves nobody, got ${JSON.stringify(first)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0, 'and writes nothing');

  // Pass 2, a confirm window later: the wearer's move is proven, so the
  // challenger's own confirmed offer resolves the pair in one go. Neither the
  // wearer's tenure nor their own pending move protects the title (uniqueness
  // beats stickiness).
  c.advance(16 * MIN);
  const second = await ann.tick();
  ok(second.announced === 1, `the takeover is one proclamation, got ${JSON.stringify(second)}`);
  ok(posts.length === 1, `and one Discord message, got ${posts.length}`);

  const lines = posts[0].split('\n');
  ok(lines.length === 2, `the proclamation is two lines, got ${lines.length}: ${posts[0]}`);
  ok(lines[0] === '⚔️ **Challenger** has earned a new title: **the Far-Seer**',
    `line one keeps the plain crown format, got: ${lines[0]}`);
  ok(lines[1] === '**Holder** passes **the Far-Seer** to **Challenger** and takes up **the Ever-Present**.',
    `line two is the handover, got: ${lines[1]}`);
  ok(!posts[0].includes('—') && !posts[0].includes('–'), 'no em or en dash in the proclamation');

  ok(writeDb.writes.voice.length === 1,
    `one voice line for the handover, got ${writeDb.writes.voice.length}`);
  ok(writeDb.writes.voice[0].text ===
      'From tonight, Challenger goes by the Far-Seer, and Holder takes up the Ever-Present.',
    `exact handover voice line, got: ${writeDb.writes.voice[0].text}`);

  // Both registry rows are written, and the budget is charged ONCE.
  const byId = Object.fromEntries(writeDb.writes.updates.map((u) => [u.id, u.current_title]));
  ok(byId.c1 === 'the Far-Seer' && byId.h1 === 'the Ever-Present',
    `both rows re-titled, got ${JSON.stringify(byId)}`);
  ok(writeDb.writes.history.length === 1 && writeDb.writes.history[0].player_id === 'c1',
    `a handover costs one proclamation, got ${JSON.stringify(writeDb.writes.history)}`);

  // Mirror the registry writes the fake does not apply, then prove it settles.
  roster[0].current_title = 'the Ever-Present';
  roster[0].title_updated_at = new Date(c.now()).toISOString();
  roster[1].current_title = 'the Far-Seer';
  roster[1].title_updated_at = new Date(c.now()).toISOString();
  c.advance(HOUR);
  const third = await ann.tick();
  ok(third.unchanged === 2 && third.announced === 0,
    `the hall settles and stays settled, got ${JSON.stringify(third)}`);
}

// ── 8d. The old wearer takes up whatever the engine offers, hall-name included ──
//        A demotion to a placeholder is still never spontaneous (rule 1), but it
//        is exactly what a takeover does to a wearer the engine has nothing else
//        for. Without this the title could never leave them at all.
{
  const posts = [];
  const c = clock();
  const roster = [
    { id: 'h2', character_name: 'Oldtimer', current_title: 'Stonewright', title_updated_at: ago(9 * DAY) },
    { id: 'c2', character_name: 'Upstart', current_title: 'the Unhurried', title_updated_at: ago(9 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    // The engine has nothing earned left for Oldtimer: it offers a hall-name.
    fetchImpl: fakeApi([['Oldtimer', 'the Quiet Flame', 'flavor'], ['Upstart', 'Stonewright', 'builds']]),
    now: c.now,
  });
  const first = await ann.tick();
  ok(first.held === 1 && first.confirming === 1 && first.announced === 0,
    `the wearer is held against the hall-name while the challenger confirms, got ${JSON.stringify(first)}`);
  c.advance(16 * MIN);
  const second = await ann.tick();
  ok(second.announced === 1 && posts.length === 1, `one proclamation, got ${JSON.stringify(second)}`);
  ok(posts[0].split('\n')[1] === '**Oldtimer** passes **Stonewright** to **Upstart** and takes up **the Quiet Flame**.',
    `the wearer is named as taking up the hall-name, got: ${posts[0]}`);
  const byId = Object.fromEntries(writeDb.writes.updates.map((u) => [u.id, u.current_title]));
  ok(byId.c2 === 'Stonewright' && byId.h2 === 'the Quiet Flame',
    `both rows written, got ${JSON.stringify(byId)}`);
  ok(writeDb.writes.history.length === 1, 'still one history row');
}

// ── 8e. Rule 4b: no duplicate is ever opened while the wearer is mid-move ─────
//        The wearer keeps being offered something new, so their own move never
//        proves itself. The challenger's clock runs the whole time (so the moment
//        the wearer settles it is already confirmed), but nothing is written.
{
  const posts = [];
  const c = clock();
  const roster = [
    { id: 'h3', character_name: 'Wearer', current_title: 'the Provider', title_updated_at: ago(9 * DAY) },
    { id: 'c3', character_name: 'Rival', current_title: 'the Unhurried', title_updated_at: ago(9 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster });
  let payload = fakeApi([['Wearer', 'Bane of Beasts', 'kills'], ['Rival', 'the Provider', 'resources']]);
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: (...a) => payload(...a), now: c.now,
  });
  await ann.tick();
  c.advance(16 * MIN);
  // The engine changes its mind about the wearer, restarting THEIR clock.
  payload = fakeApi([['Wearer', 'the Forgehand', 'crafts'], ['Rival', 'the Provider', 'resources']]);
  const second = await ann.tick();
  ok(second.announced === 0 && second.held === 1,
    `the rival waits while the wearer is unsettled, got ${JSON.stringify(second)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0, 'and no second Provider is written');
  // The wearer settles: their offer stands a whole window, so the pair resolves.
  c.advance(16 * MIN);
  const third = await ann.tick();
  ok(third.announced === 1 && posts.length === 1, `then it resolves, got ${JSON.stringify(third)}`);
  ok(posts[0].split('\n')[1] === '**Wearer** passes **the Provider** to **Rival** and takes up **the Forgehand**.',
    `and it resolves as a handover, got: ${posts[0]}`);
  ok(writeDb.writes.history.length === 1, 'one proclamation for the pair');
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
    // Charleif is not deferred: Zulf's offer is of the very title Charleif wears,
    // so Zulf's proclamation is a HANDOVER that carries Charleif to the Far-Seer
    // he was already confirmed for. One proclamation, two vikings re-titled, and
    // only Dvalinn is left waiting for tomorrow's budget.
    ok(r.announced === 3 && r.deferred === 1, `budget caps the pass at 3, got ${JSON.stringify(r)}`);
    const named = posts.map((p) => p.split('**')[1]);
    ok(JSON.stringify(named) === JSON.stringify(['Alfvin', 'Zulf', 'Bjorn']),
      `ranking = first titles (alphabetical), then combat crowns, got ${JSON.stringify(named)}`);
    ok(posts[1].includes('**Charleif** passes **the Forgehand** to **Zulf** and takes up **the Far-Seer**.'),
      `and the handover is the second line of Zulf's proclamation, got: ${posts[1]}`);
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

// ── 10. RECONCILIATION: the three duplicates production carried on 2026-09-16 ──
//        Bane of Beasts (Thorfinn, Mikael), Stonewright (S'aeien, Kætiløy) and
//        the Heavy-Handed (Psifour, Yonk) were each worn by two vikings, because
//        the old rule 1 kept an earned title on its holder forever while the
//        engine crowned the new leader. No SQL is needed to clear them: the
//        engine already names one wearer per title, so the other is offered their
//        own rung and resolves through the ordinary confirm-then-proclaim path.
{
  const posts = [];
  const c = clock();
  const roster = [
    { id: 't', character_name: 'Thorfinn', current_title: 'Bane of Beasts', title_updated_at: ago(6 * DAY) },
    { id: 'm', character_name: 'Mikael', current_title: 'Bane of Beasts', title_updated_at: ago(2 * DAY) },
    { id: 's', character_name: "S'aeien", current_title: 'Stonewright', title_updated_at: ago(6 * DAY) },
    { id: 'k', character_name: 'Kætiløy', current_title: 'Stonewright', title_updated_at: ago(2 * DAY) },
    { id: 'p', character_name: 'Psifour', current_title: 'the Heavy-Handed', title_updated_at: ago(2 * DAY) },
    { id: 'y', character_name: 'Yonk', current_title: 'the Heavy-Handed', title_updated_at: ago(6 * DAY) },
  ];
  // What the engine says today: one wearer per title, the other on their rank-2.
  const offers = fakeApi([
    ['Thorfinn', 'Beast-Hewer', 'kills'],
    ['Mikael', 'Bane of Beasts', 'kills'],
    ["S'aeien", 'the Timber-Wise', 'builds'],
    ['Kætiløy', 'Stonewright', 'builds'],
    ['Psifour', 'the Heavy-Handed', 'damage'],
    ['Yonk', 'the Bone-Breaker', 'damage'],
  ]);
  const writeDb = fakeDb({ players: roster, history: [] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: offers, now: c.now,
  });

  const first = await ann.tick();
  ok(first.announced === 0 && first.confirming === 3 && first.unchanged === 3,
    `the first pass only confirms the three movers, got ${JSON.stringify(first)}`);

  c.advance(16 * MIN);
  const second = await ann.tick();
  ok(second.announced === 3 && second.deferred === 0,
    `all three duplicates clear inside one day's budget, got ${JSON.stringify(second)}`);

  // Apply the writes the fake records, then read the hall back.
  const wrote = new Map(writeDb.writes.updates.map((u) => [u.id, u.current_title]));
  for (const row of roster) if (wrote.has(row.id)) row.current_title = wrote.get(row.id);
  const worn = roster.map((r) => r.current_title);
  ok(new Set(worn).size === worn.length, `no title is worn twice any more, got [${worn.join(', ')}]`);
  ok(wrote.get('t') === 'Beast-Hewer' && wrote.get('s') === 'the Timber-Wise' && wrote.get('y') === 'the Bone-Breaker',
    `each runner-up takes their own rung, got ${JSON.stringify([...wrote])}`);
  ok(!wrote.has('m') && !wrote.has('k') && !wrote.has('p'),
    'and the wearer the engine kept is not written at all');
  ok(writeDb.writes.history.length === 3, 'three proclamations, three history rows');
  ok(posts.every((line) => !line.includes('\n')),
    'none of them is a handover: the engine had already picked a wearer for each title');

  // And it stays clean: the next pass has nothing to say.
  c.advance(HOUR);
  const third = await ann.tick();
  ok(third.announced === 0 && third.unchanged === 6,
    `the hall settles on six distinct titles, got ${JSON.stringify(third)}`);
}

// ── 11a. The handover target must be FREE (rule 1a) ───────────────────────
//        Production, 2026-09-17 19:23: "Halldor: the Cheerful Ballast ->
//        Bane of the Forsaken (taken from Charleif, who takes up the Forgehand)"
//        — and S'aeien was already wearing the Forgehand. The engine's offer for
//        a dethroned wearer is only usable when nobody else wears it; here it is
//        not, so Charleif lands on the PLACEHOLDER /api/titles publishes for him.
{
  const posts = [];
  const c = clock();
  const roster = [
    { id: 'x1', character_name: 'Charleif', current_title: 'Bane of the Forsaken', title_updated_at: ago(5 * DAY) },
    { id: 'x2', character_name: "S'aeien", current_title: 'the Forgehand', title_updated_at: ago(5 * DAY) },
    { id: 'x3', character_name: 'Halldor', current_title: 'the Cheerful Ballast', title_updated_at: ago(5 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster, history: [] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: fakeApi([
      ['Halldor', 'Bane of the Forsaken', 'bossdmg', 'the Cheerful Ballast'],
      // The engine wants to move Charleif onto a title a third viking wears.
      ['Charleif', 'the Forgehand', 'crafts', 'the Quiet Flame'],
      ["S'aeien", 'the Forgehand', 'crafts', 'Mead-Tested'],
    ]),
    now: c.now,
  });

  await ann.tick();
  c.advance(16 * MIN);
  const r = await ann.tick();
  ok(r.announced === 1, `one proclamation, got ${JSON.stringify(r)}`);
  ok(posts[0].split('\n')[1] ===
      '**Charleif** passes **Bane of the Forsaken** to **Halldor** and takes up **the Quiet Flame**.',
    `the dethroned wearer lands on their placeholder, not on the worn title, got: ${posts[0]}`);
  ok(!posts[0].includes('takes up **the Forgehand**'),
    'the Forgehand is never handed to a second viking');

  applyWrites(roster, writeDb);
  const worn = roster.map((x) => x.current_title);
  ok(new Set(worn).size === worn.length, `no title is worn twice, got [${worn.join(', ')}]`);
  ok(roster[1].current_title === 'the Forgehand', "and S'aeien keeps the title she was wearing");
}

// ── 11b. EVERY holder is handed off, for one budget slot (rule 1b) ────────
//        Production, 2026-09-17 10:23: Asbjorn took Bane of Beasts from Mikael
//        while Thorfinn, who ALSO wore it, was left on it. Now both step off, in
//        one proclamation of three lines and one title_history row.
{
  const posts = [];
  const c = clock();
  const roster = [
    { id: 'b1', character_name: 'Thorfinn', current_title: 'Bane of Beasts', title_updated_at: ago(6 * DAY) },
    { id: 'b2', character_name: 'Mikael', current_title: 'Bane of Beasts', title_updated_at: ago(5 * DAY) },
    { id: 'b3', character_name: 'Asbjorn', current_title: 'the Late-Rising', title_updated_at: ago(5 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster, history: [] });
  const ann = announcer({
    db: writeDb, writeDb, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: fakeApi([
      ['Asbjorn', 'Bane of Beasts', 'kills', 'the Late-Rising'],
      ['Thorfinn', 'Beast-Hewer', 'kills', 'Frost-Patient'],
      ['Mikael', 'the Heavy-Handed', 'damage', 'the Unhurried'],
    ]),
    now: c.now,
  });

  await ann.tick();
  c.advance(16 * MIN);
  const r = await ann.tick();
  ok(r.announced === 1 && r.deferred === 0,
    `both holders move inside ONE budget slot, got ${JSON.stringify(r)}`);
  ok(posts.length === 1, `one Discord message, got ${posts.length}`);
  const lines = posts[0].split('\n');
  ok(lines.length === 3, `three lines: the crown and one per outgoing holder, got ${lines.length}`);
  ok(lines[0] === '⚔️ **Asbjorn** has earned a new title: **Bane of Beasts**', `line one, got: ${lines[0]}`);
  ok(lines[1] === '**Thorfinn** passes **Bane of Beasts** to **Asbjorn** and takes up **Beast-Hewer**.',
    `line two, got: ${lines[1]}`);
  ok(lines[2] === '**Mikael** passes **Bane of Beasts** to **Asbjorn** and takes up **the Heavy-Handed**.',
    `line three, got: ${lines[2]}`);
  ok(writeDb.writes.voice.length === 1 &&
     writeDb.writes.voice[0].text ===
       'From tonight, Asbjorn goes by Bane of Beasts, and Thorfinn takes up Beast-Hewer, and Mikael takes up the Heavy-Handed.',
    `one voice line names all three, got: ${writeDb.writes.voice[0]?.text}`);
  ok(writeDb.writes.history.length === 1, 'and it costs one proclamation, not two');
  ok(writeDb.writes.updates.length === 3, 'all three registry rows are written');

  applyWrites(roster, writeDb);
  const worn = roster.map((x) => x.current_title);
  ok(new Set(worn).size === worn.length, `nobody is left on Bane of Beasts, got [${worn.join(', ')}]`);
}

// ── 11c. TAKEOVER COOL-DOWN: blocked at 5 h, allowed at 25 h (rule 7) ─────
//        The Yonk -> Fjällhnot -> Yonk flip-flop of 2026-09-17: both hops were
//        confirmed and legal, five hours apart. A title now rests a day after it
//        changes hands; the challenger waits and the wearer is not disturbed.
{
  const posts = [];
  const c = clock();
  const rec = recordingLog();
  const roster = [
    { id: 'f1', character_name: 'Fjällhnot', current_title: 'the Heavy-Handed', title_updated_at: ago(5 * HOUR) },
    { id: 'y1', character_name: 'Yonk', current_title: 'of the Spare Cloak', title_updated_at: ago(9 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster, history: [] });
  const ann = announcer({
    db: writeDb, writeDb, log: rec, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: fakeApi([
      ['Yonk', 'the Heavy-Handed', 'damage', 'of the Spare Cloak'],
      ['Fjällhnot', 'the Quiet Flame', 'flavor', 'the Quiet Flame'],
    ]),
    now: c.now,
  });

  await ann.tick();
  c.advance(16 * MIN); // the offer is confirmed, but the title changed hands 5 h ago
  const blocked = await ann.tick();
  ok(blocked.announced === 0 && blocked.held === 2,
    `a confirmed challenger still waits out the cool-down, got ${JSON.stringify(blocked)}`);
  ok(posts.length === 0 && writeDb.writes.updates.length === 0,
    'nothing is proclaimed and nothing is written while the title rests');
  ok(rec.lines.includes('[titles] Yonk: waiting: "the Heavy-Handed" changed hands 5 h ago'),
    `the wait is logged with the title's age, got: ${JSON.stringify(rec.lines)}`);
  ok(roster[0].current_title === 'the Heavy-Handed', 'the wearer is not disturbed');

  c.advance(20 * HOUR); // 25 h 16 min after the title last changed hands
  const allowed = await ann.tick();
  ok(allowed.announced === 1, `past 24 h the takeover goes through, got ${JSON.stringify(allowed)}`);
  ok(posts[0].split('\n')[1] ===
      '**Fjällhnot** passes **the Heavy-Handed** to **Yonk** and takes up **the Quiet Flame**.',
    `and it is an ordinary handover, got: ${posts[0]}`);
}

// ── 11d. The whole production shape of 2026-09-17, replayed ───────────────
//        The registry as the bot journal left it at 11:55 CT (three titles worn
//        twice), with the offers that produced that night's six proclamations.
//        One pass now resolves it with no title worn twice, and the flip-flop
//        that followed is refused for a day.
{
  const posts = [];
  const c = clock();
  const rec = recordingLog();
  const roster = [
    { id: 'p', character_name: 'Psifour', current_title: 'the Heavy-Handed', title_updated_at: ago(6 * DAY) },
    { id: 'u', character_name: 'Yunter', current_title: 'the Provider', title_updated_at: ago(6 * DAY) },
    { id: 's', character_name: "S'aeien", current_title: 'Stonewright', title_updated_at: ago(6 * DAY) },
    { id: 'a', character_name: 'Asbjorn', current_title: 'the Forgehand', title_updated_at: ago(6 * DAY) },
    { id: 'f', character_name: 'Fjällhnot', current_title: 'the Ever-Present', title_updated_at: ago(6 * DAY) },
    { id: 'y', character_name: 'Yonk', current_title: 'the Heavy-Handed', title_updated_at: ago(6 * DAY) },
    { id: 'h', character_name: 'Halldor', current_title: 'the Cheerful Ballast', title_updated_at: ago(6 * DAY) },
    { id: 'c', character_name: 'Charleif', current_title: 'Bane of the Forsaken', title_updated_at: ago(6 * DAY) },
    { id: 'm', character_name: 'Mikael', current_title: 'Bane of Beasts', title_updated_at: ago(6 * DAY) },
    { id: 't', character_name: 'Thorfinn', current_title: 'Bane of Beasts', title_updated_at: ago(6 * DAY) },
  ];
  const writeDb = fakeDb({ players: roster, history: [] });
  let payload = fakeApi([
    ['Psifour', 'the Provider', 'resources', 'Mead-Tested'],
    ['Yunter', 'the Sea-Wolf', 'sail', 'the Steady Oar'],
    ["S'aeien", 'the Forgehand', 'crafts', 'the Soft-Spoken'],
    ['Asbjorn', 'Bane of Beasts', 'kills', 'the Late-Rising'],
    ['Fjällhnot', 'the Heavy-Handed', 'damage', 'Friend to Fog'],
    ['Yonk', 'of the Spare Cloak', 'flavor', 'of the Spare Cloak'],
    ['Halldor', 'Bane of the Forsaken', 'bossdmg', 'the Cheerful Ballast'],
    ['Charleif', 'the Forgehand', 'crafts', 'the Quiet Flame'],
    ['Mikael', 'the Bone-Breaker', 'damage', 'the Unbossed'],
    ['Thorfinn', 'Beast-Hewer', 'kills', 'the Half-Heard'],
  ]);
  const ann = announcer({
    db: writeDb, writeDb, log: rec, post: (ch, p) => { posts.push(p.content); return Promise.resolve(); },
    fetchImpl: (...a) => payload(...a), now: c.now, perDay: 8,
  });

  const first = await ann.tick();
  ok(first.announced === 0, `the first pass only confirms, got ${JSON.stringify(first)}`);
  c.advance(16 * MIN);
  const second = await ann.tick();
  ok(second.announced === 5 && second.deferred === 0,
    `the night resolves in five proclamations, got ${JSON.stringify(second)}`);
  ok(writeDb.writes.history.length === 5, 'five proclamations, five history rows');

  applyWrites(roster, writeDb);
  const worn = roster.map((x) => x.current_title);
  ok(new Set(worn).size === worn.length,
    `ZERO duplicates across the whole registry, got [${worn.join(', ')}]`);
  const by = Object.fromEntries(roster.map((x) => [x.id, x.current_title]));
  ok(by.a === 'Bane of Beasts' && by.m === 'the Bone-Breaker' && by.t === 'Beast-Hewer',
    `both Bane of Beasts wearers stepped off together, got ${JSON.stringify(by)}`);
  ok(by.f === 'the Heavy-Handed' && by.p === 'Mead-Tested' && by.y === 'of the Spare Cloak',
    `both Heavy-Handed wearers stepped off, and Psifour took his placeholder because Yunter still wore the Provider, got ${JSON.stringify(by)}`);
  ok(by.h === 'Bane of the Forsaken' && by.c === 'the Quiet Flame' && by.s === 'the Forgehand',
    `Charleif is NOT handed the Forgehand S'aeien wears, got ${JSON.stringify(by)}`);

  // 13:35 -> 18:33 in the journal: the Heavy-Handed swaps back five hours later.
  payload = fakeApi([
    ['Psifour', 'Mead-Tested', 'flavor', 'Mead-Tested'],
    ['Yunter', 'the Sea-Wolf', 'sail', 'the Steady Oar'],
    ["S'aeien", 'the Forgehand', 'crafts', 'the Soft-Spoken'],
    ['Asbjorn', 'Bane of Beasts', 'kills', 'the Late-Rising'],
    ['Fjällhnot', 'Friend to Fog', 'flavor', 'Friend to Fog'],
    ['Yonk', 'the Heavy-Handed', 'damage', 'of the Spare Cloak'],
    ['Halldor', 'Bane of the Forsaken', 'bossdmg', 'the Cheerful Ballast'],
    ['Charleif', 'the Quiet Flame', 'flavor', 'the Quiet Flame'],
    ['Mikael', 'the Bone-Breaker', 'damage', 'the Unbossed'],
    ['Thorfinn', 'Beast-Hewer', 'kills', 'the Half-Heard'],
  ]);
  c.advance(5 * HOUR);
  await ann.tick();
  c.advance(16 * MIN);
  const flip = await ann.tick();
  ok(flip.announced === 0, `the five-hour flip-flop is refused, got ${JSON.stringify(flip)}`);
  ok(rec.lines.some((l) => l.startsWith('[titles] Yonk: waiting: "the Heavy-Handed" changed hands 5 h ago')),
    'and the refusal says how long ago the title changed hands');

  applyWrites(roster, writeDb);
  const stillWorn = roster.map((x) => x.current_title);
  ok(new Set(stillWorn).size === stillWorn.length,
    `waiting never creates a duplicate, got [${stillWorn.join(', ')}]`);
  ok(roster.find((x) => x.id === 'f').current_title === 'the Heavy-Handed',
    'and the wearer keeps it until a day has passed');

  // A day later the same offer is honoured — the cool-down delays a change of
  // holder, it never forbids one.
  c.advance(20 * HOUR);
  const later = await ann.tick();
  ok(later.announced === 1, `past the cool-down it goes through, got ${JSON.stringify(later)}`);
  applyWrites(roster, writeDb);
  const finalWorn = roster.map((x) => x.current_title);
  ok(new Set(finalWorn).size === finalWorn.length,
    `and the hall is still free of duplicates, got [${finalWorn.join(', ')}]`);
}

console.log(`titles.test: ${passed} assertions passed`);
