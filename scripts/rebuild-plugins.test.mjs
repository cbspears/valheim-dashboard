// The launch-morning duplicate-version refusal in scripts/rebuild-plugins.sh.
//
// WHAT IT IS GUARDING. A Thunderstore version is IMMUTABLE once uploaded. On
// 2026-09-06 at 10:01 CT Eilif/EilifPaths 1.5.0 and Eilif/EilifCompanionClient
// 0.3.3 both went live at exactly the numbers their csprojs still carry. Step 2
// of the launch morning rebuilds every plugin against Valheim 1.0, so it would
// have produced DIFFERENT DLLs under those same immutable numbers and staged
// them into the very directories whose zips are already published, with nothing
// on screen saying so. Either the 16:00 upload is rejected as a duplicate, or
// the pack pins the published number and hands every player a 0.221.12 client
// DLL against a 1.0 server (T-3 audit plugins-0).
//
// HOW IT IS TESTED WITHOUT THE NETWORK. The check lives between the
// `>>> ts-version-check` and `<<< ts-version-check` sentinels and reaches the
// outside world through exactly one command: `curl`. This file extracts the
// block and runs it in a bare shell with a stub `curl` that prints whatever
// status code the case under test needs — bash resolves a function before PATH,
// so the real binary is never called.
//
//   npx tsx scripts/rebuild-plugins.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const src = readFileSync(new URL('../scripts/rebuild-plugins.sh', import.meta.url), 'utf8');

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

const start = src.indexOf('# >>> ts-version-check');
const end = src.indexOf('# <<< ts-version-check');
assert.ok(start !== -1 && end > start, 'the ts-version-check sentinels are gone from scripts/rebuild-plugins.sh');
const block = src.slice(start, end);
ok('the version-check block is extractable',
  block.includes('published_state') && block.includes('next_patch'));

/** Run the block with a stub curl that always answers `code`, then a command. */
function withCurl(code, command, { allowPublished = 0 } = {}) {
  const stub = `curl() { printf '%s' '${code}'; }\nALLOW_PUBLISHED=${allowPublished}\n`;
  return execFileSync('bash', ['-c', `${stub}${block}\n${command}\n`], { encoding: 'utf8' }).trim();
}

// ── the status code is the whole answer ─────────────────────────────────────
ok('200 means the version is published (and immutable)',
  withCurl('200', `published_state EilifPaths 1.5.0`) === 'published');
ok('404 means the version is free',
  withCurl('404', `published_state EilifPaths 1.5.1`) === 'free');

// ANYTHING ELSE IS "COULD NOT TELL", AND MUST NOT READ AS "TAKEN". This runs
// inside a stopped window on launch morning: a 500 or a timeout blocking the
// staging would cost the outage minutes that the refusal exists to save.
for (const [code, label] of [['000', 'a timeout'], ['500', 'a server error'], ['403', 'a refusal'], ['', 'no answer at all']]) {
  const state = withCurl(code, `published_state EilifPaths 1.5.0`);
  ok(`${label} is unknown, never published`, state.startsWith('unknown:'), state);
}
ok('the unknown state carries the code, so the warning can name it',
  withCurl('503', `published_state EilifPaths 1.5.0`) === 'unknown:http-503');

// ── the escape hatch ────────────────────────────────────────────────────────
// It is its OWN state, not an `unknown:`. Both message sites strip the
// `unknown:` prefix and print what is left as a failure to reach Thunderstore,
// so returning `unknown:--allow-published` made the operator's own override read
// as a network outage inside a stopped window.
ok('--allow-published short-circuits the query',
  withCurl('200', `published_state EilifPaths 1.5.0`, { allowPublished: 1 }) === 'overridden');
ok('the override is not reported as an unreachable API',
  !withCurl('200', `published_state EilifPaths 1.5.0`, { allowPublished: 1 }).startsWith('unknown:'));
ok('the override has its own message, which says NOT CHECKED',
  /overridden\)/.test(src) && /NOT CHECKED/.test(src));
ok('and no message renders a bare --allow-published as a reachability failure',
  !/could not (check|reach)[^\n]*--allow-published/.test(src));

// ── one request per (package, version) ──────────────────────────────────────
// The plan prints the state and the staging gate reads it again; on launch
// morning that must not be two round trips per plugin.
ok('the answer is cached across calls',
  withCurl('200', `published_state EilifPaths 1.5.0 >/dev/null; curl() { printf '404'; }; published_state EilifPaths 1.5.0`) === 'published');
ok('a different version is a different question',
  withCurl('200', `published_state EilifPaths 1.5.0 >/dev/null; published_state EilifPaths 9.9.9`) === 'published');

// ── the suggested bump ──────────────────────────────────────────────────────
// Exactly the two numbers launch morning needs, plus the shapes that must not
// crash the message that carries them.
ok('1.5.0 suggests 1.5.1', withCurl('404', `next_patch 1.5.0`) === '1.5.1');
ok('0.3.3 suggests 0.3.4', withCurl('404', `next_patch 0.3.3`) === '0.3.4');
ok('0.3.9 suggests 0.3.10', withCurl('404', `next_patch 0.3.9`) === '0.3.10');
ok('a non-numeric version is echoed back rather than mangled',
  withCurl('404', `next_patch 1.5.0-rc1`) === '1.5.0-rc1');
ok('a two-part version is echoed back', withCurl('404', `next_patch 1.5`) === '1.5');

// ── the wiring, in the script itself ────────────────────────────────────────
// The pure functions are only useful if the staging gate actually consults them.
ok('the staging gate refuses a published version',
  /if \[\[ "\$tsstate" == published \]\]; then/.test(src) && /REFUSED/.test(src));
ok('the refusal counts as a failure and skips the copy',
  /REFUSED[\s\S]{0,1400}FAILURES=\$\(\(FAILURES \+ 1\)\)[\s\S]{0,80}continue/.test(src));
ok('the refusal names the version to bump to', /Bump it first:[\s\S]{0,60}next_patch/.test(src));
ok('the refusal says it will not bump the csproj for you',
  /does not bump it for you/.test(src));
ok('an unreachable API warns instead of refusing',
  /elif \[\[ "\$tsstate" != free \]\]; then[\s\S]{0,200}WARN/.test(src));
ok('the plan prints the state before the stopped window', /Thunderstore: .*ALREADY PUBLISHED/.test(src));
ok('--allow-published is a real flag', /--allow-published\) ALLOW_PUBLISHED=1/.test(src));

// THE REFUSAL MUST COME BEFORE THE STAGING LOOP, NOT INSIDE IT. It first shipped
// inside the loop, one plugin at a time, which looks equivalent and is not: the
// loop copies each plugin as it reaches it, so every plugin whose turn came
// before the refused one — the two SERVER DLLs among them — was already written
// into $STAGE_DIR by the time the refusal fired, and the run then exited 1 with
// "Do not stage any of this." printed over files that were on disk.
const refusal = src.indexOf('REFUSED');
ok('the refusal exists exactly once', refusal !== -1 && src.indexOf('REFUSED', refusal + 1) === -1);
for (const write of ['mkdir -p "$STAGE_DIR"', 'mkdir -p "$tsdir"', 'cp "$src"']) {
  ok(`nothing is written before the refusal (${write})`,
    refusal < src.indexOf(write),
    `REFUSED at ${refusal}, ${write} at ${src.indexOf(write)}`);
}
// And it must feed the SHARED gate, so one published version skips staging for
// every plugin in the run rather than only for its own.
ok('the refusal runs before the shared "checks failed" gate',
  refusal < src.indexOf('if [[ $STAGE == 1 && $FAILURES -gt 0 ]]; then'));
ok('the shared gate is what actually skips the staging', /Staging skipped: \$FAILURES check\(s\) failed/.test(src));
// The staging loop must no longer make this decision itself.
const stageLoop = src.slice(src.indexOf('# CLIENT: plugins/thunderstore'));
ok('the staging loop no longer queries Thunderstore', !/published_state/.test(stageLoop));

// SERVER plugins have no Thunderstore package and must never be gated by this.
ok('the plan asks only for clients', /if \[\[ "\$\{SIDE\[\$p\]\}" == CLIENT \]\]; then\s*\n\s*tsstate=/.test(src));
ok('the gate asks only for clients',
  /\[\[ "\$\{SIDE\[\$p\]\}" == CLIENT \]\] \|\| continue/.test(src));
// A plugin that already failed its build checks must not also collect a
// Thunderstore refusal: one broken thing, one message.
ok('the gate skips plugins that already failed their build checks',
  /\[\[ "\$\{BUILT_OK\[\$p\]:-0\}" == 1 \]\] \|\| continue/.test(src));

// --help must print the WHOLE header. A hard-coded line range silently truncated
// it the first time the header grew (it stopped mid-sentence and dropped the
// "Requires:" and "Network:" paragraphs), so the range is now derived.
ok('--help does not slice the header at a hard-coded line number',
  !/sed -n '2,\d+p' "\$\{BASH_SOURCE\[0\]\}"/.test(src));
const help = execFileSync('bash', [new URL('../scripts/rebuild-plugins.sh', import.meta.url).pathname, '--help'],
  { encoding: 'utf8' });
ok('--help reaches the last line of the header', /verify-restart\.sh \(what the last Stop->Start armed\)/.test(help));
ok('--help still carries the Requires and Network paragraphs',
  /^Requires: dotnet 8/m.test(help) && /^Network: /m.test(help));
ok('--help stops at the code', !/set -uo pipefail/.test(help));

console.log(`\nOK — rebuild-plugins version check: ${checks} checks. A published version refuses the whole ` +
  `staging step and names the bump, an unreachable Thunderstore warns instead of blocking a stopped ` +
  `window, --allow-published reads as an override rather than an outage, nothing is written before ` +
  `the refusal, and --help prints the whole header.`);
