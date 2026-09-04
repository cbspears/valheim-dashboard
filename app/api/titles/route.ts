import {
  getPlayersWithStats,
  getOnlinePlayers,
  getSessionsSince,
  getEventsSince,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import { epithetsFor } from '@/lib/epithets';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import type { PlayerWithStats } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Permissive CORS + no-store so the Discord bot (and any status widget) can read
// the current titles from anywhere and never serve a stale computation.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
} as const;

/**
 * The single source of truth for living titles.
 *
 * Computes every viking's current epithet via the SHARED engine (lib/epithets.ts)
 * — the exact same function the site pages render from — so the site and the bot
 * can never disagree. The roster is built the same way the Vikings page builds it
 * (playtime derived live from sessions, since players.total_playtime_minutes is
 * not kept fresh), and each viking's persisted current_title is passed as the
 * hysteresis incumbent so this endpoint's output is stable: it only names a NEW
 * title once a challenger clears a real margin, which is exactly the signal the
 * bot uses to announce.
 */
interface TitlesResponse {
  players: { name: string; title: string; source: string }[];
  count: number;
  generatedAt: string;
}

// Module-level = per serverless instance, exactly like /api/boards. This route is
// UNAUTHENTICATED and CORS-open by design (the bot and any status widget read it
// from anywhere), and every hit costs FOUR Supabase reads — the full roster with
// stats, the online set, 70 days of sessions and 70 days of death events — plus
// the whole epithet engine. A 60 s window makes a flood cost at most one read
// cycle a minute per instance while staying far fresher than the bot's own
// titles loop (10 min). `?fresh=1` skips it for a manual check.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; body: TitlesResponse } | null = null;

export async function GET(request: Request) {
  // Best-effort per-IP throttle (lib/rate-limit), the same first line of defence
  // /api/webhook and /api/gs-ingest already use.
  if (!rateLimit(ipFromRequest(request))) {
    return Response.json({ error: 'rate limited' }, { status: 429, headers: CORS_HEADERS });
  }

  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Response.json(cache.body, { headers: CORS_HEADERS });
  }

  const [withStats, online, sessions, deaths] = await Promise.all([
    getPlayersWithStats(),
    getOnlinePlayers(),
    getSessionsSince(70),
    getEventsSince(70, ['death']),
  ]);

  const onlineNames = new Set(online.map((p) => p.character_name));
  const playtimeByName = playtimeMinutesByCharacter(sessions, onlineNames);
  const roster: PlayerWithStats[] = withStats.map((p) => ({
    ...p,
    total_playtime_minutes:
      playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
  }));

  // Death causes per viking feed the Treefoe override.
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

  // Title the whole warband at once so every viking's epithet is UNIQUE (no two
  // share a title) and consistent with the site. Each viking's persisted
  // current_title is read as the hysteresis incumbent (epithetsFor defaults to the
  // roster's current_title), so a NEW title only surfaces once a challenger clears a
  // real margin — exactly the signal the bot announces on.
  const titles = epithetsFor(roster, { causesByName });
  const players = roster.map((p) => {
    const ep = titles.get(p.character_name);
    return {
      name: p.character_name,
      title: ep?.title ?? '',
      source: ep?.source ?? 'flavor',
    };
  });

  const body: TitlesResponse = {
    players,
    count: players.length,
    generatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), body };
  return Response.json(body, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
