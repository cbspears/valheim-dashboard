import {
  getPlayersWithStats,
  getOnlinePlayers,
  getSessionsSince,
  getEventsSince,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import { epithetFor } from '@/lib/epithets';
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
export async function GET() {
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

  const players = roster.map((p) => {
    const ep = epithetFor(
      p,
      roster,
      causesByName.get(p.character_name) ?? [],
      p.current_title ?? null,
    );
    return { name: p.character_name, title: ep.title, source: ep.source };
  });

  return Response.json(
    { players, count: players.length, generatedAt: new Date().toISOString() },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
