// Unit tests for the Living Boards sign renderer (the strings a plugin pastes
// onto in-game signs). Run: npx tsx lib/boards.test.mjs
import assert from 'node:assert';
import {
  buildBoards,
  truncate,
  formatCount,
  formatKm,
  formatPct,
  formatLifeSpan,
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

// ── Whole-payload stability: same input, same eight strings ───────────────
{
  const roster = [
    viking('Astrid', { kills: 12, deaths: 3, builds: 400, resources: 9_000, distanceM: 84_200, exploredPct: 31.94, title: 'the Provider' }),
    viking('Bjorn Ironside', { kills: 12, deaths: 9, builds: 120, resources: 4_000, distanceM: 12_000, exploredPct: 8, title: 'the Wayfarer' }),
  ];
  const deeds = { achieved: 3, total: 15, latest: { title: 'The First Marathon', achievedAt: '2026-07-07T00:00:00Z' } };
  assert.deepStrictEqual(buildBoards(roster, deeds), buildBoards(roster, deeds),
    'buildBoards is deterministic across calls');
  passed++;
  const b = buildBoards(roster, deeds);
  ok(Object.keys(b).length === 8, `eight boards, got ${Object.keys(b).length}`);
  // The 14-char name is truncated wherever it ranks.
  ok(b.deaths.includes('Bjorn Irons…'), `long name truncated on the board, got ${b.deaths}`);
  ok(b.distance.includes('84.2 km') && b.explored.includes('31.9%'), 'units rendered on the boards');
}

console.log(`boards.test: ${passed} assertions passed`);
