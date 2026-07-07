// TV-local data access — deliberately self-contained (see app/tv/layout.tsx).
//
// The /tv feature owns its own fetchers so the two live feeds it introduces
// (in-game chat + live player positions) never leak into the shared data layer
// (lib/data.ts) or the public /map atlas. Same read pattern as lib/data.ts:
// the public anon key against the tables' "public read" RLS policies.
//
// DISPLAY DECREE (Charlie, db/2026-07-07_chat_and_positions.sql): live
// positions render on /tv ONLY. The page filters them to characters that are
// currently online; here we only enforce freshness.

import { createClient } from '@supabase/supabase-js';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

export interface TvChatLine {
  id: string;
  character_name: string;
  message: string;
  created_at: string;
}

/** The most recent mirrored in-game shouts, newest first (TV chat rail). */
export async function getRecentChat(limit = 6): Promise<TvChatLine[]> {
  const { data } = await db()
    .from('chat_lines')
    .select('id, character_name, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as TvChatLine[]) ?? [];
}

export interface TvPosition {
  character_name: string;
  x: number;
  z: number;
  biome: string | null;
  updated_at: string;
}

// A position is only shown while "fresh" — the plugin emits every ~60s, so a
// 3-minute window tolerates a missed beat without pinning stale ghosts to the
// map. The page additionally requires the character to be online.
const FRESH_WINDOW_MS = 3 * 60 * 1000;

/** Live player positions updated within the freshness window (raw world coords). */
export async function getFreshPositions(): Promise<TvPosition[]> {
  const since = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
  const { data } = await db()
    .from('player_positions')
    .select('character_name, x, z, biome, updated_at')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false });
  return (data as TvPosition[]) ?? [];
}
