// The six reads behind <InsightsStrip/>. SERVER ONLY.
//
// This is the whole I/O half of the insights strip. It is deliberately thin: it
// fetches plain rows, hands them to the pure `buildInsights()` in
// lib/ops/insights.ts, and holds no logic of its own beyond shaping. That split
// is what makes every rule on the strip unit-testable, because lib/ops/client.ts
// imports 'server-only' and anything that touches it cannot be loaded by tsx.
//
// THE BUDGET, and why it is six. docs/OPS-COCKPIT-V2.md §4 freezes this strip at
// six queries and 400 ms, inside the overview's own 3 s budget rather than
// beside it. `loadOpsData()` already spends about 1.2 s of that 3 s, so the
// strip runs all six in ONE Promise.all and adds one round trip's latency, not
// six. If a seventh insight ever needs a seventh read, an existing one goes.
//
// WHAT IS NOT READ, and which card is missing because of it:
//   • sessions      → peak concurrency is replayed from join and leave rows
//                     instead, which undercounts sessions that began before the
//                     window. The card says so.
//   • bosses        → the boss_kills_total deed is not evaluated.
//   • voice_lines   → no voice card here; the overview already has the queue
//                     gauge and the performance tab owns speak latency.
//   • oaths         → the announce backlog card covers deeds only. Oaths that
//                     were sworn and never announced belong to the activity tab
//                     ("fired but never announced").
//   • row counts    → no free-plan budget card. That needs a count per table and
//                     is the performance tab's panel.
//
// A FAILED READ IS NOT AN EMPTY TABLE, and this file is where that distinction
// is made. `safeRead` hands a query that threw the same fallback an empty table
// produces, and a PostgREST error (a moved column, a statement timeout under
// load) is caught by the `if (error)` branch inside each read, which used to
// return the same empty array. Every read below therefore returns
// `{ ok, rows }`, and `reads` carries those six flags into lib/ops/insights.ts,
// where each rule is gated on the reads it needs. Without it a failed events
// read renders as "0 events in the last 24 h", "the relay is 0 rows behind" and
// an all-clear, over a database nobody could see. That was the live behaviour
// until 2026-09-06.
//
// NOTHING HERE WRITES. Service role, read only, every query bounded by a window
// and an explicit limit.

import 'server-only';
import { opsServiceClient, safeRead } from '@/lib/ops/client';
import { AGGREGATE_STAT_COLUMNS } from '@/lib/milestones';
import type { Milestone } from '@/lib/types';
import { ROW_LIMIT, WINDOW_7D_MS, sinceIso } from '@/lib/ops/window';
import type {
  InsightEventRow,
  InsightHeartbeatRow,
  InsightInput,
  InsightPlayerRow,
  InsightServerStatus,
} from '@/lib/ops/insights';

/** Rows the events read may return. The shared ceiling, not a number of its own. */
export const EVENTS_LIMIT = ROW_LIMIT;
/** Heartbeat rows. One per component; 50 is headroom for a registry that grows. */
export const HEARTBEAT_LIMIT = 50;
/** Deed definition rows. Production has 38. */
export const MILESTONE_LIMIT = 100;
/** player_stats rows. One per viking; the server is capped at 20 players. */
export const PLAYER_STATS_LIMIT = 200;
/**
 * New-viking rows read. Four names are shown on the card; the rest are counted.
 *
 * 50, not 20. The rows are ordered newest first, so a cap this table can reach
 * silently truncates the count, and the server's cap of 20 CONCURRENT players
 * does not bound distinct new NAMES across a day: a re-roll or a rename writes
 * another row. Launch week is the week this rule matters and the week it is most
 * likely to cap, so the limit is raised and `newPlayersTruncated` makes the card
 * say "at least N" if it is ever hit anyway. The table is tiny; 50 is still a
 * bounded read.
 */
export const NEW_PLAYER_LIMIT = 50;

export interface LoadedInsights {
  input: InsightInput;
  /** Wall clock for the six reads, in ms. Printed under the strip. */
  ms: number;
  /** Queries actually issued. Always 6 when the client is configured. */
  queries: number;
  /** Of those, how many returned. Printed under the strip when it is not all of them. */
  returned: number;
}

/** One read's outcome: did it return, and what did it return. */
interface Read<T> {
  ok: boolean;
  rows: T;
}

/** The shape a read that never ran (no client) reports. */
function missing<T>(rows: T): Read<T> {
  return { ok: false, rows };
}

/**
 * Run the six reads and return the pure function's input.
 *
 * Never throws. An unconfigured client yields `supabaseOk: false` and the strip
 * renders one card saying the insights could not be computed, which is the
 * honest signal. A single failed read yields `reads.<name> = false`, which
 * suppresses every rule that needed it and renders the "incomplete read" card
 * naming which one, rather than reporting the empty result as a zero.
 */
export async function loadInsights(nowMs: number): Promise<LoadedInsights> {
  const empty: InsightInput = {
    nowMs,
    supabaseOk: false,
    events: [],
    eventsTruncated: false,
    eventsWindowMs: WINDOW_7D_MS,
    heartbeats: [],
    serverStatus: null,
    milestones: [],
    playerStats: [],
    newPlayers: [],
    newPlayersTruncated: false,
    reads: {
      events: false,
      heartbeats: false,
      serverStatus: false,
      milestones: false,
      playerStats: false,
      newPlayers: false,
    },
  };

  const client = opsServiceClient();
  if (!client) return { input: empty, ms: 0, queries: 0, returned: 0 };

  const since7 = sinceIso(nowMs, WINDOW_7D_MS);
  const started = performance.now();

  const [events, heartbeats, serverStatus, milestones, playerStats, newPlayers] = await Promise.all([
    // 1. events, 7 d.
    //
    // WINDOWED AND ORDERED ON inserted_at, NOT created_at, and that is on
    // purpose. There is no index on events(created_at) alone: the only ones that
    // exist are events_type_created_idx (type, created_at desc),
    // events_character_created_idx and events_inserted_at_idx (inserted_at).
    // This read wants EVERY type, so it cannot pin the leading column of the
    // first index, and a bare created_at range would seq-scan the table and then
    // sort it. Filtering and ordering on inserted_at is one backwards index scan
    // with no sort node.
    //
    // It is also a correct substitute. inserted_at is stamped at insert and
    // created_at is producer time, and lib/event-time.ts clamps producer stamps
    // that run ahead of now, so created_at <= inserted_at holds for every row
    // (the 2026-09-05 backfill set inserted_at = created_at for the rows that
    // predate the column). A row with created_at inside the window therefore has
    // inserted_at inside it too: this read is a SUPERSET of the rows the windows
    // want, and lib/ops/insights.ts filters each window on created_at in memory.
    //
    // Rows with a null inserted_at would be invisible here. The migration
    // backfilled every existing row and set a default, so production has none.
    safeRead(async () => {
      const { data, error } = await client
        .from('events')
        .select('type, character_name, created_at, inserted_at, metadata')
        .gte('inserted_at', since7)
        .order('inserted_at', { ascending: false })
        .limit(EVENTS_LIMIT);
      if (error) return missing([] as InsightEventRow[]);
      return { ok: true, rows: (data ?? []) as InsightEventRow[] };
    }, missing([] as InsightEventRow[])),

    // 2. ops_heartbeats. One row per component, upserted, so there is no time
    // window to apply and none is needed: the whole table is smaller than one
    // page of events. The limit is the bound.
    safeRead(async () => {
      const { data, error } = await client
        .from('ops_heartbeats')
        .select('component, status, last_success, metrics')
        .limit(HEARTBEAT_LIMIT);
      if (error) return missing([] as InsightHeartbeatRow[]);
      return { ok: true, rows: (data ?? []) as InsightHeartbeatRow[] };
    }, missing([] as InsightHeartbeatRow[])),

    // 3. server_status. A single row by primary key, pinned by id so it can
    // never become a scan if a second row is ever inserted by mistake.
    safeRead(async () => {
      const { data, error } = await client
        .from('server_status')
        .select('current_players, player_count, world_day, updated_at')
        .eq('id', 1)
        .limit(1);
      // A read that returned no row is still a read that RETURNED: server_status
      // holds exactly one row in every real deployment, but "the row is missing"
      // and "the query failed" are different facts and only the second one
      // silences the rules that use it.
      if (error) return missing(null as InsightServerStatus | null);
      return { ok: true, rows: ((data ?? [])[0] ?? null) as InsightServerStatus | null };
    }, missing(null as InsightServerStatus | null)),

    // 4. milestones. A definition table of 38 rows. select('*') because
    // summarizeMilestones() takes the whole row shape, and the row is small.
    safeRead(async () => {
      const { data, error } = await client.from('milestones').select('*').limit(MILESTONE_LIMIT);
      if (error) return missing([] as Milestone[]);
      return { ok: true, rows: (data ?? []) as Milestone[] };
    }, missing([] as Milestone[])),

    // 5. player_stats, only the columns computeAggregates() reads. One row per
    // viking, and the server is capped at 20 players.
    safeRead(async () => {
      const { data, error } = await client
        .from('player_stats')
        .select(AGGREGATE_STAT_COLUMNS)
        .limit(PLAYER_STATS_LIMIT);
      if (error) return missing([] as Record<string, unknown>[]);
      return { ok: true, rows: (data ?? []) as unknown as Record<string, unknown>[] };
    }, missing([] as Record<string, unknown>[])),

    // 6. players first seen inside the window. Windowed even though the table is
    // tiny, because the rule is that every read carries a window and a limit.
    safeRead(async () => {
      const { data, error } = await client
        .from('players')
        .select('character_name, first_seen_at, is_online, last_seen_at')
        .gte('first_seen_at', since7)
        .order('first_seen_at', { ascending: false })
        .limit(NEW_PLAYER_LIMIT);
      if (error) return missing([] as InsightPlayerRow[]);
      return { ok: true, rows: (data ?? []) as InsightPlayerRow[] };
    }, missing([] as InsightPlayerRow[])),
  ]);

  const ms = performance.now() - started;

  const reads = {
    events: events.ok,
    heartbeats: heartbeats.ok,
    serverStatus: serverStatus.ok,
    milestones: milestones.ok,
    playerStats: playerStats.ok,
    newPlayers: newPlayers.ok,
  };
  const returned = Object.values(reads).filter(Boolean).length;

  // supabaseOk is a claim about the reads, not about the client existing, and
  // now it is a claim about whether they RETURNED rather than about whether they
  // came back non-empty. The old test (any of four lists non-empty) failed the
  // launch-wipe minute, when every table is legitimately empty and every read
  // succeeded: the strip would have said the insights could not be computed on a
  // database that was working perfectly. Six failed reads still means exactly
  // that, and that is what this now says.
  const supabaseOk = returned > 0;

  return {
    input: {
      nowMs,
      supabaseOk,
      events: events.rows,
      eventsTruncated: events.rows.length >= EVENTS_LIMIT,
      eventsWindowMs: WINDOW_7D_MS,
      heartbeats: heartbeats.rows,
      serverStatus: serverStatus.rows,
      milestones: milestones.rows,
      playerStats: playerStats.rows,
      newPlayers: newPlayers.rows,
      newPlayersTruncated: newPlayers.rows.length >= NEW_PLAYER_LIMIT,
      reads,
    },
    ms,
    queries: 6,
    returned,
  };
}
