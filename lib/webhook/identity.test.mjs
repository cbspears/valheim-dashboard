// Tests for the two identity refusals lifted out of /api/webhook (§2e, §3b).
//
// Both messages are the runbook: they carry the SQL an admin needs to release a
// binding. If the wording drifts, the person reading the journal at 2am has to
// go find the release procedure somewhere else, so the exact text is asserted.
//
//   npx tsx lib/webhook/identity.test.mjs

import {
  escapeLikePattern,
  decideRelink,
  steamIdFingerprint,
  steamMismatchMeta,
  steamMismatchLog,
  steamMismatchBody,
  relinkRefusalLog,
  relinkRefusalBody,
} from './identity.ts';

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

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const DISCORD_A = '111111111111111111';
const DISCORD_B = '222222222222222222';

console.log('\nescapeLikePattern - a character name is matched literally');
eq(escapeLikePattern('Loa'), 'Loa', 'a plain name is unchanged');
eq(escapeLikePattern('100%Viking'), '100\\%Viking', 'a percent is escaped');
eq(escapeLikePattern('sea_wolf'), 'sea\\_wolf', 'an underscore is escaped');
eq(escapeLikePattern('%_%'), '\\%\\_\\%', 'every wildcard in the name is escaped');
eq(escapeLikePattern(''), '', 'an empty name stays empty');
eq(
  escapeLikePattern('%'),
  '\\%',
  'a bare wildcard cannot become a match-everything filter'
);

console.log('\ndecideRelink - who may claim a character with an /oath code');
eq(
  decideRelink({ boundDiscordUserId: null, claimDiscordUserId: DISCORD_A }),
  'bind',
  'an unclaimed character binds to the code owner'
);
eq(
  decideRelink({ boundDiscordUserId: undefined, claimDiscordUserId: DISCORD_A }),
  'bind',
  'an absent column counts as unclaimed'
);
eq(
  decideRelink({ boundDiscordUserId: '', claimDiscordUserId: DISCORD_A }),
  'bind',
  'an empty binding counts as unclaimed'
);
eq(
  decideRelink({ boundDiscordUserId: DISCORD_A, claimDiscordUserId: DISCORD_A }),
  'bind',
  'the SAME Discord account re-linking is allowed (re-shout, reinstall, fresh code)'
);
eq(
  decideRelink({ boundDiscordUserId: DISCORD_A, claimDiscordUserId: DISCORD_B }),
  'refuse',
  'a DIFFERENT Discord account is refused - this is the one-shout takeover'
);

console.log('\nsteamMismatchLog - the oath/pin write gate');
eq(
  steamMismatchLog('oath', 'Loa', STEAM_A, STEAM_B),
  `[webhook] STEAM MISMATCH oath Loa: bound ${STEAM_A} saw ${STEAM_B} — write refused. ` +
    `Release it with: update players set steam_id = null where character_name = 'Loa'`,
  'names the event, both ids, and the release SQL verbatim'
);
ok(
  steamMismatchLog('pin', 'Loa', STEAM_A, STEAM_B).startsWith('[webhook] STEAM MISMATCH pin '),
  'the event type is part of the greppable prefix'
);
ok(
  steamMismatchLog('oath', 'Loa', null, null).includes('bound null saw null'),
  'missing ids print as null rather than undefined'
);
ok(
  steamMismatchLog('oath', "O'Brien", STEAM_A, STEAM_B).includes("character_name = 'O'Brien'"),
  'the SQL hint quotes the name as-is (an admin still checks it before running)'
);

console.log('\nsteamMismatchBody - what the poller sees');
const sBody = steamMismatchBody('Loa');
eq(sBody.ok, false, 'ok:false, because a write really was refused');
eq(sBody.status, 'identity_mismatch', 'the machine-readable status string');
eq(sBody.character, 'Loa', 'the character it refused');
eq(
  sBody.detail,
  'That character is bound to a different Steam account. An admin has to release it (players.steam_id) first.',
  'a plain-language detail naming the column to release'
);

console.log('\nrelinkRefusalLog - the Discord takeover guard');
eq(
  relinkRefusalLog('Loa', DISCORD_A, DISCORD_B, 'p-1'),
  `[identity] refused relink of "Loa" — already linked to Discord ${DISCORD_A}, ` +
    `claim code was minted for ${DISCORD_B}. An admin must release it ` +
    `(update players set discord_user_id = null where id = 'p-1') before it can move.`,
  'names both Discord ids, the row id, and the release SQL verbatim'
);
ok(
  relinkRefusalLog('Loa', DISCORD_A, DISCORD_B, undefined).includes("where id = 'undefined'"),
  'a missing row id is printed, not silently dropped (it should never happen)'
);

console.log('\nrelinkRefusalBody - what the bot reports back to the code holder');
const rBody = relinkRefusalBody('Loa');
eq(rBody.ok, false, 'ok:false');
eq(rBody.linked, false, 'linked:false, so the bot does not claim success');
eq(rBody.status, 'character_already_linked', 'the machine-readable status string');
eq(rBody.character, 'Loa', 'the character it refused');
eq(
  rBody.detail,
  'That character is already linked to a different Discord account. An admin has to release it first.',
  'a plain-language detail'
);

// ── The public row must not carry a Steam ID (T-3 audit, data-2) ───────────
// `events` has a `public read events` policy and anon holds SELECT on every
// column, metadata included, so a mismatched join used to hand both Steam64 ids
// to anyone with the publishable key — the same value the players table revoked
// from anon in db/2026-07-11_players_pii_revoke.sql.
console.log('\nsteamIdFingerprint - a handle, never the id');
const STEAM_1 = '76561198000000001';
const STEAM_2 = '76561198000000002';
const fp1 = steamIdFingerprint(STEAM_1);
eq(fp1.length, 12, 'twelve characters');
ok(/^[0-9a-f]{12}$/.test(fp1), `lowercase hex, got ${fp1}`);
ok(!fp1.includes(STEAM_1) && !STEAM_1.includes(fp1), 'the id is not recoverable by inspection');
eq(steamIdFingerprint(STEAM_1), fp1, 'stable: the same id always fingerprints the same');
ok(steamIdFingerprint(STEAM_2) !== fp1, 'two accounts one digit apart are distinguishable');
eq(steamIdFingerprint(`  ${STEAM_1}  `), fp1, 'whitespace is trimmed before hashing');
eq(steamIdFingerprint(null), null, 'null -> null');
eq(steamIdFingerprint(undefined), null, 'undefined -> null');
eq(steamIdFingerprint(''), null, 'empty -> null');
eq(steamIdFingerprint('   '), null, 'blank -> null');
eq(steamIdFingerprint(12345), null, 'a non-string -> null, never "[object ...]"');

console.log('\nsteamMismatchMeta - what lands on the anon-readable events row');
const meta = steamMismatchMeta(STEAM_1, STEAM_2);
eq(meta.identity, 'steam_mismatch', 'the marker the cockpit filters on is unchanged');
eq(meta.boundSteamIdHash, steamIdFingerprint(STEAM_1), 'bound side is a fingerprint');
eq(meta.seenSteamIdHash, steamIdFingerprint(STEAM_2), 'seen side is a fingerprint');
const metaJson = JSON.stringify(meta);
ok(!metaJson.includes(STEAM_1) && !metaJson.includes(STEAM_2),
  `no Steam ID anywhere in the row, got: ${metaJson}`);
ok(!/7656119\d{10}/.test(metaJson), 'no Steam64-shaped string at all');
eq(Object.keys(meta).sort().join(','), 'boundSteamIdHash,identity,seenSteamIdHash',
  'exactly three keys - no id rides along under another name');

const unbound = steamMismatchMeta(null, STEAM_2);
eq(unbound.boundSteamIdHash, null, 'an unbound name fingerprints to null, not to a hash of ""');
eq(unbound.seenSteamIdHash, steamIdFingerprint(STEAM_2), 'the joining account is still recorded');

// The operator loses nothing: the journal line still carries both ids in full.
ok(steamMismatchLog('join', 'Loa', STEAM_1, STEAM_2).includes(STEAM_2),
  'the journal line the admin greps still names the account that joined');

console.log(
  failures === 0
    ? '\nwebhook/identity: all checks passed\n'
    : `\nwebhook/identity: ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
