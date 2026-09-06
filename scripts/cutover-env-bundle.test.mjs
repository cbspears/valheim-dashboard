// The one line of cutover-env.sh's output that is supposed to be pasted.
//
// scripts/cutover-env.sh prints three remote steps it cannot do itself, and step
// 3 ended with what looked like a command:
//
//     node scripts/build-config-bundle.mjs --world Eilif, deploy.
//
// It exits 2. build-config-bundle.mjs also requires --pack-number and
// --pack-date, so the operator's paste on launch morning answers with a usage
// screen (T-3 audit ops-27). This runs the printed line for real, with the two
// placeholders filled in, and fails if it does not execute.
//
// It is a slow-ish test (it spawns the bundle builder) but it is the only kind
// that can catch this class of bug: a string that reads like a command.
//
//   npx tsx scripts/cutover-env-bundle.test.mjs

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

// Dry run, with every write target pointed at /dev/null so nothing on this
// machine is read or touched. cutover-env.sh writes nothing without --apply
// anyway; the overrides make that structural rather than a promise.
const out = execFileSync('bash', ['scripts/cutover-env.sh', 'Eilif'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    EILIF_BOT_ENV: '/dev/null',
    EILIF_POLLER_ENV: '/dev/null',
    EILIF_BOT_UNIT: '/dev/null',
    EILIF_BACKUP_UNIT: '/dev/null',
  },
});

ok('the cutover prints its three remote steps', /remote steps/.test(out));

// ── pull the bundle command out of the printed block ────────────────────────
// It is a two-line command joined by a trailing backslash, exactly as it would
// be pasted.
const m = out.match(/(node scripts\/build-config-bundle\.mjs[^\n]*\\\n[^\n]*)/);
ok('the bundle command is printed', Boolean(m), out.slice(-500));
const printed = m[1];

ok('it carries --pack-number', /--pack-number/.test(printed), printed);
ok('it carries --pack-date', /--pack-date/.test(printed), printed);
ok('it carries the world', /--world Eilif/.test(printed), printed);
// The pins the 1.0 posture needs travel with it, or the bundle is built from
// pack v11's defaults while the pack pins something else.
ok('it carries the client pins and the fallback',
  /--paths /.test(printed) && /--companion-client /.test(printed) && /--no-vplus/.test(printed) && /--fallback on/.test(printed),
  printed);
// --cap belongs to mint-pack. build-config-bundle rejects it as an unknown
// argument, so a line that carried it would exit 2 for a different reason.
ok('it does NOT carry --cap, which this script rejects', !/--cap/.test(printed), printed);

// ── run it ──────────────────────────────────────────────────────────────────
// Fill the two placeholders the operator fills, add --dry-run so nothing is
// written, and execute. This is the whole point of the test.
const filled = printed
  .replace(/\\\n\s*/g, ' ')
  .replace(/<N>/g, '12')
  .replace(/'<Mon D, YYYY>'/g, "'Sep 9, 2026'")
  .replace(/<ver>/g, '0.3.4');
ok('every placeholder was substitutable', !/[<>]/.test(filled), filled);

const run = spawnSync('bash', ['-c', `${filled} --dry-run`], { cwd: ROOT, encoding: 'utf8' });
ok('the printed command RUNS', run.status === 0,
  `exit ${run.status}: ${(run.stderr || run.stdout || '').split('\n').slice(0, 3).join(' / ')}`);
ok('and it builds the bundle it claims to', /Mac config bundle/.test(run.stdout ?? ''), (run.stdout ?? '').slice(0, 200));
ok('with the world and pins it was given',
  /world\s+Eilif/.test(run.stdout) && /fallback\s+on/.test(run.stdout), (run.stdout ?? '').slice(0, 400));

// ── the regression itself ───────────────────────────────────────────────────
// The old line. If it ever comes back, this is what fails.
ok('the bare "--world <W>, deploy." form is gone',
  !/build-config-bundle\.mjs --world \w+,/.test(out), out);

console.log(`\nOK — cutover-env bundle line: ${checks} checks. The command cutover-env.sh prints for ` +
  `step 3 executes once its two placeholders are filled, instead of answering with a usage screen.`);
