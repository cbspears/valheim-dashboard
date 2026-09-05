// Server-side data access layer.
// All dashboard pages import typed query functions from here so that
// Supabase specifics stay in one place (easy to evolve / swap later).
//
// Reads use the public anon key against RLS "public read" policies.
// Pages that render this data should set `export const dynamic = 'force-dynamic'`
// so live values (online players, server status) are fresh on every request.

import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type {
  Player,
  PlayerStats,
  PlayerWithStats,
  GameSession,
  GameEvent,
  Boss,
  ServerStatus,
  DiscordEvent,
  UpcomingEvent,
  GalleryPhoto,
  PotyHistoryEntry,
  Oath,
  Milestone,
} from './types';
import { computeAggregates, type Aggregates } from './milestones';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

// Explicit column list for public player reads — every players column EXCEPT
// `steam_id`, which is a real external Steam account id the public site never
// uses. Paired with a REVOKE SELECT (steam_id) ... FROM anon migration so a
// direct PostgREST call with the (public) anon key can't harvest it either.
// (discord_user_id/discord_username stay readable — the viking page needs them.)
const PLAYERS_PUBLIC_COLS =
  'id, character_name, discord_id, first_seen_at, last_seen_at, total_playtime_minutes, is_online, bio, role, discord_user_id, discord_username, current_title, title_updated_at';

export async function getServerStatus(): Promise<ServerStatus | null> {
  const { data } = await db().from('server_status').select('*').eq('id', 1).single();
  return (data as ServerStatus) ?? null;
}

/**
 * How long `server_status.updated_at` may go without a refresh before the site
 * stops presenting the live stats as live. The GsValheimStats Emitter rewrites
 * that row every 120 s while the server runs, so 15 minutes is ~7 missed
 * cycles: the Emitter (closed source, no 1.0 statement — audit mods-7) has
 * stopped, not hiccuped. `is_online` is kept honest separately by the log
 * poller, which reads joins and leaves out of the server log and does not
 * depend on the Emitter at all.
 */
export const STATS_STALE_AFTER_MS = 15 * 60 * 1000;

export interface StatsFreshness {
  /** True only when the server reads as online but the stats feed has gone quiet. */
  statsStale: boolean;
  /** Age of `server_status.updated_at` in ms; null when it is missing or unreadable. */
  statsAgeMs: number | null;
}

/**
 * Is the live stats feed (Emitter → server_status) keeping up with a server
 * that is actually up? An offline server is its own story and never counts as
 * stale — the Hearth already says the hall sleeps. An online server with no
 * usable timestamp at all counts as stale: there is no evidence the feed is
 * running, and the site must degrade honestly rather than imply it is.
 */
export function statsFreshness(
  status: ServerStatus | null,
  now: number = Date.now()
): StatsFreshness {
  if (!status || !status.is_online) {
    return { statsStale: false, statsAgeMs: ageMs(status?.updated_at ?? null, now) };
  }
  const age = ageMs(status.updated_at, now);
  if (age === null) return { statsStale: true, statsAgeMs: null };
  return { statsStale: age > STATS_STALE_AFTER_MS, statsAgeMs: age };
}

/** Milliseconds between `iso` and `now`, or null when `iso` can't be read. Never negative. */
function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

export async function getOnlinePlayers(): Promise<Player[]> {
  const { data } = await db()
    .from('players')
    .select(PLAYERS_PUBLIC_COLS)
    .eq('is_online', true)
    .order('character_name');
  return (data as Player[]) ?? [];
}

export async function getAllPlayers(): Promise<Player[]> {
  const { data } = await db()
    .from('players')
    .select(PLAYERS_PUBLIC_COLS)
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

/**
 * How long the live map composite may go without a refresh before /map stops
 * calling it live. scripts/map-snapshot.mjs re-uploads `map/current.webp` every
 * 5 minutes, so 6 hours is ~72 missed cycles — the WebMap plugin, the SFTP
 * pull, or the snapshot service itself has stopped (audit mods-8), not a blip.
 */
export const MAP_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface LiveMap {
  url: string;
  /** `last-modified` of current.webp, i.e. when the composite was last charted. */
  updatedAt: string | null;
  frames: LiveMapFrame[];
  /** True when the composite is older than MAP_STALE_AFTER_MS, or its age is unknown. */
  stale: boolean;
  /** Age of the composite in ms; null when `last-modified` is missing or unreadable. */
  ageMs: number | null;
}

/**
 * Is the map composite still being refreshed? An unreadable or absent
 * `last-modified` counts as stale: freshness can't be proven, and a paused map
 * shown as live is exactly the lie this guard exists to prevent. The archived
 * day frames are unaffected — the timelapse keeps working either way.
 */
export function mapFreshness(
  updatedAt: string | null,
  now: number = Date.now()
): { stale: boolean; ageMs: number | null } {
  const age = ageMs(updatedAt, now);
  if (age === null) return { stale: true, ageMs: null };
  return { stale: age > MAP_STALE_AFTER_MS, ageMs: age };
}

/** The live fog-masked world map snapshot + the per-in-game-day frame archive. */
export async function getLiveMap(): Promise<LiveMap | null> {
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
    const updatedAt = head.headers.get('last-modified');
    return { url, updatedAt, frames, ...mapFreshness(updatedAt) };
  } catch {
    return null;
  }
}

export interface LivePin {
  id: string;
  name: string;
  kind: 'base' | 'poi';
  by_character_name: string | null;
  x: number;
  y: number;
  day: number | null;
}

/** Real player-placed pins on the live map (via in-game /pin). */
export async function getPins(): Promise<LivePin[]> {
  const { data } = await db()
    .from('pins')
    .select('id, name, kind, by_character_name, x, y, day')
    .order('created_at', { ascending: true });
  return (data as LivePin[]) ?? [];
}

/**
 * Pins as the Saga episode builder needs them: name + kind + author + the
 * created_at instant, so each place can be bucketed to its America/Chicago
 * calendar day. Oldest first. Separate from getPins() (which powers the live
 * map and omits created_at) so neither caller drags the other's columns.
 */
export async function getPinsForEpisodes(days = 70): Promise<
  { name: string; kind: string | null; by_character_name: string | null; created_at: string }[]
> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db()
    .from('pins')
    .select('name, kind, by_character_name, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(2000);
  return (
    (data as { name: string; kind: string | null; by_character_name: string | null; created_at: string }[]) ??
    []
  );
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

/**
 * Live-computed total playtime per character, in minutes, from session rows.
 *
 * The `players.total_playtime_minutes` column is only as fresh as whatever
 * last wrote it (historically the demo seed); the real log-poller pipeline
 * doesn't currently maintain it, so it reads back as 0 for every real viking
 * even though sessions with real durations exist. Deriving it here from the
 * sessions the pages already fetch keeps "Hours Logged" / "Total Time"
 * truthful without touching the poller.
 *
 * Sessions with a `duration_minutes` are trusted as-is. A session still open
 * (`left_at` null) only counts elapsed time (`joined_at` -> now) if the
 * character is *currently online* per `players.is_online` — i.e. it's
 * genuinely their live session. Any other open session (the poller missed a
 * `leave`, so it never closed) is dropped rather than guessed at — crediting
 * it with elapsed real time would count an overnight AFK/disconnect, or a
 * stale session left behind by a since-ended one, as active playtime.
 *
 * @param onlineNames character_names currently online (from the `players`
 *   table), used to decide which open session, if any, is still live.
 */
export function playtimeMinutesByCharacter(
  sessions: GameSession[],
  onlineNames: ReadonlySet<string> = new Set()
): Map<string, number> {
  const byName = new Map<string, GameSession[]>();
  for (const s of sessions) {
    if (!s.character_name) continue;
    const arr = byName.get(s.character_name) ?? [];
    arr.push(s);
    byName.set(s.character_name, arr);
  }

  const now = Date.now();
  const totals = new Map<string, number>();
  for (const [name, list] of byName) {
    const sorted = [...list].sort(
      (a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
    );
    let total = 0;
    sorted.forEach((s, i) => {
      if (s.duration_minutes != null) {
        total += s.duration_minutes;
        return;
      }
      // Open session: only the most recent one, for a character currently
      // online, counts as live. Earlier/stale dangling opens are unknown
      // duration — skip rather than overcount.
      if (i === sorted.length - 1 && onlineNames.has(name)) {
        total += Math.max(0, Math.round((now - new Date(s.joined_at).getTime()) / 60_000));
      }
    });
    totals.set(name, total);
  }
  return totals;
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

/**
 * The single soonest gathering, for the nav bar's pill.
 *
 * The nav renders inside the root layout, i.e. on EVERY route — including the
 * two pages that are prerendered at build time (/mods, /get-started). An
 * uncached read here would drag both of them into per-request rendering, so
 * this one goes through the data cache with a five-minute life. Every other
 * page already sets `dynamic = 'force-dynamic'` and is unaffected.
 */
export const getNextEvent = unstable_cache(
  async (): Promise<UpcomingEvent | null> => {
    const [next] = await getUpcomingEvents(1);
    return next ?? null;
  },
  ['nav-next-event'],
  { revalidate: 300, tags: ['discord-events'] }
);

export async function getGalleryPhotos(limit = 60): Promise<GalleryPhoto[]> {
  // Embed the linked map pin (place name) so the Gallery can show a place tag.
  // Falls back to a plain select if the pin_id column/FK isn't live yet
  // (db/2026-07-04_gallery_pin_link.sql not applied), so pages never crash.
  const withPin = await db()
    .from('gallery_photos')
    .select('*, pin:pins(name, kind)')
    .order('posted_at', { ascending: false })
    .limit(limit);
  if (!withPin.error) return (withPin.data as GalleryPhoto[]) ?? [];

  const { data } = await db()
    .from('gallery_photos')
    .select('*')
    .order('posted_at', { ascending: false })
    .limit(limit);
  return (data as GalleryPhoto[]) ?? [];
}

export interface PinPhoto {
  id: string;
  url: string;
  caption: string | null;
  posted_by: string | null;
  posted_at: string;
}

/**
 * Photos linked to a map pin, keyed by pin_id — powers the map's place panel.
 * Returns an empty map if the pin_id column isn't live yet (pre-migration).
 */
export async function getPhotosByPin(): Promise<Record<string, PinPhoto[]>> {
  const { data, error } = await db()
    .from('gallery_photos')
    .select('id, url, caption, posted_by, posted_at, pin_id')
    .not('pin_id', 'is', null)
    .order('posted_at', { ascending: true });
  if (error || !data) return {};
  const byPin: Record<string, PinPhoto[]> = {};
  for (const row of data as (PinPhoto & { pin_id: string })[]) {
    (byPin[row.pin_id] ??= []).push({
      id: row.id,
      url: row.url,
      caption: row.caption,
      posted_by: row.posted_by,
      posted_at: row.posted_at,
    });
  }
  return byPin;
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

/**
 * Collective Milestones ("Great Deeds"), ordered for display. Returns [] when
 * the table isn't live yet (db/2026-07-05_milestones.sql not applied) so the
 * Hall + World surfaces render an empty state instead of crashing.
 */
export async function getMilestones(): Promise<Milestone[]> {
  const { data, error } = await db().from('milestones').select('*').order('sort', { ascending: true });
  if (error) return []; // pre-migration (missing table) — degrade to empty
  return (data as Milestone[]) ?? [];
}

/**
 * The live server-wide aggregate for every milestone metric, computed with the
 * SAME pure maths as the evaluator (lib/milestones), so the dashboard's progress
 * bars match what the evaluator will fire. One batch of reads: all player_stats,
 * a wide window of sessions (for the playtime derivation), and the online roster.
 */
export async function getMilestoneAggregates(): Promise<Aggregates> {
  const [statsRes, sessions, online, bosses] = await Promise.all([
    db().from('player_stats').select('*'),
    getSessionsSince(400),
    getOnlinePlayers(),
    // boss_kills_total counts DISTINCT Forsaken felled (bosses.is_killed), not
    // the sum of each viking's repeatable boss-kill counter — see
    // AggregateInput.bossesKilled. Fetched here so the /world progress bars show
    // exactly the number the evaluator will fire on.
    getBosses(),
  ]);
  const stats = (statsRes.data as Record<string, unknown>[] | null) ?? [];
  const onlineNames = new Set(online.map((p) => p.character_name));
  const bossesKilled = bosses.filter((b) => b.is_killed).length;
  return computeAggregates({ stats, sessions, onlineNames, bossesKilled });
}
