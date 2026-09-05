// Unit tests for the Voice of the Hall: per-player death tiers, the every-3rd-
// world-day dawn line, the ambient global min-gap, and the quiet-night whisper
// pool swap. Run:
//   node scripts/voice.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
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
import {
  POTY_TEMPLATES,
  ENV_DEATH_POOLS,
  BOSS_TEMPLATES,
  CREATURE_TEMPLATES,
  NO_CAUSE_TEMPLATES,
  QUIET_RECAP_LINES,
  formatRecap,
  formatBossKill,
  formatFeedEvent,
  buildDeathMessage,
  causeNoun,
} from '../src/format.js';
import { buildPrompt, isValid, phraseDeath, sanitize, createSkald } from '../src/retelling.js';

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
  ok(h.queued[0].text === 'Fifty deaths for Steve. The ravens know that name by heart and still it walks back in through the door.',
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
  ok(h.queued.length === 1 && h.queued[0].text.startsWith('Twenty deaths for Newcomer.'),
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

// ── 11. No em-dashes anywhere a player can see one ───────────────────────
// Charlie, 2026-08-23: the em-dash is the loudest AI tell in the copy. Zero
// allowed in player-visible strings across the bot (comments may keep theirs).
// This sweeps the voice pools AND the Discord copy in format.js, both the raw
// template banks and the strings that only exist inside the render functions.
{
  const flatten = (v) =>
    typeof v === 'string' ? [v]
      : Array.isArray(v) ? v.flatMap(flatten)
        : v && typeof v === 'object' ? Object.values(v).flatMap(flatten)
          : [];

  const stats = (over = {}) => ({
    period: 'evening', playersActive: 2, hoursPlayed: 4.25, deaths: 3,
    bossKills: [], onlineNow: 1, worldDay: 41, quiet: false,
    onlineToday: [{ name: 'Steve', hours: 2.5 }],
    fallenToday: [{ name: 'Steve', count: 3 }],
    poty: null,
    ...over,
  });

  const rendered = [
    // every POTY blurb, rendered through the real picker via each category
    ...Object.entries(POTY_TEMPLATES).flatMap(([key, tpls]) =>
      tpls.map((_, seed) => formatRecap(stats({
        poty: {
          key, label: 'L', name: 'Steve', seed,
          fields: { boss: 'Bonemass', biome: 'Swamp', deaths: 4, cause: 'a Draugr', hours: 3.5, kills: 60, resources: 900, items: 70, newBiome: 'Plains' },
        },
      })))),
    formatRecap(stats()),
    formatRecap(stats({ period: 'morning' })),
    formatRecap(stats({ bossKills: [] })),
    // every quiet-day variant (the picker keys off period + world day)
    ...Array.from({ length: 64 }, (_, d) => formatRecap(stats({ quiet: true, worldDay: d }))),
    ...Array.from({ length: 64 }, (_, d) => formatRecap(stats({ quiet: true, period: 'morning', worldDay: d }))),
    formatBossKill({ name: 'Bonemass', biome: 'Swamp', players_present: ['Steve'], notes: 'ugly' }),
    formatFeedEvent({ type: 'join', character_name: 'Steve' }),
    formatFeedEvent({ type: 'leave', character_name: 'Steve' }),
    formatFeedEvent({ type: 'raid', character_name: 'Steve', metadata: {} }),
  ];

  const playerVisible = [
    ...DAWN, ...ATMOSPHERE, ...CALLBACK_TEMPLATES, ...Object.values(DEATH_LINES),
    ...SOLO_WHISPERS, ...CREW_WHISPERS,
    deathMilestoneLine(300, 'Steve Stevenson'),
    ...flatten(POTY_TEMPLATES),
    ...flatten(ENV_DEATH_POOLS),
    ...BOSS_TEMPLATES, ...CREATURE_TEMPLATES, ...NO_CAUSE_TEMPLATES,
    ...QUIET_RECAP_LINES,
    ...rendered.flatMap(flatten),
  ];

  const dashed = playerVisible.filter((s) => s.includes('—'));
  ok(dashed.length === 0, `no em-dash in player-visible copy, found: ${JSON.stringify(dashed.slice(0, 3))}`);
  ok(QUIET_RECAP_LINES.length >= 3, `the quiet day has more than one variant, got ${QUIET_RECAP_LINES.length}`);
}

// ── 12. Same rule for the identity + oath replies a newcomer actually reads ──
// Those two modules build their DM/reply copy inline, so there is nothing to
// import: scan the sources instead. Comments, journal lines (log.*) and the
// parser's own dash tokens (the regex classes, the DASH constant, the `lead`
// comparisons) are developer-facing, not player-visible.
{
  const isNotPlayerCopy = (line) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ||                       // comment line
    /log\.(info|warn|error)\?\./.test(line) ||               // journal copy
    /\.match\(|\.replace\(|RegExp|const DASH|lead ===/.test(line); // parser tokens

  const offenders = [];
  for (const file of ['identity.js', 'oaths.js']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((raw, i) => {
      if (isNotPlayerCopy(raw)) return;
      const code = raw.replace(/(^|[^:])\/\/.*$/, '$1'); // drop trailing comments
      if (/[—–]/.test(code)) offenders.push(`${file}:${i + 1}: ${code.trim()}`);
    });
  }
  ok(offenders.length === 0,
    `no em/en dash in identity + oath reply copy, found: ${JSON.stringify(offenders.slice(0, 3))}`);
}

// ── 13. The boss embed's war party credits FIGHTERS, not bystanders ─────────
// Mirrors recap.js: fight_stats.fighters wins, players_present is the fallback
// for legacy rows recorded before fighters were captured.
{
  const party = (boss) =>
    formatBossKill(boss).embeds[0].fields.find((f) => f.name.includes('War party'))?.value ?? null;

  ok(party({ name: 'Bonemass', biome: 'Swamp', players_present: ['Bren', 'Steve', 'Lurker'], fight_stats: { fighters: ['Bren', 'Steve'] } })
    === 'Bren, Steve', 'fighters win over players_present');
  ok(party({ name: 'Bonemass', biome: 'Swamp', players_present: ['Bren', 'Steve'], fight_stats: { fighters: [] } })
    === 'Bren, Steve', 'an empty fighters list falls back to players_present');
  ok(party({ name: 'Bonemass', biome: 'Swamp', players_present: ['Bren'] }) === 'Bren',
    'a legacy row with no fight_stats still names the party');
  ok(party({ name: 'Bonemass', biome: 'Swamp' }) === null, 'no names, no war party field');
}

// ── 14. Every HitType reads as English, and blames the right thing ─────────
// The eilif death reporter sends HitData.HitType verbatim, so all 22 words land
// in `events.metadata.cause` and flow to THREE bot surfaces: the #server feed
// line (buildDeathMessage), the noun phrase the recap/voice drop mid-sentence
// (causeNoun) and the skald's fact list (retelling's phraseDeath). A word
// missing from any of the three reads as "killed by a Playerhit".
//
// HIT_TYPES is copied from lib/deaths.ts (the list of record); these tests run
// under plain node, which cannot import the .ts source.
const HIT_TYPES = [
  'Undefined', 'EnemyHit', 'PlayerHit', 'Fall', 'Drowning', 'Burning', 'Freezing',
  'Poisoned', 'Water', 'Smoke', 'EdgeOfWorld', 'Impact', 'Cart', 'Tree', 'Self',
  'Structural', 'Turret', 'Boat', 'Stalagtite', 'Catapult', 'CinderFire', 'AshlandsOcean',
];

// What each cause must and must not say. The must-nots are the misattributions:
// an unseen foe is not another viking, a cart is not a tree, a ballista bolt is
// not a monster.
const READS = {
  Undefined: [/no name|nameless/i, /viking|foe|creature/i],
  EnemyHit: [/unseen|never saw|never showed|nobody got a look|dark/i, /viking|cart|tree/i],
  PlayerHit: [/one of their own|another viking|one of the clan/i, /unseen|beast/i],
  Fall: [/fall|fell|drop|fly|gravity/i, /pushed|thrown/i],
  Drowning: [/water|deep|under|come back up/i, /fire|flame/i],
  Burning: [/flame|fire|burn|crisp/i, /water|cold/i],
  Freezing: [/cold|froze|frozen/i, /flame|fire/i],
  Poisoned: [/poison|agree with them/i, /flame|water/i],
  Water: [/water|deep|under|come back up/i, /fire|flame/i],
  Smoke: [/smoke/i, /water/i],
  EdgeOfWorld: [/edge/i, /creature|beast/i],
  Impact: [/broke|broken|fall|landing/i, /blade|claw/i],
  Cart: [/cart/i, /tree|ship|boat/i],
  Tree: [/tree/i, /cart|ship/i],
  Self: [/own hand/i, /foe|beast|viking/i],
  Structural: [/timber/i, /cart|ballista/i],
  Turret: [/ballista/i, /beast|creature/i],
  Boat: [/longship|hull/i, /cart|tree/i],
  Stalagtite: [/skewer|spike|above|rock/i, /beast|foe/i],
  Catapult: [/catapult/i, /ballista|cart/i],
  CinderFire: [/cinder/i, /water|cold/i],
  AshlandsOcean: [/boil|sea/i, /cold|freez/i],
};

{
  for (const hit of HIT_TYPES) {
    const low = hit.toLowerCase();
    const [must, mustNot] = READS[hit];

    // The enum word itself (case-sensitive) must never reach a player: "tree"
    // is English, "CinderFire" is a token.
    const token = new RegExp(`\\b${hit}\\b`);

    // (a) the #server feed line
    ok(ENV_DEATH_POOLS[low], `${hit}: missing from ENV_DEATH_POOLS in format.js`);
    ok(!token.test(buildDeathMessage('**Testman**', hit)),
      `${hit}: the raw token must not surface in the feed line`);
    for (const line of ENV_DEATH_POOLS[low]) {
      const rendered = line.replace(/\{name\}/g, 'Testman');
      ok(must.test(rendered), `${hit}: feed copy should say what killed them, got: ${rendered}`);
      ok(!mustNot.test(rendered), `${hit}: feed copy blames the wrong thing, got: ${rendered}`);
      ok(!/[—–]/.test(rendered), `${hit}: no dash in the feed copy, got: ${rendered}`);
      ok(!/killed by an? [A-Z]/.test(rendered),
        `${hit}: an environmental cause must not read as a creature, got: ${rendered}`);
    }

    // (b) the mid-sentence noun phrase (POTY blurb, voice callback)
    const noun = causeNoun(hit);
    ok(noun && !token.test(noun), `${hit}: causeNoun must not hand back the raw token, got: ${noun}`);
    ok(!/^[A-Z]/.test(noun), `${hit}: a cause noun sits mid-sentence, so it stays lowercase, got: ${noun}`);
    ok(must.test(noun), `${hit}: causeNoun should say what killed them, got: ${noun}`);
    ok(!mustNot.test(noun), `${hit}: causeNoun blames the wrong thing, got: ${noun}`);

    // (c) the skald's fact list
    const skald = phraseDeath('Testman Thorsson', hit);
    ok(skald.startsWith('Testman '), `${hit}: the skald phrase leads with the first name, got: ${skald}`);
    ok(!token.test(skald), `${hit}: the raw token must not reach the skald prompt, got: ${skald}`);
    ok(must.test(skald), `${hit}: the skald phrase should say what killed them, got: ${skald}`);
    ok(!mustNot.test(skald), `${hit}: the skald phrase blames the wrong thing, got: ${skald}`);
  }

  // Not a HitType: creature names, named forsaken ones, a PlayerHit with an
  // attacker ("the hand of Bjorn"), and no cause at all.
  {
    // The creature pool is random per call, and one of its templates carries no
    // article at all, so the article rule is checked across the whole pool.
    const draw = (cause) => new Set(Array.from({ length: 200 }, () => buildDeathMessage('**T**', cause)));
    for (const line of draw('Abomination')) {
      ok(!/\ba Abomination\b/.test(line), `a vowel creature takes "an", got: ${line}`);
    }
    for (const line of draw('Greydwarf')) {
      ok(!/\ban Greydwarf\b/.test(line), `a consonant creature takes "a", got: ${line}`);
    }
    ok([...draw('Abomination')].some((l) => /an Abomination/.test(l)), 'and the article pool is actually exercised');
  }
  ok(causeNoun('Greydwarf') === 'a Greydwarf', `a creature becomes a noun phrase, got: ${causeNoun('Greydwarf')}`);
  ok(causeNoun('The Elder') === 'The Elder', 'a named forsaken one keeps its name');
  ok(causeNoun('Bonemass') === 'Bonemass', 'so does a bare boss name');
  ok(causeNoun('') === '' && causeNoun(null) === '', 'an absent cause is empty, for the caller to guard on');
  ok(causeNoun('Bj*rn') === 'a Bj\\*rn', 'markdown is escaped for Discord');
  ok(causeNoun('Bj*rn', { markdown: false }) === 'a Bj*rn', 'and left alone for the spoken line');
  {
    // "the hand of Bjorn" routes through the boss branch; the template that
    // OPENS on the cause must capitalize it.
    const lines = new Set();
    for (let i = 0; i < 200; i++) lines.add(buildDeathMessage('**Sven**', 'the hand of Bjorn'));
    ok(lines.size > 1, 'the boss pool varies');
    for (const l of lines) {
      ok(/^[A-Z*]/.test(l), `a death line never opens lowercase, got: ${l}`);
      ok(!/[—–]/.test(l), `no dash in a death line, got: ${l}`);
    }
  }
  for (const t of NO_CAUSE_TEMPLATES) {
    ok(!/\{cause\}/.test(t), 'the no-cause pool never reaches for a cause');
  }
}

// ── 15. A tally of one never reads "1 times" ───────────────────────────────
// The POTY blurb is the only copy that renders a raw count, and a boss night
// with a single death used to produce "bled 1 times wrestling Bonemass down".
{
  const blurb = (key, fields, seed = 0) =>
    formatRecap({
      period: 'evening', playersActive: 2, hoursPlayed: 4, deaths: 1, bossKills: [],
      onlineNow: 1, worldDay: 12, quiet: false, onlineToday: [], fallenToday: [],
      poty: { key, label: 'L', name: 'Steve', fields, seed },
    }).embeds[0].fields.find((f) => f.name.startsWith('🏆')).value;

  const every = [];
  for (let seed = 0; seed < 8; seed++) {
    for (const deaths of [1, 2, 3, 7]) {
      every.push(blurb('boss_kill', { boss: 'Bonemass', biome: 'Swamp', deaths }, seed));
      every.push(blurb('most_deaths', { deaths, cause: 'Tree' }, seed));
    }
    every.push(blurb('most_kills', { kills: 1 }, seed));
    every.push(blurb('most_kills', { kills: 60 }, seed));
    every.push(blurb('most_resources', { resources: 1 }, seed));
    every.push(blurb('most_resources', { resources: 900 }, seed));
    every.push(blurb('most_crafted', { items: 1 }, seed));
    every.push(blurb('most_crafted', { items: 70 }, seed));
    every.push(blurb('most_hours', { hours: 1 }, seed));
  }
  const plural = every.filter((s) => /\b1 [a-z]+s\b/.test(s));
  ok(plural.length === 0, `no "1 <plural>" anywhere in a POTY blurb, found: ${JSON.stringify(plural.slice(0, 3))}`);
  // A cause noun is lowercase by design, so a template that opens on one has to
  // capitalize it: "4 times. a falling tree had the last word" was live copy.
  const lowerStart = every.filter((s) => /[.!?] +[a-z]/.test(s.replace(/\*\*/g, '')));
  ok(lowerStart.length === 0,
    `no blurb opens a sentence in lowercase, found: ${JSON.stringify(lowerStart.slice(0, 3))}`);
  ok(every.every((s) => !/[—–]/.test(s)), 'and no dashes either');
  ok(every.some((s) => /\bonce\b/.test(s)), 'a single death is spelled "once"');
  ok(every.some((s) => /\btwice\b/.test(s)), 'two is "twice"');
  ok(every.some((s) => /\b7 times\b/.test(s)), 'more than two counts up');

  // The raw HitType never reaches the crown blurb either.
  const causes = [];
  for (let seed = 0; seed < 8; seed++) {
    for (const cause of ['Tree', 'EnemyHit', 'PlayerHit', 'Deathsquito', 'The Elder']) {
      causes.push(blurb('most_deaths', { deaths: 4, cause }, seed));
    }
  }
  ok(causes.every((s) => !/\b(EnemyHit|PlayerHit|Tree)\b/.test(s)),
    `the crown blurb speaks English, not HitTypes, got: ${JSON.stringify(causes.filter((s) => /EnemyHit|PlayerHit|\bTree\b/.test(s)).slice(0, 2))}`);
}

// ── 16. The voice callback reads with every span label ─────────────────────
// The labels are interpolated into four different sentence shapes; "four weeks
// past tonight the dark took Bren" was the kind of thing that got through.
{
  const spans = ['a week ago', 'a fortnight ago', 'four weeks ago'];
  const causes = ['a falling tree', 'something they never saw', 'a Greydwarf', 'Bonemass', 'something nobody wrote down'];
  for (const tpl of CALLBACK_TEMPLATES) {
    for (const span of spans) {
      for (const cause of causes) {
        const line = tpl
          .replace(/\{Span\}/g, span.charAt(0).toUpperCase() + span.slice(1))
          .replace(/\{span\}/g, span)
          .replace(/\{name\}/g, 'Bren')
          .replace(/\{cause\}/g, cause);
        ok(/^[A-Z]/.test(line), `a callback opens with a capital, got: ${line}`);
        ok(!/\{/.test(line), `every token is filled, got: ${line}`);
        ok(!/[—–]/.test(line), `no dash in a callback, got: ${line}`);
        ok(!/\b(ago|past)\s+tonight\b/.test(line) || /ago tonight,/.test(line),
          `a time label reads naturally before "tonight", got: ${line}`);
        ok(line.length <= 200, `a callback stays speakable, got ${line.length} chars`);
      }
    }
  }
  ok(CALLBACK_TEMPLATES.every((t) => /\{cause\}/.test(t) && /\{name\}/.test(t) && /\{S?span\}/i.test(t)),
    'every callback uses all three tokens');

  // …and the same thing through the real engine, where the cause is the raw
  // HitType word the death reporter stored.
  const h = harness({
    players: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, character_name: `V${i}`, is_online: true })),
    status: { is_online: true, player_count: 5, world_day: 9 },
    deathEvents: [{ character_name: 'Bren Bjornsson', metadata: { cause: 'EnemyHit' }, created_at: minsAgo(60 * 24 * 7) }],
    state: { voice: { deathTiersSeeded: true, deathTiers: {} } },
  });
  const picks = [];
  for (let day = 1; day <= 40; day++) picks.push(await h.voice.pickAmbient({ worldDay: day, playerCount: 5 }));
  const callbacks = picks.filter((p) => p && p.id.startsWith('cb:'));
  ok(callbacks.length > 0, 'the callback pool is reachable with a dated death on file');
  for (const c of callbacks) {
    ok(!/\{|\}/.test(c.text), `every token is filled by the engine, got: ${c.text}`);
    ok(!/EnemyHit/.test(c.text), `the raw HitType never reaches a spoken callback, got: ${c.text}`);
    ok(/^[A-Z]/.test(c.text), `a spoken callback opens with a capital, got: ${c.text}`);
    ok(/Bren/.test(c.text), `the fallen viking is named, got: ${c.text}`);
    ok(!/[—–]/.test(c.text), `no dash in a spoken callback, got: ${c.text}`);
    ok(!c.text.includes('\\'), `a spoken line carries no markdown escape, got: ${c.text}`);
  }
}

// ── 17. The ambient bank still works on an empty day-one world ─────────────
// Nothing Eilif says unprompted may assert a history the world does not have
// yet: launch night is day 1 with an empty ledger.
{
  const claimsHistory = [...ATMOSPHERE, ...DAWN].filter((line) =>
    /\b(a hundred|hundreds|thousands|many) (oaths|deaths|vikings|years)\b/i.test(line) ||
    /\bhas stood for\b/i.test(line));
  ok(claimsHistory.length === 0,
    `no ambient line may invent a past on a day-one world, found: ${JSON.stringify(claimsHistory)}`);
  ok(DAWN.every((l) => l.includes('{day}')), 'every dawn line dates itself');
}

// ── 18. The skald prompt is the one from the bench ─────────────────────────
// Facts are the live Eikthyr record. The prompt has to quote the war party back
// verbatim (accents included), cap the length, and forbid the tells; isValid is
// the enforcement half, so a model that ignores the rules still cannot publish.
{
  const facts = {
    name: 'Eikthyr', biome: 'Meadows', killedAt: '2026-08-28T03:49:34.419Z', worldDay: 17,
    players: ['ChÆrleif', 'Bren', 'Lóa'],
    fightSec: null, firstBlood: null, topDamagePlayer: 'Lóa', topDamage: 236,
    participants: null, fallen: [],
  };
  const prompt = buildPrompt(facts);
  ok(prompt.includes('ChÆrleif, Bren and Lóa'), 'the war party is quoted back exactly, accents and all');
  ok(/90 words at the most/.test(prompt), 'the prompt carries a hard length cap');
  ok(/Never use a dash of any kind/.test(prompt), 'and forbids dashes outright');
  ok(/tapestry/.test(prompt) && /testament/.test(prompt), 'and names the tells it will not accept');
  ok(/Do not invent weapons/.test(prompt), 'and forbids invented detail');
  ok(prompt.includes('- The beast felled: Eikthyr, a forsaken one of the Meadows.'), 'the facts ride along');
  // "wounds", not "damage": the prompt bans modern words in the same breath, so
  // the fact list may not hand the model one.
  ok(prompt.includes('- Struck the hardest blows: Lóa (236 wounds dealt).'), 'including the damage credit');
  ok(!/\bdamage\b/i.test(prompt), 'and the prompt never says "damage" itself');

  const fallen = buildPrompt({ ...facts, fallen: [{ name: 'Bren Bjornsson', cause: 'PlayerHit' }] });
  ok(/Bren was cut down by one of their own/.test(fallen),
    `a fallen hero reaches the prompt in English, got: ${fallen.split('\n').at(-3)}`);

  ok(isValid('The beast fell on the 17th day. The hall remembers.'), 'plain prose is accepted');
  ok(!isValid('The beast fell — and the hall remembers.'), 'an em-dash is rejected');
  ok(!isValid('A testament to their valor.'), 'so is a testament');
  ok(!isValid('A tapestry of blood.'), 'and a tapestry');
  ok(!isValid('x'.repeat(1200)), 'and anything over the char cap');
  ok(!isValid('# A Saga\n\nThe beast fell.'), 'and a markdown header');
}


// ── 19. A cause is a KEY, and the cause is attacker-supplied ───────────────
// A modded client picks the killer name it reports, and every cause-keyed map
// in format.js/retelling.js is a plain object literal, so a bare MAP[cause]
// walked Object.prototype. "constructor" was the bad one: ENV_DEATH_POOLS
// handed back the Object function and buildDeathMessage THREW on it, which is
// a crashed relay tick from one death line. causeNoun returned undefined (so
// the crown blurb rendered a double space where the cause should be) and the
// skald's fact list got "function Object() { [native code] }".
{
  for (const cause of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype']) {
    const feed = buildDeathMessage('**Testman**', cause);
    ok(typeof feed === 'string' && feed.length > 0, `${cause}: the feed line still renders, got: ${feed}`);
    ok(!/undefined|\[native code\]/.test(feed), `${cause}: no internals in the feed line, got: ${feed}`);
    ok(!/\s{2}/.test(feed) && !/\{|\}/.test(feed), `${cause}: the feed line is clean, got: ${feed}`);

    const noun = causeNoun(cause);
    ok(typeof noun === 'string' && noun.length > 0,
      `${cause}: causeNoun must always hand back a string, got: ${typeof noun} ${noun}`);
    ok(!/\[native code\]/.test(noun), `${cause}: no internals in the cause noun, got: ${noun}`);

    const skald = phraseDeath('Bren', cause);
    ok(typeof skald === 'string' && !/\[native code\]|undefined/.test(skald),
      `${cause}: no internals in the skald fact list, got: ${skald}`);
  }
  // …and the same cause through the crown blurb, which is where an undefined
  // noun turned into "met the void 4 times.  had the last word".
  const crown = formatRecap({
    period: 'evening', playersActive: 2, hoursPlayed: 4, deaths: 4, bossKills: [],
    onlineNow: 1, worldDay: 12, quiet: false, onlineToday: [], fallenToday: [],
    poty: { key: 'most_deaths', label: 'L', name: 'Steve', fields: { deaths: 4, cause: 'constructor' }, seed: 1 },
  }).embeds[0].fields.find((f) => f.name.startsWith('🏆')).value;
  ok(!/\s{2}/.test(crown) && !/undefined/.test(crown), `a hostile cause leaves the crown blurb clean, got: ${crown}`);
}

// ── 20. The skald's fact list gets the forsaken one right ──────────────────
// The heroes who fall in a boss fight are usually killed by the boss the saga
// is about, so this is the single most likely cause the prompt will ever see.
// It read "Bren was taken by an eikthyr", and the model copied it.
{
  for (const boss of ['Eikthyr', 'Bonemass', 'Moder', 'Yagluth', 'Fader', 'The Elder', 'The Queen']) {
    const line = phraseDeath('Bren Bjornsson', boss);
    ok(line === `Bren was felled by ${boss}`, `a forsaken one is named, not articled, got: ${line}`);
  }
  ok(phraseDeath('Sven', 'the hand of Bjorn') === 'Sven was felled by the hand of Bjorn', 'so is a named attacker');
  ok(phraseDeath('Sven', 'Deathsquito') === 'Sven was taken by a Deathsquito', 'a creature keeps its own casing');
  ok(phraseDeath('Sven', 'Abomination') === 'Sven was taken by an Abomination', 'and gets the right article');
  ok(phraseDeath('Sven', '   ') === 'Sven fell in the fray', 'whitespace is no cause');
  ok(phraseDeath('Sven', null) === 'Sven fell in the fray', 'and neither is a missing one');
  // The three surfaces must agree about who the boss is.
  ok(/Eikthyr/.test(buildDeathMessage('**Sven**', 'Eikthyr')), 'the feed line names the boss too');
  ok(causeNoun('Eikthyr') === 'Eikthyr', 'and so does the cause noun');
}

// ── 21. sanitize REPAIRS what a model gets wrong, instead of binning it ────
// isValid rejecting an em-dash is right, but rejecting is expensive: two
// rejections and the war-room gets the template instead of a saga that was
// correct about everything except its punctuation. So the dash is rewritten
// first and isValid stays as the backstop.
{
  const cases = [
    ['The beast fell — and the hall held.', 'The beast fell, and the hall held.'],
    ['Eikthyr fell on the 17th day — a hard fight — and the hall held.',
      'Eikthyr fell on the 17th day, a hard fight, and the hall held.'],
    ['The beast fell. — The hall held.', 'The beast fell. The hall held.'],
    ['— The beast fell.', 'The beast fell.'],
    ['The beast fell —', 'The beast fell.'],
    ['They fought for 10–20 heartbeats.', 'They fought for 10 to 20 heartbeats.'],
    ['Here is the saga:\n\nThe beast fell.', 'The beast fell.'],
    ["Sure! Here's your saga: The beast fell.", 'The beast fell.'],
    ['The beast fell.  The hall held.', 'The beast fell. The hall held.'],
    ['<think>weigh it up</think>\nThe beast fell.', 'The beast fell.'],
    ['"The beast fell."', 'The beast fell.'],
  ];
  for (const [raw, want] of cases) {
    const got = sanitize(raw);
    ok(got === want, `sanitize(${JSON.stringify(raw)}) -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    ok(isValid(got), `and the repair is publishable: ${got}`);
  }
  // A saga is not thrown away for one dash any more…
  ok(isValid(sanitize('Lóa struck hardest — the beast fell on the 17th day.')),
    'a repaired dash no longer costs a good saga');
  // …but the tells still cost it everything, and fall back to the template.
  for (const bad of [
    'A testament to their valor.', 'A tapestry of blood.', 'Written in the annals of the hall.',
    'Bone and sinew gave way.', 'Black ichor ran in the grass.', 'They stood unyielding.',
    'It rang through the ages.', 'Their names etched into the hall.', 'The whispers of the dead.',
  ]) {
    ok(!isValid(sanitize(bad)), `still rejected: ${bad}`);
  }
  // Ordinary English that merely LOOKS like a tell is not rejected: every one
  // of these costs a real saga if the guard is too greedy.
  for (const fine of ['The hall echoed with it.', 'A legend of the north was made.', 'The fires burned for ages.',
    'They will not forget it, not for a long while.']) {
    ok(isValid(sanitize(fine)), `an ordinary sentence must survive the guard: ${fine}`);
  }
  ok(!isValid('x'.repeat(1200)), 'and anything over the char cap');
  ok(!isValid('# A Saga\n\nThe beast fell.'), 'and a markdown header');
  ok(!isValid(''), 'and nothing at all');

  // The prompt and the validator have to name the same tells, or the model is
  // being punished for something it was never told.
  const bare = buildPrompt({
    name: 'Eikthyr', biome: 'Meadows', killedAt: null, worldDay: null, players: [],
    fightSec: null, firstBlood: null, topDamagePlayer: null, topDamage: null, participants: null, fallen: [],
  }).toLowerCase();
  for (const w of ['tapestry', 'testament', 'annals', 'sinew', 'ichor', 'unyielding', 'through the ages', 'etched into']) {
    ok(bare.includes(w), `isValid rejects "${w}", so the prompt must ask for it: ${w}`);
  }
}

// ── 22. A busy boss night cannot flood the prompt or the fallback ──────────
// The ±10 min window around a kill can hold a dozen deaths with a full hall.
// Every one of them in the fact list breaks both consumers at once: the prompt
// asks for every fact inside 90 words, and the template runs to a wall of names
// in what is meant to be three to five sentences.
{
  const skald = createSkald({ db: null, writeDb: null });
  const facts = {
    name: 'Bonemass', biome: 'Swamp', killedAt: '2026-09-01T00:00:00Z', worldDay: 44,
    players: Array.from({ length: 20 }, (_, i) => `Viking${i}`),
    fightSec: 412, firstBlood: 'Viking1', topDamagePlayer: 'Viking2', topDamage: 9001, participants: 20,
    fallen: Array.from({ length: 14 }, (_, i) => ({ name: `Viking${i} Thorsson`, cause: 'EnemyHit' })),
  };
  const factLine = buildPrompt(facts).split('\n').find((l) => l.startsWith('- Heroes who fell'));
  ok(/\b8 more fell beside them\b/.test(factLine), `the fallen list is capped and counted, got: ${factLine}`);
  ok(factLine.length < 400, `and stays a fact rather than a wall, got ${factLine.length} chars`);

  // The template is bounded by SHAPE, not by MAX_CHARS (which governs the model
  // only): a full 20-viking war party is named in full on purpose, and that
  // alone can pass 700. What must hold is the sentence count and the copy.
  const tpl = skald.buildTemplate(facts);
  ok(tpl.length < 1000, `the fallback stays a paragraph, got ${tpl.length} chars`);
  ok(!/\{|\}/.test(tpl), `every template token is filled, got: ${tpl}`);
  ok(!/[—–]/.test(tpl), 'and the fallback carries no dash either');
  ok(/returned unbloodied|took its toll|bought in blood/.test(tpl),
    `the fallen survive the trim, got: ${tpl}`);
  ok(!/battle raged|struggle lasted|of fury, the beast/.test(tpl),
    `and the clock is what goes instead, got: ${tpl}`);
  // List grammar, not a chain: three fallen used to read "A, and B, and C".
  const three = skald.buildTemplate({
    ...facts, players: ['Ake', 'Bo'], fightSec: null, firstBlood: null,
    topDamagePlayer: null, topDamage: null,
    fallen: [{ name: 'Ake', cause: 'Tree' }, { name: 'Bo', cause: 'Fall' }, { name: 'Cai', cause: 'Drowning' }],
  });
  ok(three.includes('Ake was crushed by a falling tree, Bo fell to their death and Cai was claimed by dark water'),
    `the fallen read as a list, got: ${three}`);

  // Thin facts still make a saga, and never a sentence with a hole in it.
  const thin = skald.buildTemplate({
    name: 'Eikthyr', biome: 'Meadows', killedAt: null, worldDay: null, players: [],
    fightSec: null, firstBlood: null, topDamagePlayer: null, topDamage: null, participants: null, fallen: [],
  });
  ok(!/\{|\}/.test(thin) && !/\s{2}/.test(thin) && !/undefined/.test(thin),
    `a factless template still reads, got: ${thin}`);

  // fight_stats is free-form jsonb written by a game client. An object in
  // `fighters` would reach the prompt as "[object Object]" — the one shape of
  // raw fight_stats that can leak into the skald's facts.
  const db = fakeClient((table) => (table === 'server_status'
    ? { data: { world_day: 44 }, error: null }
    : { data: [], error: null }));
  const gathered = await createSkald({ db, writeDb: null }).gatherFacts({
    id: 'b1', name: 'Bonemass', biome: 'Swamp', killed_at: '2026-09-01T00:00:00Z',
    fight_stats: { fighters: ['Bren', { name: 'Lóa', damage: 5 }, null, 42, 'ChÆrleif'] },
    players_present: ['Bren'],
  });
  assert.deepStrictEqual(gathered.players, ['Bren', 'ChÆrleif']); passed++;
  ok(!/\[object Object\]/.test(buildPrompt(gathered)), 'no fight_stats object reaches the prompt');
}

// ── 23. Every POTY token has a substitution ────────────────────────────────
// The blurbs and the code that fills them live 100 lines apart, and a token
// added to one and not the other renders as an empty string plus a double
// space — quiet, and live for a week before anyone reads the recap closely.
{
  const KNOWN = new Set(['name', 'boss', 'biome', 'deaths', 'cause', 'causeCap', 'hours', 'kills',
    'resources', 'items', 'newBiome', 'deathsTimes', 'gravesCount', 'killsCount', 'corpsesCount',
    'piecesCount', 'worksCount']);
  const FIELDS = {
    boss_kill: { boss: 'Bonemass', biome: 'Swamp', deaths: 3 },
    most_explored: { newBiome: 'Mistlands' },
    most_deaths: { deaths: 5, cause: 'Tree' },
    most_kills: { kills: 60 },
    most_resources: { resources: 900 },
    most_crafted: { items: 70 },
    most_hours: { hours: 6.25 },
    underdog: {},
  };
  for (const [key, pool] of Object.entries(POTY_TEMPLATES)) {
    ok(FIELDS[key] !== undefined, `${key}: a new POTY category needs a fixture here`);
    for (const tpl of pool) {
      for (const token of tpl.match(/\{(\w+)\}/g) || []) {
        ok(KNOWN.has(token.slice(1, -1)), `${key}: "${token}" has no substitution in renderPotyBlurb`);
      }
      ok(!/[—–]/.test(tpl), `${key}: no dash in a blurb, got: ${tpl}`);
    }
    // Every template in the pool, rendered: walk the seed so each index is hit.
    for (let seed = 0; seed < pool.length * 4; seed++) {
      const v = formatRecap({
        period: 'evening', playersActive: 3, hoursPlayed: 9, deaths: 5, bossKills: [],
        onlineNow: 2, worldDay: 30, quiet: false, onlineToday: [], fallenToday: [],
        poty: { key, label: 'L', name: 'Steve', fields: FIELDS[key], seed },
      }).embeds[0].fields.find((f) => f.name.startsWith('🏆')).value;
      ok(!/\{|\}/.test(v), `${key}: an unfilled token reached the recap, got: ${v}`);
      ok(!/\s{2}/.test(v) && !/\s[.,]/.test(v), `${key}: no hole where a value should be, got: ${v}`);
      ok(!/undefined|NaN/.test(v), `${key}: no internals in a blurb, got: ${v}`);
      ok(v.trim().endsWith('.'), `${key}: a blurb closes its sentence, got: ${v}`);
    }
  }
}

console.log(`voice.test: ${passed} assertions passed`);
