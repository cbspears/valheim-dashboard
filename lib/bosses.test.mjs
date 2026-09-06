// Tests for the boss-ledger summary, with the emphasis on the one case the Hall
// used to get wrong: an EMPTY read is not a completed saga (T-3 audit, site-2).
//
//   npx tsx lib/bosses.test.mjs

import { summarizeBosses } from './bosses.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

const boss = (id, name, killed) => ({ id, name, biome: 'Meadows', is_killed: killed });

console.log('\nsummarizeBosses — an empty ledger claims nothing');
for (const [label, input] of [
  ['[]', []],
  ['null', null],
  ['undefined', undefined],
]) {
  const s = summarizeBosses(input);
  ok(s.ledgerEmpty, `${label}: ledgerEmpty`);
  ok(!s.sagaComplete, `${label}: NOT sagaComplete — a failed read must never read as victory`);
  eq(s.next, null, `${label}: no objective can be named`);
  eq(s.total, 0, `${label}: total 0`);
  eq(s.felledCount, 0, `${label}: nothing felled`);
  eq(s.percent, 0, `${label}: percent 0, not NaN`);
}

console.log('\nsummarizeBosses — a fresh world');
const fresh = summarizeBosses([
  boss('1', 'Eikthyr', false),
  boss('2', 'The Elder', false),
  boss('3', 'Bonemass', false),
]);
ok(!fresh.ledgerEmpty, 'rows exist, so the ledger answered');
ok(!fresh.sagaComplete, 'nothing felled is not a complete saga');
eq(fresh.next?.name, 'Eikthyr', 'the first unfelled row is the objective');
eq(fresh.felledCount, 0, 'nothing felled yet');
eq(fresh.percent, 0, '0%');

console.log('\nsummarizeBosses — mid-saga');
const mid = summarizeBosses([
  boss('1', 'Eikthyr', true),
  boss('2', 'The Elder', true),
  boss('3', 'Bonemass', false),
  boss('4', 'Moder', false),
]);
eq(mid.next?.name, 'Bonemass', 'the objective is the first STILL STANDING row, not the first row');
eq(mid.felledCount, 2, 'two felled');
eq(mid.felled.map((b) => b.name).join(','), 'Eikthyr,The Elder', 'felled keeps ledger order');
ok(!mid.sagaComplete, 'two of four is not complete');
eq(mid.percent, 50, '50%');

console.log('\nsummarizeBosses — the only state that may claim victory');
const done = summarizeBosses([boss('1', 'Eikthyr', true), boss('2', 'The Elder', true)]);
ok(done.sagaComplete, 'rows exist and every one is killed');
eq(done.next, null, 'nothing left to hunt');
eq(done.percent, 100, '100%');

console.log('\nsummarizeBosses — a felled world and a failed read are distinguishable');
ok(
  done.sagaComplete !== summarizeBosses([]).sagaComplete,
  'the two states that used to render identically now differ'
);

console.log(failures === 0 ? '\nbosses: all checks passed\n' : `\nbosses: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
