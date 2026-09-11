// Tests for the bot's half of the excluded-character rule: src/excluded.js and
// the recap that every public board and the Player-of-the-Day crown come out of.
//
// The bot cannot import lib/excluded.ts, so the rule exists twice. These tests
// pin the JS copy to the same behaviour the site's tests pin the TS copy to —
// most importantly the one asymmetry that matters: a row read WITHOUT the
// `excluded` column carries `undefined`, and `undefined` must mean NOT excluded.
// Read the other way round, the first pre-migration tick would blank every board
// in #valheim.
//
// Run:
//   node scripts/excluded.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import {
  isExcluded,
  isExcludedName,
  filterExcluded,
  withoutExcluded,
  excludedNames,
  resetExcludedCache,
} from '../src/excluded.js';
import { createRecap, selectPlayerOfDay } from '../src/recap.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

// ── the default list, and the env override ─────────────────────────────────
eq(excludedNames(), ['steward'], 'the default list is Steward, folded to its comparison key');

{
  // The env var is the bot's mirror of config/server.ts. Spaces and empty
  // entries are tolerated so a hand-edited .env cannot half-work.
  const prev = process.env.EXCLUDED_CHARACTER_NAMES;
  process.env.EXCLUDED_CHARACTER_NAMES = 'Steward, Ghost ,';
  resetExcludedCache();
  eq(excludedNames().sort(), ['ghost', 'steward'], 'EXCLUDED_CHARACTER_NAMES overrides the default');
  ok(isExcludedName('ghost'), 'and the added name excludes');

  // An explicitly EMPTY var is "exclude nobody" — distinct from an unset one.
  process.env.EXCLUDED_CHARACTER_NAMES = '';
  resetExcludedCache();
  eq(excludedNames(), [], 'an empty var turns the name-list half off entirely');
  ok(!isExcludedName('Steward'), 'so no name is excluded by the list');
  ok(isExcluded({ character_name: 'Steward', excluded: true }), 'but the database flag still excludes');

  if (prev === undefined) delete process.env.EXCLUDED_CHARACTER_NAMES;
  else process.env.EXCLUDED_CHARACTER_NAMES = prev;
  resetExcludedCache();
}

// ── isExcludedName: fold case and padding, never match a blank ─────────────
ok(isExcludedName('Steward'), 'the listed name is excluded');
ok(isExcludedName('steward'), 'case folded');
ok(isExcludedName('  Steward '), 'padding trimmed');
ok(!isExcludedName('Stewards'), 'a longer name that merely starts the same is a different viking');
ok(!isExcludedName(''), 'a blank name is not excluded');
ok(!isExcludedName(null), 'nor is null');

// ── isExcluded: flag OR list; undefined means NOT ──────────────────────────
ok(isExcluded({ character_name: 'Astrid', excluded: true }), 'the flag alone excludes');
ok(isExcluded({ character_name: 'Steward' }), 'the list alone excludes (pre-migration)');
ok(isExcluded({ name: 'Steward' }), 'a `name` key works too — the bot tallies use both spellings');
ok(!isExcluded({ character_name: 'Astrid' }), 'an unflagged, unlisted viking is NOT excluded');
ok(!isExcluded(null), 'a missing row is not excluded');
eq(
  filterExcluded([{ character_name: 'Astrid' }, { character_name: 'Steward' }]).map((r) => r.character_name),
  ['Astrid'],
  'filterExcluded keeps order and drops the alt',
);
eq(filterExcluded(null), [], 'a null read degrades to empty, never a throw');

// ── withoutExcluded: the per-name tallies the recap is built out of ────────
eq(
  withoutExcluded({ Astrid: 3, Steward: 99, Bjorn: 1 }),
  { Astrid: 3, Bjorn: 1 },
  'a { name: value } tally loses its excluded keys and keeps the rest',
);
eq(withoutExcluded(null), {}, 'a missing tally is an empty one');

// ── selectPlayerOfDay: the crown is never offered to an excluded character ──
{
  // Steward out-dies and out-plays everybody. 'The Bold' needs 3 deaths, so
  // without the guard this ctx crowns the alt outright.
  const crown = selectPlayerOfDay({
    windowDeaths: { Steward: 9, Astrid: 1 },
    hours: { Steward: 8, Astrid: 2 },
  });
  ok(crown === null || crown.name !== 'Steward', 'the alt is never crowned Player of the Day');

  // Control: the identical shape with an ordinary name DOES crown, so the
  // assertion above cannot be passing merely because nothing ever crowns.
  const control = selectPlayerOfDay({
    windowDeaths: { Bjorn: 9, Astrid: 1 },
    hours: { Bjorn: 8, Astrid: 2 },
  });
  ok(control && control.name === 'Bjorn', 'control: the same tally crowns an ordinary viking');

  // The Unsung Hero spotlight ranks on FEWEST hours, so an excluded character
  // that logged five minutes would win it — the opposite end of the same list.
  const underdog = selectPlayerOfDay({
    hours: { Steward: 0.4, Astrid: 5, Bjorn: 6 },
    forceUnderdog: true,
  });
  ok(underdog === null || underdog.name !== 'Steward', 'nor is the alt crowned Unsung Hero');
}

// ── buildStats: the day boards, the hall's hours, and the stat deltas ──────
function fakeDb(tables) {
  return {
    from(table) {
      const q = {};
      const chain = () => (...args) => { void args; return q; };
      for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'is', 'not', 'or', 'order', 'limit']) {
        q[m] = chain();
      }
      q.maybeSingle = () => Promise.resolve({ data: tables[table]?.[0] ?? null, error: null });
      q.single = q.maybeSingle;
      q.then = (onOk, onErr) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(onOk, onErr);
      return q;
    },
  };
}

{
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const hourAgo = new Date(now - 3600_000).toISOString();
  const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString();

  const recap = createRecap({
    db: fakeDb({
      sessions: [
        { character_name: 'Astrid', joined_at: hourAgo, left_at: nowIso },
        // The alt played twice as long as anybody.
        { character_name: 'Steward', joined_at: twoHoursAgo, left_at: nowIso },
      ],
      events: [
        { character_name: 'Astrid', created_at: hourAgo, metadata: { cause: 'Troll' } },
        { character_name: 'Steward', created_at: hourAgo, metadata: { cause: 'Troll' } },
        { character_name: 'Steward', created_at: new Date(now - 1800_000).toISOString(), metadata: {} },
      ],
      bosses: [],
      players: [
        { id: 'p1', character_name: 'Astrid' },
        { id: 'p2', character_name: 'Steward', excluded: true },
      ],
      player_stats: [
        { player_id: 'p1', kills: 10, resources_harvested: 1, items_crafted: 1, distance_traveled: 1, biomes_discovered: [] },
        { player_id: 'p2', kills: 999, resources_harvested: 9, items_crafted: 9, distance_traveled: 9, biomes_discovered: ['Plains'] },
      ],
      server_status: [{ player_count: 2, world_day: 12 }],
    }),
    post: async () => {},
    state: {},
    saveState: async () => {},
  });

  const stats = await recap.buildStats('evening');

  eq(stats.onlineToday.map((r) => r.name), ['Astrid'], 'the Online-today board omits the alt');
  eq(stats.playersActive, 1, 'and the active-player count counts one viking, not two');
  ok(stats.hoursPlayed < 1.5, `the hall's hours exclude the alt's two (got ${stats.hoursPlayed})`);
  eq(stats.fallenToday.map((r) => r.name), ['Astrid'], 'the Fallen board omits the alt');
  eq(stats.deaths, 1, 'and the death total counts only the real viking');
  eq(
    Object.keys(stats._statsSnapshotNext).sort(),
    ['Astrid'],
    'the POTY stats snapshot never carries the alt, so no future delta can score it either',
  );
}

console.log(`excluded.test: ${passed} assertions passed`);
