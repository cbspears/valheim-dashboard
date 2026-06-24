// Server-side data access layer.
// All dashboard pages import typed query functions from here so that
// Supabase specifics stay in one place (easy to evolve / swap later).
//
// Reads use the public anon key against RLS "public read" policies.
// Pages that render this data should set `export const dynamic = 'force-dynamic'`
// so live values (online players, server status) are fresh on every request.

import { createClient } from '@supabase/supabase-js';
import type {
  Player,
  PlayerStats,
  PlayerWithStats,
  GameSession,
  GameEvent,
  Boss,
  RoadmapItem,
  ServerStatus,
} from './types';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function getServerStatus(): Promise<ServerStatus | null> {
  const { data } = await db().from('server_status').select('*').eq('id', 1).single();
  return (data as ServerStatus) ?? null;
}

export async function getOnlinePlayers(): Promise<Player[]> {
  const { data } = await db()
    .from('players')
    .select('*')
    .eq('is_online', true)
    .order('character_name');
  return (data as Player[]) ?? [];
}

export async function getAllPlayers(): Promise<Player[]> {
  const { data } = await db()
    .from('players')
    .select('*')
    .order('total_playtime_minutes', { ascending: false });
  return (data as Player[]) ?? [];
}

export async function getPlayersWithStats(): Promise<PlayerWithStats[]> {
  const [players, stats] = await Promise.all([getAllPlayers(), getAllStats()]);
  const byPlayer = new Map(stats.map((s) => [s.player_id, s]));
  return players.map((p) => ({ ...p, stats: byPlayer.get(p.id) ?? null }));
}

export async function getAllStats(): Promise<PlayerStats[]> {
  const { data } = await db().from('player_stats').select('*');
  return (data as PlayerStats[]) ?? [];
}

export async function getRecentEvents(limit = 20): Promise<GameEvent[]> {
  const { data } = await db()
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as GameEvent[]) ?? [];
}

export async function getAllEvents(limit = 200): Promise<GameEvent[]> {
  const { data } = await db()
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as GameEvent[]) ?? [];
}

export async function getRecentSessions(limit = 50): Promise<GameSession[]> {
  const { data } = await db()
    .from('sessions')
    .select('*')
    .order('joined_at', { ascending: false })
    .limit(limit);
  return (data as GameSession[]) ?? [];
}

export async function getActiveSessions(): Promise<GameSession[]> {
  const { data } = await db()
    .from('sessions')
    .select('*')
    .is('left_at', null)
    .order('joined_at', { ascending: false });
  return (data as GameSession[]) ?? [];
}

export async function getBosses(): Promise<Boss[]> {
  const { data } = await db().from('bosses').select('*').order('sort_order');
  return (data as Boss[]) ?? [];
}

export async function getRoadmap(): Promise<RoadmapItem[]> {
  const { data } = await db()
    .from('roadmap')
    .select('*')
    .order('sort_order', { ascending: true });
  return (data as RoadmapItem[]) ?? [];
}
