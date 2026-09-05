// Tests for the oath text parsing lifted out of /api/webhook (§2e).
//
// The bug that made this worth testing: stripping only the claim code left the
// separator from the published instructions on the front of the stored oath, so
// a live player's vow reads with a dangling dash on the signature wall, in the
// Saga episodes and in the Discord embed.
//
//   npx tsx lib/webhook/oath.test.mjs

import {
  CLAIM_CODE_PATTERN,
  firstOathToken,
  isClaimCode,
  stripLeadingSeparators,
  stripClaimCode,
  normalizeOathText,
} from './oath.ts';

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

const EM = '—';
const EN = '–';

console.log('\nnormalizeOathText - what the route accepts as `text`');
eq(normalizeOathText('  I swear  '), 'I swear', 'a string is trimmed');
eq(normalizeOathText(''), '', 'an empty string stays empty');
eq(normalizeOathText('   '), '', 'whitespace only collapses to empty (the route 400s on it)');
eq(normalizeOathText(undefined), '', 'a missing field is empty, never undefined');
eq(normalizeOathText(null), '', 'null is empty');
eq(normalizeOathText(42), '', 'a number is not text');
eq(normalizeOathText({ text: 'x' }), '', 'an object is not text');

console.log('\nfirstOathToken - the token the claim-code check looks at');
eq(firstOathToken('K7MPQ2 I swear to wander'), 'K7MPQ2', 'the first whitespace-delimited token');
eq(firstOathToken('K7MPQ2'), 'K7MPQ2', 'a lone token is the whole string');
eq(firstOathToken(''), '', 'an empty oath has an empty first token');
eq(firstOathToken('one\ttwo'), 'one', 'a tab separates tokens too');
eq(firstOathToken('one\ntwo'), 'one', 'so does a newline');

console.log('\nisClaimCode - the SHAPE of a code, not that one exists');
ok(isClaimCode('K7MPQ2'), 'six characters from the code alphabet');
ok(isClaimCode('ABCDEF'), 'all letters is a valid shape');
ok(isClaimCode('234567'), 'all digits is a valid shape');
ok(!isClaimCode('K7MPQ'), 'five characters is not a code');
ok(!isClaimCode('K7MPQ22'), 'seven characters is not a code');
ok(!isClaimCode('k7mpq2'), 'lower case is not a code (the bot mints upper case)');
ok(!isClaimCode('K7MPQ0'), 'zero is excluded from the alphabet (reads as O)');
ok(!isClaimCode('K7MPQ1'), 'one is excluded from the alphabet (reads as I or l)');
ok(!isClaimCode('K7MPQI'), 'the letter I is excluded');
ok(!isClaimCode('K7MPQO'), 'the letter O is excluded');
ok(!isClaimCode(''), 'an empty token is never a code');
ok(isClaimCode('SWEARS'), 'a six-letter word IS a valid code shape - only a live claim decides');
ok(CLAIM_CODE_PATTERN.test('SWEARS') === true, 'and the pattern says so plainly');
ok(
  !isClaimCode('K7MPQ2 X'),
  'the pattern is anchored, so a code plus more text is not a code'
);

console.log('\nstripLeadingSeparators - every separator the instructions can produce');
eq(stripLeadingSeparators(`${EM} I SWEAR`), 'I SWEAR', 'an em dash is stripped');
eq(stripLeadingSeparators(`${EN} I SWEAR`), 'I SWEAR', 'an en dash is stripped');
eq(stripLeadingSeparators('- I SWEAR'), 'I SWEAR', 'a hyphen is stripped');
eq(stripLeadingSeparators(': I SWEAR'), 'I SWEAR', 'a colon is stripped');
eq(stripLeadingSeparators('   I SWEAR'), 'I SWEAR', 'plain whitespace is stripped');
eq(stripLeadingSeparators(`${EM}${EM}- I SWEAR`), 'I SWEAR', 'a run of separators goes together');
eq(stripLeadingSeparators('I SWEAR'), 'I SWEAR', 'an oath with no separator is untouched');
eq(
  stripLeadingSeparators(`I SWEAR ${EM} ALWAYS`),
  `I SWEAR ${EM} ALWAYS`,
  'a dash INSIDE the vow is left alone (only the front is stripped)'
);
eq(stripLeadingSeparators('I SWEAR   '), 'I SWEAR', 'trailing whitespace is trimmed as well');
eq(stripLeadingSeparators(`${EM}${EM}`), '', 'separators alone leave nothing');
eq(
  stripLeadingSeparators(stripLeadingSeparators(`${EM} I SWEAR`)),
  'I SWEAR',
  'idempotent - the route runs it twice and the second pass is a no-op'
);

console.log('\nstripClaimCode - the whole rite, end to end');
eq(
  stripClaimCode(`K7MPQ2 ${EM} I SWEAR TO ALWAYS WANDER OFF`, 'K7MPQ2'),
  'I SWEAR TO ALWAYS WANDER OFF',
  'the exact live case: code, em dash, vow'
);
eq(stripClaimCode('K7MPQ2 - I SWEAR', 'K7MPQ2'), 'I SWEAR', 'code, hyphen, vow');
eq(stripClaimCode('K7MPQ2: I SWEAR', 'K7MPQ2'), 'I SWEAR', 'code, colon, vow');
eq(stripClaimCode('K7MPQ2 I SWEAR', 'K7MPQ2'), 'I SWEAR', 'code, space, vow');
eq(stripClaimCode('K7MPQ2', 'K7MPQ2'), '', 'a link-only swear leaves nothing (the route answers linked:true)');
eq(
  stripClaimCode(`K7MPQ2 ${EM} I SWEAR ${EM} TWICE`, 'K7MPQ2'),
  `I SWEAR ${EM} TWICE`,
  'only the leading separator goes; the vow keeps its own punctuation'
);

console.log(
  failures === 0 ? '\nwebhook/oath: all checks passed\n' : `\nwebhook/oath: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
