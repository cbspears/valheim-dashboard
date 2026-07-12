// Unit tests for computeState freshness boundaries + buildHealth mapping.
// Run: npx tsx lib/ops/health.test.mjs
import assert from 'node:assert';
import { computeState, buildHealth } from './health.ts';

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

console.log(`health.test: ${passed} assertions passed`);
