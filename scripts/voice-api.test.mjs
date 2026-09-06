// Tests for the per-player targeting half of GET /api/voice (lib/voice.ts).
//
// WHAT IS ACTUALLY AT RISK HERE. There is no `target` column: a recipient rides in
// the row's existing `meta` jsonb, and `meta` is written by three different callers
// in the Discord bot (voice.js, milestones.js, titles.js) plus by hand in the SQL
// editor. So `meta.target` is the loosest field in the whole voice path — it can be
// absent, null, a number, an object, an empty string, or 300 characters of paste —
// and the plugin's reaction to a target it cannot resolve is to DROP the line
// silently rather than speak it to the hall. A shaping bug here is therefore a line
// that nobody ever hears, with nothing in the database to show for it. The rules the
// route applies are asserted below, one case per way the field can be wrong.
//
// AND THE OTHER DIRECTION, which is the dangerous one: a Companion older than 0.3.3 does
// not know the `target` member exists and speaks the line TO EVERYBODY. The producer
// (services/discord-bot/src/voice.js) gates only on a hand-set VOICE_TARGETING env var,
// so the route is the last place that can stop a private oath callback being read out to
// the whole hall — see the `voiceBatch` section at the bottom.
//
//   npx tsx scripts/voice-api.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  MAX_VOICE_TARGET_LEN,
  companionCapabilities,
  voiceBatch,
  voiceLinePayload,
  voiceTarget,
} from '../lib/voice.ts';

let checks = 0;
function ok(cond, msg) {
  checks++;
  assert.ok(cond, msg);
  console.log(`  ok   ${msg}`);
}
function eq(actual, expected, msg) {
  ok(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
  );
}

const row = (meta) => ({ id: 'ff-1', text: 'The forest is watching.', speaker: 'Eilif', meta });

console.log('\nvoiceTarget - target PRESENT');
eq(voiceTarget({ target: 'Bren' }), 'Bren', 'a plain name comes back verbatim');
eq(voiceTarget({ target: '  Bren  ' }), 'Bren', 'surrounding whitespace is trimmed');
eq(voiceTarget({ target: 'Bren the Bold' }), 'Bren the Bold', 'inner spaces are kept - names have them');
eq(voiceTarget({ target: 'BREN' }), 'BREN', 'case is preserved (the PLUGIN matches case-insensitively, not the API)');
eq(voiceTarget({ target: 'Æsa' }), 'Æsa', 'non-ASCII survives - Valheim names are not ASCII-only');
eq(voiceTarget({ target: 'x', source: 'poty', player_id: 7 }), 'x', 'the rest of meta is ignored, not required to be absent');

console.log('\nvoiceTarget - target MISSING');
eq(voiceTarget({}), null, 'an empty meta has no target');
eq(voiceTarget({ source: 'milestone', id: 'first-marathon' }), null, 'a normal untargeted line (real meta shape) has no target');
eq(voiceTarget({ target: undefined }), null, 'an explicitly undefined target is no target');
eq(voiceTarget({ target: null }), null, 'a null target is no target');

console.log('\nvoiceTarget - target BLANK');
eq(voiceTarget({ target: '' }), null, 'an empty string is not a target');
eq(voiceTarget({ target: '   ' }), null, 'whitespace only is not a target');
eq(voiceTarget({ target: '\t\n' }), null, 'tabs and newlines only are not a target');

console.log('\nvoiceTarget - target TOO LONG');
eq(MAX_VOICE_TARGET_LEN, 64, 'the cap is 64, matching SpeakerIdentity.MaxNameLen in the plugin');
eq(voiceTarget({ target: 'a'.repeat(64) }), 'a'.repeat(64), '64 characters is accepted (the boundary is inclusive)');
eq(voiceTarget({ target: 'a'.repeat(65) }), null, '65 characters is refused OUTRIGHT');
eq(
  voiceTarget({ target: ` ${'a'.repeat(64)} ` }),
  'a'.repeat(64),
  'the cap is applied AFTER trimming, so padding does not push a valid name over',
);
ok(
  voiceTarget({ target: 'a'.repeat(200) }) === null,
  'an over-long value is never TRUNCATED to fit - a 64-char prefix would retarget the line at whoever it happens to match',
);

console.log('\nvoiceTarget - meta NULL and other non-objects');
eq(voiceTarget(null), null, 'meta null (the column default is {}, but a row can still be read as null)');
eq(voiceTarget(undefined), null, 'meta undefined (an older select that never asked for the column)');
eq(voiceTarget('Bren'), null, 'a meta that is a bare string is not a target carrier');
eq(voiceTarget(42), null, 'a numeric meta is not a target carrier');
eq(voiceTarget([{ target: 'Bren' }]), null, 'a jsonb ARRAY is refused - `meta[0].target` is not the contract');
eq(voiceTarget({ target: 42 }), null, 'a numeric target is not a name');
eq(voiceTarget({ target: { name: 'Bren' } }), null, 'an object target is not a name');
eq(voiceTarget({ target: ['Bren'] }), null, 'an array target is not a name - targeting is ONE viking, never a list');
eq(voiceTarget({ target: true }), null, 'a boolean target is not a name');

console.log('\nvoiceLinePayload - the wire shape the plugin deserializes');
const targeted = voiceLinePayload(row({ target: ' Bren ' }));
eq(targeted.target, 'Bren', 'a targeted line carries the trimmed name');
eq(targeted.id, 'ff-1', 'id is passed through');
eq(targeted.text, 'The forest is watching.', 'text is passed through');
eq(targeted.speaker, 'Eilif', 'speaker is passed through');

for (const [label, meta] of [
  ['no target key', {}],
  ['a blank target', { target: '  ' }],
  ['an over-long target', { target: 'a'.repeat(65) }],
  ['meta null', null],
  ['a non-string target', { target: 42 }],
]) {
  const line = voiceLinePayload(row(meta));
  ok(!('target' in line), `${label}: the target KEY is absent, not null or "" (the plugin reads member-absent as "everybody")`);
  ok(!JSON.stringify(line).includes('target'), `${label}: and it does not appear in the serialized JSON either`);
  eq(line.text, 'The forest is watching.', `${label}: the line itself is unchanged and still speakable`);
}

ok(
  !('meta' in voiceLinePayload(row({ target: 'Bren', source: 'poty', player_id: 7 }))),
  'meta itself is NEVER forwarded - the in-game half sees only id/text/speaker/target',
);

console.log('\ncompanionCapabilities - what the polling plugin says about itself');
eq(companionCapabilities('targeting', '0.3.3').targeting, true, 'the advertised capability is read');
eq(companionCapabilities('targeting', '0.3.3').plugin, '0.3.3', 'a plausible version string is kept');
eq(companionCapabilities(null, null).targeting, false, 'an older plugin sends no headers and reports false');
eq(companionCapabilities(null, null).plugin, undefined, 'and no version, rather than a null');
eq(companionCapabilities('TARGETING', null).targeting, true, 'the capability token is case-insensitive');
eq(companionCapabilities(' targeting , voice ', null).targeting, true, 'a list with spaces still matches');
eq(companionCapabilities('other', null).targeting, false, 'an unrelated capability does not turn targeting on');
eq(companionCapabilities('x'.repeat(5000), null).targeting, false, 'a junk header is bounded and simply reports false');
eq(companionCapabilities(null, 'not a version!').plugin, undefined, 'an implausible version string is dropped, never written to jsonb');
eq(companionCapabilities(null, 'v'.repeat(200)).plugin, undefined, 'an over-long version string is dropped');

console.log('\nvoiceBatch - the delivery gate (targeting must fail CLOSED)');
//
// THE FAILURE THIS EXISTS TO PREVENT. A Companion older than 0.3.3 has never heard of the
// `target` member; DataContractJsonSerializer ignores a member it was not told about, so
// that plugin speaks a private line TO EVERYBODY. The producer cannot stop it — the bot
// gates on a hand-set VOICE_TARGETING env var — so the route refuses to hand a targeted
// line to a caller that did not advertise the capability. Getting this backwards is a
// private oath callback read out to twenty people, which is why it is asserted from both
// directions rather than once.
const CAN = { targeting: true, plugin: '0.3.3' };
const CANNOT = { targeting: false };

const mixed = [
  { id: 'a', text: 'The hall is quiet.', speaker: 'Eilif', meta: {} },
  { id: 'b', text: 'You swore to return.', speaker: 'Eilif', meta: { target: 'Bren' } },
  { id: 'c', text: 'Night falls.', speaker: 'Eilif', meta: { source: 'ambient' } },
];

const modern = voiceBatch(mixed, CAN);
eq(modern.lines.length, 3, 'a targeting plugin is handed every line');
eq(modern.withheld.length, 0, 'and nothing is withheld from it');
eq(modern.lines[1].target, 'Bren', 'the targeted line keeps its recipient');
eq(modern.lines.map((l) => l.id).join(','), 'a,b,c', 'and the queue order is preserved');

const legacy = voiceBatch(mixed, CANNOT);
eq(legacy.lines.length, 2, 'a plugin that cannot target is handed only the untargeted lines');
eq(legacy.lines.map((l) => l.id).join(','), 'a,c', 'specifically: the private one is missing');
ok(
  !JSON.stringify(legacy.lines).includes('Bren'),
  'the private RECIPIENT never reaches an old plugin',
);
ok(
  !JSON.stringify(legacy.lines).includes('You swore'),
  'and neither does the private TEXT - withholding is not "send it untargeted"',
);
eq(legacy.withheld.length, 1, 'the withheld line is reported to the caller, not swallowed');
eq(legacy.withheld[0].id, 'b', 'by id, so the route can log which row it was');
eq(legacy.withheld[0].target, 'Bren', 'and by recipient, which is what an operator acts on');

// A malformed target is NOT a targeted line - it degraded to untargeted in voiceLinePayload,
// so it must reach an old plugin exactly as it does today. This is the regression that would
// turn a shaping bug into a silent, permanent hole in the voice feed.
for (const [label, meta] of [
  ['blank', { target: '   ' }],
  ['over-long', { target: 'a'.repeat(65) }],
  ['non-string', { target: 42 }],
  ['meta null', null],
]) {
  const b = voiceBatch([{ id: 'z', text: 'For the hall.', speaker: 'Eilif', meta }], CANNOT);
  eq(b.lines.length, 1, `a ${label} target is not "targeted" and still reaches an old plugin`);
  eq(b.withheld.length, 0, `a ${label} target is never withheld`);
}

eq(voiceBatch([], CANNOT).lines.length, 0, 'an empty claim is an empty batch');
eq(voiceBatch([], CANNOT).withheld.length, 0, 'and withholds nothing');

// The two ends of the wire, joined: whatever companionCapabilities() reads off the real
// headers is what the gate is handed, so an unheadered poll must lose the private line.
const fromHeaders = (caps, version) => voiceBatch(mixed, companionCapabilities(caps, version));
eq(fromHeaders('targeting', '0.3.3').lines.length, 3, 'headers end to end: 0.3.3 gets all three');
eq(fromHeaders(null, null).lines.length, 2, 'headers end to end: an unheadered poll loses the private line');
eq(fromHeaders('other', '0.3.2').lines.length, 2, 'headers end to end: an unrelated capability is not targeting');

console.log('\nroute wiring - the tripwire that keeps the shaping reachable');
const route = readFileSync(new URL('../app/api/voice/route.ts', import.meta.url), 'utf8');
ok(
  /\.select\(\s*'[^']*\bmeta\b[^']*'\s*\)/.test(route),
  "the route's .select('…') still asks for `meta` (a PostgREST select is a STRING; dropping the column would make every target undefined, silently)",
);
ok(route.includes('voiceBatch('), 'the route still shapes AND gates its lines through voiceBatch');
ok(route.includes('companionCapabilities('), 'the route still reads the plugin capability off the request');
ok(
  /lines:\s*batch\.lines/.test(route),
  'the route returns batch.lines - returning `rows` directly would bypass the gate entirely',
);
ok(
  route.includes('.in(\'id\', ids)'),
  'and it still marks EVERY claimed row spoken, withheld ones included, so none can wedge the queue head',
);

console.log(`\nvoice-api: ${checks} checks passed`);
