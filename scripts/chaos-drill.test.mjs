// The chaos drill's pass/fail logic, exercised without stopping a single service.
//
// WHY THIS EXISTS. scripts/chaos-drill.sh takes about half an hour and stops the
// three live units, so it is run once before a launch and never in a loop — which
// is exactly the shape of thing whose verdict logic is never checked. It was
// wrong: it asserted on the action word ITS OWN dispatch got back, and since the
// Supabase pg_cron pinger went live on 2026-09-06 (every five minutes, against a
// route that only speaks on a state transition) a pinger takes the ok->alerting
// edge during the drill's own 21-minute wait. The drill then read `none` and
// printed DRILL FAIL on a night the chain worked perfectly.
//
// TWO MORE HOLES, CLOSED IN THE FIX PASS. The first version of the fix took the
// "a pinger already fired it" shortcut too far:
//   * it never asserted the phase-0 BASELINE, so a drill started on a hall that
//     was already down read the route's `none while unhealthy` as "a pinger
//     alerted" and passed both edges with nothing posted during the drill; and
//   * it never looked at `notified`, so an action=alert whose Discord post FAILED
//     (the route answers 502 and deliberately does not persist) passed too — on
//     the one link the drill exists to prove.
//
// HOW IT IS TESTED WITHOUT RUNNING IT. The three decision functions live in the
// script between the `>>> drill-verdicts` and `<<< drill-verdicts` sentinels and
// touch nothing but their arguments. This file extracts that block verbatim and
// runs it in a bare `bash -c` — no gh, no sudo, no network — over the truth table
// of responses the route can actually return.
//
//   npx tsx scripts/chaos-drill.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const src = readFileSync(new URL('../scripts/chaos-drill.sh', import.meta.url), 'utf8');

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

// ── extract the decision block ──────────────────────────────────────────────
const start = src.indexOf('# >>> drill-verdicts');
const end = src.indexOf('# <<< drill-verdicts');
assert.ok(start !== -1 && end > start, 'the drill-verdicts sentinels are gone from scripts/chaos-drill.sh');
const block = src.slice(start, end);
ok('the verdict block is extractable',
  block.includes('alert_edge_taken') && block.includes('recovery_edge_taken') && block.includes('baseline_clean'));
// If the block ever grows a `gh`, `sudo`, `curl` or `systemctl` it is no longer
// pure decision logic and this file would be testing something it cannot reach.
for (const forbidden of ['gh ', 'sudo', 'curl', 'systemctl', 'iptables']) {
  ok(`the verdict block stays pure (no ${forbidden.trim()})`, !block.includes(forbidden));
}

function verdict(fn, args) {
  const script = `${block}\n${fn} ${args.map((a) => `'${String(a)}'`).join(' ')}\n`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

// ── phase 0: the baseline ───────────────────────────────────────────────────
// args: action, reason, unhealthyCount, priorState, notified
// A baseline is CLEAN only when the hall is quiet AND the alert row is back to
// ok, i.e. the ok->alerting edge is genuinely still ahead of the drill.
ok('baseline: a quiet hall with the row at ok is clean',
  verdict('baseline_clean', ['none', 'healthy', 0, 'ok', 'no-post']) === 'clean');
ok('baseline: something already unhealthy is dirty',
  verdict('baseline_clean', ['none', 'suppressed', 2, 'alerting', 'no-post']) === 'dirty');
// THE ONE THAT USED TO PASS EVERYTHING DOWNSTREAM: the services never came back
// up after the last drill, so the row still says alerting before this one starts.
ok('baseline: a standing alert is dirty even at zero unhealthy',
  verdict('baseline_clean', ['none', 'healthy', 0, 'alerting', 'no-post']) === 'dirty');
ok('baseline: this dispatch itself alerting is dirty',
  verdict('baseline_clean', ['alert', 'first-unhealthy', 1, 'ok', 'posted']) === 'dirty');
ok('baseline: an unreadable answer is dirty, never clean',
  verdict('baseline_clean', ['?', '?', '?', '?', '?']) === 'dirty');

// ── phase 3: the alert edge ─────────────────────────────────────────────────
// args: action, reason, unhealthyCount, priorState, notified, baseline verdict

ok('alert: this drill fired it and Discord took the post',
  verdict('alert_edge_taken', ['alert', 'first-unhealthy', 2, 'ok', 'posted', 'clean']) === 'this-drill');

// THE DISCORD LINK IS THE POINT OF THE DRILL. app/api/ops/watchdog/route.ts
// answers 502 with action=alert and notified.ok=false when postToDiscord() fails,
// and does NOT persist the state. Detection worked; delivery did not.
ok('alert: a decided alert whose post FAILED is not a pass',
  verdict('alert_edge_taken', ['alert', 'first-unhealthy', 2, '?', 'not-posted', 'clean']) === 'fail-not-posted');
ok('alert: an unreadable notified field is not a pass either',
  verdict('alert_edge_taken', ['alert', 'first-unhealthy', 2, 'ok', '?', 'clean']) === 'fail-not-posted');

// THE CASE THE OLD SCRIPT FAILED ON. The pg_cron pinger crossed the threshold
// during the drill's own wait, so the route is suppressing a repeat of an alert
// that is already out — and two things are genuinely unhealthy.
ok('alert: a pinger fired it first, and the hall really is unhealthy',
  verdict('alert_edge_taken', ['none', 'suppressed', 2, 'alerting', 'no-post', 'clean']) === 'already-fired');

// AND THE CASE THAT LOOKS EXACTLY LIKE IT AND IS NOT IT. Same response, dirty
// baseline: the hall was already broken before the drill started, so nothing was
// necessarily posted inside the drill window at all.
ok('alert: the same answer on a dirty baseline is a failure',
  verdict('alert_edge_taken', ['none', 'suppressed', 2, 'alerting', 'no-post', 'dirty']) === 'fail-baseline');

// The one that must NOT pass: nothing is unhealthy, so no edge was crossed at
// all. This is what a drill that failed to stop the services looks like.
ok('alert: none while HEALTHY is a failure, not a pass',
  verdict('alert_edge_taken', ['none', 'healthy', 0, 'ok', 'no-post', 'clean']) === 'fail');

// An unreadable response proves nothing, whatever else it says.
ok('alert: an unreadable count fails',
  verdict('alert_edge_taken', ['none', 'suppressed', '?', 'alerting', 'no-post', 'clean']) === 'fail');
ok('alert: an unreadable action fails',
  verdict('alert_edge_taken', ['?', '?', '?', '?', '?', 'clean']) === 'fail');
// A re-alert on a long outage is still this drill firing an alert.
ok('alert: a re-alert counts as this drill firing',
  verdict('alert_edge_taken', ['alert', 're-alert', 3, 'alerting', 'posted', 'clean']) === 'this-drill');
// A dirty baseline never blocks the drill's OWN dispatch from proving the edge:
// an alert this run decided and Discord accepted is evidence either way.
ok('alert: this drill firing still passes on a dirty baseline',
  verdict('alert_edge_taken', ['alert', 'first-unhealthy', 2, 'ok', 'posted', 'dirty']) === 'this-drill');

// Every failure word begins `fail`, which is what the script's summary matches on.
for (const args of [
  ['alert', 'first-unhealthy', 2, 'ok', 'not-posted', 'clean'],
  ['none', 'suppressed', 2, 'alerting', 'no-post', 'dirty'],
  ['none', 'healthy', 0, 'ok', 'no-post', 'clean'],
]) {
  const v = verdict('alert_edge_taken', args);
  ok(`every failure verdict begins "fail" (${v})`, v.startsWith('fail'), v);
}

// ── phase 5: the recovery edge ──────────────────────────────────────────────
// args: action, reason, unhealthyCount, priorState, notified, phase-3 verdict

ok('recover: this drill fired it and Discord took the post',
  verdict('recovery_edge_taken', ['recover', 'recovered', 0, 'alerting', 'posted', 'this-drill']) === 'this-drill');
ok('recover: a decided recovery whose post FAILED is not a pass',
  verdict('recovery_edge_taken', ['recover', 'recovered', 0, '?', 'not-posted', 'this-drill']) === 'fail-not-posted');
ok('recover: a pinger posted the all-clear first',
  verdict('recovery_edge_taken', ['none', 'healthy', 0, 'ok', 'no-post', 'already-fired']) === 'already-fired');
ok('recover: it counts after either kind of phase-3 pass',
  verdict('recovery_edge_taken', ['none', 'healthy', 0, 'ok', 'no-post', 'this-drill']) === 'already-fired');

// THE GATE THAT MAKES THE SECOND CASE MEAN ANYTHING. A drill whose phase 3
// failed never established an outage, so "everything is healthy" is the state it
// started in — not a recovery. Every phase-3 failure word begins `fail`, so the
// gate must reject all of them, not just the bare one.
for (const p3 of ['fail', 'fail-baseline', 'fail-not-posted']) {
  ok(`recover: healthy is NOT a pass when phase 3 said ${p3}`,
    verdict('recovery_edge_taken', ['none', 'healthy', 0, 'ok', 'no-post', p3]) === 'fail');
}
ok('recover: still unhealthy is a failure',
  verdict('recovery_edge_taken', ['none', 'suppressed', 2, 'alerting', 'no-post', 'this-drill']) === 'fail');
ok('recover: an unreadable count fails',
  verdict('recovery_edge_taken', ['none', 'healthy', '?', 'ok', 'no-post', 'this-drill']) === 'fail');

// ── the script says which path it took, and knows about both pingers ─────────
ok('the summary names the path taken for each edge',
  /alert edge via \$p3path, recovery edge via \$p5path/.test(src));
ok('a pinger-taken edge is called out in the summary',
  /pg_cron pinger rather than by this drill/.test(src));
ok('the header documents the Supabase pg_cron pinger',
  /eilif-watchdog-ping/.test(src) && /EVERY FIVE MINUTES/.test(src));
ok('the header tells you how to silence it for a drill',
  /cron\.unschedule\('eilif-watchdog-ping'\)/.test(src));
// dispatch() must hand the caller the reason and the count, not just the action —
// the whole fix depends on those two fields being readable.
ok('dispatch reads unhealthyCount out of the response', /d\.get\('unhealthyCount'\)/.test(src));
ok('dispatch reads the alert reason out of the response', /a\.get\('reason'\)/.test(src));
ok('dispatch reads whether Discord took the post', /d\.get\('notified'\)/.test(src));
ok('dispatch prints five fields', /print\(action, reason, .*, prior, notified\)/.test(src));
// The `notified` field has to be ONE token: the callers read it with a five-name
// `read -r`, and a "not-posted: 404 Not Found" would slide every field along.
ok('the notified field carries no failure prose', !/not-posted:/.test(src));
ok('the default log directory is not one agent session\'s scratchpad',
  !/scratchpad\/chaos/.test(src) && /CHAOS_LOG_DIR/.test(src));

// ── the baseline is asserted in the script, not merely printed ───────────────
// The verdict function is only worth anything if the drill actually calls it and
// stops. It must stop BEFORE phase 1 stops a service, so a refusal costs nothing.
ok('the script computes the baseline verdict', /p0=\$\(baseline_clean /.test(src));
ok('a dirty baseline refuses to continue', /baseline DIRTY/.test(src) && /refusing to continue\. Nothing was stopped\./.test(src));
ok('the refusal happens before anything is stopped',
  src.indexOf('baseline DIRTY') < src.indexOf('phase 1: stopping'),
  `baseline check at ${src.indexOf('baseline DIRTY')}, stop at ${src.indexOf('phase 1: stopping')}`);
ok('--force is the documented override', /--force runs it anyway/.test(src));
ok('the phase-3 verdict is given the baseline', /alert_edge_taken "\$a3" "\$r3" "\$u3" "\$s3" "\$n3" "\$p0"/.test(src));
ok('the summary passes on the fail* prefix, not an exact word',
  /\$\{p3path#fail\}" = "\$p3path"/.test(src) && /\$\{p5path#fail\}" = "\$p5path"/.test(src));

console.log(`\nOK — chaos drill: ${checks} checks. The alert and recovery edges pass whether this drill ` +
  `or the pg_cron pinger crossed them, a healthy hall never passes as an outage, a dirty baseline ` +
  `never passes as "a pinger got there first", a decided alert whose Discord post failed is a ` +
  `failure, and an unreadable response is a failure.`);
