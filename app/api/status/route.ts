import { getServerStatus, getOnlinePlayerNames } from '@/lib/data';
import { filterExcluded } from '@/lib/excluded';
import { MAX_PLAYERS } from '@/config/server';

export const dynamic = 'force-dynamic';

/** `current_players` is a bare string[]; wrap each name so filterExcluded can read it. */
const asNameRow = (name: unknown) => ({ character_name: String(name ?? '') });

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

  // `server_status.current_players` is written by the ingest paths from the raw
  // in-game roster, so unlike `onlineNames` (which lib/data already filters) it
  // still names excluded characters. Presence is one of the surfaces they stay
  // off — this endpoint is CORS-open and is what the Discord bot and any status
  // widget mean by "who is sailing" — so filter the names here, and take the same
  // number off the count so the list and the tally cannot disagree with each
  // other. The count is never pushed below the length of the list it came with.
  const rawCurrent = Array.isArray(status?.current_players) ? status.current_players : null;
  const currentPlayers = rawCurrent ? filterExcluded(rawCurrent.map(asNameRow)) : null;
  const hidden = rawCurrent ? rawCurrent.length - (currentPlayers?.length ?? 0) : 0;
  const playerCount = status?.player_count != null ? Math.max(0, status.player_count - hidden) : null;

  // `onlineNames` is only ever a fallback: when no status row is available the
  // live roster still yields useful numbers instead of empty defaults.
  return Response.json(
    {
      online: status?.is_online ?? false,
      players: playerCount ?? onlineNames.length,
      maxPlayers: MAX_PLAYERS,
      worldDay: status?.world_day ?? 0,
      currentPlayers: currentPlayers ? currentPlayers.map((r) => r.character_name) : onlineNames,
      updatedAt: status?.updated_at ?? null,
    },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
