import { getServerStatus, getOnlinePlayers } from '@/lib/data';
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
  const [status, online] = await Promise.all([
    getServerStatus(),
    getOnlinePlayers(),
  ]);

  // Fall back to live online-player data when no status row is available, so a
  // missing snapshot still yields useful numbers instead of empty defaults.
  const onlineNames = online.map((player) => player.character_name);

  return Response.json(
    {
      online: status?.is_online ?? false,
      players: status?.player_count ?? online.length,
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
