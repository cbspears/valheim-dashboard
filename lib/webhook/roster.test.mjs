// Tests for the `sync` roster reconciliation lifted out of /api/webhook (§2b).
//
// The rules these encode:
//   • exactly the announced names end up online, everyone else offline;
//   • a name is never used as a filter, so a hostile name is just a string;
//   • a name nobody has seen is created once, however many times it is sent;
//   • no write is emitted for a row that is already in the right state.
//
//   npx tsx lib/webhook/roster.test.mjs

import { planRosterSync } from './roster.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${msg}`);
  }
}
function eqSet(actual, expected, msg) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}

const row = (id, character_name, is_online = false) => ({ id, character_name, is_online });

// A hall as it stands: Loa is aboard, Bren is marked online but has dropped,
// Skarde has played before and is away.
const HALL = [
  row('id-loa', 'Loa', true),
  row('id-bren', 'Bren', true),
  row('id-skarde', 'Skarde', false),
];

console.log('\nplanRosterSync - the ordinary sync');
{
  const p = planRosterSync(['Loa', 'Skarde'], HALL);
  eqSet(p.onlineIds, ['id-loa', 'id-skarde'], 'both announced vikings are flipped online');
  eqSet(p.offlineIds, ['id-bren'], 'the one marked online but not announced is flipped offline');
  eqSet(p.unseenNames, [], 'nobody new');
}

console.log('\nplanRosterSync - no pointless writes');
{
  const p = planRosterSync(['Loa', 'Bren'], HALL);
  eqSet(p.offlineIds, [], 'Skarde is already offline and is NOT written again');
  eqSet(p.onlineIds, ['id-loa', 'id-bren'], 'the announced pair still gets its last_seen_at touch');
}

console.log('\nplanRosterSync - an empty hall');
{
  const p = planRosterSync([], HALL);
  eqSet(p.onlineIds, [], 'nobody to mark online');
  eqSet(p.offlineIds, ['id-loa', 'id-bren'], 'everyone marked online is cleared');
  eqSet(p.unseenNames, [], 'and nothing is created');
}

console.log('\nplanRosterSync - a viking nobody has seen');
{
  const p = planRosterSync(['Loa', 'Ylva'], HALL);
  eqSet(p.unseenNames, ['Ylva'], 'the new name is created');
  eqSet(p.onlineIds, ['id-loa'], 'and is NOT in onlineIds - it has no id yet');
  eqSet(p.offlineIds, ['id-bren'], 'the drop is still reconciled');
}

console.log('\nplanRosterSync - the same new name twice in one message');
{
  const p = planRosterSync(['Ylva', 'Ylva', 'Ylva'], []);
  eqSet(p.unseenNames, ['Ylva'], 'deduped to ONE insert, so a single INSERT cannot race itself');
}

console.log('\nplanRosterSync - a hostile name is only ever a string');
{
  // The exact shape that breaks postgrest-js .in(): an embedded double quote is
  // never escaped, so `x","Bren` inside in.(…) matches the REAL row for Bren.
  // Here it must match nothing, create itself, and touch nobody else.
  const hostile = 'x","Bren';
  const p = planRosterSync([hostile], HALL);
  eqSet(p.onlineIds, [], 'it matches no existing row');
  eqSet(p.unseenNames, [hostile], 'it is treated as a new viking, verbatim');
  ok(!p.onlineIds.includes('id-bren'), 'Bren is NOT pulled online by the quote injection');
  eqSet(p.offlineIds, ['id-loa', 'id-bren'], 'and the real hall is reconciled as an empty one');
}
{
  const commas = planRosterSync(['Loa,Bren'], HALL);
  eqSet(commas.onlineIds, [], 'a comma in a name matches nobody either');
  eqSet(commas.unseenNames, ['Loa,Bren'], 'it is one name, not two');
}
{
  const parens = planRosterSync(['Loa)'], HALL);
  eqSet(parens.unseenNames, ['Loa)'], 'a bracket is just a character');
}

console.log('\nplanRosterSync - exact-case matching, as the per-name .eq() loop had');
{
  const p = planRosterSync(['loa'], HALL);
  eqSet(p.onlineIds, [], '"loa" is not "Loa"');
  eqSet(p.unseenNames, ['loa'], 'it is a different viking, exactly as before');
}

console.log('\nplanRosterSync - forked rows (the 2026-07-25 incident)');
{
  const forked = [row('id-a', 'Loa', true), row('id-b', 'Loa', false)];
  const p = planRosterSync(['Loa'], forked);
  eqSet(p.onlineIds, ['id-a', 'id-b'], 'BOTH rows are flipped, so a fork cannot leave half a viking online');
  eqSet(p.unseenNames, [], 'and no third row is created on top of the fork');

  const gone = planRosterSync([], forked);
  eqSet(gone.offlineIds, ['id-a'], 'only the row that was actually online needs clearing');
}

console.log('\nplanRosterSync - an empty roster (the first sync after a world wipe)');
{
  const p = planRosterSync(['Loa', 'Bren', 'Skarde'], []);
  eqSet(p.unseenNames, ['Loa', 'Bren', 'Skarde'], 'every viking is created');
  eqSet(p.onlineIds, [], 'nothing to update');
  eqSet(p.offlineIds, [], 'nothing to clear');
}

if (failures > 0) {
  console.error(`\nwebhook/roster: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nwebhook/roster: all checks passed');
