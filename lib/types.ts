// Database row types — mirror the Supabase schema.

export type EventType =
  | 'join'
  | 'leave'
  | 'death'
  | 'boss'
  | 'raid'
  | 'chat'
  | 'craft'
  | 'discovery'
  | string;

export interface Player {
  id: string;
  steam_id: string | null;
  character_name: string;
  discord_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  total_playtime_minutes: number;
  is_online: boolean;
  /** self-described, via Discord ("@Eilif bio: ...") — may be null */
  bio: string | null;
  /** self-described job/role (Cartographer, Shipwright...) — may be null */
  role: string | null;
}

/** A sworn signature on the Oath page, collected via Discord. */
export interface Oath {
  id: string;
  /** the in-game name as the viking gave it */
  character_name: string | null;
  player_id: string | null;
  discord_id: string | null;
  discord_name: string | null;
  oath_text: string;
  match_status: 'exact' | 'fuzzy' | 'unmatched' | string;
  sworn_at: string;
  created_at: string | null;
}

export interface PlayerStats {
  player_id: string;
  kills: number;
  deaths: number;
  resources_harvested: number;
  items_crafted: number;
  distance_traveled: number;
  /** Building pieces placed (Valheim `Builds` stat). */
  structures_built: number;
  /** Percent of the world disc uncovered on the player's best world, 0–100. */
  map_explored_pct: number | null;
  biomes_discovered: string[];
  updated_at: string | null;
}

export interface PlayerWithStats extends Player {
  stats: PlayerStats | null;
}

export interface GameSession {
  id: string;
  player_id: string | null;
  character_name: string | null;
  joined_at: string;
  left_at: string | null;
  duration_minutes: number | null;
}

export interface GameEvent {
  id: string;
  type: EventType;
  player_id: string | null;
  character_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Boss {
  id: string;
  name: string;
  biome: string;
  sort_order: number;
  is_killed: boolean;
  killed_at: string | null;
  players_present: string[];
  notes: string | null;
}

export type RoadmapStatus = 'planned' | 'in_progress' | 'completed' | string;
export type RoadmapType = 'boss' | 'build' | 'milestone' | 'event' | string;

export interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  type: RoadmapType;
  status: RoadmapStatus;
  target_date: string | null;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
}

export interface DiscordEvent {
  id: string;
  discord_event_id: string | null;
  name: string;
  description: string | null;
  host: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string; // scheduled | active | completed | canceled
  user_count: number;
  cover_url: string | null;
  url: string | null;
  /** display label, e.g. "Weekly on Wednesdays" (null = one-off) */
  recurrence: string | null;
  /** roll-forward interval in days (7 = weekly; null = one-off) */
  recurrence_days: number | null;
  updated_at: string | null;
}

/** A DiscordEvent with `starts_at` resolved to its next occurrence (recurring rows rolled forward). */
export interface UpcomingEvent extends DiscordEvent {
  /** the effective next start (ISO) — same as starts_at for one-offs */
  next_at: string;
}

export interface GalleryPhoto {
  id: string;
  url: string;
  storage_path: string | null;
  caption: string | null;
  posted_by: string | null;
  discord_user_id: string | null;
  source_attachment_id: string | null;
  source_message_id: string | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  posted_at: string;
  created_at: string | null;
}

export interface PotyHistoryEntry {
  id: string;
  character_name: string;
  /** category key, e.g. 'boss_kill' | 'most_deaths' | 'underdog' */
  award_category: string;
  /** display label, e.g. '👑 Bane of Beasts (Boss-Slayer)' | '🌟 Unsung Hero' */
  award_label: string;
  world_day: number | null;
  awarded_at: string;
  created_at: string | null;
}

export interface ServerStatus {
  id: number;
  is_online: boolean;
  player_count: number;
  current_players: string[];
  world_day: number;
  updated_at: string | null;
}
