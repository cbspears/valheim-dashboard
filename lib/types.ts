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

/** GsValheimStatsClient long-tail breakdown blob (player_stats.gs_stats jsonb). */
export interface GsClientStats {
  weapons: { weapon: string; damageDealt: number; kills: number; hardestHit: number; biggestSwing: number }[];
  creatureKills: { creature: string; kills: number }[];
  bossDamage: { boss: string; damageDealt: number; fightSec: number }[];
  skills: { skill: string; level: number }[];
  materials: { material: string; amount: number }[];
  records: {
    topWeapon: string | null;
    topWeaponDamage: number;
    hardestHit: number;
    biggestSwing: number;
  };
  currentLifeStartedUtc: string | null;
  platformId: string | null;
  /**
   * Per-mode distance counters (metres) from the .fch profile, folded in by
   * /api/gs-ingest. Optional so blobs written before this landed still type.
   */
  distances?: {
    total: number;
    walk: number;
    run: number;
    sail: number;
    air: number;
  };
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
  // ── GsValheimStatsClient merge (db/2026-07-04_gs_player_stats.sql) ──
  // Optional so rows written before the migration / by other writers still type.
  /** Total damage dealt (sum of per-weapon damageDealt), cumulative. */
  damage_dealt?: number;
  /** Boss creature kills, cumulative. */
  boss_kills?: number;
  /** Longest single life in seconds (client-tracked active playtime). */
  longest_life_sec?: number;
  /** Most kills in a single life (client-tracked). */
  best_kills_before_death?: number;
  /** Long-tail breakdown: weapons/creatures/boss/skills/materials/records. */
  gs_stats?: GsClientStats | null;
  gs_reporter?: string | null;
  gs_world?: string | null;
  gs_updated_at?: string | null;
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
  /**
   * Fight detail from GsValheimStats bossKillEvents (db/2026-07-04_boss_kills_and_distance.sql).
   * Optional so rows read before the migration still type. Powers the /boss
   * "Full Record" surface.
   */
  fight_stats?: {
    fightSec?: number;
    firstBlood?: string | null;
    topDamagePlayer?: string | null;
    topDamage?: number;
    participants?: number;
    tsUtc?: string;
    source?: string;
    /** The TRUE fighters (dealt damage to / MVP'd this boss) — the honest war party. */
    fighters?: string[];
    /** The reconciled online roster at kill time — for the "also in the realm" note. */
    onlineAtKill?: string[];
  } | null;
  /**
   * Skald-written saga retelling of the fight, generated once per kill by the
   * Discord bot (db/2026-07-05_boss_retelling.sql). Optional so rows read before
   * the migration still type; the /boss "Retelling" surface renders it verbatim.
   */
  retelling?: string | null;
  retelling_generated_at?: string | null;
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
  // Gallery ↔ map link (db/2026-07-04_gallery_pin_link.sql). Optional so rows
  // read before the migration still type. `pin` is the embedded place, when linked.
  pin_id?: string | null;
  pin?: { name: string; kind: string } | null;
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
