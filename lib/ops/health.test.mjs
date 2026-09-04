// Unit tests for computeState freshness boundaries + buildHealth mapping.
// Run: npx tsx lib/ops/health.test.mjs
import assert from 'node:assert';
import { computeState, buildHealth, COMPONENTS } from './health.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const NOW = Date.parse('2026-07-11T12:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

// ── computeState boundaries ───────────────────────────────────────────────
{
  const staleAfter = 300;
  ok(computeState(NOW, NOW - 10_000, staleAfter) === 'healthy', 'fresh → healthy');
  ok(computeState(NOW, NOW - 299_000, staleAfter) === 'healthy', 'just inside window → healthy');
  ok(computeState(NOW, NOW - 301_000, staleAfter) === 'stale', 'past window → stale');
  ok(computeState(NOW, null, staleAfter) === 'unknown', 'no lastSuccess → unknown');
  ok(computeState(NOW, null, staleAfter, { disabled: true }) === 'disabled', 'disabled wins over unknown');
  ok(computeState(NOW, NOW - 10_000, staleAfter, { disabled: true }) === 'disabled', 'disabled wins over healthy');
  ok(computeState(NOW, NOW - 10_000, staleAfter, { errored: true }) === 'degraded', 'fresh+errored → degraded');
  ok(computeState(NOW, NOW - 301_000, staleAfter, { errored: true }) === 'stale', 'stale beats errored');
}

const find = (reports, key) => reports.find((r) => r.key === key);

// ── buildHealth: core liveness ────────────────────────────────────────────
{
  const reports = buildHealth({
    nowMs: NOW,
    supabaseOk: true,
    dashboardVersion: '3a3daba',
    serverStatusUpdatedAt: ago(30),
    heartbeats: {},
  });
  ok(find(reports, 'dashboard-api').state === 'healthy', 'dashboard-api always healthy when rendered');
  ok(find(reports, 'dashboard-api').version === '3a3daba', 'dashboard version surfaced');
  ok(find(reports, 'supabase').state === 'healthy', 'supabase healthy when ok');
  ok(find(reports, 'server-emitter').state === 'healthy', 'emitter healthy from fresh server_status');
  ok(find(reports, 'server-emitter').version === null, 'emitter has no version (third-party)');
  // No heartbeats → pipeline procs unknown (never assume healthy)
  ok(find(reports, 'log-poller').state === 'unknown', 'no heartbeat → unknown, not healthy');
  ok(find(reports, 'map-snapshot').state === 'unknown', 'no map heartbeat → unknown');
}

// ── buildHealth: supabase down → degraded + everything unknown ────────────
{
  const reports = buildHealth({
    nowMs: NOW,
    supabaseOk: false,
    dashboardVersion: null,
    serverStatusUpdatedAt: ago(30),
    heartbeats: {},
  });
  ok(find(reports, 'supabase').state === 'degraded', 'supabase down → degraded');
  ok(find(reports, 'dashboard-api').state === 'healthy', 'dashboard still healthy (page rendered)');
  ok(find(reports, 'server-emitter').state === 'unknown', 'emitter unknown when db down');
  ok(find(reports, 'log-poller').state === 'unknown', 'poller unknown when db down');
  ok(find(reports, 'dashboard-api').version === null, 'absent commit → null version (honest)');
}

// ── buildHealth: heartbeat-sourced states ─────────────────────────────────
{
  const reports = buildHealth({
    nowMs: NOW,
    supabaseOk: true,
    dashboardVersion: 'v1',
    serverStatusUpdatedAt: ago(1000), // stale emitter
    heartbeats: {
      'log-poller': { component: 'log-poller', instance: 'h', version: 'p1', status: 'ok', last_success: ago(30), last_attempt: ago(30), error_summary: null, metrics: {}, updated_at: ago(30) },
      'discord-bot': { component: 'discord-bot', instance: 'h', version: 'b1', status: 'error', last_success: ago(20), last_attempt: ago(5), error_summary: 'boom', metrics: { loops: { 'events-sync': { enabled: true, lastSuccessAt: ago(60) }, 'gallery-ingest': { enabled: false }, 'voice-queue': { enabled: true, lastError: 'queue jam', lastSuccessAt: ago(30) } }, flags: { recapPilotChannel: true } }, updated_at: ago(5) },
      'map-snapshot': { component: 'map-snapshot', instance: 'h', version: 'm1', status: 'ok', last_success: ago(4000), last_attempt: ago(4000), error_summary: null, metrics: {}, updated_at: ago(4000) },
    },
  });
  ok(find(reports, 'log-poller').state === 'healthy', 'fresh ok poller → healthy');
  ok(find(reports, 'server-emitter').state === 'stale', 'stale server_status → emitter stale');
  ok(find(reports, 'discord-bot').state === 'degraded', 'fresh error bot → degraded');
  ok(find(reports, 'discord-bot').lastError === 'boom', 'bot error surfaced');
  ok(find(reports, 'discord-bot').flags.some((f) => f.label === 'recapPilotChannel'), 'bot flags surfaced');
  ok(find(reports, 'map-snapshot').state === 'stale', 'old map success → stale');
  // Sub-loops derived from bot metrics
  ok(find(reports, 'events-sync').state === 'healthy', 'events-sync loop healthy');
  ok(find(reports, 'gallery-ingest').state === 'disabled', 'gallery-ingest disabled flag honored');
  ok(find(reports, 'voice-queue').state === 'degraded', 'voice-queue with lastError → degraded');
  ok(find(reports, 'title-evaluator').state === 'unknown', 'loop not reported → unknown');
}

// ── buildHealth: no bot heartbeat → all sub-loops unknown ─────────────────
{
  const reports = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30), heartbeats: {},
  });
  for (const k of ['events-sync', 'gallery-ingest', 'voice-queue', 'title-evaluator', 'milestone-evaluator']) {
    ok(find(reports, k).state === 'unknown', `${k} unknown with no bot heartbeat`);
  }
}

// ── buildHealth against a REAL discord-bot heartbeat row ──────────────────
//
// Copied from the live ops_heartbeats row (2026-09-03), which is where both bugs
// showed: the bot sends `metrics.subLoops` (this file read `metrics.loops`,
// which nothing has ever written) and it files each loop's ENABLED flag under
// the hyphenated name while `safe()` files the RUN RESULT under a shorter one
// ('voice', 'titles', 'milestones', 'events'). Result before the fix: every
// sub-loop rendered "unknown — The bot heartbeat did not report this loop".
{
  const reports = buildHealth({
    nowMs: NOW,
    supabaseOk: true,
    dashboardVersion: 'v1',
    serverStatusUpdatedAt: ago(30),
    heartbeats: {
      'discord-bot': {
        component: 'discord-bot', instance: 'h', version: 'b1', status: 'ok',
        last_success: ago(30), last_attempt: ago(30), error_summary: null,
        metrics: {
          subLoops: {
            relay: { enabled: true, ok: true, lastRunAt: ago(10), error: null },
            bosses: { enabled: true, ok: true, lastRunAt: ago(20), error: null },
            'events-sync': { enabled: true },
            'gallery-ingest': { enabled: false },
            'voice-queue': { enabled: true },
            'title-evaluator': { enabled: true },
            'milestone-evaluator': { enabled: true },
          },
          // The three pilot flags the bot really sends, at the TOP level under
          // their own names (lib/ops/db extractBotFlags is what reads these).
          recapChannelIsServer: true,
          milestoneChannelIsServer: true,
          recapsStartPulledForward: true,
        },
        updated_at: ago(30),
      },
      // The bot ALSO files run results under the short labels when it is fixed
      // host-side; the alias merge must pick those up without a code change here.
      'log-poller': { component: 'log-poller', instance: 'h', version: 'p1', status: 'ok', last_success: ago(30), last_attempt: ago(30), error_summary: null, metrics: {}, updated_at: ago(30) },
    },
  });
  ok(find(reports, 'relay').state === 'healthy', 'subLoops is read (relay healthy from its lastRunAt)');
  ok(find(reports, 'bosses').state === 'healthy', 'bosses healthy');
  ok(find(reports, 'gallery-ingest').state === 'disabled', 'an off loop still reads as disabled');
  // These three are ENABLED but carry no tick result, because the bot files it
  // under another label. Honest answer: not "unknown, never reported" — we know
  // it is on — but no success timestamp, so never green either.
  ok(find(reports, 'voice-queue').state === 'unknown', 'enabled-but-never-ticked is not green');
  ok(/has never recorded a tick result/.test(find(reports, 'voice-queue').detail), 'and the detail says why');
}

// The alias merge itself: a payload that files the run result under the SHORT
// label must light up the cockpit's hyphenated key.
{
  const reports = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: {
      'discord-bot': {
        component: 'discord-bot', instance: 'h', version: null, status: 'ok',
        last_success: ago(10), last_attempt: ago(10), error_summary: null,
        metrics: {
          subLoops: {
            'voice-queue': { enabled: true },
            voice: { ok: true, lastRunAt: ago(20) },
            'title-evaluator': { enabled: true },
            titles: { ok: false, lastRunAt: ago(20), error: 'titles API 500' },
          },
        },
        updated_at: ago(10),
      },
    },
  });
  ok(find(reports, 'voice-queue').state === 'healthy', "the short 'voice' label merges into voice-queue");
  ok(find(reports, 'title-evaluator').state === 'degraded', "ok:false on 'titles' → title-evaluator degraded");
  ok(find(reports, 'title-evaluator').lastError === 'titles API 500', 'and its error is surfaced');
}

// ── the retired stats-parser is gone from the model ───────────────────────
// eilif-stats-parser.service was retired 2026-08-23; its ops_heartbeats row is
// still in the database (deleting rows is Charlie's call) and would otherwise
// render a permanently STALE component, which is what kept /admin/ops red.
{
  ok(!COMPONENTS.some((c) => c.key === 'stats-parser'), 'stats-parser is no longer a component');
  const reports = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: {
      'stats-parser': { component: 'stats-parser', instance: 'h', version: 's1', status: 'ok', last_success: ago(970000), last_attempt: ago(970000), error_summary: null, metrics: {}, updated_at: ago(970000) },
    },
  });
  ok(!reports.some((r) => r.key === 'stats-parser'), 'and its stale row is simply not read');
}

// ── the two in-game plugins ───────────────────────────────────────────────
// Neither can POST a heartbeat; their rows are written by the routes they poll
// (lib/ops/route-heartbeat). A fresh authed poll = healthy; silence = stale,
// which is the signal that used to exist nowhere but the GTX log file.
{
  const reports = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: {
      'boards-plugin': { component: 'boards-plugin', instance: null, version: null, status: 'ok', last_success: ago(40), last_attempt: ago(40), error_summary: null, metrics: { lastPoll: ago(40) }, updated_at: ago(40) },
      'companion-voice': { component: 'companion-voice', instance: null, version: null, status: 'ok', last_success: ago(3000), last_attempt: ago(3000), error_summary: null, metrics: {}, updated_at: ago(3000) },
    },
  });
  ok(find(reports, 'boards-plugin').state === 'healthy', 'a recent authed /api/boards poll → healthy');
  ok(find(reports, 'companion-voice').state === 'stale', 'no /api/voice poll for 50 min → stale');
}
{
  // Never green on absence: no poll ever recorded is 'unknown', not 'healthy'.
  const reports = buildHealth({ nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30), heartbeats: {} });
  ok(find(reports, 'boards-plugin').state === 'unknown', 'no boards poll ever → unknown');
  ok(find(reports, 'companion-voice').state === 'unknown', 'no voice poll ever → unknown');
}

// ── voice queue stalled: polling, but not speaking ────────────────────────
// The poll proves the Companion loaded. It does NOT prove it is speaking — a
// broken speak path or a stale token leaves lines queued while the polls keep
// coming. Ten minutes of a queued line WITH players online is the DB-derived
// second opinion, and it arrives on the component's own metrics (that is how
// lib/ops/db hands it over without the cockpit page needing to know).
{
  const fresh = (metrics) => ({
    component: 'companion-voice', instance: null, version: null, status: 'ok',
    last_success: ago(30), last_attempt: ago(30), error_summary: null, metrics, updated_at: ago(30),
  });
  const stalled = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: { 'companion-voice': fresh({ voiceQueueOldestSec: 15 * 60 }) },
  });
  ok(find(stalled, 'companion-voice').state === 'degraded', 'queued 15 min with players on → degraded');
  ok(/not speaking them/.test(find(stalled, 'companion-voice').detail), 'and says so plainly');

  const fine = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: { 'companion-voice': fresh({ voiceQueueOldestSec: 60 }) },
  });
  ok(find(fine, 'companion-voice').state === 'healthy', 'a minute-old queued line is normal');

  // Nobody online → lib/ops/db reports null and nothing is attached: a waiting
  // queue with an empty server is correct, not a fault.
  const empty = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: { 'companion-voice': fresh({}) },
  });
  ok(find(empty, 'companion-voice').state === 'healthy', 'no players online → no voice fault');

  // Passed explicitly (the path the cockpit page can use once it wires it up).
  const explicit = buildHealth({
    nowMs: NOW, supabaseOk: true, dashboardVersion: null, serverStatusUpdatedAt: ago(30),
    heartbeats: { 'companion-voice': fresh({}) },
    voiceQueueOldestSec: 20 * 60,
  });
  ok(find(explicit, 'companion-voice').state === 'degraded', 'the explicit input works too');
}

console.log(`health.test: ${passed} assertions passed`);
