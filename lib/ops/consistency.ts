// Cross-checks over the live data — PURE (data in → findings out).
//
// The health model answers "is each process running?". These checks answer the
// second question: "does the DATA the processes produced actually hang together,
// or has something drifted?" Each check is grounded ONLY in data the cockpit
// actually fetches — an honest unknown beats a fabricated signal, so a check we
// can't ground is simply not here.
//
// Every check returns a Finding (or null when clean) with a PLAIN title + a
// concrete "what to do". Severity orders the "Needs attention" list.

export type Severity = 'info' | 'warn' | 'critical';

export interface Finding {
  id: string;
  severity: Severity;
  title: string; // plain: what is wrong
  detail: string; // the evidence
  whatToDo: string; // the next action
}

export interface ConsistencyInput {
  nowMs: number;
  serverStatusUpdatedAt: string | null;
  serverCurrentPlayers: string[]; // roster the emitter last wrote
  onlinePlayerNames: string[]; // players.is_online = true
  /** Most recent join/leave per online name (from recent events). */
  latestPresenceByName: Record<string, { type: string; at: string } | undefined>;
  openSessions: { character_name: string | null; joined_at: string }[];
  mapSnapshotLastSuccess: string | null;
  unannouncedMilestones: { title: string }[]; // achieved_at set, announced_at null
  unannouncedIdentityConfirmations: number; // consumed_at set, announced_at null
  expiredUnconsumedClaims: number; // expires_at < now, consumed_at null
  statPoisonReporters: string[]; // player_stats.gs_stats._flags present
  botFlags: BotPilotFlags | null;
  demoDiscordEvents: number; // discord_events with discord_event_id null
  /** required table → present? (probed by existence). */
  tablePresence: Record<string, boolean>;
}

export interface BotPilotFlags {
  recapPilotChannel?: boolean; // RECAP_CHANNEL forced to a pilot channel
  milestonePilotChannel?: boolean; // MILESTONE_CHANNEL forced to a pilot channel
  recapsStartPulledForward?: boolean; // RECAPS_START pulled earlier for the demo
}

/**
 * Pull the pilot/demo flags out of the bot's heartbeat metrics.
 *
 * THE BUG THIS FIXES. This read `metrics.flags.recapPilotChannel` &c. The bot has
 * never sent a `flags` object: it puts three differently-named booleans at the
 * TOP LEVEL of metrics (services/discord-bot/src/index.js ~240-242
 * `recapChannelIsServer`, `milestoneChannelIsServer`, `recapsStartPulledForward`).
 * So `flags` was always undefined, this returned null, and checkPilotFlags could
 * never fire — the cockpit was structurally incapable of warning that the pilot
 * channel overrides were still on, which is a launch-day checklist item.
 *
 * The bot runs on the host and is not edited from here, so this reads what it
 * actually sends: top level first, under either spelling, with the old nested
 * `flags` shape still accepted in case the bot is ever changed to match.
 */
export function extractBotFlags(metrics: Record<string, unknown> | null): BotPilotFlags | null {
  if (!metrics || typeof metrics !== 'object') return null;
  const nested = (metrics.flags ?? null) as Record<string, unknown> | null;

  /** First of `keys` that is present as a boolean, at the top level or under flags. */
  const b = (...keys: string[]): boolean | undefined => {
    for (const k of keys) {
      if (typeof metrics[k] === 'boolean') return metrics[k] as boolean;
      if (nested && typeof nested === 'object' && typeof nested[k] === 'boolean') return nested[k] as boolean;
    }
    return undefined;
  };

  const out: BotPilotFlags = {
    recapPilotChannel: b('recapChannelIsServer', 'recapPilotChannel'),
    milestonePilotChannel: b('milestoneChannelIsServer', 'milestonePilotChannel'),
    recapsStartPulledForward: b('recapsStartPulledForward'),
  };
  // All three absent = the bot told us nothing; say so rather than reporting
  // three confident "false"s the cockpit would render as "all clear".
  if (Object.values(out).every((v) => v === undefined)) return null;
  return out;
}

const SERVER_STATUS_WARN_SEC = 10 * 60;
const SERVER_STATUS_CRIT_SEC = 30 * 60;
const OPEN_SESSION_STALE_SEC = 6 * 60 * 60;
const MAP_SNAPSHOT_WARN_SEC = 30 * 60;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

function ageSec(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 1000);
}

function fmtAge(sec: number | null): string {
  if (sec === null) return 'unknown';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** Run every check; return only the findings that fired, worst-first. */
export function runConsistencyChecks(input: ConsistencyInput): Finding[] {
  const checks: (Finding | null)[] = [
    checkStaleServerStatus(input),
    checkRosterDisagreement(input),
    checkOnlineWithoutPresence(input),
    checkStaleOpenSessions(input),
    checkStaleMapSnapshot(input),
    checkUnannouncedMilestones(input),
    checkUnannouncedIdentities(input),
    checkStatPoison(input),
    checkExpiredClaims(input),
    checkMissingTables(input),
    checkPilotFlags(input),
    checkDemoData(input),
  ];
  return checks
    .filter((f): f is Finding => f !== null)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function checkStaleServerStatus(i: ConsistencyInput): Finding | null {
  const age = ageSec(i.nowMs, i.serverStatusUpdatedAt);
  if (age === null) {
    return {
      id: 'server-status-missing',
      severity: 'warn',
      title: 'Server status has no timestamp',
      detail: 'server_status.updated_at is empty, so we cannot tell when the world was last heard from.',
      whatToDo: 'Check the GsValheimStats emitter and the log poller are POSTing, and that the server is up.',
    };
  }
  if (age >= SERVER_STATUS_CRIT_SEC) {
    return {
      id: 'server-status-stale-critical',
      severity: 'critical',
      title: 'Server status is very stale',
      detail: `Last updated ${fmtAge(age)} ago — nothing has refreshed the roster/world day.`,
      whatToDo: 'Confirm the server is online and the emitter + log poller are running; restart whichever is down (host-side, not from here).',
    };
  }
  if (age >= SERVER_STATUS_WARN_SEC) {
    return {
      id: 'server-status-stale',
      severity: 'warn',
      title: 'Server status is going stale',
      detail: `Last updated ${fmtAge(age)} ago (expected every ~2 min while anyone is on).`,
      whatToDo: 'If players are online, check the emitter; if the world is empty this is normal.',
    };
  }
  return null;
}

function checkRosterDisagreement(i: ConsistencyInput): Finding | null {
  const emitter = new Set(i.serverCurrentPlayers);
  const online = new Set(i.onlinePlayerNames);
  const onlyEmitter = [...emitter].filter((n) => !online.has(n));
  const onlyOnline = [...online].filter((n) => !emitter.has(n));
  if (onlyEmitter.length === 0 && onlyOnline.length === 0) return null;
  return {
    id: 'roster-disagreement',
    severity: 'warn',
    title: 'Online roster disagrees with the emitter',
    detail:
      `players.is_online and server_status.current_players differ. ` +
      (onlyEmitter.length ? `Emitter-only: ${onlyEmitter.join(', ')}. ` : '') +
      (onlyOnline.length ? `Flagged-online-only: ${onlyOnline.join(', ')}.` : ''),
    whatToDo: 'Usually self-heals on the next roster sync; if it persists a player is likely stuck online after an unclean drop.',
  };
}

function checkOnlineWithoutPresence(i: ConsistencyInput): Finding | null {
  const suspects = i.onlinePlayerNames.filter((name) => {
    const p = i.latestPresenceByName[name];
    return !p || p.type === 'leave';
  });
  if (suspects.length === 0) return null;
  return {
    id: 'online-without-join',
    severity: 'warn',
    title: 'Players marked online without a recent join',
    detail: `Flagged online but their latest presence event is a leave or missing: ${suspects.join(', ')}.`,
    whatToDo: 'Likely a stuck-online row from an unclean disconnect; the next roster sync clears it. Investigate if it lingers.',
  };
}

function checkStaleOpenSessions(i: ConsistencyInput): Finding | null {
  const stale = i.openSessions.filter((s) => {
    const age = ageSec(i.nowMs, s.joined_at);
    return age !== null && age >= OPEN_SESSION_STALE_SEC;
  });
  if (stale.length === 0) return null;
  const names = stale.map((s) => s.character_name ?? 'unknown').slice(0, 8);
  return {
    id: 'stale-open-sessions',
    severity: 'warn',
    title: 'Play sessions left open too long',
    detail: `${stale.length} session(s) have no leave after 6h+ (${names.join(', ')}).`,
    whatToDo: 'A missed leave line leaves a session open; the leave/sync path normally closes it. Check the log poller if many pile up.',
  };
}

function checkStaleMapSnapshot(i: ConsistencyInput): Finding | null {
  const age = ageSec(i.nowMs, i.mapSnapshotLastSuccess);
  if (age === null) {
    return {
      id: 'map-snapshot-missing',
      severity: 'info',
      title: 'No map snapshot recorded',
      detail: 'The map snapshotter has not reported a successful pull.',
      whatToDo: 'Fine before the world map exists; otherwise check the eilif-map-snapshot service.',
    };
  }
  if (age >= MAP_SNAPSHOT_WARN_SEC) {
    return {
      id: 'map-snapshot-stale',
      severity: 'warn',
      title: 'Map snapshot is stale',
      detail: `Last successful snapshot ${fmtAge(age)} ago (cadence ~5 min).`,
      whatToDo: 'Check the map-snapshot service and its SFTP access to the WebMap files.',
    };
  }
  return null;
}

function checkUnannouncedMilestones(i: ConsistencyInput): Finding | null {
  if (i.unannouncedMilestones.length === 0) return null;
  const titles = i.unannouncedMilestones.map((m) => m.title).slice(0, 6);
  return {
    id: 'unannounced-milestones',
    severity: 'warn',
    title: 'Great Deeds achieved but not announced',
    detail: `${i.unannouncedMilestones.length} milestone(s) have achieved_at set with no announcement: ${titles.join(', ')}.`,
    whatToDo: 'The bot announces achieved milestones; if these linger, check the discord-bot milestone loop.',
  };
}

function checkUnannouncedIdentities(i: ConsistencyInput): Finding | null {
  if (i.unannouncedIdentityConfirmations <= 0) return null;
  return {
    id: 'unannounced-identities',
    severity: 'info',
    title: 'Identity links confirmed but not announced',
    detail: `${i.unannouncedIdentityConfirmations} identity claim(s) consumed with no announcement.`,
    whatToDo: 'The bot confirms linked identities; check its identity-announce path if these persist.',
  };
}

function checkStatPoison(i: ConsistencyInput): Finding | null {
  if (i.statPoisonReporters.length === 0) return null;
  return {
    id: 'stat-poison-flags',
    severity: 'warn',
    title: 'Stat-poison flags recorded',
    detail: `player_stats carry _flags (implausible counter jumps) for: ${i.statPoisonReporters.slice(0, 8).join(', ')}.`,
    whatToDo: 'Review the flagged rows (gs_stats._flags has prev→next); the jump was merged but marked for a manual undo.',
  };
}

function checkExpiredClaims(i: ConsistencyInput): Finding | null {
  if (i.expiredUnconsumedClaims <= 0) return null;
  return {
    id: 'expired-claims',
    severity: 'info',
    title: 'Expired identity codes never used',
    detail: `${i.expiredUnconsumedClaims} identity claim code(s) expired without being consumed.`,
    whatToDo: 'Housekeeping only — safe to leave; prune periodically if the table grows.',
  };
}

function checkMissingTables(i: ConsistencyInput): Finding | null {
  const missing = Object.entries(i.tablePresence)
    .filter(([, present]) => present === false)
    .map(([name]) => name);
  if (missing.length === 0) return null;
  return {
    id: 'missing-migrations',
    severity: 'critical',
    title: 'Expected tables are missing',
    detail: `These tables were not found (a migration is likely unapplied): ${missing.join(', ')}.`,
    whatToDo: 'Apply the matching db/*.sql migration in Supabase (Charlie applies migrations by hand — none run automatically).',
  };
}

function checkPilotFlags(i: ConsistencyInput): Finding | null {
  const f = i.botFlags;
  if (!f) return null;
  const on: string[] = [];
  if (f.recapPilotChannel) on.push('RECAP_CHANNEL pilot override');
  if (f.milestonePilotChannel) on.push('MILESTONE_CHANNEL pilot override');
  if (f.recapsStartPulledForward) on.push('RECAPS_START pulled forward');
  if (on.length === 0) return null;
  return {
    id: 'pilot-flags-enabled',
    severity: 'warn',
    title: 'Launch-only pilot flags still enabled',
    detail: `The bot reports these demo/pilot settings are active: ${on.join(', ')}.`,
    whatToDo: 'Revert these to their launch values before go-live (bot .env, then restart the bot host-side).',
  };
}

function checkDemoData(i: ConsistencyInput): Finding | null {
  if (i.demoDiscordEvents <= 0) return null;
  return {
    id: 'demo-data-present',
    severity: 'info',
    title: 'Demo data still present',
    detail: `${i.demoDiscordEvents} manually-seeded demo event row(s) (discord_event_id is null) remain.`,
    whatToDo: 'Wipe seeded demo rows before launch (see the tracker "wipe before launch" list).',
  };
}
