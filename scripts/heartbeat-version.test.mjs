// The cockpit's Version column, from both ends.
//
// /admin/ops has always had a Version column, lib/ops/health.ts has always
// mapped it straight off the heartbeat row, and both heartbeat senders have
// always ACCEPTED a `version` argument. No call site ever passed one, so all
// fifteen component rows read "unknown" while the glossary explained the column
// as the way to tell whether a host unit was restarted on the build you
// deployed. A number the page explains and never renders (T-3 audit ops-4).
//
// The bot and the poller now default `version` to their own package.json
// version inside the sender, so every existing call site carries it without
// being changed. These checks hold both halves: the senders really put it on the
// wire, and the glossary really describes what the column shows.
//
// Lives under scripts/ rather than in either service's own suite so the root
// `npm test` covers it; it imports the two service modules directly and stubs
// fetch, so nothing leaves the process.
//
//   npx tsx scripts/heartbeat-version.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

const pkgVersion = (p) =>
  JSON.parse(readFileSync(new URL(`../${p}/package.json`, import.meta.url), 'utf8')).version;

// ── capture what a sender would POST, without a network ─────────────────────
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (_url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200 };
};
process.env.OPS_HEARTBEAT_TOKEN = 'test-token';
process.env.OPS_HEARTBEAT_URL = 'http://127.0.0.1:1/api/ops/heartbeat';
const quiet = { warn() {}, info() {}, error() {} };

try {
  const bot = await import('../services/discord-bot/src/heartbeat.js');
  const poller = await import('../services/log-poller/src/heartbeat.js');

  // ── the bot ───────────────────────────────────────────────────────────────
  sent.length = 0;
  await bot.createHeartbeatSender('discord-bot', quiet)({ status: 'ok', metrics: {} });
  ok('the bot sends a heartbeat', sent.length === 1);
  // THE REGRESSION ITSELF: a call site that passes only status and metrics, which
  // is exactly what services/discord-bot/src/index.js does, must still carry a
  // version.
  ok('a call site that passes no version still sends one',
    typeof sent[0].version === 'string' && sent[0].version.length > 0, JSON.stringify(sent[0].version));
  ok('and it is the bot package\'s own version',
    sent[0].version === pkgVersion('services/discord-bot'), `${sent[0].version} vs ${pkgVersion('services/discord-bot')}`);

  // An explicit version still wins. NOTHING IN THE BOT PASSES ONE TODAY — the
  // component name below is invented by this test, not taken from the codebase;
  // the real `companion-voice` heartbeat is written by the site's /api/voice
  // route, not by this process. The parameter is kept so a sender that reports
  // somebody else's version does not have to route around the default.
  sent.length = 0;
  await bot.createHeartbeatSender('made-up-component', quiet)({ status: 'ok', version: '0.3.3' });
  ok('an explicit version overrides the default', sent[0].version === '0.3.3', sent[0].version);

  // ── the poller ────────────────────────────────────────────────────────────
  sent.length = 0;
  await poller.createHeartbeatSender('log-poller', quiet)({ status: 'ok', metrics: {} });
  ok('the poller sends a heartbeat', sent.length === 1);
  ok('the poller carries a version too',
    sent[0].version === pkgVersion('services/log-poller'), JSON.stringify(sent[0].version));
  ok('and it names itself as the component', sent[0].component === 'log-poller');

  // ── the wiring must not have broken anything else ────────────────────────
  sent.length = 0;
  await poller.createHeartbeatSender('log-poller', quiet)({ status: 'degraded', error: 'token=hunter2 broke', metrics: { a: 1 } });
  ok('status still travels', sent[0].status === 'degraded');
  ok('metrics still travel', sent[0].metrics?.a === 1);
  ok('errors are still redacted on the way out',
    !/hunter2/.test(sent[0].error ?? ''), sent[0].error);

  // A sender with no token is a no-op, and must stay one.
  const prevToken = process.env.OPS_HEARTBEAT_TOKEN;
  delete process.env.OPS_HEARTBEAT_TOKEN;
  sent.length = 0;
  await poller.createHeartbeatSender('log-poller', quiet)({ status: 'ok' });
  ok('no token still means no heartbeat at all', sent.length === 0);
  process.env.OPS_HEARTBEAT_TOKEN = prevToken;
} finally {
  globalThis.fetch = realFetch;
}

// ── the reading end ─────────────────────────────────────────────────────────
const health = readFileSync(new URL('../lib/ops/health.ts', import.meta.url), 'utf8');
ok('the cockpit reads the heartbeat\'s version', /version:\s*hb\.version/.test(health));

// ── the comment above the default must stay true ────────────────────────────
// It says "no call site in the bot passes a version". That is the kind of claim
// that rots silently, and it sits in the file an operator opens when the Version
// column misbehaves, so it is held here rather than trusted.
const botSrc = readFileSync(new URL('../services/discord-bot/src/index.js', import.meta.url), 'utf8');
const pollerSrc = readFileSync(new URL('../services/log-poller/src/poller.js', import.meta.url), 'utf8');
const callSites = [...botSrc.matchAll(/createHeartbeatSender\(([^)]*)\)/g), ...pollerSrc.matchAll(/createHeartbeatSender\(([^)]*)\)/g)]
  .map((m) => m[1]);
ok('both services still create their sender', callSites.length === 2, JSON.stringify(callSites));
ok('no call site passes a version, so the default is the only source',
  callSites.every((a) => !/version/i.test(a)), JSON.stringify(callSites));
const heartbeatSrc = readFileSync(new URL('../services/discord-bot/src/heartbeat.js', import.meta.url), 'utf8');
ok('the comment does not claim a caller that does not exist',
  !/voice puppet reports the Companion/.test(heartbeatSrc));

const { GLOSSARY } = await import('../lib/ops/glossary.ts');
const entry = GLOSSARY['component-version'];
ok('the Version column still has a glossary entry', Boolean(entry));
// It must describe what the column SHOWS, not a reading that cannot occur.
ok('the glossary says the bot and poller report a version',
  /package\.json version/.test(entry.what), entry.what);
ok('it says why a host row can still read unknown',
  /restarted/i.test(entry.what), entry.what);
ok('it says why the dashboard row reads unknown',
  /CLI deploy does not set/.test(entry.what), entry.what);
ok('it names the components that report nothing',
  /map snapshotter/.test(entry.what) && /server emitter/.test(entry.what), entry.what);
// The claim that made the old entry wrong: that this column answers "was it
// restarted". It must now point at the thing that actually answers that.
ok('whenRed names its own limits', /CANNOT answer/.test(entry.whenRed), entry.whenRed);
ok('whenRed points at verify-restart.sh', /verify-restart\.sh/.test(entry.whenRed), entry.whenRed);

console.log(`\nOK — heartbeat version: ${checks} checks. Both host senders carry their package version ` +
  `with no call-site change, and the glossary describes the column the page actually renders.`);
