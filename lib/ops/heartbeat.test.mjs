// Unit tests for heartbeat validation + allowlist + redaction.
// Run: npx tsx lib/ops/heartbeat.test.mjs
import assert from 'node:assert';
import { validateHeartbeat, HEARTBEAT_ALLOWLIST } from './heartbeat.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── Allowlist enforced ────────────────────────────────────────────────────
for (const c of HEARTBEAT_ALLOWLIST) {
  const r = validateHeartbeat({ component: c });
  ok(r.ok === true, `allowlisted component ${c} accepted`);
}
{
  const r = validateHeartbeat({ component: 'evil-injector' });
  ok(r.ok === false && r.status === 400, 'non-allowlisted component rejected 400');
}
{
  // The retired stats-parser (eilif-stats-parser.service, retired 2026-08-23) is
  // off the allowlist as of 2026-09-04: accepting a beat from it would put a
  // stale row back into a cockpit that no longer renders one. Its EXISTING row is
  // deliberately left in the database for Charlie to delete.
  ok(!HEARTBEAT_ALLOWLIST.includes('stats-parser'), 'stats-parser is off the allowlist');
  const r = validateHeartbeat({ component: 'stats-parser' });
  ok(r.ok === false && r.status === 400, 'a late stats-parser beat is rejected 400');
}
{
  // The two in-game plugins are NOT allowlisted on purpose — neither can POST
  // anything; their rows are written straight to the table by the routes they
  // poll (lib/ops/route-heartbeat), which never goes through this validator.
  for (const c of ['boards-plugin', 'companion-voice']) {
    ok(validateHeartbeat({ component: c }).ok === false, `${c} cannot POST a heartbeat`);
  }
}
{
  const r = validateHeartbeat({});
  ok(r.ok === false && r.status === 400, 'missing component rejected 400');
}
{
  ok(validateHeartbeat(null).ok === false, 'null body rejected');
  ok(validateHeartbeat([]).ok === false, 'array body rejected');
  ok(validateHeartbeat('x').ok === false, 'string body rejected');
}

// ── Status coercion + isOk derivation ─────────────────────────────────────
{
  const r = validateHeartbeat({ component: 'log-poller' });
  ok(r.ok && r.value.status === 'ok' && r.value.isOk === true, 'default status ok → isOk');
}
{
  const r = validateHeartbeat({ component: 'log-poller', status: 'degraded' });
  ok(r.ok && r.value.status === 'degraded' && r.value.isOk === false, 'degraded → not ok');
}
{
  const r = validateHeartbeat({ component: 'log-poller', ok: false });
  ok(r.ok && r.value.status === 'error' && r.value.isOk === false, 'ok:false → error, not ok');
}
{
  const r = validateHeartbeat({ component: 'log-poller', status: 'error', ok: true });
  ok(r.ok && r.value.isOk === true, 'ok:true forces success even with status error');
}
{
  const r = validateHeartbeat({ component: 'log-poller', status: 'bogus' });
  ok(r.ok === false && r.status === 400, 'invalid status rejected 400');
}

// ── Redaction of error + metric strings ───────────────────────────────────
{
  const r = validateHeartbeat({
    component: 'discord-bot',
    error: 'crashed with token=supersecretvalue1234567890 in handler',
    metrics: { lag: 5, note: 'bearer abcdefghijklmnopqrstuvwxyz012345' },
  });
  ok(r.ok, 'valid payload with secrets still ok');
  ok(!String(r.value.errorSummary).includes('supersecret'), `error redacted, got: ${r.value.errorSummary}`);
  ok(r.value.metrics.lag === 5, 'numeric metric preserved');
  ok(!JSON.stringify(r.value.metrics).includes('abcdefghijklmnop'), 'metric secret redacted');
}
{
  // error_summary truncated ~200
  const r = validateHeartbeat({ component: 'map-snapshot', error: 'e'.repeat(400) });
  ok(r.ok && r.value.errorSummary.length <= 200, `error truncated, got ${r.value.errorSummary.length}`);
}
{
  const r = validateHeartbeat({ component: 'map-snapshot' });
  ok(r.ok && r.value.errorSummary === null, 'no error → null summary');
  ok(r.ok && typeof r.value.metrics === 'object', 'no metrics → {}');
}

// ── instance/version passthrough (trimmed) ────────────────────────────────
{
  const r = validateHeartbeat({ component: 'discord-bot', instance: '  host-1 ', version: ' 3a3daba ' });
  ok(r.ok && r.value.instance === 'host-1' && r.value.version === '3a3daba', 'instance/version trimmed');
}

console.log(`heartbeat.test: ${passed} assertions passed`);
