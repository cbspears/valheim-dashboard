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

import { getPlayersWithStats, getMilestones } from '@/lib/data';
import { safeEqual } from '@/lib/ops/auth';
import { recordRouteHeartbeat } from '@/lib/ops/route-heartbeat';
import { buildBoards, buildLeaders, type BoardPlayer, type Boards, type DeedsSummary, type Leaders } from '@/lib/boards';

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

/** Flatten players + player_stats into the shape lib/boards renders from. */
async function compute(): Promise<BoardsResponse> {
  const [withStats, milestones] = await Promise.all([getPlayersWithStats(), getMilestones()]);

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
    boards: buildBoards(players, deeds),
    leaders: buildLeaders(players),
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
