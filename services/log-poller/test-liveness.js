// Offline liveness test: drive the server-liveness state machine through a
// scripted timeline and assert the transitions. No network, no SFTP, no clock.
import {
  evaluateLiveness,
  normalizeLiveness,
  logAgeSec,
  formatDuration,
  formatWhen,
} from './src/liveness.js';

const MIN = 60 * 1000;
const STALE = 30 * MIN;
const REALERT = 6 * 60 * MIN;
const cfg = { staleLogThresholdMs: STALE, downReAlertMs: REALERT };

let ok = true;
const checks = [];
function check(label, pass) {
  checks.push([label, pass]);
  if (!pass) ok = false;
}

// A tiny driver: keeps state, records every action the machine emits.
function driver(initial = null) {
  let state = normalizeLiveness(initial);
  const actions = [];
  return {
    feed(now, size, extra = {}) {
      const r = evaluateLiveness(state, { now, size, ...extra }, cfg);
      state = r.state;
      if (r.action) actions.push({ at: now, ...r.action });
      return r;
    },
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
  };
}

const T0 = Date.parse('2026-08-15T00:00:00Z');

// --- 1. Healthy server: log keeps growing, never fires ---------------------
{
  const d = driver();
  let size = 1000;
  for (let i = 0; i <= 20; i++) {
    d.feed(T0 + i * 10 * MIN, (size += 500));
  }
  check('healthy: growing log emits no actions', d.actions.length === 0);
  check('healthy: serverDown stays false', d.state.serverDown === false);
}

// --- 2. Server stops: exactly one 'down' at the threshold ------------------
{
  const d = driver();
  d.feed(T0, 1000); // first observation seeds the clock
  d.feed(T0 + 10 * MIN, 1500); // last growth
  const growthAt = T0 + 10 * MIN;
  for (let i = 1; i <= 6; i++) d.feed(growthAt + i * 10 * MIN, 1500); // static for 60m
  const downs = d.actions.filter((a) => a.kind === 'down');
  check('stop: exactly one down action', downs.length === 1);
  check('stop: no down before the threshold', downs[0]?.at === growthAt + 30 * MIN);
  check('stop: downSince == last growth time', downs[0]?.downSince === growthAt);
  check('stop: state is serverDown', d.state.serverDown === true);
  check(
    'stop: no repeat alerts inside the re-alert window',
    d.actions.filter((a) => a.kind === 'still-down').length === 0
  );
  check('stop: logAgeSec keeps climbing', logAgeSec(d.state, growthAt + 60 * MIN) === 3600);
}

// --- 3. Long outage: re-alert at most every 6h -----------------------------
{
  const d = driver();
  d.feed(T0, 1000);
  // Static for 24h, polled every 10 minutes.
  for (let i = 1; i <= 24 * 6; i++) d.feed(T0 + i * 10 * MIN, 1000);
  const downs = d.actions.filter((a) => a.kind === 'down');
  const repeats = d.actions.filter((a) => a.kind === 'still-down');
  check('outage: still exactly one initial down', downs.length === 1);
  // First alert at T+30m, then +6h each: 6:30, 12:30, 18:30 within 24h.
  check(`outage: 3 re-alerts in 24h (got ${repeats.length})`, repeats.length === 3);
  check(
    'outage: re-alerts are >= 6h apart',
    repeats.every((a, i) => a.at - (i === 0 ? downs[0].at : repeats[i - 1].at) >= REALERT)
  );
  check('outage: downSince never drifts', repeats.every((a) => a.downSince === downs[0].downSince));
}

// --- 4. Recovery: growth after a down fires exactly one 'recovered' --------
{
  const d = driver();
  d.feed(T0, 1000);
  for (let i = 1; i <= 6; i++) d.feed(T0 + i * 10 * MIN, 1000); // down at T+30m
  d.feed(T0 + 70 * MIN, 1200); // log grows again
  d.feed(T0 + 80 * MIN, 1400);
  const rec = d.actions.filter((a) => a.kind === 'recovered');
  check('recovery: exactly one recovered action', rec.length === 1);
  check('recovery: recovered fires on the growing poll', rec[0]?.at === T0 + 70 * MIN);
  check('recovery: downForSec measured from downSince', rec[0]?.downForSec === 70 * 60);
  check('recovery: state clears', d.state.serverDown === false && d.state.downSince === null);
  check('recovery: a later stall can fire down again', (() => {
    for (let i = 1; i <= 5; i++) d.feed(T0 + 80 * MIN + i * 10 * MIN, 1400);
    return d.actions.filter((a) => a.kind === 'down').length === 2;
  })());
}

// --- 5. Truncation = server restart = alive --------------------------------
{
  const d = driver();
  d.feed(T0, 500000);
  for (let i = 1; i <= 6; i++) d.feed(T0 + i * 10 * MIN, 500000); // goes down
  check('truncate: went down first', d.state.serverDown === true);
  d.feed(T0 + 65 * MIN, 900); // log truncated on restart — SMALLER, but alive
  check('truncate: shrink counts as growth (recovered)', d.actions.at(-1)?.kind === 'recovered');
  check('truncate: serverDown cleared', d.state.serverDown === false);
}

// --- 6. Failed observation (SFTP down) must NOT advance anything -----------
{
  const d = driver();
  d.feed(T0, 1000);
  d.feed(T0 + 10 * MIN, 1500);
  const before = { ...d.state };
  for (let i = 1; i <= 12; i++) d.feed(T0 + 10 * MIN + i * 10 * MIN, undefined, { ok: false });
  check('sftp-down: no actions emitted', d.actions.length === 0);
  check('sftp-down: state untouched', JSON.stringify(d.state) === JSON.stringify(before));
  // ...and once SFTP returns with a still-static log, the clock resumes from
  // the real last-growth time, so the outage is detected immediately.
  const r = d.feed(T0 + 130 * MIN, 1500);
  check('sftp-down: detection fires on the first successful poll after', r.action?.kind === 'down');
  check('sftp-down: downSince is the pre-outage growth time', r.action?.downSince === T0 + 10 * MIN);
}

// --- 7. Restart continuity: persisted state keeps the clock running --------
{
  // The poller restarts after the server has already been dead for 2h. The
  // staleness clock must NOT restart from zero.
  const persisted = {
    lastSize: 1000,
    lastMtimeMs: T0,
    lastGrowthAt: T0,
    serverDown: false,
    downSince: null,
    lastAlertAt: null,
  };
  const d = driver(persisted);
  const r = d.feed(T0 + 120 * MIN, 1000, { mtimeMs: T0 });
  check('restart: down fires on the very first poll after restart', r.action?.kind === 'down');
  check('restart: downSince preserved from persisted state', r.action?.downSince === T0);
}

// --- 8. Cold start with no persisted state seeds from mtime ----------------
{
  const d = driver();
  // Fresh state.json, but the remote log's mtime says it last grew 3h ago.
  const r = d.feed(T0 + 180 * MIN, 1000, { mtimeMs: T0 });
  check('cold start: seeds the clock from remote mtime, fires immediately', r.action?.kind === 'down');
  check('cold start: downSince == mtime', r.action?.downSince === T0);

  // Without a usable mtime, a cold start must NOT insta-alert; it waits.
  const d2 = driver();
  const r2 = d2.feed(T0, 1000);
  check('cold start: no mtime => no alert on the first poll', r2.action === null);
  check('cold start: still alerts once the threshold elapses', d2.feed(T0 + 31 * MIN, 1000).action?.kind === 'down');
}

// --- 9. Skewed remote clock (mtime in the future) is clamped ---------------
{
  const d = driver();
  const r = d.feed(T0, 1000, { mtimeMs: T0 + 365 * 24 * 60 * MIN });
  check('skew: future mtime clamped to now (no negative age)', r.logAgeSec === 0 && r.action === null);
}

// --- 10. mtime advancing with an unchanged size counts as growth -----------
{
  const d = driver();
  d.feed(T0, 1000, { mtimeMs: T0 });
  for (let i = 1; i <= 6; i++) d.feed(T0 + i * 10 * MIN, 1000, { mtimeMs: T0 });
  check('mtime: went down on a static log', d.state.serverDown === true);
  const r = d.feed(T0 + 65 * MIN, 1000, { mtimeMs: T0 + 64 * MIN });
  check('mtime: mtime bump alone recovers', r.action?.kind === 'recovered');
}

// --- 11. Formatting helpers ------------------------------------------------
{
  check('formatDuration: seconds', formatDuration(45) === '45s');
  check('formatDuration: minutes', formatDuration(30 * 60) === '30m');
  check('formatDuration: hours+minutes', formatDuration(90 * 60) === '1h 30m');
  check('formatDuration: days', formatDuration(5 * 24 * 3600) === '5d');
  check('formatDuration: bad input is safe', formatDuration(null) === 'an unknown time');
  check('formatWhen: has both zones', /UTC \(\d\d:\d\d CT\)$/.test(formatWhen(T0)));
  check('formatWhen: bad input is safe', formatWhen(null) === 'an unknown time');
}

// --- 12. normalizeLiveness tolerates junk ----------------------------------
{
  const n = normalizeLiveness({ lastSize: 'nope', serverDown: 'yes', downSince: NaN });
  check(
    'normalize: junk becomes nulls/false',
    n.lastSize === null && n.serverDown === false && n.downSince === null
  );
  check('normalize: undefined input is safe', normalizeLiveness(undefined).lastGrowthAt === null);
  check('normalize: null age reports null', logAgeSec(null, T0) === null);
}

for (const [label, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${label}`);
console.log(ok ? '\nLIVENESS OK' : '\nLIVENESS FAILED');
process.exit(ok ? 0 : 1);
