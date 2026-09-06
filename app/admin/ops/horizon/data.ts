// The reads behind /admin/ops/horizon. Server only, service role, READ ONLY.
//
// Every panel on the tab is fed from this one function. It is deliberately thin:
// fetch, shape, hand plain rows to lib/ops/horizon.ts. Nothing here computes a
// countdown, a state or a percentage, because none of that could then be tested
// (this module imports lib/ops/client.ts, which imports 'server-only', which
// throws under tsx). See docs/OPS-COCKPIT-V2.md section 3.
//
// BOUNDED, IN ONE WAVE, PLUS ONE. Every query carries an explicit limit and,
// where the table grows, a time window. They run in a single Promise.all, so the
// page pays for the slowest round trip rather than the sum of nineteen of them.
// One dependent read follows: the relay backlog count needs the bot's cursor,
// which only arrives with the heartbeat row, so it cannot be in the first wave.
//
// WHY SOME READS COME THROUGH lib/data. The Great Deeds progress bars, the
// gathering roll-forward and the living titles all already exist as loaders the
// public site uses. Reimplementing them here would let the cockpit and the site
// disagree about how close a deed is or which title a viking holds, which is a
// worse failure than an extra query: an ops page that contradicts the page it is
// meant to be watching is not evidence of anything.
//
// ── THE FAILURE MODE THIS FILE IS WRITTEN AROUND (fixed 2026-09-06) ──────────
//
// supabase-js DOES NOT THROW when a query fails. A missing column, a revoked
// grant, a statement timeout or a 5xx all come back as `{ data: null, error }`,
// and only a network-level failure rejects the promise. Proved against
// production: `select('character_name, no_such_column')` on poty_history returns
// data null with error.code 42703 and no throw. So `safeRead(...)`'s catch is
// unreachable for the ordinary failure, and a read written as `return data ?? []`
// turns every broken read into a confident empty world:
//
//   poty_history broken  -> "no recap has run in the last 7 d"  (a false alarm on
//                           the exact signal that panel exists for)
//   player_stats broken  -> eight Great Deeds sitting at 0 percent
//   voice_lines broken   -> "nothing queued, every line has been spoken"
//
// After the launch wipe a genuinely empty world and a failed read would be
// pixel-identical, which is the one night that must not happen. So:
//
//   EVERY read below destructures `error` and returns NULL on it. On this page
//   `null` means "could not read" and `[]` means "read fine, nothing there".
//   Those are different facts and the panels print them differently.
//
// Four reads still come through lib/data, whose loaders swallow their own errors
// and return `[]` before this file can see them (lib/data.ts is owned by another
// track and is not editable from here). For those there is a sentinel instead:
// `publicReadOk`. `milestones` and `bosses` are seeded reference tables that a
// working database always answers with rows, and the launch wipe RESETS them
// rather than deleting them (scripts/launch-wipe.mjs), so both empty at once is
// a broken read path and never an empty world. The page says so once, at the
// top, rather than letting six panels each report a cheerful nothing.

import 'server-only';
import { unstable_cache } from 'next/cache';
import { opsServiceClient, safeRead } from '@/lib/ops/client';
import {
  getServerStatus,
  getMilestones,
  getMilestoneAggregates,
  getBosses,
  getUpcomingEvents,
  getPlayersWithStats,
  getSessionsSince,
  getEventsSince,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import { epithetsFor } from '@/lib/epithets';
import { sinceIso, WINDOW_7D_MS, WINDOW_24H_MS } from '@/lib/ops/window';
import {
  LAUNCH_YMD,
  LAUNCH_TZ,
  zonedTimeToMs,
  maskClaimCode,
  type TitleContestInput,
} from '@/lib/ops/horizon';
import type {
  Milestone,
  Boss,
  ServerStatus,
  UpcomingEvent,
  PlayerWithStats,
} from '@/lib/types';
import type { Aggregates } from '@/lib/milestones';

/**
 * Who is about to be re-titled, computed the way /api/titles computes it.
 *
 * FOUR READS BEHIND A SIXTY SECOND CACHE (2026-09-06). This is the most
 * expensive thing on the page by bytes: `player_stats` is `select('*')` on the
 * widest rows in the schema (measured at 12.8 kB for five vikings, roughly 51 kB
 * at a full hall of twenty), plus 70 days of sessions and 70 days of death
 * events, about 31 kB a render today. It feeds one panel that usually renders a
 * single sentence, and the loop it describes ticks every ten minutes, so a
 * refresh-heavy launch night was paying that toll several times a minute against
 * a free plan whose egress is the budget that runs out first.
 *
 * Sixty seconds is the same trade `getMilestoneAggregates` already documents,
 * and the panel says the number can sit a minute behind. Everything time
 * critical on this page (the relay cursor, the voice queue, the heartbeats, the
 * watchdog) is read fresh on every request and is not in here.
 *
 * The engine itself is still `epithetsFor`, run twice: once with each viking's
 * persisted `current_title` as the hysteresis incumbent, which is what
 * /api/titles returns and therefore what the bot announces on, and once with
 * every incumbent stripped, which is the raw standings. The difference between
 * the two IS the "contested" signal: a title nothing but hysteresis is holding.
 */
const loadTitleContests = unstable_cache(
  async (): Promise<TitleContestInput[]> => {
    const [roster, sessions, deaths] = await Promise.all([
      safeRead(() => getPlayersWithStats(), [] as PlayerWithStats[]),
      safeRead(() => getSessionsSince(70), []),
      safeRead(() => getEventsSince(70, ['death']), []),
    ]);
    if (roster.length === 0) return [];

    const onlineNames = new Set(roster.filter((p) => p.is_online).map((p) => p.character_name));
    const playtimeByName = playtimeMinutesByCharacter(sessions, onlineNames);
    const withPlaytime: PlayerWithStats[] = roster.map((p) => ({
      ...p,
      total_playtime_minutes: playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
    }));
    const causesByName = new Map<string, string[]>();
    for (const e of deaths) {
      const nm = e.character_name;
      if (!nm) continue;
      const cause = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : '';
      if (!cause) continue;
      const arr = causesByName.get(nm) ?? [];
      arr.push(cause);
      causesByName.set(nm, arr);
    }
    const stable = epithetsFor(withPlaytime, { causesByName });
    // An empty Map means "every incumbent is null": epithetsFor reads
    // `incumbentByName.get(name) ?? null` when the map is supplied at all.
    const raw = epithetsFor(withPlaytime, { causesByName, incumbentByName: new Map() });
    return withPlaytime.map((p) => ({
      name: p.character_name,
      incumbent: p.current_title ?? null,
      stable: stable.get(p.character_name)?.title ?? null,
      raw: raw.get(p.character_name)?.title ?? null,
      source: stable.get(p.character_name)?.source,
    }));
  },
  ['ops-horizon-title-contests'],
  { revalidate: 60 },
);

/** How long a title contest figure on this page may sit behind the database. */
export const TITLES_CACHE_SEC = 60;

/** The bot's own schedule block (services/discord-bot/src/heartbeat.js). */
export interface BotSchedule {
  reportedAt?: string | null;
  recapHour?: number | null;
  recapTz?: string | null;
  recapChannel?: string | null;
  recapsStart?: string | null;
  nextRecapAt?: string | null;
  chronicleEnabled?: boolean | null;
  chronicleHour?: number | null;
  chronicleWeekday?: number | null;
  chronicleChannel?: string | null;
  voiceCadenceMinutes?: number | null;
  voiceMinGapMs?: number | null;
  dawnEveryDays?: number | null;
  ambientOnlineMinutes?: number | null;
  ambientCount?: number | null;
  lastDawnDay?: number | null;
  relayCursor?: string | null;
  relayLastInsertedAt?: string | null;
  relayLastEventAt?: string | null;
  relayInsertionFloor?: string | null;
  relayHeldIds?: number | null;
  relayBatch?: number | null;
  loopsEnabled?: Record<string, boolean> | null;
  intervalsMs?: Record<string, number> | null;
  channels?: Record<string, string | null> | null;
}

export interface HeartbeatRow {
  component: string;
  status: string | null;
  last_success: string | null;
  last_attempt: string | null;
  version: string | null;
  metrics: Record<string, unknown> | null;
}

export interface WatchdogRow {
  key: string;
  state: string | null;
  signature: string | null;
  since: string | null;
  last_alert_at: string | null;
  alert_count: number | null;
}

export interface PotyRow {
  character_name: string | null;
  award_label: string | null;
  awarded_at: string | null;
  world_day: number | null;
}

export interface QueuedVoiceLine {
  id: string;
  kind: string | null;
  queued_at: string | null;
  meta: Record<string, unknown> | null;
}

export interface ClaimRow {
  /**
   * The code with everything after the first two characters starred out. There
   * is deliberately NO field carrying the whole code: see maskClaimCode. Masking
   * in the component was not enough, because the row keyed off the raw value and
   * React keys are serialised into the page.
   */
  codeMasked: string;
  requested_name: string | null;
  discord_username: string | null;
  expires_at: string | null;
}

export interface LoopMetricRow {
  enabled?: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  ok?: boolean;
}

export interface HorizonData {
  /** One clock for the whole page, so no two panels disagree about "now". */
  nowMs: number;
  /** Wall-clock milliseconds the reads took, for the page's own cost line. */
  fetchMs: number;
  /**
   * Database round trips this render could issue, itemised in DB_READS below.
   * Printed on the page so the cost is never silent. It is a ceiling, not a
   * count: four of them sit behind getMilestoneAggregates' 60 s cache and are
   * skipped on a warm hit.
   */
  queryCount: number;
  /** Non-database fetches: the map bucket's status.json. Counted separately. */
  storageFetches: number;
  /** False when the service role is not configured: the page says so and renders nothing live. */
  databaseReachable: boolean;
  /**
   * False when the seeded reference tables (`milestones`, `bosses`) BOTH came
   * back empty. Those are read through lib/data, whose loaders swallow their own
   * errors, so this is the only way this page can tell a broken public read path
   * from an empty world. See the header.
   */
  publicReadOk: boolean;

  /** Null when the ops_heartbeats read itself failed, distinct from an empty table. */
  heartbeats: HeartbeatRow[] | null;
  botSchedule: BotSchedule | null;
  botSubLoops: Record<string, LoopMetricRow>;
  /** The bot's non-secret pilot flags, straight off its heartbeat metrics. */
  botFlags: {
    recapChannelIsServer: boolean | null;
    milestoneChannelIsServer: boolean | null;
    recapsStartPulledForward: boolean | null;
  };
  /** metrics of the companion-voice heartbeat: the in-game plugin's self-report. */
  companionCaps: { targeting: boolean | null; plugin: string | null } | null;

  watchdog: WatchdogRow | null;
  /** False when the ops_alerts read failed. True with a null `watchdog` means "no row yet". */
  watchdogReadable: boolean;
  serverStatus: ServerStatus | null;

  /** Null when the poty_history read failed. [] means "read fine, no recap in 7 d". */
  lastPoty: PotyRow[] | null;
  newestEventInsertedAt: string | null;
  /** False when the events read failed, so "no events at all" is never guessed. */
  newestEventReadable: boolean;
  relayPending: number | null;
  preLaunchEventRows: number | null;

  milestones: Milestone[];
  aggregates: Aggregates;
  bosses: Boss[];
  gatherings: UpcomingEvent[];
  /** Null when the identity_claims read failed. */
  claims: ClaimRow[] | null;
  /** Null when the voice_lines read failed. */
  voiceQueue: QueuedVoiceLine[] | null;
  newestVoiceQueuedAt: string | null;
  titles: TitleContestInput[];

  /** map/status.json: the snapshotter's own record of the last frame it charted. */
  mapCapturedAt: string | null;
  mapWorldDay: number | null;
  mapRevealedPct: number | null;
}

/** The empty shape, so a page with no database still renders every panel's "no data". */
function emptyData(nowMs: number, fetchMs: number): HorizonData {
  return {
    nowMs,
    fetchMs,
    queryCount: 0,
    storageFetches: 0,
    databaseReachable: false,
    publicReadOk: false,
    heartbeats: null,
    botSchedule: null,
    botSubLoops: {},
    botFlags: { recapChannelIsServer: null, milestoneChannelIsServer: null, recapsStartPulledForward: null },
    companionCaps: null,
    watchdog: null,
    watchdogReadable: false,
    serverStatus: null,
    lastPoty: null,
    newestEventInsertedAt: null,
    newestEventReadable: false,
    relayPending: null,
    preLaunchEventRows: null,
    milestones: [],
    aggregates: {},
    bosses: [],
    gatherings: [],
    claims: null,
    voiceQueue: null,
    newestVoiceQueuedAt: null,
    titles: [],
    mapCapturedAt: null,
    mapWorldDay: null,
    mapRevealedPct: null,
  };
}

export async function loadHorizonData(): Promise<HorizonData> {
  const started = performance.now();
  const nowMs = Date.now();
  const client = opsServiceClient();
  if (!client) return emptyData(nowMs, performance.now() - started);

  // Launch day, 00:00 in the runbook's zone. Everything stamped before it is the
  // pilot world, which is what step 20a of docs/LAUNCH-DAY.md wipes.
  const launchStartMs = zonedTimeToMs(LAUNCH_YMD.y, LAUNCH_YMD.m, LAUNCH_YMD.d, 0, 0, LAUNCH_TZ);
  const launchStartIso = launchStartMs === null ? null : new Date(launchStartMs).toISOString();

  const [
    heartbeats,
    watchdog,
    serverStatus,
    lastPoty,
    newestEvent,
    preLaunchEventRows,
    milestones,
    aggregates,
    bosses,
    gatherings,
    claims,
    voiceQueue,
    newestVoice,
    titles,
    mapStatus,
  ] = await Promise.all([
    // ── service-role tables (no public read policy) ──
    // Every one of these destructures `error` and returns null on it. See the
    // header: supabase-js resolves rather than throws on a PostgREST failure, so
    // `data ?? []` would hand the page a confident empty world.
    safeRead(async () => {
      const { data, error } = await client
        .from('ops_heartbeats')
        .select('component, status, last_success, last_attempt, version, metrics')
        .limit(50);
      if (error) return null;
      return (data ?? []) as HeartbeatRow[];
    }, null as HeartbeatRow[] | null),

    safeRead(async () => {
      const { data, error } = await client
        .from('ops_alerts')
        .select('key, state, signature, since, last_alert_at, alert_count')
        .eq('key', 'watchdog')
        .limit(1);
      // Two different nulls, so the panel can tell "no alert row yet" (which is
      // the healthy state before the watchdog has ever fired) from "the table
      // could not be read", which is not a state at all.
      if (error) return { ok: false, row: null };
      return { ok: true, row: ((data ?? [])[0] ?? null) as WatchdogRow | null };
    }, { ok: false, row: null } as { ok: boolean; row: WatchdogRow | null }),

    safeRead(() => getServerStatus(), null),

    // Proof a recap actually ran: the bot archives a Player of the Day on every
    // one. Windowed to 7 d and capped at 5, so "no recap in the last 7 d" is a
    // sentence the panel can say rather than an unbounded scan for one that is
    // not there.
    safeRead(async () => {
      const { data, error } = await client
        .from('poty_history')
        .select('character_name, award_label, awarded_at, world_day')
        .gte('awarded_at', sinceIso(nowMs, WINDOW_7D_MS))
        .order('awarded_at', { ascending: false })
        .limit(5);
      // Null, not []: "no recap ran in the last 7 d" is an alarm, and raising it
      // because the read broke is the worst thing this panel could do.
      if (error) return null;
      return (data ?? []) as PotyRow[];
    }, null as PotyRow[] | null),

    // The newest row the relay could possibly have to reach. One row, on the
    // events_inserted_at index.
    safeRead(async () => {
      const { data, error } = await client
        .from('events')
        .select('inserted_at')
        .order('inserted_at', { ascending: false })
        .limit(1);
      if (error) return { ok: false, at: null };
      return { ok: true, at: ((data ?? [])[0]?.inserted_at ?? null) as string | null };
    }, { ok: false, at: null } as { ok: boolean; at: string | null }),

    // Head-only count: transfers no rows. Zero after the launch wipe.
    safeRead(async () => {
      if (!launchStartIso) return null;
      const { count, error } = await client
        .from('events')
        .select('id', { count: 'exact', head: true })
        .lt('created_at', launchStartIso);
      if (error) return null;
      return typeof count === 'number' ? count : null;
    }, null as number | null),

    // ── public tables, through the loaders the site itself uses ──
    safeRead(() => getMilestones(), [] as Milestone[]),
    safeRead(() => getMilestoneAggregates(), {} as Aggregates),
    safeRead(() => getBosses(), [] as Boss[]),
    safeRead(() => getUpcomingEvents(10), [] as UpcomingEvent[]),

    // Claims still open. `consumed_at is null` rides the partial index
    // identity_claims_unconsumed_idx; the 7 d ceiling keeps a forgotten pile of
    // codes from ever being an unbounded read.
    safeRead(async () => {
      const { data, error } = await client
        .from('identity_claims')
        .select('code, requested_name, discord_username, expires_at')
        .is('consumed_at', null)
        .gte('expires_at', new Date(nowMs).toISOString())
        .lte('expires_at', new Date(nowMs + WINDOW_7D_MS).toISOString())
        .order('expires_at', { ascending: true })
        .limit(50);
      if (error) return null;
      // Masked here, at the edge, so the raw credential never reaches the render
      // tree, the flight payload, or a screenshot.
      return (data ?? []).map((r) => ({
        codeMasked: maskClaimCode(r.code as string | null),
        requested_name: (r.requested_name ?? null) as string | null,
        discord_username: (r.discord_username ?? null) as string | null,
        expires_at: (r.expires_at ?? null) as string | null,
      })) as ClaimRow[];
    }, null as ClaimRow[] | null),

    // The queue itself, oldest first. The overview shows only the oldest age.
    safeRead(async () => {
      const { data, error } = await client
        .from('voice_lines')
        .select('id, kind, queued_at, meta')
        .eq('status', 'queued')
        .order('queued_at', { ascending: true })
        .limit(100);
      if (error) return null;
      return (data ?? []) as QueuedVoiceLine[];
    }, null as QueuedVoiceLine[] | null),

    // The newest line of ANY status: this is what the ambient min-gap is
    // measured from (voice.js lastVoiceQueuedAt()), so a spoken line counts.
    safeRead(async () => {
      const { data, error } = await client
        .from('voice_lines')
        .select('queued_at')
        .order('queued_at', { ascending: false })
        .limit(1);
      if (error) return null;
      return ((data ?? [])[0]?.queued_at ?? null) as string | null;
    }, null as string | null),

    // The reads /api/titles makes, so the cockpit's answer is the same answer
    // the bot will get from that endpoint at its next titles tick. Behind a 60 s
    // cache of their own: see loadTitleContests above.
    safeRead(() => loadTitleContests(), [] as TitleContestInput[]),

    // Not Postgres: the snapshot loop's own record of the last frame it charted,
    // written to the public `map` bucket on every run. `last-modified` is not a
    // liveness signal here (Supabase leaves it alone on a byte-identical
    // upsert), which is exactly why status.json exists. See lib/data getLiveMap.
    safeRead(async () => {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/map/status.json`,
        { cache: 'no-store' },
      );
      if (!res.ok) return null;
      return (await res.json()) as { capturedAt?: string; worldDay?: number; revealedPct?: number };
    }, null),
  ]);

  // ── the bot's heartbeat, unpacked ──
  // `heartbeats` is null when the read failed and [] when the table is empty.
  // Both give a null bot row, but the page says two different things about them,
  // so the distinction is carried through rather than collapsed here.
  const heartbeatRows = heartbeats ?? [];
  const botRow = heartbeatRows.find((h) => h.component === 'discord-bot') ?? null;
  const botMetrics = (botRow?.metrics ?? {}) as Record<string, unknown>;
  const botSchedule = (botMetrics.schedule ?? null) as BotSchedule | null;
  const botSubLoops = (botMetrics.subLoops ?? botMetrics.loops ?? {}) as Record<string, LoopMetricRow>;
  const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

  const voiceRow = heartbeatRows.find((h) => h.component === 'companion-voice') ?? null;
  const voiceMetrics = (voiceRow?.metrics ?? null) as Record<string, unknown> | null;

  // ── wave two: the one read that needs the cursor ──
  // It cannot join wave one because the cursor arrives with the heartbeat. A
  // head-only count, so a large backlog costs the same as an empty one.
  const cursor = botSchedule?.relayCursor ?? null;
  const relayPending = cursor
    ? await safeRead(async () => {
        const { count, error } = await client
          .from('events')
          .select('id', { count: 'exact', head: true })
          .gt('inserted_at', cursor);
        // Null on error: relayDrain() reads a null count as "no count
        // available" and refuses to call the relay idle on it, which is exactly
        // the behaviour a failed count should get.
        if (error) return null;
        return typeof count === 'number' ? count : null;
      }, null as number | null)
    : null;

  // The sentinel for the four loaders that swallow their own errors. `milestones`
  // and `bosses` are seeded reference tables; the launch wipe resets their rows
  // rather than deleting them, so a working database always answers with rows
  // from at least one of the two. Both empty at once means the public read path
  // is broken, and the page says that once at the top instead of letting the
  // deeds, boss, gathering and titles panels each report a cheerful nothing.
  const publicReadOk = milestones.length > 0 || bosses.length > 0;

  return {
    nowMs,
    fetchMs: performance.now() - started,
    queryCount: DB_READS + (cursor ? 1 : 0),
    storageFetches: 1,
    databaseReachable: true,
    publicReadOk,
    heartbeats,
    botSchedule,
    botSubLoops,
    botFlags: {
      recapChannelIsServer: boolOrNull(botMetrics.recapChannelIsServer),
      milestoneChannelIsServer: boolOrNull(botMetrics.milestoneChannelIsServer),
      recapsStartPulledForward: boolOrNull(botMetrics.recapsStartPulledForward),
    },
    companionCaps: voiceMetrics
      ? {
          targeting: boolOrNull(voiceMetrics.targeting),
          plugin: typeof voiceMetrics.plugin === 'string' ? voiceMetrics.plugin : null,
        }
      : null,
    watchdog: watchdog.row,
    watchdogReadable: watchdog.ok,
    serverStatus,
    lastPoty,
    newestEventInsertedAt: newestEvent.at,
    newestEventReadable: newestEvent.ok,
    relayPending,
    preLaunchEventRows,
    milestones,
    aggregates,
    bosses,
    gatherings,
    claims,
    voiceQueue,
    newestVoiceQueuedAt: newestVoice,
    titles,
    mapCapturedAt: typeof mapStatus?.capturedAt === 'string' ? mapStatus.capturedAt : null,
    mapWorldDay: typeof mapStatus?.worldDay === 'number' ? mapStatus.worldDay : null,
    mapRevealedPct: typeof mapStatus?.revealedPct === 'number' ? mapStatus.revealedPct : null,
  };
}

/** The 24 h window the claims panel highlights inside its 7 d read. */
export const CLAIM_URGENT_MS = WINDOW_24H_MS;

/**
 * Database round trips in the first wave, counted by hand so the page can print
 * its own cost. Keep this in step with the Promise.all above.
 *
 *   8  direct reads here: ops_heartbeats, ops_alerts, poty_history,
 *      events (newest inserted_at), events (pre-launch count, head only),
 *      identity_claims, voice_lines (queued), voice_lines (newest).
 *   1  getServerStatus
 *   1  getMilestones
 *   4  getMilestoneAggregates: player_stats, sessions, players, bosses.
 *      Behind a 60 s unstable_cache, so a warm render issues none of them.
 *   1  getBosses
 *   1  getUpcomingEvents
 *   4  loadTitleContests: players, player_stats, sessions(70 d), events(70 d
 *      deaths). Behind its OWN 60 s unstable_cache, so a second render inside a
 *      minute issues none of them and transfers none of their ~31 kB.
 *
 * Plus one storage fetch (map/status.json), counted separately because it is
 * not a database query, and plus one dependent count in wave two when the bot
 * has reported a relay cursor.
 *
 * MEASURED, against production on 2026-09-06 by counting outbound PostgREST
 * calls in a scratch build: a COLD render (both caches expired) issues 19
 * database round trips plus the 1 storage fetch, and a WARM one issues 13 plus
 * 1. Twenty-one is a ceiling and never a tally, because `bosses` and one
 * `players` read are deduped by the request-level cache with reads the page
 * makes anyway, and the eight cached ones vanish entirely inside a minute.
 *
 * TWENTY IS OVER THE SPEC'S ALLOWANCE OF EIGHT (docs/OPS-COCKPIT-V2.md section
 * 7) AND THAT IS A DELIBERATE, DECLARED EXCEEDANCE, not an oversight. The
 * budget's other half, 2.5 s of server render, is met with an order of
 * magnitude to spare (measured against production with 0 players online:
 * 0.4 s cold, about 0.22 s warm), because all twenty go out in one Promise.all
 * and the page pays for the slowest round trip rather than the sum. Eight of
 * the twenty sit behind a 60 s cache. The spec's rule for not fitting is "drop
 * the panel, not the budget"; the panels here were each asked for by name in
 * this track's brief, so the exceedance is reported for ratification rather
 * than resolved by quietly deleting one. The page prints the count itself so
 * the cost is never silent.
 */
const DB_READS = 20;
