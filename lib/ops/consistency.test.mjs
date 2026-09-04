// Unit tests for the consistency checks (stale open sessions, roster
// disagreement, missing migrations, pilot flags, empty state).
// Run: npx tsx lib/ops/consistency.test.mjs
import assert from 'node:assert';
import { runConsistencyChecks, extractBotFlags } from './consistency.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const NOW = Date.parse('2026-07-11T12:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

// A clean baseline: nothing should fire.
const clean = () => ({
  nowMs: NOW,
  serverStatusUpdatedAt: ago(30),
  serverCurrentPlayers: ['Astrid', 'Bjorn'],
  onlinePlayerNames: ['Astrid', 'Bjorn'],
  latestPresenceByName: { Astrid: { type: 'join', at: ago(60) }, Bjorn: { type: 'join', at: ago(90) } },
  openSessions: [{ character_name: 'Astrid', joined_at: ago(120) }],
  mapSnapshotLastSuccess: ago(120),
  unannouncedMilestones: [],
  unannouncedIdentityConfirmations: 0,
  expiredUnconsumedClaims: 0,
  statPoisonReporters: [],
  botFlags: { recapPilotChannel: false, milestonePilotChannel: false, recapsStartPulledForward: false },
  demoDiscordEvents: 0,
  tablePresence: { identity_claims: true, chat_lines: true, player_positions: true, ops_heartbeats: true },
});

const ids = (findings) => new Set(findings.map((f) => f.id));

// ── Empty/clean → no findings ─────────────────────────────────────────────
{
  const f = runConsistencyChecks(clean());
  ok(f.length === 0, `clean input yields nothing, got [${[...ids(f)].join(', ')}]`);
}

// ── Stale server_status → warn then critical ──────────────────────────────
{
  const i = clean(); i.serverStatusUpdatedAt = ago(15 * 60);
  ok(ids(runConsistencyChecks(i)).has('server-status-stale'), 'warns at 15m');
  const i2 = clean(); i2.serverStatusUpdatedAt = ago(40 * 60);
  const f2 = runConsistencyChecks(i2);
  ok(ids(f2).has('server-status-stale-critical'), 'critical at 40m');
  ok(f2[0].severity === 'critical', 'critical sorts first');
}

// ── Roster disagreement ───────────────────────────────────────────────────
{
  const i = clean(); i.onlinePlayerNames = ['Astrid']; // Bjorn only in emitter roster
  const f = runConsistencyChecks(i);
  ok(ids(f).has('roster-disagreement'), 'emitter vs online mismatch flagged');
  ok(f.find((x) => x.id === 'roster-disagreement').detail.includes('Bjorn'), 'names the disagreeing viking');
}

// ── Online without recent presence ────────────────────────────────────────
{
  const i = clean();
  i.latestPresenceByName = { Astrid: { type: 'leave', at: ago(60) }, Bjorn: undefined };
  const f = runConsistencyChecks(i);
  ok(ids(f).has('online-without-join'), 'online but latest event is leave/missing flagged');
}

// ── Stale open session (>6h) ──────────────────────────────────────────────
{
  const i = clean();
  i.openSessions = [{ character_name: 'Ghost', joined_at: ago(7 * 3600) }];
  const f = runConsistencyChecks(i);
  ok(ids(f).has('stale-open-sessions'), 'session open >6h flagged');
  ok(f.find((x) => x.id === 'stale-open-sessions').detail.includes('Ghost'), 'names the stuck session');
}
{
  const i = clean();
  i.openSessions = [{ character_name: 'Fresh', joined_at: ago(3600) }]; // 1h, fine
  ok(!ids(runConsistencyChecks(i)).has('stale-open-sessions'), '1h open session not flagged');
}

// ── Missing migration table → critical ────────────────────────────────────
{
  const i = clean(); i.tablePresence.ops_heartbeats = false;
  const f = runConsistencyChecks(i);
  ok(ids(f).has('missing-migrations'), 'missing table flagged');
  ok(f[0].severity === 'critical', 'missing migration is critical, sorts first');
  ok(f.find((x) => x.id === 'missing-migrations').detail.includes('ops_heartbeats'), 'names missing table');
}

// ── Pilot flags still on → warn ───────────────────────────────────────────
{
  const i = clean(); i.botFlags = { recapPilotChannel: true, milestonePilotChannel: true };
  const f = runConsistencyChecks(i);
  ok(ids(f).has('pilot-flags-enabled'), 'pilot flags flagged');
}
{
  const i = clean(); i.botFlags = null; // bot didn't report → no flag
  ok(!ids(runConsistencyChecks(i)).has('pilot-flags-enabled'), 'no bot flags → no pilot finding');
}

// ── Unannounced milestones + stat poison + demo data + expired claims ─────
{
  const i = clean();
  i.unannouncedMilestones = [{ title: 'The First Marathon' }];
  i.statPoisonReporters = ['Chaerlie'];
  i.demoDiscordEvents = 3;
  i.expiredUnconsumedClaims = 2;
  i.unannouncedIdentityConfirmations = 1;
  const s = ids(runConsistencyChecks(i));
  ok(s.has('unannounced-milestones'), 'unannounced milestone flagged');
  ok(s.has('stat-poison-flags'), 'stat poison flagged');
  ok(s.has('demo-data-present'), 'demo data flagged');
  ok(s.has('expired-claims'), 'expired claims flagged');
  ok(s.has('unannounced-identities'), 'unannounced identities flagged');
}

// ── Stale map snapshot ────────────────────────────────────────────────────
{
  const i = clean(); i.mapSnapshotLastSuccess = ago(45 * 60);
  ok(ids(runConsistencyChecks(i)).has('map-snapshot-stale'), 'stale map snapshot flagged');
  const i2 = clean(); i2.mapSnapshotLastSuccess = null;
  ok(ids(runConsistencyChecks(i2)).has('map-snapshot-missing'), 'missing map snapshot flagged');
}

// ── extractBotFlags reads what the bot ACTUALLY sends ─────────────────────
//
// This is the half that was broken. The cockpit looked for
// `metrics.flags.recapPilotChannel`; the bot has never sent a `flags` object at
// all — it puts three differently-named booleans at the TOP level of metrics
// (services/discord-bot/src/index.js ~240-242). So botFlags was always null and
// checkPilotFlags could never fire: /admin/ops was structurally incapable of
// warning that the pilot channel overrides were still on, which is exactly the
// launch-day item it exists to catch.
{
  // Verbatim shape of the live discord-bot heartbeat metrics (2026-09-03).
  const flags = extractBotFlags({
    subLoops: { relay: { enabled: true, ok: true } },
    recapChannelIsServer: true,
    milestoneChannelIsServer: true,
    recapsStartPulledForward: true,
    timerCount: 7,
  });
  ok(flags !== null, 'the real heartbeat shape yields flags at all');
  ok(flags.recapPilotChannel === true, 'recapChannelIsServer → recapPilotChannel');
  ok(flags.milestonePilotChannel === true, 'milestoneChannelIsServer → milestonePilotChannel');
  ok(flags.recapsStartPulledForward === true, 'recapsStartPulledForward passes through');

  // …and end to end: those flags now reach the finding.
  const i = clean();
  i.botFlags = flags;
  const f = runConsistencyChecks(i);
  ok(ids(f).has('pilot-flags-enabled'), 'live bot metrics now raise the pilot-flags finding');
}
{
  // Reverted to launch values → all three false → no finding (but still not null:
  // "the bot reported, and everything is clear" is different from "no report").
  const flags = extractBotFlags({
    recapChannelIsServer: false,
    milestoneChannelIsServer: false,
    recapsStartPulledForward: false,
  });
  ok(flags !== null && flags.recapPilotChannel === false, 'a clear report is a report');
  const i = clean();
  i.botFlags = flags;
  ok(!ids(runConsistencyChecks(i)).has('pilot-flags-enabled'), 'reverted overrides raise nothing');
}
{
  // The nested shape the cockpit used to expect still works, in case the bot is
  // ever changed to match the docs.
  const flags = extractBotFlags({ flags: { recapPilotChannel: true } });
  ok(flags !== null && flags.recapPilotChannel === true, 'the legacy nested shape is still accepted');
}
{
  // Nothing recognisable → null, so the cockpit says "unknown" rather than
  // rendering three confident "false"s as an all-clear.
  ok(extractBotFlags({ subLoops: {}, timerCount: 3 }) === null, 'metrics with no flags at all → null');
  ok(extractBotFlags(null) === null, 'no metrics → null');
  ok(extractBotFlags({ recapChannelIsServer: 'yes' }) === null, 'a non-boolean is not a flag');
}

console.log(`consistency.test: ${passed} assertions passed`);
