// Unit tests for the weekly Skald's Chronicle: the pure selection helpers
// (hours board, deaths board, the horizon line, the week key) and the embed
// copy formatChronicle renders from them.
//
// Everything here is offline: formatChronicle takes a plain object, and the two
// board pickers take plain maps. The Supabase reads in createChronicle are not
// covered on purpose — they are thin selects, and the logic worth defending is
// the ranking and the copy.
//
// Run:
//   node scripts/chronicle.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import {
  CHRONICLE_WINDOW_DAYS,
  HOURS_BOARD_LIMIT,
  FALLEN_BOARD_LIMIT,
  sessionHours,
  pickTopHours,
  pickTopFallen,
  nextHorizonLine,
  weekKey,
  formatChronicle,
  embedLength,
  createChronicle,
} from '../src/chronicle.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const NOW = Date.parse('2026-09-13T01:00:00.000Z');
const START = NOW - CHRONICLE_WINDOW_DAYS * 24 * 3600 * 1000;
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const session = (name, fromH, toH) => ({
  character_name: name,
  joined_at: hoursAgo(fromH),
  left_at: toH === null ? null : hoursAgo(toH),
});

// ── sessionHours: the window, and the stale-open guard ──────────────────────
{
  const { hours, totalHours } = sessionHours([session('Astrid', 5, 3)], START, NOW);
  eq(Math.round(hours.Astrid * 100) / 100, 2, 'a two-hour session counts two hours');
  eq(Math.round(totalHours * 100) / 100, 2, 'and lands in the total');

  const clipped = sessionHours([session('Astrid', 24 * 9, 24 * 8)], START, NOW);
  eq(Object.keys(clipped.hours).length, 0, 'a session that ended before the window is ignored');

  // Half in, half out: only the part inside the seven days counts.
  const straddle = sessionHours([session('Bjorn', CHRONICLE_WINDOW_DAYS * 24 + 2, CHRONICLE_WINDOW_DAYS * 24 - 2)], START, NOW);
  eq(Math.round(straddle.hours.Bjorn * 100) / 100, 2, 'a session straddling the window edge is clipped to it');

  const open = sessionHours([session('Cnut', 2, null)], START, NOW);
  eq(Math.round(open.hours.Cnut * 100) / 100, 2, 'an open session runs to now');

  const stale = sessionHours([session('Dagny', 24 * 10, null)], START, NOW);
  eq(Object.keys(stale.hours).length, 0, 'an open session older than the window is NOT counted');
  eq(stale.staleOpen[0], 'Dagny', 'it is reported back so the row gets closed');

  eq(Object.keys(sessionHours(null, START, NOW).hours).length, 0, 'a null read is tolerated');
  eq(Object.keys(sessionHours([{ character_name: 'X', joined_at: 'nope' }], START, NOW).hours).length, 0,
    'an unparseable joined_at is skipped, never NaN hours');
  const unnamed = sessionHours([{ character_name: '  ', joined_at: hoursAgo(3), left_at: hoursAgo(1) }], START, NOW);
  eq(Object.keys(unnamed.hours).length, 0, 'an unnamed session adds no board row');
  eq(Math.round(unnamed.totalHours * 100) / 100, 2, 'but its hours still count toward the total');
}

// ── pickTopHours: order, ties, the cap ─────────────────────────────────────
{
  const board = pickTopHours({ Astrid: 1, Bjorn: 9, Cnut: 4 });
  eq(board[0].name, 'Bjorn', 'the hours board leads with the most hours');
  eq(board[2].name, 'Astrid', 'and ends with the least');

  const tied = pickTopHours({ zoe: 3, Astrid: 3, bjorn: 3 });
  eq(tied.map((r) => r.name).join(','), 'Astrid,bjorn,zoe', 'a tie breaks on name, case-insensitively');

  const many = {};
  for (let i = 0; i < 12; i++) many[`V${i}`] = i + 1;
  eq(pickTopHours(many).length, HOURS_BOARD_LIMIT, `the board names at most ${HOURS_BOARD_LIMIT} vikings`);
  eq(pickTopHours(many, 10).length, 10, 'and the cap is a parameter (the poll ballot uses ten)');

  eq(pickTopHours({ Ghost: 0 }).length, 0, 'somebody with zero hours never makes the board');
  eq(pickTopHours().length, 0, 'no argument is not a crash');
}

// ── pickTopFallen: order, causes, the cap ──────────────────────────────────
{
  const board = pickTopFallen({ Astrid: 1, Bjorn: 5, Cnut: 2, Dagny: 9 }, { Bjorn: 'Greydwarf' });
  eq(board.length, FALLEN_BOARD_LIMIT, `the deaths board names at most ${FALLEN_BOARD_LIMIT} vikings`);
  eq(board[0].name, 'Dagny', 'most deaths first');
  eq(board[1].cause, 'Greydwarf', 'the last thing that killed them rides along');
  eq(board[2].cause, undefined, 'a viking with no recorded cause carries none');
  eq(pickTopFallen({ Astrid: 0 }).length, 0, 'zero deaths is not a board row');
  eq(pickTopFallen().length, 0, 'no argument is not a crash');
}

// ── nextHorizonLine ────────────────────────────────────────────────────────
{
  const ladder = [
    { name: 'Eikthyr', biome: 'Meadows', sort_order: 1, is_killed: true },
    { name: 'Bonemass', biome: 'Swamp', sort_order: 3, is_killed: false },
    { name: 'The Elder', biome: 'Black Forest', sort_order: 2, is_killed: false },
  ];
  const line = nextHorizonLine(ladder);
  ok(line.includes('The Elder'), 'the horizon names the first boss still standing, in ladder order');
  ok(line.includes('Black Forest'), 'and says where it stands');
  ok(!/[—–]/.test(line), 'no em dash or en dash reaches the players');

  const done = nextHorizonLine(ladder.map((b) => ({ ...b, is_killed: true })));
  ok(done.includes('Every boss on the ladder has fallen'), 'a genuinely finished ladder says so');
  ok(!done.includes('undefined'), 'and never renders the word undefined');

  // The bosses table is seeded with the whole ladder and is never legitimately
  // empty, so an empty read means the SELECT failed. Answering that with
  // "every boss has fallen" would publish a flatly false sentence to the hall.
  for (const [label, arg] of [['an empty read', []], ['a failed read', null], ['no argument', undefined]]) {
    const line = nextHorizonLine(arg);
    ok(line.length > 0, `${label} still gets a line`);
    ok(!/has fallen|have fallen/.test(line), `${label} must NOT claim the ladder is finished, got: ${line}`);
    ok(/could not be read/.test(line), `${label} says plainly that it does not know, got: ${line}`);
    ok(!/[—–]/.test(line), 'and no dash reaches the players');
  }
}

// ── weekKey ────────────────────────────────────────────────────────────────
{
  // 01:00 UTC on Monday is still Sunday evening in Chicago: the key must follow
  // the posting timezone, not UTC, or the Sunday post files under Monday.
  eq(weekKey(new Date('2026-09-14T01:00:00Z'), 'America/Chicago'), '2026-09-13',
    'the week key is the LOCAL date in the posting timezone');
  eq(weekKey(new Date('2026-09-13T20:00:00Z'), 'America/Chicago'), '2026-09-13',
    'the same Sunday evening gives the same key');
  eq(weekKey(new Date('2026-09-20T20:00:00Z'), 'America/Chicago'), '2026-09-20',
    'the next Sunday gives a different one');
  eq(weekKey(new Date('2026-09-13T20:00:00Z'), 'Not/AZone'), '2026-09-13',
    'a bad timezone falls back to the ISO date instead of throwing');
}

// ── formatChronicle: the full week ─────────────────────────────────────────
const FULL = {
  from: '2026-09-06T01:00:00.000Z',
  to: '2026-09-13T01:00:00.000Z',
  windowLabel: 'Sep 5 to Sep 12',
  worldDay: 24,
  activeVikings: 6,
  hoursTotal: 41.25,
  deathsTotal: 11,
  killsWeek: { value: 342, hasBaseline: true },
  arrivals: [{ name: 'Sigrid' }, { name: 'Torvald' }],
  hoursTop: [
    { name: 'Astrid', hours: 12.4 },
    { name: 'Bjorn', hours: 9.1 },
  ],
  fallenTop: [
    { name: 'Cnut', count: 5, cause: 'Greydwarf' },
    { name: 'Dagny', count: 3 },
  ],
  deeds: [{ title: 'The Length of Norway' }],
  bosses: [{ name: 'The Elder', biome: 'Black Forest', warParty: ['Astrid', 'Bjorn'] }],
  titles: [{ name: 'Cnut', title: 'The Bold' }],
  poty: [{ name: 'Astrid', label: '👑 Bane of Beasts (Boss-Slayer)' }],
  horizon: '**Bonemass** in the Swamp still stands. That is the next name for the book.',
  quiet: false,
};

const fieldsOf = (payload) => payload.embeds[0].fields || [];
const fieldNamed = (payload, name) => fieldsOf(payload).find((f) => f.name.startsWith(name));

{
  const out = formatChronicle(FULL);
  const embed = out.embeds[0];
  eq(embed.title, '📜 The week in the hall', 'the title says plainly what is shown');
  ok(embed.description.includes("The Skald's Chronicle"), 'the flavor name lives in the subtitle');
  ok(embed.description.includes('Sep 5 to Sep 12'), 'the subtitle carries the window');
  ok(embed.footer.text.length > 0, 'the standard footer is set');

  eq(fieldNamed(out, 'Vikings on this week').value, '6', 'the active count is reported');
  eq(fieldNamed(out, 'Hours logged').value, '41.3h', 'hours are rounded to one decimal');
  eq(fieldNamed(out, 'Deaths').value, '11', 'the death total is reported');
  eq(fieldNamed(out, 'Kills').value, '342', 'the weekly kill delta is reported');
  eq(fieldNamed(out, 'World day').value, '24', 'the world day is reported');

  ok(fieldNamed(out, 'New arrivals').value.includes('Sigrid'), 'arrivals are named');
  const hours = fieldNamed(out, 'Hours by viking').value;
  ok(hours.startsWith('1. '), 'the hours board is a numbered list');
  ok(hours.includes('12.4h'), 'with one decimal of hours');
  ok(fieldNamed(out, 'Deaths and causes').value.includes('×5'), 'the deaths board carries the count');
  ok(fieldNamed(out, 'Deaths and causes').value.includes('last cause: Greydwarf'), 'and the cause when there is one');
  ok(fieldNamed(out, 'Bosses felled').value.includes('war party: Astrid, Bjorn'),
    'a felled boss names the war party');
  ok(fieldNamed(out, 'Deeds earned').value.includes('The Length of Norway'), 'deeds are listed');
  ok(fieldNamed(out, 'Titles changed').value.includes('is now The Bold'), 'title changes are listed');
  ok(fieldNamed(out, 'Player of the Day winners').value.includes('Astrid'), 'POTY winners are listed');
  ok(fieldNamed(out, 'Next on the horizon').value.includes('Bonemass'), 'and the week closes on the horizon');
}

// ── formatChronicle: every section is optional ─────────────────────────────
{
  const bare = formatChronicle({
    ...FULL,
    arrivals: [], hoursTop: [], fallenTop: [], deeds: [], bosses: [], titles: [], poty: [],
  });
  for (const label of ['New arrivals', 'Hours by viking', 'Deaths and causes', 'Bosses felled', 'Deeds earned', 'Titles changed', 'Player of the Day']) {
    eq(fieldNamed(bare, label), undefined, `${label} is omitted when it is empty`);
  }
  ok(fieldNamed(bare, 'Next on the horizon'), 'the horizon line always survives');
  ok(fieldNamed(bare, 'Vikings on this week'), 'and so does the summary row');
}

// ── formatChronicle: the three states of the Kills field ───────────────────
{
  const first = formatChronicle({ ...FULL, killsWeek: { value: 0, hasBaseline: false } });
  eq(fieldNamed(first, 'Kills').value, 'Counting starts this week',
    'the first Chronicle says so instead of publishing a lifetime total as a week');

  // A week whose counters could not be read borrows neither of the other two
  // meanings: "0" would be a lie and "counting starts" would be wrong twice.
  const blind = formatChronicle({ ...FULL, killsWeek: { value: 0, hasBaseline: false, unavailable: true } });
  eq(fieldNamed(blind, 'Kills').value, 'Not counted this week',
    'an unreadable week says so rather than publishing a zero');
}

// ── formatChronicle: a quiet week ──────────────────────────────────────────
{
  const quiet = formatChronicle({ ...FULL, quiet: true });
  eq(quiet.embeds[0].fields, undefined, 'a quiet week is one paragraph, no stat fields');
  ok(quiet.embeds[0].description.includes('quiet seven days'), 'and it says so');
  ok(quiet.embeds[0].description.includes('Bonemass'), 'while still pointing at what is next');
}

// ── copy doctrine + Discord limits ─────────────────────────────────────────
{
  const out = formatChronicle(FULL);
  const embed = out.embeds[0];
  const allCopy = [embed.title, embed.description, ...fieldsOf(out).flatMap((f) => [f.name, f.value])].join('\n');
  ok(!/[—–]/.test(allCopy), 'no em dash or en dash anywhere in the player-visible copy');
  ok(!allCopy.includes('undefined'), 'and nothing renders the word undefined');
  for (const f of fieldsOf(out)) {
    ok(f.value.length <= 1024, `field "${f.name}" stays inside the 1024-char embed limit`);
    ok(f.name.length <= 256, `field name "${f.name}" stays inside the 256-char limit`);
  }
  ok(fieldsOf(out).length <= 25, 'and the embed stays inside the 25-field limit');

  // A markdown-hostile name must not break the layout.
  const nasty = formatChronicle({ ...FULL, hoursTop: [{ name: 'Bj*rn_the~Bold', hours: 1 }] });
  ok(fieldNamed(nasty, 'Hours by viking').value.includes('\\*'), 'markdown specials in a name are escaped');

  // A very long board is clipped rather than rejected by Discord.
  const long = formatChronicle({
    ...FULL,
    bosses: Array.from({ length: 40 }, (_, i) => ({
      name: `Boss ${i}`,
      warParty: Array.from({ length: 20 }, (_, j) => `Viking${j}`),
    })),
  });
  ok(fieldNamed(long, 'Bosses felled').value.length <= 1024, 'an absurd week is clipped to the field limit');
}

// ── the whole embed fits Discord's 6000-char ceiling ───────────────────────
// Each field is capped at 1024 on its own, but SEVEN boards at 1024 plus the
// summary row is over 6000, and Discord rejects the whole embed with a 400 —
// which loses the weekly post and leaves the kill baseline unrolled. The boards
// shrink evenly instead: every section survives, just shorter.
{
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const monstrous = formatChronicle({
    ...FULL,
    arrivals: many(60, (i) => ({ name: `Newcomer Number ${i}` })),
    hoursTop: many(5, (i) => ({ name: `Averyverylongvikingname${i}`, hours: 12.5 })),
    fallenTop: many(3, (i) => ({ name: `Averyverylongvikingname${i}`, count: 9, cause: 'A very long cause indeed' })),
    bosses: many(20, (i) => ({ name: `Boss number ${i}`, warParty: many(20, (j) => `Viking${j}`) })),
    deeds: many(40, (i) => ({ title: `A deed with a fairly long ceremonial title ${i}` })),
    titles: many(40, (i) => ({ name: `Viking${i}`, title: `The Extremely Long Epithet of Somewhere ${i}` })),
    poty: many(40, (i) => ({ name: `Viking${i}`, label: `👑 A long award label of some kind ${i}` })),
  });
  const embed = monstrous.embeds[0];
  ok(embedLength(embed) <= 6000,
    `the busiest imaginable week still fits the 6000-char embed ceiling, got ${embedLength(embed)}`);
  for (const f of embed.fields) ok(f.value.length <= 1024, `and "${f.name}" still fits its own 1024`);

  // Nothing is silently deleted: every section that had content still has a field.
  for (const label of ['New arrivals', 'Hours by viking', 'Deaths and causes', 'Bosses felled', 'Deeds earned', 'Titles changed', 'Player of the Day']) {
    ok(fieldNamed(monstrous, label), `${label} survives the shrink rather than being dropped`);
  }
  ok(fieldNamed(monstrous, 'Next on the horizon').value === FULL.horizon,
    'and the horizon line is never the thing that gets cut');
  eq(fieldNamed(monstrous, 'Vikings on this week').value, '6', 'nor is the summary row');

  // An ordinary week is left completely alone.
  const ordinary = formatChronicle(FULL);
  eq(fieldNamed(ordinary, 'Bosses felled').value.includes('…'), false, 'an ordinary week is not shrunk at all');
  ok(embedLength(ordinary.embeds[0]) < 2000, 'and stays comfortably inside the ceiling');
}

// ── the loop, against a fake Supabase ──────────────────────────────────────
// supabase-js RESOLVES with {data,error}; it never throws. So a failed read is
// indistinguishable from an empty table unless `error` is checked, and the
// weekly kill baseline is where that distinction has teeth: player_stats.kills
// is CUMULATIVE, so an empty snapshot written after a failed read makes the
// NEXT week diff every lifetime total against zero.
function fakeDb(tables) {
  const chainFor = (table) => {
    const result = () => {
      const t = tables[table];
      const r = typeof t === 'function' ? t() : t;
      return r && Object.prototype.hasOwnProperty.call(r, 'error') ? r : { data: r ?? [], error: null };
    };
    const chain = {
      select: () => chain,
      order: () => chain,
      or: () => chain,
      eq: () => chain,
      gte: () => chain,
      limit: () => chain,
      maybeSingle: () => chain,
      then: (res, rej) => Promise.resolve(result()).then(res, rej),
    };
    return chain;
  };
  return { from: chainFor };
}

const LADDER = [
  { name: 'Eikthyr', biome: 'Meadows', sort_order: 1, is_killed: true, killed_at: '2026-09-10T00:00:00Z', fight_stats: null },
  { name: 'The Elder', biome: 'Black Forest', sort_order: 2, is_killed: false, killed_at: null, fight_stats: null },
];

function chronHarness(tables = {}) {
  const posts = [];
  const state = {};
  const loop = createChronicle({
    db: fakeDb({
      sessions: [],
      events: [],
      bosses: LADDER,
      players: [{ id: 'p1', character_name: 'Astrid', first_seen_at: '2020-01-01T00:00:00Z' }],
      player_stats: [{ player_id: 'p1', kills: 500 }],
      milestones: [],
      title_history: [],
      // The fake ignores the .gte() filters, so one POTY row keeps every week
      // non-quiet and the stat fields rendered. Overridden by the quiet test.
      poty_history: [{ character_name: 'Astrid', award_label: 'A crown' }],
      server_status: { player_count: 0, world_day: 30 },
      ...tables,
    }),
    post: async (channel, payload) => posts.push({ channel, payload }),
    state,
    saveState: async () => {},
    channel: 'valheim',
  });
  return { loop, posts, state };
}

const NOW_MS = Date.parse('2026-09-13T01:00:00.000Z');
const killsField = (p) => (p.embeds[0].fields || []).find((f) => f.name === 'Kills')?.value;

// The first week has no baseline; the second week reports a real delta.
{
  const h = chronHarness();
  await h.loop.postChronicle(NOW_MS);
  eq(killsField(h.posts[0].payload), 'Counting starts this week', 'week one has nothing to diff against');
  ok(h.state.chronicle.killsBaselineAt, 'and it records that the baseline is now real');
  eq(h.state.chronicle.killsSnapshot.Astrid, 500, 'with the current cumulative counter');

  await h.loop.postChronicle(NOW_MS + 7 * 86400000);
  eq(killsField(h.posts[1].payload), '0', 'week two with no new kills reports zero, not 500');
}

// THE REGRESSION: a failed player_stats read must not become next week's
// baseline, or the following week publishes a lifetime total as one week.
{
  let broken = true;
  const h = chronHarness({
    player_stats: () => (broken ? { data: null, error: { message: 'permission denied' } } : [{ player_id: 'p1', kills: 500 }]),
  });

  await h.loop.postChronicle(NOW_MS);
  eq(killsField(h.posts[0].payload), 'Not counted this week', 'the unreadable week says so');
  eq(h.state.chronicle.killsBaselineAt, undefined, 'and no baseline is claimed');
  eq(h.state.chronicle.killsSnapshot, undefined, 'nor is an empty snapshot written');
  ok(h.state.chronicle.lastPostedKey, 'the week is still marked posted');

  broken = false;
  await h.loop.postChronicle(NOW_MS + 7 * 86400000);
  eq(killsField(h.posts[1].payload), 'Counting starts this week',
    'the next week starts counting instead of publishing 500 lifetime kills as a week');

  await h.loop.postChronicle(NOW_MS + 14 * 86400000);
  eq(killsField(h.posts[2].payload), '0', 'and the week after that diffs properly');
}

// A players read that fails takes the kill count with it (the counters are
// keyed by player id, so the names cannot be resolved) but nothing else breaks.
{
  const h = chronHarness({ players: { data: null, error: { message: 'permission denied for column steam_id' } } });
  await h.loop.postChronicle(NOW_MS);
  eq(killsField(h.posts[0].payload), 'Not counted this week', 'no names, no kill count');
  eq(h.state.chronicle.killsBaselineAt, undefined, 'and still no baseline');
  const fields = h.posts[0].payload.embeds[0].fields || [];
  eq(fields.find((f) => f.name === 'New arrivals'), undefined, 'the arrivals section is simply omitted');
}

// A total outage must not be published as "a quiet seven days".
{
  const down = { data: null, error: { message: 'connection refused' } };
  const h = chronHarness({ sessions: down, events: down, bosses: down, players: down, player_stats: down });
  await h.loop.postChronicle(NOW_MS);
  const embed = h.posts[0].payload.embeds[0];
  ok(!/quiet seven days/.test(embed.description),
    'a database outage is not a claim that nothing happened');
  ok(embed.fields, 'the normal embed renders with empty sections instead');
  ok(/could not be read/.test(embed.fields.at(-1).value), 'and the horizon admits it does not know');
}

// A genuinely empty week IS allowed to say it was quiet.
{
  const h = chronHarness({ player_stats: [], poty_history: [], bosses: [LADDER[1]] });
  await h.loop.postChronicle(NOW_MS);
  ok(/quiet seven days/.test(h.posts[0].payload.embeds[0].description),
    'an empty week that read cleanly still reads as quiet');
}

// ── runScheduled: the launch gate and the one-post-per-date guard ──────────
{
  const posts = [];
  const state = {};
  const gated = createChronicle({
    db: fakeDb({ sessions: [], events: [], bosses: LADDER, players: [], player_stats: [], milestones: [], title_history: [], poty_history: [], server_status: {} }),
    post: async (c, p) => posts.push({ c, p }),
    state,
    saveState: async () => {},
    startsAt: new Date('2026-09-09T00:00:00Z'),
  });
  eq(await gated.runScheduled(Date.parse('2026-09-06T01:00:00Z')), null,
    'before the world opens the Chronicle stays silent, like the nightly recap');
  eq(posts.length, 0, 'nothing is posted');
  eq(state.chronicle, undefined, 'and no state is written, so the first real week is still the first');

  ok(await gated.runScheduled(NOW_MS), 'after launch it runs');
  eq(posts.length, 1, 'and posts once');
  eq(await gated.runScheduled(NOW_MS + 60000), null,
    'a second run on the same local date is refused, so a restart cannot send the week twice');
  eq(posts.length, 1, 'still once');
  ok(await gated.runScheduled(NOW_MS + 7 * 86400000), 'the next Sunday is a different date, so it posts again');
  eq(posts.length, 2, 'twice in total');
}

console.log(`chronicle.test: ${passed} assertions passed`);
