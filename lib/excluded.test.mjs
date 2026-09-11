// Tests for the excluded-character rule (lib/excluded.ts) and for the one
// aggregation path that has to honour it without any roster to lean on
// (lib/milestones.ts evaluateAndRecord).
//
// WHY THE SECOND HALF MATTERS MORE THAN THE FIRST. `isExcludedPlayer` is four
// lines and hard to get wrong. What is easy to get wrong is a read site that
// forgets to call it — and the Great Deed evaluator is the worst place for that,
// because there is no page to look at: an excluded character's kills would just
// quietly advance the warband's collective deeds, and the only symptom would be
// the site's progress bar (which lib/data.ts filters) disagreeing with the deed
// that fired. So the orchestrator is driven against a stub that includes an
// excluded viking whose numbers are big enough to cross a threshold on their own.
//
// Run: npx tsx lib/excluded.test.mjs
import assert from 'node:assert';
import {
  isExcludedName,
  isExcludedPlayer,
  filterExcluded,
  onlyExcluded,
  filterExcludedByPlayerId,
} from './excluded.ts';
import { EXCLUDED_CHARACTER_NAMES } from '../config/server.ts';
import { evaluateAndRecord } from './milestones.ts';

let checks = 0;
const ok = (cond, msg) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};

// ── the config list ─────────────────────────────────────────────────────────
ok(EXCLUDED_CHARACTER_NAMES.includes('Steward'), 'Steward is the first excluded character');

// ── isExcludedName: fold case and whitespace, never exclude a blank ─────────
ok(isExcludedName('Steward'), 'the listed name is excluded');
ok(isExcludedName('steward'), 'case is folded — a lowercase spelling is the same viking');
ok(isExcludedName('  Steward  '), 'padding is trimmed');
ok(!isExcludedName('Stewards'), 'a DIFFERENT name that merely starts the same is not excluded');
ok(!isExcludedName('Astrid'), 'an ordinary viking is not excluded');
ok(!isExcludedName(''), 'an empty name is not excluded (it would match every blank row)');
ok(!isExcludedName(null), 'null is not excluded');
ok(!isExcludedName(undefined), 'undefined is not excluded');

// ── isExcludedPlayer: the flag OR the list, and `undefined` means NOT ───────
ok(isExcludedPlayer({ character_name: 'Astrid', excluded: true }), 'the database flag alone excludes');
ok(isExcludedPlayer({ character_name: 'Steward' }), 'the name list alone excludes (pre-migration)');
ok(
  isExcludedPlayer({ character_name: 'Steward', excluded: false }),
  'a listed name stays excluded even if the row says false — either signal is decisive',
);
ok(
  !isExcludedPlayer({ character_name: 'Astrid' }),
  'a row read WITHOUT the column (excluded === undefined) is not excluded — this is the one that ' +
    'would empty every board on the site if it went the other way',
);
ok(!isExcludedPlayer({ character_name: 'Astrid', excluded: null }), 'null flag is not excluded');
ok(!isExcludedPlayer(null), 'a missing row is not excluded');

// ── filterExcluded / onlyExcluded: complementary, order-preserving ──────────
{
  const rows = [
    { character_name: 'Astrid' },
    { character_name: 'Steward' },
    { character_name: 'Bjorn', excluded: true },
    { character_name: 'Cato' },
  ];
  eq(
    filterExcluded(rows).map((r) => r.character_name),
    ['Astrid', 'Cato'],
    'filterExcluded drops both the flagged and the listed, and keeps the original order',
  );
  eq(
    onlyExcluded(rows).map((r) => r.character_name),
    ['Steward', 'Bjorn'],
    'onlyExcluded is the exact complement',
  );
  eq(filterExcluded(null), [], 'a null read degrades to an empty list, never a throw');
  eq(filterExcluded(undefined), [], 'so does undefined');
}

// ── filterExcludedByPlayerId: player_stats has no name of its own ───────────
{
  const stats = [{ player_id: 'a', kills: 1 }, { player_id: 'b', kills: 2 }, { kills: 3 }];
  eq(
    filterExcludedByPlayerId(stats, new Set(['b'])).map((s) => s.kills),
    [1, 3],
    'the excluded id is dropped; a row with NO id is kept (an orphan stat row is an ingest ' +
      'problem, and dropping it would silently shrink every Great Deed)',
  );
  eq(
    filterExcludedByPlayerId(stats, new Set()).length,
    3,
    'an empty exclusion set changes nothing',
  );
}

// ── the aggregation path: evaluateAndRecord must not count an excluded viking ─
//
// Minimal Supabase stub, modelled on scripts/milestones.test.mjs. The excluded
// viking ("Steward") carries enough kills to cross the deed BY ITSELF; the two
// real vikings together do not. So the deed firing is a direct statement that the
// exclusion was ignored, and the deed staying unachieved is the assertion.
function makeStubDb(state) {
  const reads = [];
  return {
    reads,
    from(table) {
      if (table === 'milestones') {
        return {
          select: () => ({
            is: () =>
              Promise.resolve({
                data: state.milestones.filter((m) => !m.achieved_at).map((m) => ({ ...m })),
                error: null,
              }),
          }),
          update(patch) {
            let id = null;
            const b = {
              eq(col, val) {
                if (col === 'id') id = val;
                return b;
              },
              is: () => b,
              select() {
                const row = state.milestones.find((m) => m.id === id);
                if (!row || row.achieved_at) return Promise.resolve({ data: [], error: null });
                Object.assign(row, patch);
                return Promise.resolve({ data: [{ id }], error: null });
              },
            };
            return b;
          },
        };
      }
      if (table === 'player_stats') {
        return { select: () => Promise.resolve({ data: state.stats, error: null }) };
      }
      if (table === 'sessions') {
        return { select: () => Promise.resolve({ data: state.sessions, error: null }) };
      }
      if (table === 'players') {
        return {
          select: (cols) => {
            reads.push(cols);
            // The two-tier read: when the migration is "not applied" the stub
            // answers the flagged select with an error, exactly as PostgREST does
            // for a column that does not exist.
            if (String(cols).includes('excluded') && !state.hasExcludedColumn) {
              return Promise.resolve({
                data: null,
                error: { code: '42703', message: 'column players.excluded does not exist' },
              });
            }
            return Promise.resolve({ data: state.players, error: null });
          },
        };
      }
      if (table === 'bosses') {
        return { select: () => Promise.resolve({ data: state.bosses ?? [], error: null }) };
      }
      return { insert: () => Promise.resolve({ data: null, error: null }) };
    },
  };
}

const silent = { info() {}, warn() {}, error() {} };

/** One unachieved deed at 1,000 kills, plus a roster where the alt carries most of them. */
function scenario({ hasExcludedColumn, altName }) {
  return {
    hasExcludedColumn,
    milestones: [
      {
        id: 'kills-thousand',
        metric: 'kills_total',
        threshold: 1000,
        sort: 40,
        title: 'A Thousand Foes',
        line: 'A thousand corpses mark the road. ({value})',
        equivalence: null,
        achieved_at: null,
        achieved_value: null,
        announced_at: null,
        meta: {},
      },
    ],
    players: [
      { id: 'p1', character_name: 'Astrid', is_online: false, excluded: false },
      { id: 'p2', character_name: 'Bjorn', is_online: false, excluded: false },
      // The alt. Flagged in the database AND (when altName is 'Steward') on the
      // config list, so each half can be tested on its own.
      { id: 'p3', character_name: altName, is_online: false, excluded: true },
    ],
    stats: [
      { player_id: 'p1', kills: 300, deaths: 0, gs_stats: null, map_explored_pct: null },
      { player_id: 'p2', kills: 300, deaths: 0, gs_stats: null, map_explored_pct: null },
      { player_id: 'p3', kills: 900, deaths: 0, gs_stats: null, map_explored_pct: null },
    ],
    sessions: [
      { character_name: 'Astrid', joined_at: '2026-09-01T10:00:00Z', duration_minutes: 60 },
      { character_name: altName, joined_at: '2026-09-01T10:00:00Z', duration_minutes: 6000 },
    ],
    bosses: [],
  };
}

// 1. Migration applied: the flag is what excludes the alt (it is named 'Ghost',
//    which is NOT on the config list, so only `excluded: true` can be doing it).
{
  const state = scenario({ hasExcludedColumn: true, altName: 'Ghost' });
  const db = makeStubDb(state);
  const res = await evaluateAndRecord(db, silent);
  eq(res.crossed, 0, 'the flagged alt\'s 900 kills do not push the warband over 1,000');
  ok(
    state.milestones[0].achieved_at === null,
    'and the deed is left unachieved, not merely unreported',
  );
  ok(
    db.reads.some((c) => String(c).includes('excluded')),
    'the players read asks for the flag',
  );
}

// 2. Migration NOT applied: the flagged select errors, the read falls back, and
//    the CONFIG NAME LIST has to carry the exclusion on its own.
{
  const state = scenario({ hasExcludedColumn: false, altName: 'Steward' });
  const db = makeStubDb(state);
  const res = await evaluateAndRecord(db, silent);
  eq(
    res.crossed,
    0,
    'before the migration lands, EXCLUDED_CHARACTER_NAMES alone keeps the alt out of the aggregate',
  );
  eq(db.reads.length, 2, 'the read was tried with the flag, then again without it');
}

// 3. The control: with the alt counted, this same deed WOULD fire. Without this
//    case the two above could pass for the wrong reason (a stub that never
//    crosses anything is not evidence of an exclusion).
{
  const state = scenario({ hasExcludedColumn: true, altName: 'Ghost' });
  state.players[2].excluded = false; // no longer excluded, and not on the list
  const res = await evaluateAndRecord(makeStubDb(state), silent);
  eq(res.crossed, 1, 'control: an ordinary viking\'s 900 kills DO cross the deed');
  ok(state.milestones[0].achieved_at !== null, 'and the row is stamped achieved');
}

console.log(`excluded: ${checks} assertions passed`);
