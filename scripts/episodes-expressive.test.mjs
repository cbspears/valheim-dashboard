// Expressive-night tests for lib/episodes.ts (no network).
//
// WHAT THIS GUARDS (Charlie, 2026-09-27): "the story to be more expressive
// sometimes, especially when there's a lot of people online and doing
// something notable." A 21-viking night with 41 deaths used to render the same
// two sentences as a four-viking night. It now renders four to seven specific
// ones — and, just as importantly, an ORDINARY night still renders exactly
// what it rendered before, byte for byte.
//
// The quiet-night expectation below is a SNAPSHOT of the real output captured
// from the unmodified code before this change landed. If it ever has to move,
// that is a decision about the season's existing cards, not a test that needs
// updating.
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
const QUIET_DESCRIPTION =
  'Bjorn, Ingrid and Sven gathered at the longfire, the world at day 120. Sven learned to fear the Greydwarf.';

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
  eq(ep.title, 'The First Marathon, Achieved', 'the Great Deed names the night');

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
  // Fourteen vikings alone is under the floor; an oath and a place named take
  // it over, and with no deaths and no deed the benches name the night.
  eq(buildEpisodes(crew(14), [], [oath], [pin])[0].title, 'Fourteen at the Benches');
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

console.log(`OK — all expressive-episode assertions passed (${checks} checks)`);
