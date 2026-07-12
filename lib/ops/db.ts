// SERVER-ONLY data access for the ops cockpit.
//
// The public site reads through lib/data.ts with the ANON key (RLS-limited). The
// cockpit needs to read tables that anon CANNOT (ops_heartbeats, identity_claims,
// player_positions, ...), so it uses its OWN SERVICE-ROLE client. That key
// bypasses RLS and must NEVER reach the browser — everything here runs only in
// the /admin/ops Server Component (which is force-dynamic and auth-gated). No
// client-facing data API exposes any of this.

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { HeartbeatRow } from './health';
import type { BotPilotFlags } from './consistency';

const REQUIRED_TABLES = ['identity_claims', 'chat_lines', 'player_positions', 'ops_heartbeats'];

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // unconfigured → cockpit shows supabase degraded, never 500
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Build-time / deploy commit for the "version" column; honest 'unknown' if absent. */
export function dashboardVersion(): string | null {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_COMMIT_SHA ||
    process.env.COMMIT_SHA;
  if (sha && sha.length >= 7) return sha.slice(0, 7);
  return null;
}

export interface OpsData {
  nowMs: number;
  supabaseOk: boolean;
  dashboardVersion: string | null;
  // health inputs
  serverStatusUpdatedAt: string | null;
  heartbeats: Record<string, HeartbeatRow>;
  // consistency inputs
  serverCurrentPlayers: string[];
  onlinePlayerNames: string[];
  latestPresenceByName: Record<string, { type: string; at: string } | undefined>;
  openSessions: { character_name: string | null; joined_at: string }[];
  mapSnapshotLastSuccess: string | null;
  unannouncedMilestones: { title: string }[];
  unannouncedIdentityConfirmations: number;
  expiredUnconsumedClaims: number;
  statPoisonReporters: string[];
  botFlags: BotPilotFlags | null;
  demoDiscordEvents: number;
  tablePresence: Record<string, boolean>;
}

/**
 * Probe whether a table exists. A PostgREST "relation does not exist" / missing-
 * from-schema error means the migration is unapplied; any OTHER error (e.g. a
 * permission quirk) is treated as "exists" so we never cry wolf about a missing
 * migration.
 */
async function tableExists(client: SupabaseClient, table: string): Promise<boolean> {
  const { error } = await client.from(table).select('*', { head: true }).limit(1);
  if (!error) return true;
  const code = (error.code ?? '').toLowerCase();
  const msg = (error.message ?? '').toLowerCase();
  if (code === '42p01' || code === 'pgrst205' || msg.includes('does not exist') || msg.includes('could not find the table')) {
    return false;
  }
  return true;
}

/**
 * Gather everything the cockpit renders. FAIL SOFT: every query is guarded, and
 * if the client is unconfigured we return a fully-populated "unknown" bundle with
 * supabaseOk=false so the page still renders (never a 500).
 */
export async function loadOpsData(nowMs: number = Date.now()): Promise<OpsData> {
  const empty: OpsData = {
    nowMs,
    supabaseOk: false,
    dashboardVersion: dashboardVersion(),
    serverStatusUpdatedAt: null,
    heartbeats: {},
    serverCurrentPlayers: [],
    onlinePlayerNames: [],
    latestPresenceByName: {},
    openSessions: [],
    mapSnapshotLastSuccess: null,
    unannouncedMilestones: [],
    unannouncedIdentityConfirmations: 0,
    expiredUnconsumedClaims: 0,
    statPoisonReporters: [],
    botFlags: null,
    demoDiscordEvents: 0,
    tablePresence: Object.fromEntries(REQUIRED_TABLES.map((t) => [t, true])),
  };

  const client = serviceClient();
  if (!client) return empty;

  const data: OpsData = { ...empty, supabaseOk: true };

  // A helper that never throws — records failure by flipping supabaseOk only when
  // the core liveness probe fails.
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  // Core liveness probe (server_status). If THIS throws, treat supabase as down.
  try {
    const { data: status, error } = await client
      .from('server_status')
      .select('updated_at, current_players')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    data.serverStatusUpdatedAt = (status?.updated_at as string | null) ?? null;
    data.serverCurrentPlayers = Array.isArray(status?.current_players)
      ? (status!.current_players as string[])
      : [];
  } catch {
    data.supabaseOk = false;
    return data; // everything else stays "unknown"; page renders supabase degraded
  }

  // Heartbeats.
  data.heartbeats = await safe(async () => {
    const { data: rows } = await client
      .from('ops_heartbeats')
      .select('component, instance, version, status, last_success, last_attempt, error_summary, metrics, updated_at');
    const map: Record<string, HeartbeatRow> = {};
    for (const r of (rows ?? []) as HeartbeatRow[]) {
      map[r.component] = { ...r, metrics: (r.metrics ?? {}) as Record<string, unknown> };
    }
    return map;
  }, {});

  data.mapSnapshotLastSuccess = data.heartbeats['map-snapshot']?.last_success ?? null;
  data.botFlags = extractBotFlags(data.heartbeats['discord-bot']?.metrics ?? null);

  // Online players.
  data.onlinePlayerNames = await safe(async () => {
    const { data: rows } = await client.from('players').select('character_name').eq('is_online', true);
    return (rows ?? []).map((r) => r.character_name as string).filter(Boolean);
  }, []);

  // Latest join/leave per online name (last 24h window is plenty).
  data.latestPresenceByName = await safe(async () => {
    const map: Record<string, { type: string; at: string } | undefined> = {};
    if (data.onlinePlayerNames.length === 0) return map;
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await client
      .from('events')
      .select('character_name, type, created_at')
      .in('character_name', data.onlinePlayerNames)
      .in('type', ['join', 'leave'])
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    for (const r of rows ?? []) {
      const name = r.character_name as string | null;
      if (!name || map[name]) continue; // first (newest) per name
      map[name] = { type: r.type as string, at: r.created_at as string };
    }
    return map;
  }, {});

  // Open sessions (left_at null).
  data.openSessions = await safe(async () => {
    const { data: rows } = await client
      .from('sessions')
      .select('character_name, joined_at')
      .is('left_at', null)
      .order('joined_at', { ascending: true })
      .limit(200);
    return (rows ?? []).map((r) => ({
      character_name: (r.character_name as string | null) ?? null,
      joined_at: r.joined_at as string,
    }));
  }, []);

  // Unannounced milestones (achieved but not announced).
  data.unannouncedMilestones = await safe(async () => {
    const { data: rows } = await client
      .from('milestones')
      .select('title')
      .not('achieved_at', 'is', null)
      .is('announced_at', null);
    return (rows ?? []).map((r) => ({ title: (r.title as string) ?? 'a milestone' }));
  }, []);

  // Identity claims: unannounced confirmations + expired-unconsumed (one query).
  const claims = await safe(async () => {
    const { data: rows } = await client
      .from('identity_claims')
      .select('consumed_at, announced_at, expires_at');
    return (rows ?? []) as { consumed_at: string | null; announced_at: string | null; expires_at: string | null }[];
  }, [] as { consumed_at: string | null; announced_at: string | null; expires_at: string | null }[]);
  data.unannouncedIdentityConfirmations = claims.filter((c) => c.consumed_at && !c.announced_at).length;
  data.expiredUnconsumedClaims = claims.filter(
    (c) => !c.consumed_at && c.expires_at !== null && Date.parse(c.expires_at) < nowMs,
  ).length;

  // Stat-poison flags: rows whose gs_stats._flags is a non-empty array.
  data.statPoisonReporters = await safe(async () => {
    const { data: rows } = await client.from('player_stats').select('gs_reporter, gs_stats');
    const out: string[] = [];
    for (const r of rows ?? []) {
      const gs = r.gs_stats as { _flags?: unknown } | null;
      if (gs && Array.isArray(gs._flags) && gs._flags.length > 0) {
        out.push((r.gs_reporter as string | null) ?? 'unknown');
      }
    }
    return out;
  }, []);

  // Demo data: discord_events with a null discord_event_id (manually seeded).
  data.demoDiscordEvents = await safe(async () => {
    const { count } = await client
      .from('discord_events')
      .select('*', { count: 'exact', head: true })
      .is('discord_event_id', null);
    return count ?? 0;
  }, 0);

  // Required-table existence probes.
  data.tablePresence = await safe(async () => {
    const entries = await Promise.all(
      REQUIRED_TABLES.map(async (t) => [t, await tableExists(client, t)] as const),
    );
    return Object.fromEntries(entries);
  }, Object.fromEntries(REQUIRED_TABLES.map((t) => [t, true])));

  return data;
}

/** Pull the pilot/demo flags the bot reports in its heartbeat metrics.flags. */
function extractBotFlags(metrics: Record<string, unknown> | null): BotPilotFlags | null {
  const flags = (metrics?.flags ?? null) as Record<string, unknown> | null;
  if (!flags || typeof flags !== 'object') return null;
  const b = (k: string): boolean | undefined =>
    typeof flags[k] === 'boolean' ? (flags[k] as boolean) : undefined;
  return {
    recapPilotChannel: b('recapPilotChannel'),
    milestonePilotChannel: b('milestonePilotChannel'),
    recapsStartPulledForward: b('recapsStartPulledForward'),
  };
}
