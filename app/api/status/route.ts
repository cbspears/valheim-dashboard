import { getServerStatus, getOnlinePlayerNames } from '@/lib/data';
import { MAX_PLAYERS } from '@/config/server';

export const dynamic = 'force-dynamic';

// Permissive CORS so external widgets (Discord bots, status badges, uptime
// checks) can read this endpoint from anywhere.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
} as const;

export async function GET() {
  const [status, onlineNames] = await Promise.all([
    getServerStatus(),
    // NAMES ONLY, not the roster (2026-09-06). This route reads `players` for
    // exactly two fallbacks — a count and a list of names — and it is
    // unauthenticated, CORS-open and `no-store`, so every hit pays its egress
    // in full. `getOnlinePlayers()` derives its answer from the whole roster,
    // which is free on a page that already fetched it and is not free here:
    // Route Handlers get no per-request memoization at all. Measured against
    // production: 2,008 bytes for the roster of five, two bytes for this.
    getOnlinePlayerNames(),
  ]);

  // `onlineNames` is only ever a fallback: when no status row is available the
  // live roster still yields useful numbers instead of empty defaults.
  return Response.json(
    {
      online: status?.is_online ?? false,
      players: status?.player_count ?? onlineNames.length,
      maxPlayers: MAX_PLAYERS,
      worldDay: status?.world_day ?? 0,
      currentPlayers: status?.current_players ?? onlineNames,
      updatedAt: status?.updated_at ?? null,
    },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
