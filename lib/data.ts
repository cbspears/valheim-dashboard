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
  DiscordEvent,
  UpcomingEvent,
  GalleryPhoto,
  PotyHistoryEntry,
  Oath,
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

export interface LiveMapFrame {
  day: number;
  url: string;
}

/** The live fog-masked world map snapshot + the per-in-game-day frame archive. */
export async function getLiveMap(): Promise<
  { url: string; updatedAt: string | null; frames: LiveMapFrame[] } | null
> {
  const bucket = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/map`;
  const url = `${bucket}/current.webp`;
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!head.ok) return null;
    let frames: LiveMapFrame[] = [];
    try {
      const mf = await fetch(`${bucket}/frames-manifest.json`, { cache: 'no-store' });
      if (mf.ok) {
        const m = (await mf.json()) as { days?: number[]; prefix?: string };
        frames = (m.days ?? [])
          .filter((d) => Number.isFinite(d))
          .sort((a, b) => a - b)
          .map((day) => ({
            day,
            url: `${bucket}/${m.prefix ?? 'frames-by-day/day-'}${String(day).padStart(4, '0')}.webp`,
          }));
      }
    } catch {
      /* no manifest yet — live-only */
    }
    return { url, updatedAt: head.headers.get('last-modified'), frames };
  } catch {
    return null;
  }
}

/** The sworn oaths, oldest first (the Oath page + Hall teaser). */
export async function getOaths(): Promise<Oath[]> {
  const { data } = await db()
    .from('oaths')
    .select('*')
    .order('sworn_at', { ascending: true })
    .limit(100);
  return (data as Oath[]) ?? [];
}

/** All sessions from the last `days` days, oldest first (attendance calendar, episodes). */
export async function getSessionsSince(days = 70): Promise<GameSession[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db()
    .from('sessions')
    .select('*')
    .gte('joined_at', since)
    .order('joined_at', { ascending: true })
    .limit(2000);
  return (data as GameSession[]) ?? [];
}

/** Events from the last `days` days, oldest first; optionally filtered by type. */
export async function getEventsSince(days = 70, types?: string[]): Promise<GameEvent[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let q = db().from('events').select('*').gte('created_at', since);
  if (types?.length) q = q.in('type', types);
  const { data } = await q.order('created_at', { ascending: true }).limit(2000);
  return (data as GameEvent[]) ?? [];
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

/**
 * Upcoming community events for the dashboard. Recurring rows (recurrence_days)
 * are rolled forward to their next future occurrence, so weekly nights never
 * look stale; one-offs that have passed are dropped (unless still active).
 * Sorted soonest-first.
 */
export async function getUpcomingEvents(limit = 10): Promise<UpcomingEvent[]> {
  const { data } = await db()
    .from('discord_events')
    .select('*')
    .in('status', ['scheduled', 'active'])
    .order('starts_at', { ascending: true });

  const rows = (data as DiscordEvent[]) ?? [];
  const now = Date.now();
  const DAY = 86_400_000;
  const upcoming: UpcomingEvent[] = [];

  for (const ev of rows) {
    let nextMs = new Date(ev.starts_at).getTime();
    if (ev.recurrence_days && ev.recurrence_days > 0) {
      // advance to the next occurrence at or after now
      if (nextMs < now) {
        const step = ev.recurrence_days * DAY;
        nextMs += Math.ceil((now - nextMs) / step) * step;
      }
    } else if (nextMs < now) {
      // a one-off in the past — keep only while it's still ongoing
      const ongoing =
        ev.status === 'active' || (ev.ends_at != null && new Date(ev.ends_at).getTime() > now);
      if (!ongoing) continue;
    }
    upcoming.push({ ...ev, next_at: new Date(nextMs).toISOString() });
  }

  upcoming.sort((a, b) => new Date(a.next_at).getTime() - new Date(b.next_at).getTime());
  return upcoming.slice(0, limit);
}

export async function getGalleryPhotos(limit = 60): Promise<GalleryPhoto[]> {
  const { data } = await db()
    .from('gallery_photos')
    .select('*')
    .order('posted_at', { ascending: false })
    .limit(limit);
  return (data as GalleryPhoto[]) ?? [];
}

/**
 * Player-of-the-Day archive (newest first). The bot writes one row per evening
 * recap; the Vikings page renders a log + derives a "most crowned" tally.
 */
export async function getPotyArchive(limit = 120): Promise<PotyHistoryEntry[]> {
  const { data } = await db()
    .from('poty_history')
    .select('*')
    .order('awarded_at', { ascending: false })
    .limit(limit);
  return (data as PotyHistoryEntry[]) ?? [];
}

export async function getRoadmap(): Promise<RoadmapItem[]> {
  const { data } = await db()
    .from('roadmap')
    .select('*')
    .order('sort_order', { ascending: true });
  return (data as RoadmapItem[]) ?? [];
}
