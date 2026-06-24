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
}

export interface PlayerStats {
  player_id: string;
  kills: number;
  deaths: number;
  resources_harvested: number;
  items_crafted: number;
  distance_traveled: number;
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

export interface ServerStatus {
  id: number;
  is_online: boolean;
  player_count: number;
  current_players: string[];
  world_day: number;
  updated_at: string | null;
}
