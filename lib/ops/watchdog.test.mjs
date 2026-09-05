// Unit tests for the off-PC watchdog: threshold sanity, evaluation states,
// alert/suppress/re-alert/recover decisions, and message formatting.
// Run: npx tsx lib/ops/watchdog.test.mjs
import assert from 'node:assert';
import {
  WATCHDOG_TARGETS,
  PING_INTERVAL_SEC,
  RE_ALERT_AFTER_SEC,
  DISCORD_MAX_CONTENT,
  evaluateWatchdog,
  decideAlert,
  formatAlertMessage,
  formatRecoveryMessage,
  formatAge,
} from './watchdog.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const NOW = Date.parse('2026-08-21T12:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

/** Minimal ops_heartbeats row. */
const hb = (component, { lastSuccess = ago(30), status = 'ok', error = null } = {}) => ({
  component,
  instance: 'host',
  version: '1.0.0',
  status,
  last_success: lastSuccess,
  last_attempt: lastSuccess,
  error_summary: error,
  metrics: {},
  updated_at: lastSuccess,
});

/** Every reporting component fresh + a fresh online server. */
const FRESH = () => ({
  'discord-bot': hb('discord-bot'),
  'log-poller': hb('log-poller'),
  'map-snapshot': hb('map-snapshot'),
  'boards-plugin': hb('boards-plugin'),
  'companion-voice': hb('companion-voice'),
});

const allHealthy = (over = {}) =>
  evaluateWatchdog({
    nowMs: NOW,
    heartbeats: FRESH(),
    serverStatusUpdatedAt: ago(60),
    serverIsOnline: true,
    ...over,
  });

const find = (evaluation, key) => evaluation.checks.find((c) => c.key === key);

// ── Threshold sanity: never tighter than the poll interval ────────────────
{
  ok(WATCHDOG_TARGETS.length === 6, 'three host processes + two in-game plugins + the game server are watched');
  for (const t of WATCHDOG_TARGETS) {
    ok(
      t.staleAfterSec > PING_INTERVAL_SEC,
      `${t.key} threshold (${t.staleAfterSec}s) exceeds the ${PING_INTERVAL_SEC}s ping interval`,
    );
    ok(t.staleAfterSec > t.cadenceSec * 3, `${t.key} tolerates several missed ticks`);
  }
  for (const key of ['discord-bot', 'log-poller', 'map-snapshot', 'boards-plugin', 'companion-voice', 'game-server']) {
    ok(WATCHDOG_TARGETS.some((t) => t.key === key), `${key} is watched`);
  }
  // The retired eilif-stats-parser.service (2026-08-23) came off the registry on
  // 2026-09-05, following lib/ops/health.ts. It is off the heartbeat allowlist,
  // so it can never report again — a target for it could only ever be noise.
  ok(!WATCHDOG_TARGETS.some((t) => t.key === 'stats-parser'), 'stats-parser is no longer watched');
  // Exactly one target is excused from alerting on silence, and it is the one
  // that only reports while somebody is playing.
  const quiet = WATCHDOG_TARGETS.filter((t) => t.alertsOnSilence === false).map((t) => t.key);
  ok(quiet.length === 1 && quiet[0] === 'companion-voice', 'only companion-voice is quiet by design');
}

// ── Evaluation: everything fresh → ok ─────────────────────────────────────
{
  const e = allHealthy();
  ok(e.ok === true, 'all fresh → ok');
  ok(e.unhealthy.length === 0, 'nothing unhealthy');
  ok(e.signature === '', 'healthy signature is empty');
  ok(e.neverReported.length === 0, 'nothing marked never-reported');
  ok(find(e, 'game-server').state === 'healthy', 'fresh server_status → healthy');
}

// ── Never reported is NOT an alert ────────────────────────────────────────
// A plugin whose route-recorded heartbeat has not shipped to the GTX box yet
// looks exactly like a dead one; with zero data we refuse to guess.
{
  const heartbeats = FRESH();
  delete heartbeats['boards-plugin']; // row absent entirely
  const e = evaluateWatchdog({
    nowMs: NOW,
    heartbeats,
    serverStatusUpdatedAt: ago(60),
    serverIsOnline: true,
  });
  ok(e.ok === true, 'a component that never reported does not trip the watchdog');
  ok(find(e, 'boards-plugin').state === 'unknown', 'missing row → unknown');
  ok(find(e, 'boards-plugin').unhealthy === false, 'unknown never alerts');
  ok(e.neverReported.includes('boards-plugin'), 'never-reported is surfaced in the summary');

  // A row that exists but has never had a success is the same case.
  const e2 = evaluateWatchdog({
    nowMs: NOW,
    heartbeats: { 'boards-plugin': hb('boards-plugin', { lastSuccess: null, status: 'error' }) },
    serverStatusUpdatedAt: ago(60),
    serverIsOnline: true,
  });
  ok(find(e2, 'boards-plugin').state === 'unknown', 'row with no last_success → unknown');
  ok(find(e2, 'boards-plugin').unhealthy === false, 'no success yet → still not an alert');
}

// ── The two in-game plugins ───────────────────────────────────────────────
// boards-plugin polls /api/boards on a timer whether or not anybody is playing,
// so its silence is a real signal — and the only one there is, because a 401
// after a token rotation just freezes the signs. companion-voice polls
// /api/voice only while players are online, so an empty hall silences it by
// design and the watchdog must not page about that.
{
  const boardsDown = allHealthy({
    heartbeats: { ...FRESH(), 'boards-plugin': hb('boards-plugin', { lastSuccess: ago(3 * 3600) }) },
  });
  ok(find(boardsDown, 'boards-plugin').state === 'stale', 'a silent boards plugin is stale');
  ok(find(boardsDown, 'boards-plugin').unhealthy === true, 'and it alerts — frozen signs are invisible otherwise');
  ok(boardsDown.signature === 'boards-plugin:stale', 'the signature names it');

  const hallEmpty = allHealthy({
    heartbeats: { ...FRESH(), 'companion-voice': hb('companion-voice', { lastSuccess: ago(3 * 3600) }) },
  });
  const voice = find(hallEmpty, 'companion-voice');
  ok(voice.state === 'stale', 'a silent voice half is still REPORTED as stale');
  ok(voice.unhealthy === false, 'but silence never alerts — an empty hall looks identical');
  ok(hallEmpty.ok === true, 'so a quiet hall alone leaves the watchdog happy');
  ok(/empty hall/.test(voice.detail), 'and the detail says why it is not an alert');
  ok(voice.ageSec !== null, 'the age is still reported for anyone investigating');

  // Silence is excused; a beat that arrives and says it errored is not.
  const voiceErrored = allHealthy({
    heartbeats: { ...FRESH(), 'companion-voice': hb('companion-voice', { status: 'error', error: 'voice token rejected' }) },
  });
  ok(find(voiceErrored, 'companion-voice').state === 'degraded', 'a fresh erroring beat → degraded');
  ok(find(voiceErrored, 'companion-voice').unhealthy === true, 'and degraded still alerts');
}

// ── Once it HAS reported, silence alerts ──────────────────────────────────
{
  const e = allHealthy({
    heartbeats: { ...FRESH(), 'log-poller': hb('log-poller', { lastSuccess: ago(3 * 3600) }) },
  });
  ok(e.ok === false, 'a stale producer trips the watchdog');
  ok(find(e, 'log-poller').state === 'stale', 'silent producer → stale');
  ok(e.signature === 'log-poller:stale', 'signature names the failing component');
  ok(/3\.0h/.test(find(e, 'log-poller').detail), 'detail states how long it has been silent');
}

// ── Boundary: just inside vs just outside the window ──────────────────────
{
  const t = WATCHDOG_TARGETS.find((x) => x.key === 'discord-bot');
  const inside = allHealthy({
    heartbeats: { 'discord-bot': hb('discord-bot', { lastSuccess: ago(t.staleAfterSec - 60) }) },
  });
  ok(find(inside, 'discord-bot').state === 'healthy', 'just inside the window → healthy');
  const outside = allHealthy({
    heartbeats: { 'discord-bot': hb('discord-bot', { lastSuccess: ago(t.staleAfterSec + 60) }) },
  });
  ok(find(outside, 'discord-bot').unhealthy === true, 'just past the window → alerts');
}

// ── Fresh but self-reported error → degraded, and it alerts ───────────────
{
  const e = allHealthy({
    heartbeats: { ...FRESH(), 'discord-bot': hb('discord-bot', { status: 'error', error: 'gateway closed' }) },
  });
  ok(find(e, 'discord-bot').state === 'degraded', 'fresh beat reporting error → degraded');
  ok(e.ok === false, 'degraded producer alerts');
  ok(/gateway closed/.test(find(e, 'discord-bot').detail), 'the reported error is quoted');
}

// ── Game server: stale server_status, and the offline flag ────────────────
{
  const stale = allHealthy({ serverStatusUpdatedAt: ago(6 * 24 * 3600) });
  ok(find(stale, 'game-server').state === 'stale', 'six-day-old server_status → stale');
  ok(stale.ok === false, 'a dead game server alerts');
  ok(/6d/.test(find(stale, 'game-server').detail), 'the outage length is stated');

  const offline = allHealthy({ serverIsOnline: false });
  ok(find(offline, 'game-server').unhealthy === true, 'fresh-but-offline server alerts');
  ok(find(offline, 'game-server').state === 'degraded', 'fresh + is_online false → degraded');

  const never = allHealthy({ serverStatusUpdatedAt: null });
  ok(find(never, 'game-server').state === 'unknown', 'never-written server_status → unknown');
  ok(never.ok === true, 'never-written server_status does not alert');
}

// ── Alert decisions ───────────────────────────────────────────────────────
const unhealthy = allHealthy({
  heartbeats: { ...FRESH(), 'log-poller': hb('log-poller', { lastSuccess: ago(3 * 3600) }) },
});
const healthy = allHealthy();

{
  // 1. First transition (no prior row at all).
  const d = decideAlert(unhealthy, null, NOW);
  ok(d.action === 'alert' && d.reason === 'first-unhealthy', 'ok → unhealthy alerts');
  ok(d.next.state === 'alerting', 'state flips to alerting');
  ok(d.next.signature === unhealthy.signature, 'signature recorded');
  ok(d.next.alertCount === 1, 'alert counted');
  ok(d.next.since === new Date(NOW).toISOString(), 'episode start recorded');

  // 2. Same problem, 1h later → suppressed.
  const prior = d.next;
  const later = NOW + 3600 * 1000;
  const d2 = decideAlert(unhealthy, prior, later);
  ok(d2.action === 'none' && d2.reason === 'suppressed', 'repeat run inside 6h stays quiet');
  ok(d2.next.lastAlertAt === prior.lastAlertAt, 'suppression does not move the alert clock');
  ok(d2.next.since === prior.since, 'suppression preserves the episode start');
  ok(d2.nextAlertEligibleAt === new Date(NOW + RE_ALERT_AFTER_SEC * 1000).toISOString(),
    'next eligible time is 6h after the last alert');

  // 3. Same problem, just past 6h → re-alert, episode start preserved.
  const d3 = decideAlert(unhealthy, prior, NOW + (RE_ALERT_AFTER_SEC + 60) * 1000);
  ok(d3.action === 'alert' && d3.reason === 're-alert', 're-alerts after 6h of the same problem');
  ok(d3.next.since === prior.since, 're-alert keeps the original episode start');
  ok(d3.next.alertCount === 2, 're-alert increments the count');

  // 3b. Exactly at the boundary re-alerts.
  const d3b = decideAlert(unhealthy, prior, NOW + RE_ALERT_AFTER_SEC * 1000);
  ok(d3b.action === 'alert', 'exactly 6h is eligible');

  // 4. A DIFFERENT thing breaks while alerting → alert immediately.
  const worse = allHealthy({
    heartbeats: {
      ...FRESH(),
      'log-poller': hb('log-poller', { lastSuccess: ago(3 * 3600) }),
      'map-snapshot': hb('map-snapshot', { lastSuccess: ago(3 * 3600) }),
    },
  });
  const d4 = decideAlert(worse, prior, NOW + 600 * 1000);
  ok(d4.action === 'alert' && d4.reason === 'signature-changed', 'a new failure re-alerts inside 6h');

  // 5. Recovery, exactly once.
  const d5 = decideAlert(healthy, prior, NOW + 7200 * 1000);
  ok(d5.action === 'recover' && d5.reason === 'recovered', 'unhealthy → healthy posts the all-clear');
  ok(d5.next.state === 'ok' && d5.next.signature === null, 'state clears on recovery');
  const d6 = decideAlert(healthy, d5.next, NOW + 8000 * 1000);
  ok(d6.action === 'none' && d6.reason === 'healthy', 'recovery is posted only once');

  // 6. Healthy with no prior row → silence (a fresh deploy must not chirp).
  ok(decideAlert(healthy, null, NOW).action === 'none', 'healthy with no prior state says nothing');

  // 7. Alerting row with a missing lastAlertAt still alerts (no silent stall).
  const d7 = decideAlert(unhealthy, { ...prior, lastAlertAt: null }, NOW + 60_000);
  ok(d7.action === 'alert' && d7.reason === 're-alert', 'missing last_alert_at re-alerts rather than hanging');
}

// ── Message formatting ────────────────────────────────────────────────────
{
  const d = decideAlert(unhealthy, null, NOW);
  const msg = formatAlertMessage(unhealthy, d, { dashboardUrl: 'https://example.test/admin/ops' });
  ok(msg.includes('Log poller'), 'alert names the failing component');
  ok(msg.includes('1 check unhealthy'), 'alert counts the failures');
  ok(msg.includes('https://example.test/admin/ops'), 'alert links the cockpit');
  ok(msg.includes('checked 2026-08-21T12:00:00.000Z'), 'alert states when it checked');
  ok(msg.length <= DISCORD_MAX_CONTENT, 'alert fits in one Discord message');
  ok(msg.split('\n').length <= 6, 'alert stays concise');
  ok(!msg.includes('@'), 'no ping unless a mention is configured');

  const pinged = formatAlertMessage(unhealthy, d, { mention: '<@42>' });
  ok(pinged.startsWith('<@42> '), 'configured mention leads the message');

  // Worst case: everything down at once still fits.
  const allDown = evaluateWatchdog({
    nowMs: NOW,
    heartbeats: Object.fromEntries(
      Object.keys(FRESH()).map((k) => [
        k,
        hb(k, { lastSuccess: ago(9 * 24 * 3600), status: 'error', error: 'x'.repeat(200) }),
      ]),
    ),
    serverStatusUpdatedAt: ago(9 * 24 * 3600),
    serverIsOnline: false,
  });
  ok(allDown.unhealthy.length === 5, 'everything down flags every alerting check plus the server');
  ok(
    !allDown.unhealthy.some((c) => c.key === 'companion-voice'),
    'and the quiet-by-design check stays out of the alert even when it is down with everything else',
  );
  const big = formatAlertMessage(allDown, decideAlert(allDown, null, NOW), {
    dashboardUrl: 'https://example.test/admin/ops',
  });
  ok(big.length <= DISCORD_MAX_CONTENT, 'worst-case alert still fits in one message');

  const rec = formatRecoveryMessage(
    healthy,
    { state: 'alerting', signature: 'log-poller:stale', since: ago(3 * 3600), lastAlertAt: ago(3 * 3600), alertCount: 1 },
    NOW,
    { dashboardUrl: 'https://example.test/admin/ops' },
  );
  ok(rec.includes('all clear'), 'recovery says all clear');
  ok(rec.includes('log-poller'), 'recovery names what recovered');
  ok(rec.includes('3.0h'), 'recovery states how long it was down');
  ok(rec.length <= DISCORD_MAX_CONTENT, 'recovery fits in one Discord message');
}

// ── formatAge ─────────────────────────────────────────────────────────────
{
  ok(formatAge(null) === 'never', 'null age → never');
  ok(formatAge(45) === '45s', 'seconds');
  ok(formatAge(600) === '10m', 'minutes');
  ok(formatAge(3 * 3600) === '3.0h', 'hours');
  ok(formatAge(6 * 24 * 3600) === '6d', 'days');
}

console.log(`watchdog.test: ${passed} assertions passed`);
