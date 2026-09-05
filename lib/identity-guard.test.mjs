// Tests for the viking identity guard (audit security-3): the pure decision
// the webhook makes when a name-keyed write arrives with a SteamID pairing.
//
//   npx tsx lib/identity-guard.test.mjs

import { decideIdentity, isIdentityMismatch } from './identity-guard.ts';

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

const A = '76561198000000001';
const B = '76561198000000002';

console.log('\ndecideIdentity — the full decision table');
eq(
  decideIdentity({ boundSteamId: null, seenSteamId: A, hasPairing: true }),
  'bind',
  'unclaimed name + a pairing -> bind (first sight owns the name)'
);
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: A, hasPairing: true }),
  'match',
  'same account rejoining its own viking -> match'
);
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: B, hasPairing: true }),
  'mismatch',
  'a DIFFERENT account under a bound name -> mismatch'
);
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: null, hasPairing: false }),
  'unknown',
  'bound name but no pairing -> unknown (allow; never a false positive)'
);
eq(
  decideIdentity({ boundSteamId: null, seenSteamId: null, hasPairing: false }),
  'unknown',
  'unclaimed name and no pairing -> unknown (nothing to bind)'
);

console.log('\ndecideIdentity — degenerate inputs');
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: '', hasPairing: true }),
  'unknown',
  'an empty seen id is no pairing at all, even when hasPairing says otherwise'
);
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: '   ', hasPairing: true }),
  'unknown',
  'a whitespace-only seen id is no pairing either'
);
eq(
  decideIdentity({ boundSteamId: '', seenSteamId: A, hasPairing: true }),
  'bind',
  'an empty bound id counts as unclaimed -> bind'
);
eq(
  decideIdentity({ boundSteamId: `  ${A}  `, seenSteamId: A, hasPairing: true }),
  'match',
  'both sides are trimmed before comparing'
);
eq(decideIdentity({}), 'unknown', 'an empty input is unknown, not a mismatch');
eq(
  decideIdentity({ boundSteamId: undefined, seenSteamId: A, hasPairing: true }),
  'bind',
  'an undefined binding (column absent) counts as unclaimed'
);
eq(
  decideIdentity({ boundSteamId: A, seenSteamId: B }),
  'mismatch',
  'hasPairing defaults to "the seen id speaks for itself"'
);

console.log('\nisIdentityMismatch — the one decision that blocks a write');
ok(isIdentityMismatch({ boundSteamId: A, seenSteamId: B, hasPairing: true }), 'mismatch blocks');
ok(!isIdentityMismatch({ boundSteamId: A, seenSteamId: A, hasPairing: true }), 'match does not block');
ok(!isIdentityMismatch({ boundSteamId: null, seenSteamId: A, hasPairing: true }), 'bind does not block');
ok(!isIdentityMismatch({ boundSteamId: A, hasPairing: false }), 'unknown does not block');

console.log(
  failures === 0 ? '\nidentity-guard: all checks passed\n' : `\nidentity-guard: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
