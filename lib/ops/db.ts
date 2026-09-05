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
import { extractBotFlags, type BotPilotFlags } from './consistency';

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

/**
 * A join that arrived under a Steam account other than the one bound to that
 * character name. The webhook records presence anyway (someone really is in the
 * world) but annotates the event and freezes that name's oath, pin and
 * Discord-link writes until an admin releases the binding by hand.
 */
export interface IdentityMismatchEvent {
  characterName: string;
  /** players.steam_id at the time: the account that owns the name. */
  boundSteamId: string | null;
  /** The account that actually joined under it. */
  seenSteamId: string | null;
  at: string;
}

/** How far back the cockpit looks for identity mismatches. */
export const IDENTITY_MISMATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Most mismatch rows the cockpit renders. One more is fetched to detect the cut. */
export const IDENTITY_MISMATCH_LIMIT = 50;

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
  /** Age (s) of the oldest queued voice line while players are online; null otherwise. */
  voiceQueueOldestSec: number | null;
  /** Steam-identity mismatches recorded in the last 7 days, newest first. */
  identityMismatches: IdentityMismatchEvent[];
  /** True when more mismatches exist in the window than the list above holds. */
  identityMismatchesTruncated: boolean;
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
    voiceQueueOldestSec: null,
    identityMismatches: [],
    identityMismatchesTruncated: false,
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

  // Voice queue depth: the age of the OLDEST still-queued line, but only while
  // somebody is actually on the server — with nobody online there is no one to
  // speak to and a waiting queue is correct, not broken. One tiny read (oldest
  // queued row) plus the player count we already hold from server_status.
  data.voiceQueueOldestSec = await safe(async () => {
    if ((data.serverCurrentPlayers?.length ?? 0) === 0) return null;
    const { data: rows, error } = await client
      .from('voice_lines')
      .select('queued_at')
      .eq('status', 'queued')
      .order('queued_at', { ascending: true })
      .limit(1);
    if (error) return null; // pre-migration / unreadable → honest unknown, never a false alarm
    const oldest = rows?.[0]?.queued_at as string | undefined;
    if (!oldest) return null;
    const t = Date.parse(oldest);
    return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 1000);
  }, null);

  // Hand it to buildHealth through the component's own metrics as well as the
  // top-level field. The cockpit page passes `heartbeats` wholesale but picks the
  // other health inputs by name, so riding along in the row is what makes this
  // check live without the page having to know about it — and it reads naturally
  // in the cockpit's metric flags either way.
  if (data.voiceQueueOldestSec !== null && data.heartbeats['companion-voice']) {
    const hb = data.heartbeats['companion-voice'];
    data.heartbeats['companion-voice'] = {
      ...hb,
      metrics: { ...(hb.metrics ?? {}), voiceQueueOldestSec: Math.round(data.voiceQueueOldestSec) },
    };
  }

  // Steam-identity mismatches, last 7 days. The webhook writes the evidence onto
  // the event row itself (metadata.identity = 'steam_mismatch' plus both ids), so
  // this is a straight read of that annotation — the cockpit never re-derives who
  // owns a name, it only shows what was recorded at the time.
  //
  // Filtered in the database on the JSON key so a quiet week reads a handful of
  // rows, not every join of the week. A failed read yields an empty list (the
  // convention everywhere in this file); the page says plainly that it is showing
  // the last 7 days, so an empty table reads as "none recorded", never as "all
  // clear, guaranteed".
  //
  // `type = 'join'` is pinned FIRST and is not cosmetic: it is what makes this a
  // BOUNDED read. `events_type_created_idx (type, created_at desc)` — applied to
  // prod in db/2026-09-04_events_indexes.sql precisely because `events` was doing
  // 638k sequential scans — has `type` as its leading column, so pinning it lets
  // one index scan serve the equality, the created_at range AND the ordering,
  // leaving the JSON key as a cheap filter over a small slice.
  //
  // Verified on prod with EXPLAIN ANALYZE (read-only, 2026-09-04):
  //   with the type pin: Index Scan, Index Cond on (type, created_at), no sort,
  //                      2 shared buffers, 7 rows filtered.
  //   without it:        the same index scanned end to end with only created_at
  //                      as the cond, plus a Sort node, 6 buffers, 20 filtered.
  // At ~100 rows both are instant; the difference is how they GROW. The pinned
  // shape costs what the last 7 days of joins cost, the unpinned one costs the
  // whole table and tips to a plain seq scan once the planner stops liking the
  // index. This renders on every refresh of the page Charlie will sit on all
  // launch night, against the table growing fastest at that moment.
  //
  // Pinning the type is LOSSLESS: metadata.identity is only ever set inside
  // `if (type === 'join' && playerId)` (app/api/webhook/route.ts §3b) and merged
  // into that same insert, so a steam_mismatch annotation cannot exist on any
  // other event type. If a second writer is ever added, widen this to `.in('type',
  // [...])` rather than dropping it — an unfiltered type means a seq scan again.
  const mismatchRows = await safe(async () => {
    const since = new Date(nowMs - IDENTITY_MISMATCH_WINDOW_MS).toISOString();
    const { data: rows, error } = await client
      .from('events')
      .select('character_name, created_at, metadata')
      .eq('type', 'join')
      .eq('metadata->>identity', 'steam_mismatch')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      // One over the render limit: the extra row is never shown, it only tells
      // the page that the table it is drawing is not the whole window.
      .limit(IDENTITY_MISMATCH_LIMIT + 1);
    if (error) return [];
    return (rows ?? []).map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const id = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      return {
        characterName: (r.character_name as string | null) ?? 'unknown',
        boundSteamId: id(meta.boundSteamId),
        seenSteamId: id(meta.seenSteamId),
        at: r.created_at as string,
      };
    });
  }, [] as IdentityMismatchEvent[]);
  data.identityMismatchesTruncated = mismatchRows.length > IDENTITY_MISMATCH_LIMIT;
  data.identityMismatches = mismatchRows.slice(0, IDENTITY_MISMATCH_LIMIT);

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
