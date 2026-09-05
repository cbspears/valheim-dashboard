// Unit tests for the daily recap's death accounting: the 10 s collapse that
// folds one death reported by BOTH producers into one fall, and the boards it
// feeds (the death total, the Fallen board, and the POTY 'The Bold' crown).
//
// The bug behind it: the 2026-09-01 recap reported 7 deaths for 4 real ones,
// because the gs mod report and the eilif death report both land in `events`.
// The line these tests defend is the 10 s width itself — a corpse run that ends
// in a second death a minute later is a REAL second death and must still count.
//
// Run:
//   node scripts/recap.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { createRecap, collapseDeathRows, selectPlayerOfDay } from '../src/recap.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const T0 = Date.parse('2026-09-09T20:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const death = (name, offsetMs, cause) => ({
  character_name: name,
  created_at: at(offsetMs),
  metadata: cause ? { cause } : {},
});
const names = (rows) => rows.map((r) => r.character_name).sort();

// ── collapseDeathRows: the window itself ────────────────────────────────────
{
  eq(collapseDeathRows([]).length, 0, 'no deaths collapse to nothing');
  eq(collapseDeathRows(null).length, 0, 'a null read is tolerated (the query can fail soft)');
  eq(collapseDeathRows(undefined).length, 0, 'so is an undefined one');

  const twins = [death('Loa', 0, 'Greydwarf'), death('Loa', 400, 'Greydwarf')];
  eq(collapseDeathRows(twins).length, 1, 'two reports 0.4 s apart are ONE death');

  eq(collapseDeathRows([death('Loa', 0), death('Loa', 9_999)]).length, 1,
    'just inside 10 s still collapses');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 10_000)]).length, 1,
    'exactly 10 s is inside the window');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 10_001)]).length, 2,
    'one millisecond past 10 s is a second death');

  // The rule that must never be widened.
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 60_000)]).length, 2,
    'a corpse-run double 60 s apart stays TWO deaths');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 30_000)]).length, 2,
    'and 30 s apart stays two');

  // Anchored on the kept row, exactly like relay.js: a burst cannot chain into
  // a window wider than 10 s.
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 8_000), death('Loa', 16_000)]).length, 2,
    'a 0/8/16 s burst is two deaths, not one - the window never chains');

  eq(collapseDeathRows([death('Loa', 0), death('Bjorn', 400)]).length, 2,
    'two vikings dying together are two deaths, never collapsed into one');

  const unsorted = [death('Loa', 900), death('Loa', 0), death('Loa', 400)];
  eq(collapseDeathRows(unsorted).length, 1,
    'rows arrive in PostgREST order, so they are sorted before folding');
}

// ── collapseDeathRows: rows it must not touch ───────────────────────────────
{
  const unnamed = [{ character_name: '', created_at: at(0), metadata: {} }];
  eq(collapseDeathRows(unnamed).length, 1, 'an unnamed row is passed through untouched');
  const undated = [{ character_name: 'Loa', created_at: 'not a date', metadata: {} }];
  eq(collapseDeathRows(undated).length, 1, 'so is a row with an unparseable timestamp');
  const mixed = collapseDeathRows([
    { character_name: null, created_at: at(0), metadata: {} },
    death('Loa', 0),
    death('Loa', 500),
  ]);
  eq(mixed.length, 2, 'un-keyable rows survive alongside the collapsed ones');
  ok(names(mixed).includes('Loa'), 'and the kept death is still there');
}

// ── collapseDeathRows: the cause survives the fold ──────────────────────────
{
  // Only the gs report knows what killed you; the log-poller row has no cause.
  const pollerFirst = collapseDeathRows([death('Loa', 0), death('Loa', 300, 'Troll')]);
  eq(pollerFirst.length, 1, 'the pair is one death');
  eq(pollerFirst[0].metadata.cause, 'Troll',
    'a cause on the folded row is carried onto the kept one');

  const gsFirst = collapseDeathRows([death('Loa', 0, 'Troll'), death('Loa', 300)]);
  eq(gsFirst[0].metadata.cause, 'Troll', 'a cause already on the kept row is preserved');

  const both = collapseDeathRows([death('Loa', 0, 'Troll'), death('Loa', 300, 'Greydwarf')]);
  eq(both[0].metadata.cause, 'Troll', 'the kept row wins when both name a cause');

  const source = death('Loa', 0);
  collapseDeathRows([source, death('Loa', 300, 'Troll')]);
  eq(source.metadata.cause, undefined, 'the input rows are never mutated');
}

// ── buildStats: the boards the collapse feeds ───────────────────────────────
// A fake supabase client that serves one canned table set (same chainable shape
// as scripts/milestones.test.mjs).
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

function harness(deathRows) {
  const nowIso = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  return createRecap({
    db: fakeDb({
      // One closed session each so both vikings count as active (and so the
      // Unsung Hero cadence has a pool), inside the trailing 24 h window.
      sessions: [
        { character_name: 'Loa', joined_at: hourAgo, left_at: nowIso },
        { character_name: 'Bjorn', joined_at: hourAgo, left_at: nowIso },
      ],
      events: deathRows,
      bosses: [],
      players: [],
      player_stats: [],
      server_status: [{ player_count: 0, world_day: 12 }],
    }),
    post: async () => {},
    state: {},
    saveState: async () => {},
  });
}

{
  // Four real falls, each reported twice within 10 s: the exact 2026-09-01 shape.
  const doubled = [];
  for (const offset of [0, 120_000, 240_000, 360_000]) {
    doubled.push(death('Loa', offset, 'Greydwarf'), death('Loa', offset + 350, 'Greydwarf'));
  }
  const stats = await harness(doubled).buildStats('evening');
  eq(stats.deaths, 4, 'eight rows for four falls report FOUR deaths');
  eq(stats.fallenToday.length, 1, 'one viking on the Fallen board');
  eq(stats.fallenToday[0].count, 4, 'and the board shows her real count, not the doubled one');
}

{
  // 'The Bold' needs 3 deaths. Two real falls reported twice each used to look
  // like four and crown a viking who never earned it.
  const doubled = [
    death('Loa', 0, 'Troll'), death('Loa', 200, 'Troll'),
    death('Loa', 300_000, 'Troll'), death('Loa', 300_400, 'Troll'),
  ];
  const stats = await harness(doubled).buildStats('evening');
  eq(stats.deaths, 2, 'two real falls');
  eq(stats.poty, null, "'The Bold' is NOT crowned on a doubled tally of two");

  const real = [
    death('Loa', 0, 'Troll'),
    death('Loa', 300_000, 'Troll'),
    death('Loa', 600_000, 'Troll'),
  ];
  const earned = await harness(real).buildStats('evening');
  eq(earned.deaths, 3, 'three genuinely separate falls still count as three');
  eq(earned.poty?.key, 'most_deaths', "and 'The Bold' is crowned when it is earned");
  eq(earned.poty?.fields.deaths, 3, 'the crown reports the collapsed count');
}

{
  // The collapse must not eat a corpse run: two deaths a minute apart are two.
  const corpseRun = [
    death('Loa', 0, 'Troll'),
    death('Loa', 60_000, 'Troll'),
    death('Loa', 120_000, 'Troll'),
  ];
  const stats = await harness(corpseRun).buildStats('evening');
  eq(stats.deaths, 3, 'a corpse run of three deaths a minute apart is still three');
}

// ── selectPlayerOfDay still scores whatever it is handed ────────────────────
{
  const crown = selectPlayerOfDay({ windowDeaths: { Loa: 3 }, hours: { Loa: 1 } });
  eq(crown?.key, 'most_deaths', 'the POTY picker is unchanged: 3 deaths clears The Bold');
  const none = selectPlayerOfDay({ windowDeaths: { Loa: 2 }, hours: { Loa: 1 } });
  eq(none, null, 'and 2 does not');
}

console.log(`recap.test: ${passed} assertions passed`);
