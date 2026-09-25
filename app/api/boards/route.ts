// Living Boards feed — polled by the server-side Living Boards plugin, which
// writes these strings onto in-game signs (the dashboard's leaderboards, readable
// without leaving Valheim).
//
// CADENCE: the plugin polls about once every 60s. The 30s module cache exists so
// that cadence is the plugin's business and not Supabase's: someone tightening the
// poll to 5s (or three signs polling independently) still costs at most two reads
// a minute, and the served string stays byte-identical inside a window — which is
// what the plugin's write-on-change check wants anyway. `?fresh=1` skips the cache
// for a manual check.
//
// AUTH: Bearer BOARDS_TOKEN, FAIL CLOSED exactly like /api/ops/heartbeat — env
// unset is 503 (never open-access), missing/wrong token is 401. Compared with
// lib/ops/auth's constant-time safeEqual. The token is SERVER-ONLY: it lives on
// the Valheim host's plugin config and in Vercel's env, and unlike the companion
// client's token it never ships inside a player-facing Thunderstore pack.
//
// Reads go through lib/data (anon key + RLS public read) — these are the same
// numbers the public site renders, so this route needs no service-role privilege.
// Board formatting is pure and lives in lib/boards.ts (unit-tested); this file is
// only auth, IO, and the cache.
//
// COVERAGE: the feed carries one board per leaderboard /players shows (ten stat
// boards), plus Living Titles, Great Deeds and the world day — thirteen in
// `boards`, and a leader plaque for each of the ten ranked ones in `leaders`.
//
// `keys`: the marker vocabulary, top-level and flat (lib/boards BOARD_KEYS). It
// lists EVERY board key this payload carries, stat boards first, so a plugin can
// claim any sign whose text is `[board:<key>]` for a key in that array — and
// `[board:<key>:leader]` for any key that also appears in `leaders` — without
// being rebuilt the next time a board is added here. Keys are append-only and
// never re-spelled: a sign in the world is already claimed with the old one, and
// the deployed 0.2.0 plugin still reads its eight fixed fields by name and
// ignores everything else (DataContractJsonSerializer binds what it declares).

import {
  getPlayersWithStats,
  getMilestones,
  getServerStatus,
  getSessionsSince,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import { safeEqual } from '@/lib/ops/auth';
import { recordRouteHeartbeat } from '@/lib/ops/route-heartbeat';
import {
  buildBoards,
  buildLeaders,
  BOARD_KEYS,
  type BoardPlayer,
  type Boards,
  type DeedsSummary,
  type Leaders,
} from '@/lib/boards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** An authed payload must never be cached by Vercel's edge or the plugin's HTTP stack. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const CACHE_TTL_MS = 30_000;

// `leaders` is a SIBLING of `boards`, never a replacement: the deployed plugin parses this
// payload with DataContractJsonSerializer, which binds the members it declares and skips the
// rest (that is how the undeclared `data` has always been ignored). So adding a member is
// invisible to a 0.1.0 plugin in the field, and a 0.2.0 plugin asked for a leader plaque by a
// feed that predates this line just gets null and falls back to the full board.
interface BoardsResponse {
  generatedAt: string;
  boards: Boards;
  leaders: Leaders;
  /** Every board key `boards` carries — see the `keys` note in the header. */
  keys: string[];
  data: { players: BoardPlayer[]; deeds: DeedsSummary };
}

// Module-level = per serverless instance. A cold instance just does the reads;
// there is no correctness cost to a miss, only a Supabase round trip.
let cache: { at: number; body: BoardsResponse } | null = null;

/** Extract a Bearer token from the Authorization header. */
function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Total catches for one viking — the GREATER of the per-species `gs_stats.fish`
 * sum and the profile's own `gs_stats.fishCaught`.
 *
 * Deliberately the same rule as `totalCatches` on /players (and FeatsOfArms on a
 * viking page): GsValheimStatsClient reports `fish: []` for everyone on Valheim
 * 1.0, so the species breakdown alone is a row of zeros, while the profile total
 * carries no species detail. Taking the max loses neither source. Kept here in
 * the IO layer rather than in lib/boards because it reads a third-party blob —
 * lib/boards stays pure and renders from flat numbers.
 */
function totalCatches(stats: { gs_stats?: { fish?: { count: number }[]; fishCaught?: number } | null } | null): number {
  const gs = stats?.gs_stats;
  const bySpecies = (gs?.fish ?? []).reduce((sum, f) => sum + (f.count ?? 0), 0);
  return Math.max(bySpecies, gs?.fishCaught ?? 0);
}

/**
 * The world day for the Day board — `server_status.world_day`, the same single row
 * /api/status reads, through the same lib/data accessor (anon key + the retrying
 * fetch wrapper every read on this route already goes through).
 *
 * NEVER fatal. The Day board is one plank; the other twelve are the reason the plugin
 * polls, so a status row that is missing, unreadable or mid-outage returns null and
 * renders the board's empty state instead of taking the whole feed down with a 500.
 * One console.warn per request says which of the two happened.
 */
async function readWorldDay(): Promise<number | null> {
  try {
    const day = (await getServerStatus())?.world_day;
    if (typeof day === 'number' && Number.isFinite(day)) return day;
    console.warn('[boards] world day unavailable: no usable server_status row');
    return null;
  } catch (err) {
    console.warn('[boards] world day read failed:', err instanceof Error ? err.message : 'error');
    return null;
  }
}

/** Flatten players + player_stats (+ sessions, for hours) into the shape lib/boards renders from. */
async function compute(): Promise<BoardsResponse> {
  // `sessions` is the third read, and only the Hours board needs it: the real
  // pipeline never writes `players.total_playtime_minutes`, so /players derives
  // hours live from session rows and this feed has to derive them the same way or
  // the sign and the site would disagree. Behind the same 30 s cache as the rest,
  // and already filtered of excluded vikings inside getSessionsSince.
  const [withStats, milestones, sessions, worldDay] = await Promise.all([
    getPlayersWithStats(),
    getMilestones(),
    getSessionsSince(70),
    // Fourth read, and the only one that swallows its own failure — see readWorldDay.
    readWorldDay(),
  ]);

  // Who is online comes off the roster rows already in hand — an open session only
  // counts as live time for a viking actually on the server (same rule as /players),
  // and a Route Handler gets no per-request memoization, so re-reading `players`
  // through getOnlinePlayers() would be a second round trip for a field we have.
  const onlineNames = new Set(withStats.filter((p) => p.is_online).map((p) => p.character_name));
  const playtimeByName = playtimeMinutesByCharacter(sessions, onlineNames);

  const players: BoardPlayer[] = withStats.map((p) => ({
    name: p.character_name,
    title: p.current_title ?? null,
    kills: p.stats?.kills ?? 0,
    deaths: p.stats?.deaths ?? 0,
    builds: p.stats?.structures_built ?? 0,
    resources: p.stats?.resources_harvested ?? 0,
    crafts: p.stats?.items_crafted ?? 0,
    distanceM: p.stats?.distance_traveled ?? 0,
    exploredPct: p.stats?.map_explored_pct ?? null,
    longestLifeSec: p.stats?.longest_life_sec ?? 0,
    bestKillsBeforeDeath: p.stats?.best_kills_before_death ?? 0,
    damageDealt: p.stats?.damage_dealt ?? 0,
    playtimeMin: playtimeByName.get(p.character_name) ?? 0,
    fishCaught: totalCatches(p.stats),
  }));

  // "Most recent" is by achieved_at, not by the display `sort` order — the sign
  // is reporting what the warband just earned.
  const achieved = milestones.filter((m) => m.achieved_at);
  const latest = achieved
    .slice()
    .sort((a, b) => String(b.achieved_at).localeCompare(String(a.achieved_at)))[0];
  const deeds: DeedsSummary = {
    achieved: achieved.length,
    total: milestones.length,
    latest: latest ? { title: latest.title, achievedAt: latest.achieved_at } : null,
  };

  return {
    generatedAt: new Date().toISOString(),
    boards: buildBoards(players, deeds, worldDay),
    leaders: buildLeaders(players),
    keys: [...BOARD_KEYS],
    data: { players, deeds },
  };
}

export async function GET(request: Request) {
  // ---- 1. Auth (fail closed) ----------------------------------------------
  const expected = process.env.BOARDS_TOKEN;
  if (!expected) {
    return Response.json({ error: 'boards not configured' }, { status: 503, headers: NO_STORE });
  }
  const provided = bearer(request);
  if (!provided || !safeEqual(provided, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // ---- 1b. Liveness for the in-game signs ---------------------------------
  // The Boards plugin cannot heartbeat for itself, but an AUTHED poll is proof it
  // is running and still holds the token — the one thing that goes silently wrong
  // (a 401 after a rotation logs once to LogOutput.log and leaves stale numbers on
  // the signs forever). Recorded only after the token check, throttled to once a
  // minute per instance, and never allowed to fail the response. Awaited rather
  // than fire-and-forget: a serverless invocation can be frozen the moment the
  // response returns, and a dropped write would read as "the signs are dead".
  await recordRouteHeartbeat('boards-plugin');

  // ---- 2. Serve from cache unless asked for a fresh read -------------------
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    // Served byte-identically to a fresh response on purpose: the plugin diffs the
    // strings to decide whether to rewrite a sign, so a "cached" marker would be
    // noise it has to strip.
    return Response.json(cache.body, { headers: NO_STORE });
  }

  // ---- 3. Compute -----------------------------------------------------------
  try {
    const body = await compute();
    cache = { at: Date.now(), body };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    // Caller-safe message only — never leak the connection or the raw error.
    console.error('[boards] compute failed:', err instanceof Error ? err.message : 'error');
    return Response.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
  }
}
