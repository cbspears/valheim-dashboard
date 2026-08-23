// Unit tests for the Voice of the Hall: per-player death tiers, the every-3rd-
// world-day dawn line, the ambient global min-gap, and the quiet-night whisper
// pool swap. Run:
//   node scripts/voice.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import {
  createVoiceEngine,
  deathTier,
  deathMilestoneLine,
  DAWN,
  ATMOSPHERE,
  CALLBACK_TEMPLATES,
  DEATH_LINES,
  SOLO_WHISPERS,
  CREW_WHISPERS,
} from '../src/voice.js';

const silentLog = { info() {}, warn() {}, error() {} };

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// A chainable fake supabase client: every builder method records its call and
// returns the same thenable, so `await db.from(t).select().eq()...` resolves
// through one handler.
function fakeClient(handler) {
  return {
    from(table) {
      const ops = [];
      const q = {};
      const chain = (name) => (...args) => { ops.push({ op: name, args }); return q; };
      for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'is', 'not', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
        q[m] = chain(m);
      }
      q.maybeSingle = () => Promise.resolve(handler(table, ops, 'maybeSingle'));
      q.single = q.maybeSingle;
      q.then = (onOk, onErr) => Promise.resolve(handler(table, ops, 'list')).then(onOk, onErr);
      return q;
    },
  };
}

// One fixture drives both the read and the write client (service role in prod).
function harness({
  players = [],
  stats = [],
  status = { is_online: true, player_count: 2, world_day: 5 },
  oaths = [],
  deathEvents = [],
  recentEvents = [],        // rows the 45-min "was it a quiet night?" probe sees
  lastVoiceQueuedAt = null, // ISO string or null (= hall has never spoken)
  state = {},
  minGapMs,
} = {}) {
  const fixture = { players, stats, status, oaths, deathEvents, recentEvents, lastVoiceQueuedAt };
  const queued = [];
  const handler = (table, ops, mode) => {
    const insert = ops.find((o) => o.op === 'insert');
    if (insert) {
      if (table === 'voice_lines') queued.push(insert.args[0]);
      return { data: null, error: null };
    }
    if (ops.some((o) => o.op === 'update')) return { data: null, error: null };
    if (table === 'server_status') return { data: fixture.status, error: null };
    if (table === 'players') return { data: fixture.players, error: null };
    if (table === 'player_stats') return { data: fixture.stats, error: null };
    if (table === 'oaths') return { data: fixture.oaths, error: null };
    if (table === 'events') {
      // Two different reads hit `events`: the callback hunt (selects the death
      // columns) and the quiet-night probe (selects just `id`).
      const sel = String(ops.find((o) => o.op === 'select')?.args?.[0] ?? '');
      return { data: sel.includes('character_name') ? fixture.deathEvents : fixture.recentEvents, error: null };
    }
    if (table === 'voice_lines') {
      return { data: fixture.lastVoiceQueuedAt ? [{ queued_at: fixture.lastVoiceQueuedAt }] : [], error: null };
    }
    return { data: [], error: null };
  };
  const db = fakeClient(handler);
  const posts = [];
  const voice = createVoiceEngine({
    client: { user: { id: 'bot' }, on() {} },
    db,
    writeDb: db,
    post: (ch, p) => { posts.push({ ch, p }); return Promise.resolve(); },
    state,
    saveState: async () => {},
    log: silentLog,
    ...(minGapMs === undefined ? {} : { minGapMs }),
  });
  return { voice, state, queued, posts, fixture };
}

const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

// ── 1. Tier maths: 20 / 50 / 100 / every +100 ────────────────────────────
{
  ok(deathTier(0) === 0 && deathTier(19) === 0, 'below 20 is no tier');
  ok(deathTier(20) === 20 && deathTier(49) === 20, '20..49 -> tier 20');
  ok(deathTier(50) === 50 && deathTier(99) === 50, '50..99 -> tier 50');
  ok(deathTier(100) === 100 && deathTier(199) === 100, '100..199 -> tier 100');
  ok(deathTier(200) === 200 && deathTier(250) === 200 && deathTier(700) === 700,
    'past 100 a tier every +100');
  ok(deathMilestoneLine(200, 'Bob Ross').startsWith('200 deaths, Bob.'),
    `generic tier line interpolates count+first name, got: ${deathMilestoneLine(200, 'Bob Ross')}`);
}

// ── 2. First pass seeds tiers SILENTLY (no storm on an existing roster) ───
{
  const h = harness({
    players: [{ id: 'p1', character_name: 'Steve' }, { id: 'p2', character_name: 'Psifour' }],
    stats: [{ player_id: 'p1', deaths: 37 }, { player_id: 'p2', deaths: 4 }],
  });
  await h.voice.tick();
  ok(h.queued.length === 0, 'seed pass queues nothing');
  ok(h.state.voice.deathTiersSeeded === true, 'seed flag set');
  ok(h.state.voice.deathTiers.Steve === 20, 'Steve adopted at tier 20');
  ok(h.state.voice.deathTiers.Psifour === undefined, 'a viking below 20 gets no tier entry');
}

// ── 3. Crossing a tier announces ONCE, in register, exempt from the gap ───
{
  const h = harness({
    players: [{ id: 'p1', character_name: 'Steve' }],
    stats: [{ player_id: 'p1', deaths: 37 }],
    lastVoiceQueuedAt: minsAgo(1), // the hall spoke a minute ago: events don't care
    state: { voice: { deathTiersSeeded: true, deathTiers: { Steve: 20 } } },
  });
  h.fixture.stats[0].deaths = 50;
  await h.voice.tick();
  ok(h.queued.length === 1, `tier 50 announced despite a 1-minute-old line, got ${h.queued.length}`);
  ok(h.queued[0].text === 'Fifty deaths for Steve. The ravens know that name by heart now — and still it walks back in through the door.',
    `exact tier-50 copy, got: ${h.queued[0].text}`);
  ok(h.queued[0].kind === 'event' && h.queued[0].meta.source === 'deaths' && h.queued[0].meta.tier === 50,
    'queued as an event line with death meta');
  await h.voice.tick();
  ok(h.queued.length === 1, 'the same tier never fires twice');
  ok(h.state.voice.deathTiers.Steve === 50, 'tier recorded in state');

  h.fixture.stats[0].deaths = 250;
  await h.voice.tick();
  ok(h.queued.length === 2 && h.queued[1].meta.tier === 200,
    `a jump past several tiers announces the highest one, got ${h.queued[1]?.meta?.tier}`);
}

// ── 4. A viking who joins after seeding starts from zero ─────────────────
{
  const h = harness({
    players: [{ id: 'p1', character_name: 'Steve' }, { id: 'p9', character_name: 'Newcomer' }],
    stats: [{ player_id: 'p1', deaths: 50 }, { player_id: 'p9', deaths: 19 }],
    state: { voice: { deathTiersSeeded: true, deathTiers: { Steve: 50 } } },
  });
  await h.voice.tick();
  ok(h.queued.length === 0, 'a newcomer at 19 deaths says nothing');
  h.fixture.stats[1].deaths = 20;
  await h.voice.tick();
  ok(h.queued.length === 1 && h.queued[0].text.startsWith('Mark it in the saga: Newcomer has fallen twenty times'),
    `newcomer crossing 20 fires the tier-20 line, got: ${h.queued[0]?.text}`);
}

// ── 5. Duplicate players rows never multiply a viking's tally ────────────
{
  const h = harness({
    players: [
      { id: 'p1', character_name: 'Testman' },
      { id: 'p2', character_name: 'Testman' },
      { id: 'p3', character_name: 'Testman' },
    ],
    stats: [
      { player_id: 'p1', deaths: 20 },
      { player_id: 'p2', deaths: 18 },
      { player_id: 'p3', deaths: 20 },
    ],
    state: { voice: { deathTiersSeeded: true, deathTiers: {} } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1, `three dup rows -> one proclamation, got ${h.queued.length}`);
}

// ── 6. Dawn: every 3rd world day, once, only to a populated hall ─────────
{
  const h = harness({
    status: { is_online: true, player_count: 3, world_day: 9 },
    lastVoiceQueuedAt: minsAgo(2), // gap-exempt
    state: { voice: { deathTiersSeeded: true } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1 && h.queued[0].meta.source === 'dawn', 'day 9 fires a dawn line');
  ok(h.queued[0].kind === 'ambient' && /\b9\b/.test(h.queued[0].text),
    `dawn line carries the day number, got: ${h.queued[0].text}`);
  ok(h.state.voice.lastDawnDay === 9, 'lastDawnDay recorded');

  await h.voice.tick();
  ok(h.queued.length === 1, 'the same world day never speaks twice');

  h.fixture.status.world_day = 10;
  await h.voice.tick();
  ok(h.queued.length === 1, 'day 10 is not a dawn day');

  h.fixture.status.world_day = 12;
  await h.voice.tick();
  ok(h.queued.length === 2 && h.state.voice.lastDawnDay === 12, 'day 12 fires the next dawn line');
}

{
  const h = harness({
    status: { is_online: true, player_count: 0, world_day: 12 },
    state: { voice: { deathTiersSeeded: true } },
  });
  await h.voice.tick();
  ok(h.queued.length === 0 && h.state.voice.lastDawnDay == null,
    'no dawn line to an empty hall, and the day is not burned');
}

{
  // World wipe: the day counter goes back to 3 after a lastDawnDay of 300.
  const h = harness({
    status: { is_online: true, player_count: 1, world_day: 3 },
    state: { voice: { deathTiersSeeded: true, lastDawnDay: 300 } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1, 'a wiped world starts the dawn cycle over');
}

// ── 7. Ambient: 2h cadence AND the global min-gap ────────────────────────
{
  const h = harness({
    status: { is_online: true, player_count: 2, world_day: 5 }, // 5 % 3 != 0: no dawn
    lastVoiceQueuedAt: minsAgo(5),
    state: { voice: { deathTiersSeeded: true, onlineMinutes: 119 } },
  });
  await h.voice.tick();
  ok(h.queued.length === 0, 'cadence due but the hall spoke 5 minutes ago -> held');
  ok(h.state.voice.onlineMinutes >= 120, 'the owed cadence is held, not thrown away');

  h.fixture.lastVoiceQueuedAt = minsAgo(45);
  await h.voice.tick();
  ok(h.queued.length === 1, 'gap cleared -> the held ambient line goes out');
  ok(h.queued[0].kind === 'ambient' && /^atmo:/.test(h.queued[0].meta.template),
    `ambient line queued from the atmosphere pool, got: ${JSON.stringify(h.queued[0].meta)}`);
  ok(h.state.voice.onlineMinutes === 0, 'cadence clock reset after a successful ambient line');
}

{
  const h = harness({
    status: { is_online: true, player_count: 2, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(120),
    state: { voice: { deathTiersSeeded: true, onlineMinutes: 10 } },
  });
  await h.voice.tick();
  ok(h.queued.length === 0, 'gap clear but cadence not due -> still silent');
}

{
  const h = harness({
    status: { is_online: true, player_count: 2, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(1),
    state: { voice: { deathTiersSeeded: true, onlineMinutes: 200 } },
    minGapMs: 0,
  });
  await h.voice.tick();
  ok(h.queued.length === 1, 'VOICE_MIN_GAP_MS=0 disables the ambient gap');
}

{
  const h = harness({
    status: { is_online: false, player_count: 0, world_day: 5 },
    state: { voice: { deathTiersSeeded: true, onlineMinutes: 500 } },
  });
  await h.voice.tick();
  ok(h.queued.length === 0, 'never speaks to an empty hall, however overdue');
}

// ── 8. Whispers on quiet nights — a POOL SWAP, not extra volume ──────────
// The ambient slot (2h clock + min-gap) is unchanged; only which pool fills it.
const ambientDue = { deathTiersSeeded: true, onlineMinutes: 200 };
const firstNames = (rows) => rows.map((r) => r.character_name.split(' ')[0]);

{
  // Exactly one viking online -> the SOLO whisper pool, naming them.
  const h = harness({
    players: [{ id: 'p1', character_name: 'Steve Stevenson', is_online: true }],
    status: { is_online: true, player_count: 1, world_day: 5 }, // 5 % 3 != 0: no dawn
    lastVoiceQueuedAt: minsAgo(120),
    state: { voice: { ...ambientDue } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1, `the lone viking still gets exactly one ambient line, got ${h.queued.length}`);
  ok(h.queued[0].kind === 'ambient' && h.queued[0].meta.source === 'whisper'
    && /^solo:/.test(h.queued[0].meta.template),
    `solo whisper takes the ambient slot, got: ${JSON.stringify(h.queued[0].meta)}`);
  ok(h.queued[0].text.includes('Steve') && !h.queued[0].text.includes('{firstName}'),
    `the whisper says the viking's first name, got: ${h.queued[0].text}`);

  const cand = await h.voice._buildWhispers({ playerCount: 1, worldDay: 5 });
  ok(cand.length === SOLO_WHISPERS.length && cand.every((c) => /^solo:\d+$/.test(c.id)),
    `the whole solo pool is offered, got ${cand.length}`);
  ok(cand.every((c) => c.text.includes('Steve') && !c.text.includes('{firstName}')),
    'every solo line names the online viking');
}

{
  // 2-3 online and nothing eventful for 45 minutes -> the QUIET-CREW pool.
  const crew = [
    { id: 'p1', character_name: 'Astrid Shieldmaiden', is_online: true },
    { id: 'p2', character_name: 'Bjorn Ironside', is_online: true },
    { id: 'p3', character_name: 'Ghost Ofthepast', is_online: false },
  ];
  const h = harness({
    players: crew,
    status: { is_online: true, player_count: 2, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(120),
    recentEvents: [],
    state: { voice: { ...ambientDue } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1 && /^crew:/.test(h.queued[0].meta.template)
    && h.queued[0].meta.source === 'whisper',
    `a quiet two-hander gets the crew pool, got: ${JSON.stringify(h.queued[0]?.meta)}`);

  const cand = await h.voice._buildWhispers({ playerCount: 2, worldDay: 5 });
  ok(cand.length === CREW_WHISPERS.length && cand.every((c) => /^crew:\d+$/.test(c.id)),
    `the whole crew pool is offered, got ${cand.length}`);
  ok(cand.every((c) => !c.text.includes('{firstName}')), 'no unfilled {firstName} escapes');
  const online = firstNames(crew.filter((p) => p.is_online));
  const named = cand.filter((c, i) => CREW_WHISPERS[i].includes('{firstName}'));
  ok(named.length >= 1 && named.every((c) => online.some((n) => c.text.includes(n))),
    'the crew lines that name someone name an ONLINE viking');
  ok(cand.every((c) => !c.text.includes('Ghost')), 'an offline viking is never whispered about');
}

{
  // Same small crew, but the saga logged something inside the 45 minutes.
  const h = harness({
    players: [
      { id: 'p1', character_name: 'Astrid Shieldmaiden', is_online: true },
      { id: 'p2', character_name: 'Bjorn Ironside', is_online: true },
    ],
    status: { is_online: true, player_count: 2, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(120),
    recentEvents: [{ id: 'e1' }],
    state: { voice: { ...ambientDue } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1 && /^(atmo|cb):/.test(h.queued[0].meta.template)
    && h.queued[0].meta.source === undefined,
    `a hall with recent deeds gets the normal pool, got: ${JSON.stringify(h.queued[0]?.meta)}`);
  ok((await h.voice._buildWhispers({ playerCount: 2, worldDay: 5 })).length === 0,
    'no whisper candidates while the events log is warm');
}

{
  // Four online: a crowd is never whispered to, however quiet it is.
  const h = harness({
    players: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, character_name: `Viking${i} Thorsson`, is_online: true })),
    status: { is_online: true, player_count: 4, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(120),
    recentEvents: [],
    state: { voice: { ...ambientDue } },
  });
  await h.voice.tick();
  ok(h.queued.length === 1 && /^(atmo|cb):/.test(h.queued[0].meta.template),
    `4 online -> the normal ambient pool, got: ${JSON.stringify(h.queued[0]?.meta)}`);
  ok((await h.voice._buildWhispers({ playerCount: 4, worldDay: 5 })).length === 0,
    'no whisper candidates above a crew of three');
}

{
  // The swap changes the pool, never the cadence: an undue clock stays silent,
  // and a roster that disagrees with server_status keeps Eilif conventional.
  const quiet = harness({
    players: [{ id: 'p1', character_name: 'Steve Stevenson', is_online: true }],
    status: { is_online: true, player_count: 1, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(120),
    state: { voice: { deathTiersSeeded: true, onlineMinutes: 10 } },
  });
  await quiet.voice.tick();
  ok(quiet.queued.length === 0, 'a lone viking with the cadence undue hears nothing');

  const held = harness({
    players: [{ id: 'p1', character_name: 'Steve Stevenson', is_online: true }],
    status: { is_online: true, player_count: 1, world_day: 5 },
    lastVoiceQueuedAt: minsAgo(5), // inside VOICE_MIN_GAP_MS
    state: { voice: { ...ambientDue } },
  });
  await held.voice.tick();
  ok(held.queued.length === 0, 'whispers obey the same min-gap as any ambient line');

  const stale = harness({
    players: [{ id: 'p1', character_name: 'Steve Stevenson', is_online: true }],
    status: { is_online: true, player_count: 3, world_day: 5 }, // roster disagrees
    lastVoiceQueuedAt: minsAgo(120),
    state: { voice: { ...ambientDue } },
  });
  await stale.voice.tick();
  ok(stale.queued.length === 1 && /^(atmo|cb):/.test(stale.queued[0].meta.template),
    'a roster that disagrees with server_status falls back to the normal pool');
}

// ── 9. Retired mechanics are gone, and their state keys are cleaned up ────
{
  const h = harness({
    state: { voice: { lastDeathMilestone: 50, announcedDiscoveries: ['a', 'b'], deathTiersSeeded: true } },
  });
  await h.voice.tick();
  ok(!('lastDeathMilestone' in h.state.voice) && !('announcedDiscoveries' in h.state.voice),
    'legacy warband-death / discovery state keys dropped');
}

// ── 10. Copy register guards ─────────────────────────────────────────────
{
  ok(DAWN.length >= 5 && DAWN.length <= 7, `dawn pool is 5-7 lines, got ${DAWN.length}`);
  ok(DAWN.filter((l) => l.includes('Eilif')).length >= Math.ceil(DAWN.length / 2),
    'most dawn lines name Eilif');
  ok(DAWN.every((l) => l.includes('{day}')), 'every dawn line carries the world day');
  ok(ATMOSPHERE.length === 10, `atmosphere pool kept at 10, got ${ATMOSPHERE.length}`);
  ok(CALLBACK_TEMPLATES.length === 4, `callback pool kept at 4, got ${CALLBACK_TEMPLATES.length}`);
  ok(SOLO_WHISPERS.length >= 5 && SOLO_WHISPERS.length <= 6,
    `solo whisper pool is 5-6 lines, got ${SOLO_WHISPERS.length}`);
  ok(SOLO_WHISPERS.every((l) => l.includes('{firstName}')), 'every solo whisper names the lone viking');
  ok(CREW_WHISPERS.length >= 5 && CREW_WHISPERS.length <= 6,
    `crew whisper pool is 5-6 lines, got ${CREW_WHISPERS.length}`);
  ok(CREW_WHISPERS.some((l) => l.includes('{firstName}')) && CREW_WHISPERS.some((l) => !l.includes('{firstName}')),
    'the crew pool mixes named and unnamed lines');
  ok([20, 50, 100, 'next'].every((k) => typeof DEATH_LINES[k] === 'string'),
    'a distinct line exists for the 20 / 50 / 100 / every-100 tiers');

  // Never mimic vanilla Valheim's own on-screen text (Hugin tips, raid banners,
  // sleep/day messages) — players must be able to tell Eilif apart.
  const vanilla = [
    /the forest is moving/i,
    /a foul smell from the swamp/i,
    /you are being hunted/i,
    /what is that sound/i,
    /skeleton surprise/i,
    /slept until morning/i,
    /you stink of/i,
  ];
  const all = [
    ...DAWN, ...ATMOSPHERE, ...CALLBACK_TEMPLATES, ...Object.values(DEATH_LINES),
    ...SOLO_WHISPERS, ...CREW_WHISPERS,
  ];
  ok(all.every((line) => !vanilla.some((re) => re.test(line))), 'no vanilla-sounding phrasings');
  ok(all.every((line) => line.trim().length > 0 && line.length <= 200), 'lines stay readable in 3 seconds');
}

console.log(`voice.test: ${passed} assertions passed`);
