// Unit tests for the Living Boards sign renderer (the strings a plugin pastes
// onto in-game signs). Run: npx tsx lib/boards.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildBoards,
  buildLeaders,
  dayBoard,
  truncate,
  formatCount,
  formatKm,
  formatPct,
  formatHours,
  formatLifeSpan,
  BOARD_KEYS,
  STAT_KEYS,
  TOP_N,
  MAX_NAME_CHARS,
  MAX_TITLE_CHARS,
  BOARD_CHAR_BUDGET,
  EMPTY_LINE,
} from './boards.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

/** A viking with every metric zeroed; pass overrides for the one under test. */
const viking = (name, over = {}) => ({
  name,
  title: null,
  kills: 0,
  deaths: 0,
  builds: 0,
  resources: 0,
  crafts: 0,
  distanceM: 0,
  exploredPct: null,
  longestLifeSec: 0,
  bestKillsBeforeDeath: 0,
  damageDealt: 0,
  playtimeMin: 0,
  fishCaught: 0,
  ...over,
});

const NO_DEEDS = { achieved: 0, total: 0, latest: null };
const lines = (board) => board.split('\n');
const rows = (board) => lines(board).slice(1); // drop the <b>Header</b>

// ── Units ─────────────────────────────────────────────────────────────────
{
  ok(formatCount(1842) === '1,842', `thousands separated, got ${formatCount(1842)}`);
  ok(formatCount(7) === '7', `small counts unadorned, got ${formatCount(7)}`);

  // Distance is ALWAYS km with one decimal — a sign column must not change width.
  ok(formatKm(84200) === '84.2 km', `84200m -> 84.2 km, got ${formatKm(84200)}`);
  ok(formatKm(920) === '0.9 km', `sub-km still km (not "920 m"), got ${formatKm(920)}`);
  ok(formatKm(1000) === '1.0 km', `exact km keeps the decimal, got ${formatKm(1000)}`);

  ok(formatPct(31.94) === '31.9%', `rounds to one decimal, got ${formatPct(31.94)}`);
  ok(formatPct(30) === '30%', `whole percent drops ".0", got ${formatPct(30)}`);

  // Hours are ALWAYS hours with one decimal — the site's formatPlaytime switches
  // between "48m" and "2h 5m", which would change a sign row's width mid-poll.
  ok(formatHours(750) === '12.5 h', `750 min -> 12.5 h, got ${formatHours(750)}`);
  ok(formatHours(30) === '0.5 h', `sub-hour still hours (not "30m"), got ${formatHours(30)}`);
  ok(formatHours(120) === '2.0 h', `exact hours keep the decimal, got ${formatHours(120)}`);

  ok(formatLifeSpan(7500) === '2h 5m', `7500s -> 2h 5m, got ${formatLifeSpan(7500)}`);
  ok(formatLifeSpan(120) === '0h 2m', `both parts always present, got ${formatLifeSpan(120)}`);
  ok(formatLifeSpan(0) === '0h 0m', `zero is safe, got ${formatLifeSpan(0)}`);
}

// ── truncate: names over the cap lose their tail to an ellipsis ───────────
{
  ok(truncate('Bjorn', MAX_NAME_CHARS) === 'Bjorn', 'short names untouched');
  const exact = 'Twelvecharss'; // exactly 12
  ok(exact.length === MAX_NAME_CHARS && truncate(exact, MAX_NAME_CHARS) === exact,
    'a name AT the cap is not truncated');
  const long = truncate('Bjorn Ironside', MAX_NAME_CHARS);
  ok(long === 'Bjorn Irons…', `13+ chars truncated with an ellipsis, got ${long}`);
  ok(long.length === MAX_NAME_CHARS, `truncated name is exactly the cap, got ${long.length}`);
  ok(truncate('  Padded  ', MAX_NAME_CHARS) === 'Padded', 'surrounding whitespace trimmed');
}

// ── Top-5 ordering, value desc ────────────────────────────────────────────
{
  const roster = [
    viking('Astrid', { kills: 10 }),
    viking('Bjorn', { kills: 50 }),
    viking('Ceol', { kills: 30 }),
    viking('Dagr', { kills: 40 }),
    viking('Eir', { kills: 20 }),
    viking('Frode', { kills: 5 }),
    viking('Gunnar', { kills: 1 }),
  ];
  const b = buildBoards(roster, NO_DEEDS).kills;
  ok(lines(b)[0] === '<b>Kills</b>', `header is a bold first line, got ${lines(b)[0]}`);
  ok(rows(b).length === TOP_N, `exactly ${TOP_N} rows, got ${rows(b).length}`);

  const names = rows(b).map((l) => l.split(' ')[0]);
  assert.deepStrictEqual(names, ['Bjorn', 'Dagr', 'Ceol', 'Eir', 'Astrid'], 'ordered by value desc');
  passed++;
  ok(!b.includes('Frode') && !b.includes('Gunnar'), 'players outside the top 5 are cut');
  ok(!b.endsWith('\n'), 'no trailing newline');
}

// ── Deterministic ties: equal values fall back to name ascending ──────────
{
  const tied = [
    viking('Sigrun', { builds: 100 }),
    viking('Arne', { builds: 100 }),
    viking('Magnus', { builds: 100 }),
  ];
  const forward = buildBoards(tied, NO_DEEDS).builds;
  // Same roster, reversed input order — the sign string must be IDENTICAL, or the
  // plugin would rewrite the sign on every poll.
  const reversed = buildBoards(tied.slice().reverse(), NO_DEEDS).builds;
  ok(forward === reversed, 'tie order is input-order independent');
  const names = rows(forward).map((l) => l.split(' ')[0]);
  assert.deepStrictEqual(names, ['Arne', 'Magnus', 'Sigrun'], 'ties broken by name ascending');
  passed++;
}

// ── Zero-skip: a metric at 0 (or null) never reaches the sign ─────────────
{
  const roster = [
    viking('Astrid', { kills: 3, deaths: 0, exploredPct: null }),
    viking('Bjorn', { kills: 0, deaths: 2, exploredPct: 12.5 }),
  ];
  const boards = buildBoards(roster, NO_DEEDS);
  ok(boards.kills.includes('Astrid') && !boards.kills.includes('Bjorn'), 'zero kills skipped');
  ok(boards.deaths.includes('Bjorn') && !boards.deaths.includes('Astrid'), 'zero deaths skipped');
  ok(boards.explored.includes('Bjorn') && !boards.explored.includes('Astrid'),
    'null map_explored_pct skipped');
  // Nobody has built anything -> honest empty state, not five rows of "0".
  ok(boards.builds === `<b>Builds</b>\n${EMPTY_LINE}`, `empty board states so, got ${boards.builds}`);
}
{
  // Negative / non-finite junk from a bad merge must not rank above a real score.
  const roster = [viking('Astrid', { distanceM: -5 }), viking('Bjorn', { distanceM: NaN })];
  const b = buildBoards(roster, NO_DEEDS).distance;
  ok(b === `<b>Distance</b>\n${EMPTY_LINE}`, `negative and NaN are skipped, got ${b}`);
}

// ── Rich text: <b> header plus AT MOST ONE <color=#...> accent ────────────
{
  const roster = [viking('Astrid', { kills: 9 }), viking('Bjorn', { kills: 4 })];
  const boards = buildBoards(roster, { achieved: 7, total: 15, latest: { title: 'The First Marathon', achievedAt: '2026-07-07T00:00:00Z' } });
  for (const [key, board] of Object.entries(boards)) {
    const colors = board.match(/<color=#/g) ?? [];
    ok(colors.length <= 1, `${key}: at most one colour tag, got ${colors.length}`);
    const tags = board.match(/<[^>]+>/g) ?? [];
    ok(tags.every((t) => /^(<b>|<\/b>|<color=#[0-9a-fA-F]{3,8}>|<\/color>)$/.test(t)),
      `${key}: only <b> and <color=#..> markup, got ${tags.join(',')}`);
  }
  // The accent marks the LEADER's value, so the winner reads at a glance.
  ok(/^Astrid <color=#[0-9a-f]{6}>9<\/color>$/i.test(rows(boards.kills)[0]),
    `leader's value is accented, got ${rows(boards.kills)[0]}`);
  ok(!rows(boards.kills)[1].includes('<color'), 'runners-up are plain');
}

// ── Char budget: every board fits a sign, rows dropped whole ──────────────
{
  const roster = Array.from({ length: 40 }, (_, i) =>
    viking(`Verylongvikingname${i}`, {
      kills: 1_000_000 - i,
      deaths: 999_999 - i,
      builds: 888_888 - i,
      resources: 777_777 - i,
      distanceM: 9_999_999 - i,
      exploredPct: 99.9 - i / 100,
      damageDealt: 12_345_678 - i,
      playtimeMin: 999_999 - i,
      crafts: 666_666 - i,
      fishCaught: 555_555 - i,
      title: 'the Exceedingly Long Winded Epithet of Doom',
    }));
  const boards = buildBoards(roster, {
    achieved: 15,
    total: 15,
    latest: { title: 'An Absurdly Long Great Deed Title That Runs On', achievedAt: '2026-08-01T00:00:00Z' },
  });
  for (const [key, board] of Object.entries(boards)) {
    ok(board.length <= BOARD_CHAR_BUDGET, `${key}: ${board.length} chars <= ${BOARD_CHAR_BUDGET}`);
    ok(!board.endsWith('\n'), `${key}: no trailing newline`);
    // Budget must drop whole ROWS, never clip a line mid-word.
    ok(rows(board).every((l) => l.length > 0), `${key}: no empty rows`);
    for (const l of rows(board)) {
      ok(!/…$/.test(l) || l.includes('…'), `${key}: rows end cleanly`);
    }
  }
  // Names still capped inside a budget-trimmed board.
  ok(rows(boards.kills).every((l) => l.split(' ')[0].length <= MAX_NAME_CHARS),
    'every name obeys the cap');
}

// ── Living Titles: everyone titled, alphabetical, no accent ───────────────
{
  const roster = [
    viking('Sigrun', { title: 'the Provider' }),
    viking('Arne', { title: null }),
    viking('Magnus', { title: '   ' }),
    viking('Bjorn', { title: 'the Wayfarer' }),
  ];
  const b = buildBoards(roster, NO_DEEDS).titles;
  ok(lines(b)[0] === '<b>Living Titles</b>', `titles header, got ${lines(b)[0]}`);
  assert.deepStrictEqual(rows(b), ['Bjorn — the Wayfarer', 'Sigrun — the Provider'],
    'alphabetical, untitled and whitespace-only skipped');
  passed++;
  ok(!b.includes('<color'), 'no accent on titles (alphabetical order implies no winner)');
  // Not a top-5 board: more than TOP_N titled vikings all appear (budget allowing).
  const many = Array.from({ length: 7 }, (_, i) => viking(`V${i}`, { title: 'the Bold' }));
  ok(rows(buildBoards(many, NO_DEEDS).titles).length > TOP_N, 'titles board is not capped at 5');
}
{
  const b = buildBoards([viking('Astrid', { title: 'a'.repeat(40) })], NO_DEEDS).titles;
  const title = rows(b)[0].split(' — ')[1];
  ok(title.length === MAX_TITLE_CHARS && title.endsWith('…'),
    `long titles truncated to ${MAX_TITLE_CHARS}, got ${title}`);
}
{
  ok(buildBoards([], NO_DEEDS).titles === `<b>Living Titles</b>\n${EMPTY_LINE}`,
    'no titled vikings -> empty state');
}

// ── Great Deeds summary ───────────────────────────────────────────────────
{
  const b = buildBoards([], { achieved: 7, total: 15, latest: { title: 'The First Marathon', achievedAt: '2026-07-07T00:00:00Z' } }).deeds;
  assert.deepStrictEqual(lines(b), [
    '<b>Great Deeds</b>',
    '<color=#f2c14e>7 of 15</color>',
    'Latest: The First Marathon',
  ], 'deeds board shows progress then the newest deed');
  passed++;
}
{
  const b = buildBoards([], { achieved: 0, total: 15, latest: null }).deeds;
  assert.deepStrictEqual(lines(b), ['<b>Great Deeds</b>', '<color=#f2c14e>0 of 15</color>'],
    'no deed earned yet -> progress only');
  passed++;
  // Pre-migration (table missing -> lib/data returns []) must not render "0 of 0".
  ok(buildBoards([], NO_DEEDS).deeds === `<b>Great Deeds</b>\n${EMPTY_LINE}`,
    'no milestone rows at all -> empty state');
}

// ── The world day: the one board that turns without a viking ─────────────
// Added 2026-09-25 because a player asked for a sign that says what day it is.
// Everything here is the same contract as the rest: one accent, the budget, and
// an honest empty state rather than a number nobody can trust.
{
  const b = dayBoard(673);
  assert.deepStrictEqual(lines(b), ['<b>Day</b>', '<color=#f2c14e>673</color>'],
    'the day board is its header plus the number, accented');
  passed++;
  ok(b === `<b>Day</b>\n<color=#f2c14e>673</color>`, `exact string, got ${JSON.stringify(b)}`);
  ok(dayBoard(1) === `<b>Day</b>\n<color=#f2c14e>1</color>`, `day one renders, got ${dayBoard(1)}`);
  // Bare digits past a thousand: the Hall page and the game both say "Day 1042", and
  // this world reaches that in about a week of real time.
  ok(dayBoard(1042) === `<b>Day</b>\n<color=#f2c14e>1042</color>`,
    `no thousands separator on a day, got ${dayBoard(1042)}`);

  // No usable day is said plainly. A plank reading "Day 0" reads as a broken feed.
  const empty = `<b>Day</b>\n${EMPTY_LINE}`;
  ok(dayBoard(null) === empty, `no status row -> empty state, got ${dayBoard(null)}`);
  ok(dayBoard(0) === empty, `a world not yet a day old -> empty state, got ${dayBoard(0)}`);
  ok(dayBoard(-3) === empty, `a negative day -> empty state, got ${dayBoard(-3)}`);
  ok(dayBoard(Number.NaN) === empty, 'NaN -> empty state');
  ok(!dayBoard(null).includes('<color'), 'an empty day board spends no accent');

  // The board on the sign IS what buildBoards was handed.
  ok(buildBoards([], NO_DEEDS, 673).day === dayBoard(673), 'buildBoards renders the day it is given');
  ok(buildBoards([], NO_DEEDS, null).day === dayBoard(null),
    'a null world day reaches the sign as the empty state, not as a crash');

  // Budget and accent, at the widest day this world could ever reach.
  for (const day of [1, 673, 9_999_999, 0, null]) {
    const rendered = dayBoard(day);
    ok(rendered.length <= BOARD_CHAR_BUDGET,
      `day ${day}: ${rendered.length} chars <= ${BOARD_CHAR_BUDGET}`);
    ok((rendered.match(/<color=#/g) ?? []).length <= 1, `day ${day}: at most one accent tag`);
    ok(!rendered.endsWith('\n'), `day ${day}: no trailing newline`);
  }
}

// ── Leader plaques: the top row of the same board, standing alone ─────────
// The whole contract is "a plaque and a full board never disagree about who is winning",
// so every assertion here compares against buildBoards rather than restating the format.
{
  const roster = [
    viking('Astrid', { kills: 12, deaths: 3, builds: 400, resources: 9_000, distanceM: 84_200, exploredPct: 31.94, title: 'the Provider', damageDealt: 90_000, playtimeMin: 750, crafts: 310, fishCaught: 44 }),
    // Ties Astrid on kills AND builds, so two of the ten leaders are decided by name.
    viking('Bjorn Ironside', { kills: 12, deaths: 9, builds: 400, resources: 4_000, distanceM: 12_000, exploredPct: 8, damageDealt: 40_000, playtimeMin: 300, crafts: 120, fishCaught: 9 }),
    viking('Ceol', { kills: 5, deaths: 1, builds: 12, resources: 1, distanceM: 5, exploredPct: 0.4, damageDealt: 10, playtimeMin: 20, crafts: 2, fishCaught: 1 }),
  ];
  const boards = buildBoards(roster, { achieved: 3, total: 15, latest: { title: 'The First Marathon', achievedAt: '2026-07-07T00:00:00Z' } });
  const leaders = buildLeaders(roster);

  // Ten, not twelve: Living Titles has no winner and Great Deeds is a warband total.
  assert.deepStrictEqual(
    Object.keys(leaders),
    ['kills', 'deaths', 'builds', 'resources', 'explored', 'distance', 'damage', 'hours', 'crafts', 'fish'],
    'ten stat plaques, no titles and no deeds',
  );
  passed++;
  assert.deepStrictEqual(STAT_KEYS, Object.keys(leaders), 'STAT_KEYS is exactly the plaque vocabulary');
  passed++;

  for (const key of STAT_KEYS) {
    const plaque = lines(leaders[key]);
    const full = lines(boards[key]);
    ok(plaque.length === 2, `${key}: header plus exactly one row, got ${plaque.length} lines`);
    ok(plaque[0] === full[0], `${key}: same header word as the full board, got ${plaque[0]}`);
    ok(plaque[1] === full[1], `${key}: the plaque IS the board's top row, got "${plaque[1]}" vs "${full[1]}"`);
    ok(!leaders[key].endsWith('\n'), `${key}: no trailing newline`);
    ok(leaders[key].length <= BOARD_CHAR_BUDGET, `${key}: ${leaders[key].length} chars <= ${BOARD_CHAR_BUDGET}`);

    // One accent, spent on the leader's whole value — same rule as a full board.
    const colors = leaders[key].match(/<color=#/g) ?? [];
    ok(colors.length === 1, `${key}: exactly one colour tag, got ${colors.length}`);
    ok(/^.+ <color=#[0-9a-f]{6}>[^<]+<\/color>$/i.test(plaque[1]),
      `${key}: the accent wraps the whole value, got ${plaque[1]}`);
    ok(plaque[1].split(' ')[0].length <= MAX_NAME_CHARS, `${key}: the name obeys the cap`);
  }
  // The 14-char name still wins deaths, still truncated.
  ok(leaders.deaths.includes('Bjorn Irons…'), `long names truncated on a plaque, got ${leaders.deaths}`);
}
{
  // Ties: deterministic and identical to the board's first line, whatever order rows arrive in.
  const tied = [
    viking('Sigrun', { builds: 100 }),
    viking('Arne', { builds: 100 }),
    viking('Magnus', { builds: 100 }),
  ];
  const forward = buildLeaders(tied).builds;
  ok(forward === buildLeaders(tied.slice().reverse()).builds, 'plaque tie order is input-order independent');
  ok(rows(forward)[0] === rows(buildBoards(tied, NO_DEEDS).builds)[0],
    `a tied plaque still names the board's top row, got ${rows(forward)[0]}`);
  ok(rows(forward)[0].split(' ')[0] === 'Arne', `ties broken by name ascending, got ${rows(forward)[0]}`);
}
{
  // Zero-skip on a plaque: an untouched stat must say so, not crown someone at 0.
  const leaders = buildLeaders([viking('Astrid', { kills: 3 }), viking('Bjorn', { kills: 0 })]);
  assert.deepStrictEqual(lines(leaders.kills), ['<b>Kills</b>', 'Astrid <color=#f2c14e>3</color>'],
    'a lone qualifier is the leader');
  passed++;
  ok(leaders.builds === `<b>Builds</b>\n${EMPTY_LINE}`, `nobody has built -> empty state, got ${leaders.builds}`);
  ok(leaders.explored === `<b>Explored</b>\n${EMPTY_LINE}`, `null map_explored_pct -> empty state, got ${leaders.explored}`);
  ok(!leaders.builds.includes('<color'), 'an empty plaque spends no accent');
  ok(buildLeaders([]).distance === `<b>Distance</b>\n${EMPTY_LINE}`, 'no roster at all -> empty state');
}

// ── Whole-payload stability: same input, same eight strings ───────────────
{
  const roster = [
    viking('Astrid', { kills: 12, deaths: 3, builds: 400, resources: 9_000, distanceM: 84_200, exploredPct: 31.94, title: 'the Provider', damageDealt: 90_210, playtimeMin: 750, crafts: 310, fishCaught: 44 }),
    viking('Bjorn Ironside', { kills: 12, deaths: 9, builds: 120, resources: 4_000, distanceM: 12_000, exploredPct: 8, title: 'the Wayfarer', damageDealt: 40_000, playtimeMin: 300, crafts: 120, fishCaught: 9 }),
  ];
  const deeds = { achieved: 3, total: 15, latest: { title: 'The First Marathon', achievedAt: '2026-07-07T00:00:00Z' } };
  assert.deepStrictEqual(buildBoards(roster, deeds), buildBoards(roster, deeds),
    'buildBoards is deterministic across calls');
  passed++;
  assert.deepStrictEqual(buildLeaders(roster), buildLeaders(roster),
    'buildLeaders is deterministic across calls');
  passed++;
  const b = buildBoards(roster, deeds, 673);
  ok(Object.keys(b).length === 13, `thirteen boards, got ${Object.keys(b).length}`);
  ok(b.day === dayBoard(673), 'the day board is the day the feed read');
  // The 14-char name is truncated wherever it ranks.
  ok(b.deaths.includes('Bjorn Irons…'), `long name truncated on the board, got ${b.deaths}`);
  ok(b.distance.includes('84.2 km') && b.explored.includes('31.9%'), 'units rendered on the boards');
  ok(b.damage.includes('90,210') && b.hours.includes('12.5 h'), 'new units rendered on the boards');
}

// ── The four boards added for parity with /players ────────────────────────
// One per dashboard leaderboard that had no sign: Damage, Hours, Crafts, Catches.
// Same machinery as the original six, so the assertions here are about the things
// that are NEW: the header word, the unit, and which raw field feeds each.
{
  const roster = [
    viking('Astrid', { damageDealt: 120_500, playtimeMin: 750, crafts: 310, fishCaught: 44 }),
    viking('Bjorn', { damageDealt: 90_000, playtimeMin: 300, crafts: 120, fishCaught: 9 }),
  ];
  const boards = buildBoards(roster, NO_DEEDS);
  const leaders = buildLeaders(roster);

  assert.deepStrictEqual(lines(boards.damage), [
    '<b>Damage</b>',
    'Astrid <color=#f2c14e>120,500</color>',
    'Bjorn 90,000',
  ], 'damage board: thousands separated, leader accented');
  passed++;
  assert.deepStrictEqual(lines(boards.hours), [
    '<b>Hours</b>',
    'Astrid <color=#f2c14e>12.5 h</color>',
    'Bjorn 5.0 h',
  ], 'hours board: minutes rendered as one-decimal hours');
  passed++;
  assert.deepStrictEqual(lines(boards.crafts), [
    '<b>Crafts</b>',
    'Astrid <color=#f2c14e>310</color>',
    'Bjorn 120',
  ], 'crafts board: items_crafted as a count');
  passed++;
  // Header word is "Catches" while the KEY is `fish` — the marker a player writes
  // is [board:fish], the word on the plank names the number.
  assert.deepStrictEqual(lines(boards.fish), [
    '<b>Catches</b>',
    'Astrid <color=#f2c14e>44</color>',
    'Bjorn 9',
  ], 'catches board: total catches as a count');
  passed++;

  for (const key of ['damage', 'hours', 'crafts', 'fish']) {
    ok(lines(leaders[key])[0] === lines(boards[key])[0], `${key}: plaque shares the board's header`);
    ok(lines(leaders[key])[1] === lines(boards[key])[1], `${key}: plaque IS the board's top row`);
    ok(lines(leaders[key]).length === 2, `${key}: plaque is header plus one row`);
  }

  // Zero-skip applies to the new boards too: no sign of five zeros.
  const empty = buildBoards([viking('Astrid')], NO_DEEDS);
  ok(empty.damage === `<b>Damage</b>\n${EMPTY_LINE}`, `untouched damage says so, got ${empty.damage}`);
  ok(empty.hours === `<b>Hours</b>\n${EMPTY_LINE}`, `untouched hours says so, got ${empty.hours}`);
  ok(empty.crafts === `<b>Crafts</b>\n${EMPTY_LINE}`, `untouched crafts says so, got ${empty.crafts}`);
  ok(empty.fish === `<b>Catches</b>\n${EMPTY_LINE}`, `untouched catches says so, got ${empty.fish}`);
}

// ── Budget: a 5-row new board with long names and huge numbers still fits ──
// Per board, not just in aggregate: "Catches" is a longer header than "Kills" and
// "12,345.6 h" is a wider value than any count, so each gets its own worst case.
{
  const worst = Array.from({ length: 5 }, (_, i) =>
    viking(`Verylongvikingname${i}`, {
      damageDealt: 99_999_999 - i,
      playtimeMin: 5_999_999 - i,
      crafts: 8_888_888 - i,
      fishCaught: 7_777_777 - i,
    }));
  const boards = buildBoards(worst, NO_DEEDS);
  const leaders = buildLeaders(worst);
  for (const key of ['damage', 'hours', 'crafts', 'fish']) {
    ok(boards[key].length <= BOARD_CHAR_BUDGET,
      `${key}: 5 long rows fit the budget (${boards[key].length} <= ${BOARD_CHAR_BUDGET})`);
    ok(!boards[key].endsWith('\n'), `${key}: no trailing newline`);
    ok(rows(boards[key]).every((l) => l.length > 0), `${key}: no empty rows`);
    ok(rows(boards[key]).every((l) => l.split(' ')[0].length <= MAX_NAME_CHARS),
      `${key}: every name obeys the cap`);
    ok(leaders[key].length <= BOARD_CHAR_BUDGET, `${key}: the plaque fits too`);
    const colors = boards[key].match(/<color=#/g) ?? [];
    ok(colors.length === 1, `${key}: still exactly one accent, got ${colors.length}`);
  }
}

// ── The marker vocabulary served as `keys` ────────────────────────────────
// A plugin claims `[board:<key>]` for any key in this array, so it must name every
// board the payload actually carries — nothing missing (a sign that can never be
// claimed) and nothing extra (a claim that resolves to nothing).
{
  const b = buildBoards([viking('Astrid', { kills: 1 })], NO_DEEDS);
  assert.deepStrictEqual([...BOARD_KEYS], Object.keys(b),
    'BOARD_KEYS is exactly the boards buildBoards returns, in order');
  passed++;
  assert.deepStrictEqual([...BOARD_KEYS].slice(0, STAT_KEYS.length), [...STAT_KEYS],
    'the ranked stat keys come first, so a :leader claim can be checked against the head');
  passed++;
  ok(BOARD_KEYS.includes('builds') && !BOARD_KEYS.includes('built'),
    'the original six keep their spelling (builds, not built) — a rename blanks claimed signs');
  ok(new Set(BOARD_KEYS).size === BOARD_KEYS.length, 'no duplicate keys');
  for (const key of ['damage', 'hours', 'crafts', 'fish', 'titles', 'deeds', 'day']) {
    ok(BOARD_KEYS.includes(key), `the vocabulary advertises "${key}"`);
  }
  // Append-only, and `day` is the newest: it sits after `deeds` and last of all, so
  // no sign already standing in the world changes which board it is claimed with.
  ok(BOARD_KEYS.indexOf('day') === BOARD_KEYS.indexOf('deeds') + 1,
    `day was appended after deeds, got ${BOARD_KEYS.join(', ')}`);
  ok(BOARD_KEYS[BOARD_KEYS.length - 1] === 'day', 'and is the last key in the vocabulary');
}

// ── The route wires it up (the half a pure module cannot prove) ───────────
{
  const route = readFileSync(new URL('../app/api/boards/route.ts', import.meta.url), 'utf8');
  ok(/keys:\s*\[\.\.\.BOARD_KEYS\]/.test(route), 'the route serves lib/boards BOARD_KEYS as `keys`');
  ok(/playtimeMin:\s*playtimeByName\.get/.test(route),
    'hours come from the sessions-derived playtime map, not players.total_playtime_minutes');
  ok(/fishCaught:\s*totalCatches\(p\.stats\)/.test(route), 'catches use the max-of-both-sources rule');
  ok(/damageDealt:\s*p\.stats\?\.damage_dealt/.test(route), 'damage comes from player_stats.damage_dealt');
  ok(/crafts:\s*p\.stats\?\.items_crafted/.test(route), 'crafts come from player_stats.items_crafted');
}

console.log(`boards.test: ${passed} assertions passed`);
