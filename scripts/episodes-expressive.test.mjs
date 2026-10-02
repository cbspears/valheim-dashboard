// Expressive-night tests for lib/episodes.ts (no network).
//
// WHAT THIS GUARDS (Charlie, 2026-09-27): "the story to be more expressive
// sometimes, especially when there's a lot of people online and doing
// something notable." A 21-viking night with 41 deaths used to render the same
// two sentences as a four-viking night. It now renders four to seven specific
// ones — and, just as importantly, an ORDINARY night still renders exactly
// what it rendered before, byte for byte.
//
// The quiet-night expectation below is a SNAPSHOT of real output. It has moved
// ONCE, deliberately, and the reason is recorded beside it.
//
// THE TIER IS A RANK, NOT A THRESHOLD (2026-09-27, second pass). A night is
// expressive when it is one of the top two scores among the nights within
// three calendar days either side of it AND clears the EXPRESSIVE_SCORE floor,
// or when a boss fell. That is why several tests here build a LIST of nights
// rather than one: a night's telling depends on its neighbours.
//
// Run: npx tsx scripts/episodes-expressive.test.mjs
import { buildEpisodes, notability, EXPRESSIVE_SCORE, BIG_NIGHT_SCORE } from '../lib/episodes.ts';
import assert from 'node:assert';

let checks = 0;
function ok(cond, msg) {
  checks += 1;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  checks += 1;
  assert.equal(a, b, msg);
}

/** Sentences, counted the way a reader counts them. */
function sentences(text) {
  return (text.match(/\.(\s|$)/g) ?? []).length;
}

// ═══ 1. THE ORDINARY NIGHT DOES NOT MOVE ═════════════════════════════════
// Three vikings, one death, one discovery. Captured from the pre-change code.
const QUIET_SESSIONS = [
  { character_name: 'Bjorn', joined_at: '2026-09-20T23:00:00Z', left_at: '2026-09-21T02:00:00Z', duration_minutes: 180 },
  { character_name: 'Ingrid', joined_at: '2026-09-20T23:30:00Z', left_at: '2026-09-21T01:30:00Z', duration_minutes: 120 },
  { character_name: 'Sven', joined_at: '2026-09-21T00:00:00Z', left_at: '2026-09-21T01:00:00Z', duration_minutes: 60 },
];
const QUIET_EVENTS = [
  { type: 'death', character_name: 'Sven', created_at: '2026-09-21T00:30:00Z', metadata: { cause: 'Greydwarf', world_day: 120 } },
  { type: 'discovery', character_name: 'Bjorn', created_at: '2026-09-21T01:00:00Z', metadata: { detail: 'entered the Swamp', world_day: 120 } },
];

const QUIET_TITLE = 'Into the Swamp';
// SNAPSHOT MOVED 2026-09-27, ON PURPOSE. Charlie, on the shipped page: "The
// story each day seems to over index on deaths." It did: the death sentence
// was second in the old ladder and deaths are the one thing that happens every
// night, so 13 of 19 nights led with one. Under the rebalanced ladder the
// discovery leads this night and the single death is the colour clause after
// it, which is exactly the intended change. The FIRST snapshot, captured from
// the code before any of this work, was:
//
//   'Bjorn, Ingrid and Sven gathered at the longfire, the world at day 120.
//    Sven learned to fear the Greydwarf.'
//
// Note what did NOT change: the opener, and the fact that the death is still
// told with its cause and never as a count.
const QUIET_DESCRIPTION =
  'Bjorn, Ingrid and Sven gathered at the longfire, the world at day 120. New country was charted this day. Sven will not soon forget the Greydwarf that felled them.';

{
  const [ep] = buildEpisodes(QUIET_SESSIONS, QUIET_EVENTS);
  eq(ep.title, QUIET_TITLE, 'a quiet night keeps its title');
  eq(ep.description, QUIET_DESCRIPTION, 'a quiet night keeps its description, byte for byte');
  eq(ep.tier, 'terse', 'a quiet night is terse');
  ok(notability(ep).score < EXPRESSIVE_SCORE, `and does not clear the floor, scored ${notability(ep).score}`);

  // And the sixth argument existing changes nothing about it.
  const [same] = buildEpisodes(QUIET_SESSIONS, QUIET_EVENTS, [], [], [], {
    titleAwards: [],
    potyAwards: [],
    chatLines: [],
    firstSeen: [],
  });
  eq(same.description, QUIET_DESCRIPTION, 'passing an empty extras object is the same as passing none');
}

// ═══ 2. THE BIG NIGHT ════════════════════════════════════════════════════
// Twenty vikings, 41 deaths, two titles conferred, a newcomer, a Great Deed
// and one quotable shout, all on Thursday 2026-09-24 Central.
const CREW = [
  'Mikael', 'Asbjorn', 'Thorfinn', 'Rosir', 'Kætiløy', 'Lóa', 'Psifour', 'Æymundr',
  'Fjällhnot', 'Yunter', 'Bren', 'Skarde', 'Astrid', 'Ingrid', 'Sven', 'Halvar',
  'Gunnhild', 'Torvald', 'Eirik', 'Yosh',
];
const NEWCOMER = 'Yosh';

function bigSessions() {
  return CREW.map((name, i) => {
    const minutes = 540 - i * 20; // Mikael longest, Yosh shortest
    const joined = Date.parse('2026-09-24T22:00:00Z');
    return {
      character_name: name,
      joined_at: new Date(joined).toISOString(),
      left_at: new Date(joined + minutes * 60_000).toISOString(),
      duration_minutes: minutes,
    };
  });
}

function bigEvents() {
  const at = (n) => new Date(Date.parse('2026-09-25T00:00:00Z') + n * 60_000).toISOString();
  const events = [
    {
      type: 'milestone',
      character_name: null,
      created_at: at(1),
      metadata: { title: 'The First Marathon', line: '1,000 kilometres walked', milestone: 'distance', world_day: 214 },
    },
  ];
  // 41 deaths: a Swamp night, and Æymundr had the worst of it.
  const roll = [
    ...Array(12).fill(['Fuling', 'Swamp']),
    ...Array(8).fill(['Draugr', 'Swamp']),
    ...Array(3).fill(['Blob', 'Swamp']),
    ...Array(6).fill(['Greydwarf', 'Black Forest']),
    ...Array(5).fill(['Deathsquito', 'Plains']),
    ...Array(4).fill(['Wolf', 'Mountain']),
    ['The Elder', 'Black Forest'],
    ['fall', 'Mountain'],
    ['drowning', 'Ocean'],
  ];
  eq(roll.length, 41, 'the fixture really does hold 41 deaths');
  roll.forEach(([cause, biome], i) => {
    // Æymundr takes the first six; the rest go round the crew.
    const who = i < 6 ? 'Æymundr' : CREW[i % CREW.length];
    events.push({
      type: 'death',
      character_name: who,
      created_at: at(2 + i),
      metadata: { cause, biome, world_day: 214 },
    });
  });
  return events;
}

const BIG_EXTRAS = {
  titleAwards: [
    { characterName: 'Mikael', title: 'the Heavy-Handed', awardedAt: '2026-09-25T01:00:00Z' },
    { characterName: 'Rosir', title: 'the Far-Seer', awardedAt: '2026-09-25T01:30:00Z' },
  ],
  potyAwards: [
    { characterName: 'Mikael', awardLabel: '👑 Bane of Beasts (Boss-Slayer)', awardedAt: '2026-09-25T03:00:00Z' },
  ],
  firstSeen: [
    // Everybody has been here since the founding except the newcomer.
    ...CREW.filter((n) => n !== NEWCOMER).map((n) => ({ characterName: n, firstSeenAt: '2026-09-09T18:00:00Z' })),
    { characterName: NEWCOMER, firstSeenAt: '2026-09-24T22:05:00Z' },
  ],
  chatLines: [
    { characterName: 'Yosh', message: 'we found 6 crypts under the swamp', createdAt: '2026-09-25T00:40:00Z' },
    // Rejected: a link.
    { characterName: 'Bren', message: 'https://eilifgg/map lads', createdAt: '2026-09-25T00:41:00Z' },
    // Rejected: a sign claim is a command, not speech.
    { characterName: 'Bren', message: '[board:kills] mine now', createdAt: '2026-09-25T00:42:00Z' },
    // Rejected: the console-echo mirror shouts in capitals.
    { characterName: 'Astrid', message: 'GET TO THE BOAT RIGHT NOW', createdAt: '2026-09-25T00:43:00Z' },
    // Rejected: too short.
    { characterName: 'Sven', message: 'hey', createdAt: '2026-09-25T00:44:00Z' },
  ],
};

const EXPECTED_QUOTE = '"we found 6 crypts under the swamp," said Yosh.';

{
  const [ep] = buildEpisodes(bigSessions(), bigEvents(), [], [], [], BIG_EXTRAS);
  const { score, reasons } = notability(ep);
  ok(score >= EXPRESSIVE_SCORE, `a 20-viking, 41-death night clears the floor, scored ${score}`);
  ok(score >= BIG_NIGHT_SCORE, `and it is a BIG night, scored ${score} (${reasons.join('; ')})`);
  // A ONE-NIGHT LIST RANKS ITSELF TOP, so the rank rule cannot hide the only
  // night there is behind a neighbour that does not exist.
  eq(ep.tier, 'expressive', 'the only night in the list is told loudly');

  const d = ep.description;
  const n = sentences(d);
  ok(n >= 4 && n <= 7, `an expressive night runs four to seven sentences, got ${n}: ${d}`);
  ok(d.includes(NEWCOMER), `the newcomer is named, got: ${d}`);
  ok(/took up the /.test(d), `a title conferred is named, got: ${d}`);
  ok(d.includes(EXPECTED_QUOTE), `the night's shout is quoted, got: ${d}`);
  ok(/\b20\b/.test(d), `the scale is stated, got: ${d}`);

  // The quote filter's rejects must not reach the page by any route.
  ok(!/https?:|eilifgg/.test(d), `a link is never quoted, got: ${d}`);
  ok(!/board:kills|\[|\]/.test(d), `a sign claim is never quoted, got: ${d}`);
  ok(!/GET TO THE BOAT/.test(d), `an all-caps shout is never quoted, got: ${d}`);
  eq(ep.chatLines.length, 1, 'exactly one shout survived the filter');

  // It reads as prose, by the same rules the terse path is held to.
  ok(!/\{|\}/.test(d), `every token is filled, got: ${d}`);
  ok(!/\s{2}/.test(d) && !/\s[.,]/.test(d), `no stray spacing, got: ${d}`);
  ok(/^[A-Z"]/.test(d), `it opens with a capital, got: ${d}`);
  ok(d.trim().endsWith('.'), `and closes a sentence, got: ${d}`);

  // The title names the headline rather than counting deaths.
  ok(/The First Marathon/.test(ep.title), `the Great Deed names the night, got: ${ep.title}`);
  ok(!/Death/i.test(ep.title), `and 41 deaths do not, got: ${ep.title}`);

  // The inputs landed where they should have.
  eq(ep.newcomers.join(','), NEWCOMER, 'the newcomer was detected from first_seen_at');
  eq(ep.titleAwards.length, 2, 'both titles were bucketed onto this night');
  eq(ep.milestones.length, 1, 'the Great Deed came off the event stream');
  eq(ep.deaths.length, 41, 'all 41 deaths are on the episode');
}

// ═══ 2b. THE QUOTE FILTER, ONE REJECTION AT A TIME ══════════════════════
// Each line below is disqualified by exactly ONE rule, so a rule that stops
// working fails a named assertion rather than quietly widening the gate.
{
  const crew14 = CREW.slice(0, 14).map((name) => ({
    character_name: name,
    joined_at: '2026-07-11T22:00:00Z',
    left_at: '2026-07-12T01:00:00Z',
    duration_minutes: 180,
  }));
  const said = (message) => [{ characterName: 'Bren', message, createdAt: '2026-07-11T23:00:00Z' }];
  const quoted = (message) =>
    buildEpisodes(crew14, [], [], [], [], { chatLines: said(message) })[0].chatLines;

  eq(quoted('https://eilifgg/map lads').length, 0, 'a link is rejected');
  eq(quoted('[board:kills] mine now').length, 0, 'a sign claim is rejected');
  eq(quoted('nice work @Mikael today').length, 0, 'a ping is rejected');
  eq(quoted('GET TO THE BOAT RIGHT NOW').length, 0, 'an all-caps shout is rejected');
  eq(quoted('hey').length, 0, 'too short is rejected');
  eq(quoted('a'.repeat(120)).length, 0, 'too long is rejected');
  eq(quoted('Katieisthecoolest').length, 0, 'a single run-on token is rejected');
  eq(quoted('what a load of shit that was').length, 0, 'profanity is rejected');
  eq(quoted('buttplains from leroy over there').length, 0, 'and it matches inside a word');
  eq(quoted('we did it. it took all night').length, 0, 'two sentences in one shout are rejected');

  // Kept, with the fish taken off it.
  const keeper = quoted('wanna do a fishing tour \u{1F41F}\u{1F41F}');
  eq(keeper.length, 1, 'an emoji does not disqualify a line');
  eq(keeper[0].message, 'wanna do a fishing tour', 'the emoji is stripped, and so is the space it left');

  // A boss kill is the one input that makes a night expressive regardless of
  // rank or floor, which is what this assertion needs: the quote only reaches
  // the card on an expressive night.
  const bossKill = [
    { type: 'boss', character_name: 'Bren', created_at: '2026-07-11T23:30:00Z', metadata: { boss: 'Eikthyr' } },
  ];
  const [ep] = buildEpisodes(crew14, bossKill, [], [], [], {
    chatLines: said('wanna do a fishing tour \u{1F41F}\u{1F41F}'),
  });
  eq(ep.tier, 'expressive', 'a boss night is always told loudly');
  ok(
    ep.description.includes('"wanna do a fishing tour," said Bren.'),
    `the stripped line is what reaches the card, got: ${ep.description}`
  );
}

// ═══ 3. DETERMINISM ══════════════════════════════════════════════════════
// The same input twice is the same string twice — there is no Math.random in
// this file and there must never be one: /events is prerendered, so a random
// choice would mean the card changed every time ISR revalidated.
{
  const a = buildEpisodes(bigSessions(), bigEvents(), [], [], [], BIG_EXTRAS)[0];
  const b = buildEpisodes(bigSessions(), bigEvents(), [], [], [], BIG_EXTRAS)[0];
  eq(a.title, b.title, 'the title is deterministic');
  eq(a.description, b.description, 'the description is deterministic');

  const q1 = buildEpisodes(QUIET_SESSIONS, QUIET_EVENTS)[0];
  const q2 = buildEpisodes(QUIET_SESSIONS, QUIET_EVENTS)[0];
  eq(q1.description, q2.description, 'so is the terse one');

  // Re-ordering the inputs must not re-order the prose: callers may pass data
  // in any order (buildEpisodes says so in its own doc comment).
  const shuffled = buildEpisodes(
    [...bigSessions()].reverse(),
    [...bigEvents()].reverse(),
    [], [], [],
    { ...BIG_EXTRAS, chatLines: [...BIG_EXTRAS.chatLines].reverse() }
  )[0];
  eq(shuffled.description, a.description, 'input order does not change the telling');
}

// ═══ 4. THE THRESHOLD, ON SHAPES THAT SHOULD AND SHOULD NOT CROSS IT ═════
{
  const day = (h) => `2026-08-22T${String(h).padStart(2, '0')}:00:00Z`;
  const session = (name, minutes = 300) => ({
    character_name: name,
    joined_at: '2026-08-22T18:00:00Z',
    left_at: '2026-08-22T23:00:00Z',
    duration_minutes: minutes,
  });
  const ev = (type, metadata, name = 'Bjorn') => ({ type, character_name: name, created_at: day(20), metadata });
  const crew = (n) => CREW.slice(0, n).map((name) => session(name));

  const oath = { character_name: 'Bjorn', oath_text: 'I will build the hall', sworn_at: day(21) };
  const pin = { name: 'Skull Rock', kind: 'landmark', by_character_name: 'Bjorn', created_at: day(21) };

  // Each of these is the ONLY night in its list, so rank never bites and the
  // case is purely about the floor (and about the boss override).
  const cases = [
    // [label, sessions, events, expectedScore, expectedExpressive]
    ['one viking, one death', [session('Bjorn')], [ev('death', { cause: 'Neck' })], 0, false],
    ['six vikings, a raid and a discovery', crew(6), [ev('raid', { event: 'The forest is moving...' }), ev('discovery', { detail: 'entered the Swamp' })], 2, false],
    ['eight vikings alone', crew(8), [], 2, false],
    ['eight vikings and a Great Deed', crew(8), [ev('milestone', { title: 'The First Mile', line: 'a mile walked' })], 4, false],
    ['fourteen vikings who stayed', crew(14), [], 6, false],
    [
      'a full hall, a long night and a body count',
      crew(16),
      Array.from({ length: 20 }, (_, i) => ev('death', { cause: 'Fuling', biome: 'Plains' }, CREW[i % 16])),
      8,
      true,
    ],
    // Below the floor, and told loudly anyway, because a boss fell.
    ['a boss falls', [session('Bjorn')], [ev('boss', { boss: 'Bonemass', world_day: 44 })], 4, true],
  ];

  for (const [label, sessions, events, expectedScore, expressive] of cases) {
    const [e] = buildEpisodes(sessions, events);
    const { score } = notability(e);
    eq(score, expectedScore, `${label}: score`);
    eq(e.tier, expressive ? 'expressive' : 'terse', `${label}: tier (scored ${score})`);
    const n = sentences(e.description);
    if (expressive) {
      ok(n >= 4 && n <= 7, `${label}: four to seven sentences, got ${n}: ${e.description}`);
    }
  }

  // THE FLOOR IS A FLOOR, NOT A THRESHOLD: clearing it is necessary, not
  // sufficient. Two nights three days apart, both over the floor, plus a third
  // that beats them both — the weakest of the three loses its slot.
  {
    const night = (date, deaths) => ({
      sessions: CREW.slice(0, 16).map((n) => ({
        character_name: n,
        joined_at: `${date}T22:00:00Z`,
        left_at: `${date}T23:00:00Z`,
        duration_minutes: 300,
      })),
      events: Array.from({ length: deaths }, (_, i) => ({
        type: 'death',
        character_name: CREW[i % 16],
        created_at: `${date}T22:${String(10 + (i % 40)).padStart(2, '0')}:00Z`,
        metadata: { cause: 'Fuling', biome: 'Plains' },
      })),
    });
    const a = night('2026-03-01', 20);
    const b = night('2026-03-02', 20);
    const c = night('2026-03-03', 20);
    const eps = buildEpisodes(
      [...a.sessions, ...b.sessions, ...c.sessions],
      [
        ...a.events,
        ...b.events,
        // The middle night also lands a Great Deed and a title, so it outscores
        // its neighbours, who are otherwise identical to it and to each other.
        { type: 'milestone', created_at: '2026-03-02T22:05:00Z', metadata: { title: 'The Long Walk' } },
        ...c.events,
      ],
      [], [], [],
      { titleAwards: [{ characterName: 'Mikael', title: 'the Heavy-Handed', awardedAt: '2026-03-02T23:00:00Z' }] }
    );
    eq(eps.length, 3, 'three nights');
    eq(eps.map((e) => notability(e).score).join(','), '8,11,8', 'the middle night outscores the other two');
    eq(
      eps.map((e) => e.tier).join(','),
      'expressive,expressive,terse',
      'top two of the window, and the tie for second goes to the earlier date'
    );
  }

  // A boss night names the boss in the title, and "The Elder" does not read
  // as "The Night The Elder Fell".
  eq(buildEpisodes([session('Bjorn')], [ev('boss', { boss: 'Bonemass' })])[0].title, 'The Night Bonemass Fell');
  eq(buildEpisodes([session('Bjorn')], [ev('boss', { boss: 'The Elder' })])[0].title, 'The Night the Elder Fell');
  // Places named now outrank turnout, so the oath-and-pin night is named for
  // its map rather than its benches.
  eq(buildEpisodes(crew(14), [], [oath], [pin])[0].title, 'New Ground, Newly Named');

  // The turnout rung is reached only when nothing named itself: fourteen
  // vikings, fifteen deaths (not a peak, not thirty) and nothing else at all.
  {
    const deaths = Array.from({ length: 15 }, (_, i) => ev('death', { cause: 'Fuling' }, CREW[i % 14]));
    const t = buildEpisodes(crew(14), deaths)[0].title;
    ok(
      /Benches|A Hall of|Answered the Horn|Hours by the Fire|Hours Between Them/.test(t),
      `turnout names the night when nothing else does, got: ${t}`
    );
    ok(!/Death/i.test(t), `and fifteen deaths do not, got: ${t}`);
  }
}

// ═══ 4b. THE RANK RULE OVER A REAL RUN OF NIGHTS ════════════════════════
// Nine consecutive nights with hand-built scores, so the window can be walked
// on paper. A night is expressive when it is one of the top two scores inside
// its own seven-night window (three days either side) and clears the floor.
//
//   day    0   1   2   3   4   5   6   7   8
//   score 12   8   6  10   9   6   6  14  11
//
//   day 0 sees 0..3   → top two are 12 (day 0) and 10 (day 3)  → day 0 IN
//   day 1 sees 0..4   → top two are 12 and 10                  → day 1 out
//   day 2 sees 0..5   → top two are 12 and 10                  → day 2 out
//   day 3 sees 0..6   → top two are 12 and 10                  → day 3 IN
//   day 4 sees 1..7   → top two are 14 (day 7) and 10 (day 3)  → day 4 out
//   day 5 sees 2..8   → top two are 14 and 11 (day 8)          → day 5 out
//   day 6 sees 3..8   → top two are 14 and 11                  → day 6 out
//   day 7 sees 4..8   → top two are 14 and 11                  → day 7 IN
//   day 8 sees 5..8   → top two are 14 and 11                  → day 8 IN
//
// Four of nine, which is the rate Charlie asked for over a run this length.
{
  // Score arithmetic per night: 14 vikings (+4) at five hours each is 70
  // viking-hours (+2), so the base is 6. A newcomer adds a fifteenth session
  // (still 14+, still over 60 hours) and +2.
  const VETERANS = CREW.slice(0, 14);

  function synthNight(dateKey, opts = {}) {
    const {
      deaths = 0, milestone = false, newcomer = null,
      titleAward = false, raid = false, discovery = false,
    } = opts;
    const at = (m) => new Date(Date.parse(`${dateKey}T22:00:00Z`) + m * 60_000).toISOString();
    const roster = newcomer ? [...VETERANS, newcomer] : VETERANS;
    const sessions = roster.map((n) => ({
      character_name: n, joined_at: at(0), left_at: at(300), duration_minutes: 300,
    }));
    const events = [];
    if (milestone) events.push({ type: 'milestone', created_at: at(5), metadata: { title: `The Deed of ${dateKey}` } });
    if (raid) events.push({ type: 'raid', created_at: at(6), metadata: { event: 'The forest is moving...' } });
    if (discovery) events.push({ type: 'discovery', character_name: roster[0], created_at: at(7), metadata: { detail: 'entered the Swamp' } });
    for (let i = 0; i < deaths; i++) {
      events.push({
        type: 'death', character_name: roster[i % roster.length], created_at: at(10 + i),
        metadata: { cause: 'Greydwarf', biome: 'Black Forest' },
      });
    }
    return {
      sessions,
      events,
      firstSeen: newcomer ? [{ characterName: newcomer, firstSeenAt: at(1) }] : [],
      titleAwards: titleAward ? [{ characterName: roster[0], title: 'the Heavy-Handed', awardedAt: at(20) }] : [],
    };
  }

  function run(recipes, startDay, withExtras = true) {
    const sessions = [];
    const events = [];
    const firstSeen = [];
    const titleAwards = [];
    recipes.forEach((opts, i) => {
      const key = `2026-05-${String(startDay + i).padStart(2, '0')}`;
      const night = synthNight(key, opts);
      sessions.push(...night.sessions);
      events.push(...night.events);
      firstSeen.push(...night.firstSeen);
      titleAwards.push(...night.titleAwards);
    });
    // The five-argument form on purpose when withExtras is false: the callers
    // that predate the sixth argument must get the same rank rule.
    return withExtras
      ? buildEpisodes(sessions, events, [], [], [], { firstSeen, titleAwards })
      : buildEpisodes(sessions, events, [], []);
  }

  const NINE = [
    { deaths: 15, milestone: true, newcomer: 'Grimbly' },                                  // 12
    { deaths: 15 },                                                                        //  8
    {},                                                                                    //  6
    { deaths: 15, milestone: true },                                                       // 10
    { deaths: 15, titleAward: true },                                                      //  9
    {},                                                                                    //  6
    {},                                                                                    //  6
    { deaths: 15, milestone: true, newcomer: 'Ravena', raid: true, discovery: true },       // 14
    { deaths: 15, milestone: true, titleAward: true },                                     // 11
  ];

  const nights = run(NINE, 1);
  eq(nights.length, 9, 'nine nights, nine episodes');
  eq(
    nights.map((e) => notability(e).score).join(','),
    '12,8,6,10,9,6,6,14,11',
    'the fixture really does produce the scores the table above reasons about'
  );
  eq(
    nights.map((e) => e.tier).join(','),
    'expressive,terse,terse,expressive,terse,terse,terse,expressive,expressive',
    'exactly the top two of each seven-night window are told loudly'
  );
  eq(nights.filter((e) => e.tier === 'expressive').length, 4, 'four of nine');

  // A night that scores 8 and a night that scores 15 are told the same way
  // when neither is top of its own week, which is the whole point of the rule:
  // the terse ones really are terse.
  for (const e of nights.filter((x) => x.tier === 'terse')) {
    const n = sentences(e.description);
    ok(n <= 3, `a terse night stays short, got ${n}: ${e.description}`);
  }
  for (const e of nights.filter((x) => x.tier === 'expressive')) {
    const n = sentences(e.description);
    ok(n >= 4 && n <= 7, `an expressive night runs four to seven, got ${n}: ${e.description}`);
  }

  // A DEAD WEEK YIELDS NOTHING. Seven nights all scoring 6: something is top
  // of every window, and the floor is what stops it being promoted for it.
  const dead = run(Array(7).fill({}), 1);
  eq(dead.length, 7, 'seven quiet nights');
  eq(dead.map((e) => notability(e).score).join(','), '6,6,6,6,6,6,6', 'all under the floor');
  eq(dead.filter((e) => e.tier === 'expressive').length, 0, 'and not one of them is forced expressive');

  // THE OLD CALL SHAPE GETS THE SAME RULE. Without the sixth argument there
  // are no newcomers and no titles, so the same nine nights score differently
  // (10,8,6,10,8,6,6,12,10) and the rule is applied to those scores instead.
  const legacy = run(NINE, 1, false);
  eq(
    legacy.map((e) => notability(e).score).join(','),
    '10,8,6,10,8,6,6,12,10',
    'without the extras the newcomer and title points are simply absent'
  );
  eq(
    legacy.map((e) => e.tier).join(','),
    'expressive,terse,terse,expressive,terse,terse,terse,expressive,expressive',
    'and a five-argument caller still gets the top two of each window'
  );
  eq(buildEpisodes([], []).length, 0, 'an empty list is still an empty list');
}

// ═══ 5. NO DASH, NO BRACE, ANYWHERE A PLAYER READS ═══════════════════════
// Em and en dashes are banned in player-facing copy, and the expressive path
// inserts producer-supplied strings (creature names, biomes, deed titles,
// living titles, award labels, a player's own shout) that can each carry one.
{
  const nasty = '— a dash – and {a brace}';
  const dashed = buildEpisodes(
    bigSessions(),
    [
      { type: 'milestone', created_at: '2026-09-25T00:01:00Z', metadata: { title: `The Long Walk ${nasty}`, line: nasty } },
      ...Array.from({ length: 20 }, (_, i) => ({
        type: 'death',
        character_name: CREW[i % CREW.length],
        created_at: `2026-09-25T00:${String(10 + i).padStart(2, '0')}:00Z`,
        metadata: { cause: `Fuling ${nasty}`, biome: `Swamp ${nasty}` },
      })),
    ],
    [],
    [],
    [],
    {
      ...BIG_EXTRAS,
      titleAwards: [{ characterName: 'Mikael', title: `the Heavy-Handed ${nasty}`, awardedAt: '2026-09-25T01:00:00Z' }],
      chatLines: [{ characterName: 'Yosh', message: 'we sailed — far – today', createdAt: '2026-09-25T00:40:00Z' }],
    }
  )[0];

  for (const text of [dashed.title, dashed.description]) {
    ok(!/[—–]/.test(text), `no dash in expressive copy, got: ${text}`);
    ok(!/\{|\}/.test(text), `no brace in expressive copy, got: ${text}`);
    ok(!/\s{2}/.test(text) && !/\s[.,]/.test(text), `no stray spacing, got: ${text}`);
  }
  ok(dashed.description.includes('"we sailed, far, today," said Yosh.'), `a dashed shout is repunctuated, got: ${dashed.description}`);
}

// ═══ 6. EVERY SEED, NOT JUST TODAY'S ════════════════════════════════════
// Variant choice is seeded off the calendar day, and some of the pools the
// expressive path borrows from the terse renderer are TWO sentences long
// ("{boss} met its end. Skål to the war party that took its head."). Budgeting
// by beat rather than by sentence let one of those push a card to eight, so
// the shapes below are walked across a month of seeds.
{
  const shapeFor = (iso) => {
    const at = (m) => new Date(Date.parse(`${iso}T22:00:00Z`) + m * 60_000).toISOString();
    const sessions = CREW.slice(0, 16).map((name, i) => ({
      character_name: name,
      joined_at: at(0),
      left_at: at(400 - i * 10),
      duration_minutes: 400 - i * 10,
    }));
    const events = [
      { type: 'boss', character_name: 'Mikael', created_at: at(30), metadata: { boss: 'Moder', players: 'Mikael and Rosir', world_day: 300 } },
      { type: 'milestone', created_at: at(31), metadata: { title: 'The Long Haul', line: 'a hundred trees felled' } },
      { type: 'raid', created_at: at(32), metadata: { event: 'The ground is shaking...' } },
      { type: 'discovery', character_name: 'Lóa', created_at: at(33), metadata: { detail: 'entered the Plains' } },
      ...Array.from({ length: 18 }, (_, i) => ({
        type: 'death',
        character_name: CREW[i % 8],
        created_at: at(40 + i),
        metadata: { cause: i % 3 === 0 ? 'Deathsquito' : 'Fuling', biome: 'Plains' },
      })),
    ];
    return { sessions, events };
  };

  for (let d = 1; d <= 28; d++) {
    const iso = `2026-06-${String(d).padStart(2, '0')}`;
    const { sessions, events } = shapeFor(iso);
    const [e] = buildEpisodes(sessions, events, [], [], [], {
      titleAwards: [{ characterName: 'Rosir', title: 'the Far-Seer', awardedAt: `${iso}T23:00:00Z` }],
      potyAwards: [{ characterName: 'Mikael', awardLabel: '👑 Bane of Beasts (Boss-Slayer)', awardedAt: `${iso}T23:30:00Z` }],
      firstSeen: CREW.map((n) => ({ characterName: n, firstSeenAt: '2026-01-01T00:00:00Z' })),
      chatLines: [{ characterName: 'Lóa', message: 'that was the worst landing yet', createdAt: `${iso}T22:45:00Z` }],
    });
    const n = sentences(e.description);
    ok(n >= 4 && n <= 7, `${iso}: four to seven sentences, got ${n}: ${e.description}`);
    ok(!/[\u2014\u2013]/.test(`${e.title} ${e.description}`), `${iso}: no dash, got: ${e.description}`);
    ok(!/\{|\}/.test(`${e.title} ${e.description}`), `${iso}: no brace, got: ${e.description}`);
    ok(!/\s{2}/.test(e.description) && !/\s[.,]/.test(e.description), `${iso}: no stray spacing, got: ${e.description}`);
    ok(e.description.trim().endsWith('.'), `${iso}: closes a sentence, got: ${e.description}`);
  }
}

// ═══ 7. DEATHS ARE ONE COLOUR, NOT THE DEFAULT HEADLINE ═════════════════
// Charlie, on the shipped page: "The story each day seems to over index on
// deaths." Thirteen of nineteen nights carried a death-count title. The ladder
// now puts a boss, a Great Deed, a newcomer, new country, a raid, places, oaths
// and titles above deaths, and deaths only lead when the night really was the
// deadliest of its week (or when 30-plus deaths are genuinely all there was).
{
  const CAUSES = ['Fuling', 'Greydwarf', 'Deathsquito', 'Draugr'];
  const nightOf = (date, { vikings = 20, deaths = 0, minutes = 300, extra = [] } = {}) => {
    const roster = CREW.slice(0, vikings);
    return {
      sessions: roster.map((n) => ({
        character_name: n,
        joined_at: `${date}T22:00:00Z`,
        left_at: `${date}T23:00:00Z`,
        duration_minutes: minutes,
      })),
      events: [
        ...Array.from({ length: deaths }, (_, i) => ({
          type: 'death',
          character_name: roster[i % roster.length],
          // Four causes in rotation, so no single creature owns a third of the
          // night and the horde title cannot fire.
          created_at: `${date}T22:${String(5 + (i % 50)).padStart(2, '0')}:00Z`,
          metadata: { cause: CAUSES[i % CAUSES.length], biome: 'Plains' },
        })),
        ...extra.map((ev) => ({ ...ev, created_at: `${date}T22:02:00Z` })),
      ],
    };
  };

  const noDeathCount = (d, label) => {
    ok(!/\b\d+ (deaths|lives)\b/i.test(d), `${label}: no death count, got: ${d}`);
    ok(!/Blood was spilled/i.test(d), `${label}: no blood tally, got: ${d}`);
    ok(!/deaths darkened/i.test(d), `${label}: no death tally, got: ${d}`);
    ok(!/took (\w+|\d+) of them/i.test(d), `${label}: no grouped death picture, got: ${d}`);
  };

  // (a) TWENTY VIKINGS, TWELVE DEATHS, ONE NEW PLACE. The place names the
  //     night on both tiers, and the description never counts the dead.
  {
    const pin = { name: 'Boss Stones', kind: 'landmark', by_character_name: 'Mikael', created_at: '2026-02-10T23:00:00Z' };
    const n = nightOf('2026-02-10', { vikings: 20, deaths: 12 });

    const [terseEp] = buildEpisodes(n.sessions, n.events, [], [pin]);
    eq(terseEp.tier, 'terse', 'twelve deaths and a pin is an ordinary night');
    ok(!/Death/i.test(terseEp.title), `terse: a non-death title, got: ${terseEp.title}`);
    eq(terseEp.title, 'New Ground, Newly Named', 'terse: the place names it');
    noDeathCount(terseEp.description, 'terse');

    // The same night with a tale told about it clears the floor and goes loud.
    const [loudEp] = buildEpisodes(n.sessions, n.events, [], [pin], [
      { id: 't1', title: 'A quiet map', text: 'We walked the shore.', told_for: '2026-02-10', created_at: '2026-02-10T23:30:00Z' },
    ]);
    eq(loudEp.tier, 'expressive', 'a tale takes it over the floor');
    ok(!/Death/i.test(loudEp.title), `expressive: a non-death title, got: ${loudEp.title}`);
    noDeathCount(loudEp.description, 'expressive');
    ok(/Boss Stones/.test(loudEp.description), `expressive: the place is in the prose, got: ${loudEp.description}`);
  }

  // (b) FORTY-ONE DEATHS AND NOTHING ELSE still leads with the dying, by
  //     either of the two routes that are left open to it.
  {
    // Route one: the deadliest night of its week, among nights that exist.
    const quietA = nightOf('2026-02-17', { deaths: 5 });
    const bad = nightOf('2026-02-18', { deaths: 41 });
    const quietB = nightOf('2026-02-19', { deaths: 5 });
    const eps = buildEpisodes(
      [...quietA.sessions, ...bad.sessions, ...quietB.sessions],
      [...quietA.events, ...bad.events, ...quietB.events]
    );
    eq(eps.length, 3, 'three nights');
    eq(eps[1].title, 'The Night of Forty-One Deaths', 'the deadliest night of the week is named for it');
    ok(!/Death/i.test(eps[0].title), `and its quiet neighbour is not, got: ${eps[0].title}`);
    ok(
      /took \d+ of them|did most of the work/i.test(eps[1].description),
      `the peak night leads with the death picture, got: ${eps[1].description}`
    );

    // Route two: thirty or more with nothing above it at all, turnout
    // included, which on a four-viking night means the count is all there is.
    const lonely = nightOf('2026-02-24', { vikings: 4, deaths: 41 });
    const [only] = buildEpisodes(lonely.sessions, lonely.events);
    eq(only.title, 'The Day of 41 Deaths', 'thirty-plus deaths and nothing else, not even a hall');
  }

  // (c) A BOSS, A GREAT DEED AND A NEWCOMER EACH OUTRANK THE DEADLIEST NIGHT.
  //     Same 41-death peak, one extra event at a time.
  {
    const build = (extra, firstSeen) => {
      const quietA = nightOf('2026-02-17', { deaths: 5 });
      const bad = nightOf('2026-02-18', { deaths: 41, extra });
      const quietB = nightOf('2026-02-19', { deaths: 5 });
      return buildEpisodes(
        [...quietA.sessions, ...bad.sessions, ...quietB.sessions],
        [...quietA.events, ...bad.events, ...quietB.events],
        [], [], [],
        firstSeen ? { firstSeen } : {}
      )[1];
    };

    const boss = build([{ type: 'boss', character_name: 'Mikael', metadata: { boss: 'Bonemass', players: '12 vikings' } }]);
    eq(boss.title, 'The Night Bonemass Fell', 'a boss outranks the deadliest night of the week');
    ok(/Bonemass/.test(boss.description), `and leads the prose, got: ${boss.description}`);

    const deed = build([{ type: 'milestone', metadata: { title: 'The Long Haul', line: 'a hundred trees felled' } }]);
    // The deed rung has three shapes (DEED_TITLES); all of them name the deed
    // and none of them counts the dead.
    ok(
      /Long Haul/.test(deed.title) && !/Death/i.test(deed.title),
      `a Great Deed outranks it too, got: ${deed.title}`
    );
    ok(/The Long Haul/.test(deed.description), `and leads the prose, got: ${deed.description}`);

    const newcomer = build([], [{ characterName: 'Mikael', firstSeenAt: '2026-02-18T22:00:00Z' }]);
    ok(
      /Mikael/.test(newcomer.title) && !/Death/i.test(newcomer.title),
      `a first night outranks it as well, got: ${newcomer.title}`
    );
    ok(/Mikael/.test(newcomer.description), `and leads the prose, got: ${newcomer.description}`);
  }
}

// ═══ 8. THE BOSS NIGHT ══════════════════════════════════════════════════
// A forsaken falls eight times in a season. The `events` row the Story used to
// read carries the boss name and a COUNT of players; the `bosses` row beside
// it carries the war party, a per-fighter damage ledger, how long the fight
// ran and who was still in the realm when it dropped. Built 2026-10-02 for
// Moder's inaugural kill.
{
  const WARBAND = [
    "S'aeien", 'Asbjorn', 'Yosh', 'Mikael', 'Kætiløy', 'Lóa', 'Psifour', 'Æymundr',
    'Fjällhnot', 'Yunter', 'Bren', 'Skarde',
  ];
  const DAMAGE = {
    "S'aeien": 9713, Asbjorn: 7368, Yosh: 6688, Mikael: 5682, 'Kætiløy': 5196,
    'Lóa': 4100, Psifour: 3900, 'Æymundr': 3200, 'Fjällhnot': 2800, Yunter: 2400,
    Bren: 1900, Skarde: 1200,
  };
  const DAY = '2026-10-02';
  const at = (m) => new Date(Date.parse(`${DAY}T22:00:00Z`) + m * 60_000).toISOString();

  // Distinct minutes on purpose: with every session the same length the
  // participant order IS the input order (a stable sort on first-seen order),
  // and the determinism check below would be testing the fixture rather than
  // the renderer.
  const sessions = WARBAND.map((n, i) => ({
    character_name: n, joined_at: at(0), left_at: at(420 - i * 20), duration_minutes: 420 - i * 20,
  }));
  const bossEvent = {
    type: 'boss', character_name: 'Mikael', created_at: at(40),
    metadata: { boss: 'Moder', players: '12 vikings', world_day: 221 },
  };
  // Two of them died to Moder itself, one to something else: only the first
  // two are the boss's toll.
  const deaths = [
    { type: 'death', character_name: 'Æymundr', created_at: at(38), metadata: { cause: 'Moder', biome: 'Mountain' } },
    { type: 'death', character_name: 'Yunter', created_at: at(39), metadata: { cause: 'wolf', attacker: 'Moder', biome: 'Mountain' } },
    { type: 'death', character_name: 'Bren', created_at: at(20), metadata: { cause: 'Fuling', biome: 'Plains' } },
  ];
  const bossFights = [
    {
      name: 'Moder',
      killedAt: at(40),
      playersPresent: WARBAND,
      fightStats: {
        fighters: WARBAND,
        damage: DAMAGE,
        topDamagePlayer: "S'aeien",
        topDamage: 9713,
        onlineAtKill: WARBAND.slice(0, 11),
        source: 'gs',
      },
      retellingAt: at(42),
    },
  ];
  const extras = { bossFights, bossFightSeconds: { Moder: 253 } };

  const [ep] = buildEpisodes(sessions, [bossEvent, ...deaths], [], [], [], extras);

  eq(ep.tier, 'expressive', 'a boss night is always told loudly');
  eq(ep.bossFights.length, 1, 'the fight was bucketed onto its night');
  eq(ep.bossFights[0].fightSec, 253, 'the warband clock supplied the length');
  eq(ep.bossFights[0].onlineAtKill, 11, 'and the roster at the kill');
  eq(ep.bossFights[0].toll.join(','), 'Æymundr,Yunter', 'cause and attacker both count toward the toll');
  eq(ep.bossFights[0].retellingAt, at(42), 'the card knows there is a retelling to link to');
  eq(ep.bossFights[0].worldDay, 221, 'the kill event supplied the world day');

  const d = ep.description;
  const n = sentences(d);
  ok(n >= 8 && n <= 12, `a boss night runs eight to twelve sentences, got ${n}: ${d}`);

  // The block says who marched, how long, who hit hardest and what it cost.
  ok(/Moder/.test(d), `the boss is named, got: ${d}`);
  // Twelve fighters, spelled out because the house style spells anything
  // under thirteen.
  ok(/twelve in all|of twelve|twelve strong/.test(d), `the war party is counted, got: ${d}`);
  ok(/S'aeien/.test(d), `the hardest hitter is named, got: ${d}`);
  ok(/9,713/.test(d), `with the number, grouped, got: ${d}`);
  ok(/Asbjorn/.test(d) && /Yosh/.test(d), `and the two behind them, got: ${d}`);
  ok(/four minutes/.test(d), `the fight length is told in words, got: ${d}`);
  ok(/Æymundr/.test(d) && /Yunter/.test(d), `the toll is named, got: ${d}`);
  // And named ONCE: the block's toll line replaces the lone death sentence.
  eq((d.match(/Æymundr/g) ?? []).length, 1, `the toll is not told twice, got: ${d}`);
  ok(/day 221/.test(d), `the kill carries its world day, got: ${d}`);
  ok(/eleven/.test(d), `and who was standing there at the end, got: ${d}`);

  // The title comes from the boss-night pool.
  ok(
    /Moder|Mountain's Dragon/.test(ep.title),
    `the title names the forsaken, got: ${ep.title}`
  );

  // It reads as prose, by the same rules every other night is held to.
  ok(!/[\u2014\u2013]/.test(`${ep.title} ${d}`), `no dash on a boss night, got: ${d}`);
  ok(!/\{|\}/.test(`${ep.title} ${d}`), `every token is filled, got: ${d}`);
  ok(!/\s{2}/.test(d) && !/\s[.,]/.test(d), `no stray spacing, got: ${d}`);
  ok(!/\.\s+[a-z0-9]/.test(d), `every sentence opens with a capital, got: ${d}`);
  ok(d.trim().endsWith('.'), `and the last one closes, got: ${d}`);

  // DETERMINISM, including against re-ordered input.
  const again = buildEpisodes(sessions, [bossEvent, ...deaths], [], [], [], extras)[0];
  eq(again.description, d, 'the boss block is deterministic');
  eq(again.title, ep.title, 'and so is its title');
  const shuffled = buildEpisodes(
    [...sessions].reverse(),
    [...deaths].reverse().concat(bossEvent),
    [], [], [],
    { ...extras, bossFights: [...bossFights] }
  )[0];
  eq(shuffled.description, d, 'input order does not change the telling');

  // NO `bosses` ROW, SAME EVENT: the single line the Story has always had.
  const [plain] = buildEpisodes(sessions, [bossEvent, ...deaths]);
  eq(plain.tier, 'expressive', 'still a boss night');
  eq(plain.bossFights.length, 0, 'but with no record of the fight');
  const pn = sentences(plain.description);
  ok(pn >= 4 && pn <= 7, `so it keeps the ordinary budget, got ${pn}: ${plain.description}`);
  ok(/Moder/.test(plain.description), `and still says the boss fell, got: ${plain.description}`);
  ok(!/9,713/.test(plain.description), `without inventing a ledger, got: ${plain.description}`);
  ok(/^The (Night Moder Fell|Fall of Moder)$/.test(plain.title), `and keeps the old title, got: ${plain.title}`);

  // A FIGHT THAT KEPT ALMOST NO RECORD still produces honest sentences rather
  // than a paragraph of hedging.
  const [bare] = buildEpisodes(sessions, [bossEvent], [], [], [], {
    bossFights: [{ name: 'Moder', killedAt: at(40), playersPresent: [], fightStats: null, retellingAt: null }],
  });
  ok(!/\{|\}/.test(bare.description), `no holes in a recordless fight, got: ${bare.description}`);
  const bn = sentences(bare.description);
  ok(bn >= 4 && bn <= 12, `and a sane length, got ${bn}: ${bare.description}`);

  // EVERY SEED, because the pools are seeded per calendar day.
  for (let day = 1; day <= 28; day++) {
    const key = `2026-11-${String(day).padStart(2, '0')}`;
    const t = (m) => new Date(Date.parse(`${key}T22:00:00Z`) + m * 60_000).toISOString();
    const [e] = buildEpisodes(
      WARBAND.map((nm) => ({ character_name: nm, joined_at: t(0), left_at: t(300), duration_minutes: 300 })),
      [
        { type: 'boss', character_name: 'Mikael', created_at: t(40), metadata: { boss: 'Moder', world_day: 221 } },
        { type: 'death', character_name: 'Æymundr', created_at: t(38), metadata: { cause: 'Moder' } },
      ],
      [], [], [],
      {
        bossFights: [{ ...bossFights[0], killedAt: t(40) }],
        bossFightSeconds: { Moder: 253 },
      }
    );
    const c = sentences(e.description);
    ok(c >= 8 && c <= 12, `${key}: eight to twelve on a boss night, got ${c}: ${e.description}`);
    ok(!/[\u2014\u2013]/.test(`${e.title} ${e.description}`), `${key}: no dash, got: ${e.description}`);
    ok(!/\{|\}/.test(`${e.title} ${e.description}`), `${key}: no brace, got: ${e.title} / ${e.description}`);
    ok(!/\.\s+[a-z0-9]/.test(e.description), `${key}: every sentence opens with a capital, got: ${e.description}`);
    ok(!/\s{2}/.test(e.description) && !/\s[.,]/.test(e.description), `${key}: no stray spacing, got: ${e.description}`);
  }
}

console.log(`OK — all expressive-episode assertions passed (${checks} checks)`);
