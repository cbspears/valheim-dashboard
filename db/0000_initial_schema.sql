-- ============================================================================
-- BASE SCHEMA — EXPORTED FROM PRODUCTION 2026-09-04. DISASTER RECOVERY ONLY.
-- ============================================================================
--
-- This file is NOT a migration to apply to the live project — every object in it
-- already exists there. It exists because, until now, the base schema lived ONLY
-- inside the database: db/*.sql started at 2026-06-24_player_stats_extra_columns
-- (an ALTER), and nothing in the repo, the docs or the scripts created players,
-- sessions, events, player_stats, bosses, roadmap or server_status. The Supabase
-- project (syuwavxpmtdmxupxjzje) is on the FREE plan, which has no automated
-- daily backups and no PITR, so a deleted project or a destructive DDL mistake
-- would have taken the schema with the data.
--
-- WHAT THIS IS: the `initial_schema` migration (version 20260624203209) exactly
-- as stored in supabase_migrations.schema_migrations, copied VERBATIM — same
-- statements, same order, same casing, no reformatting, no `if not exists`
-- guards added. Exported read-only via
--   select name, statements from supabase_migrations.schema_migrations
--    where name = 'initial_schema';
--
-- WHEN YOU WOULD RUN IT: rebuilding this database from nothing (a new Supabase
-- project after a loss, or a local/staging clone). Run it FIRST, then every
-- other db/*.sql in filename (date) order. Re-running it against the live
-- project WILL FAIL on the first CREATE TABLE — that is the intended guard.
--
-- WHAT IT DOES NOT COVER: the two later hand-applied columns and the drift
-- reconciled in db/2026-09-04_reconcile_drift.sql, the storage buckets (gallery
-- photos), and none of the DATA except the two seed INSERTs below (server_status
-- row 1 and the eight boss rows). A schema file is not a backup — the standing
-- recommendation (backend-2) is a periodic `supabase db dump` to the NAS.
--
-- ---------------------------------------------------------------------------
-- BEGIN VERBATIM EXPORT (supabase_migrations.schema_migrations, name =
-- 'initial_schema', version = 20260624203209, statements[1])
-- ---------------------------------------------------------------------------

-- Players
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT UNIQUE,
  character_name TEXT NOT NULL,
  discord_id TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  total_playtime_minutes INTEGER DEFAULT 0,
  is_online BOOLEAN DEFAULT FALSE
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  character_name TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  duration_minutes INTEGER
);

-- Events feed
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  character_name TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Player stats (leaderboards)
CREATE TABLE player_stats (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  kills INTEGER DEFAULT 0,
  deaths INTEGER DEFAULT 0,
  resources_harvested INTEGER DEFAULT 0,
  items_crafted INTEGER DEFAULT 0,
  distance_traveled REAL DEFAULT 0,
  biomes_discovered TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bosses (world progress gates)
CREATE TABLE bosses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  biome TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_killed BOOLEAN DEFAULT FALSE,
  killed_at TIMESTAMPTZ,
  players_present TEXT[] DEFAULT '{}',
  notes TEXT
);

-- Roadmap
CREATE TABLE roadmap (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'milestone',
  status TEXT DEFAULT 'planned',
  target_date DATE,
  completed_at TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Server status (single row)
CREATE TABLE server_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  is_online BOOLEAN DEFAULT FALSE,
  player_count INTEGER DEFAULT 0,
  current_players TEXT[] DEFAULT '{}',
  world_day INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO server_status (id) VALUES (1);

-- Seed bosses
INSERT INTO bosses (name, biome, sort_order) VALUES
  ('Eikthyr', 'Meadows', 1),
  ('The Elder', 'Black Forest', 2),
  ('Bonemass', 'Swamp', 3),
  ('Moder', 'Mountain', 4),
  ('Yagluth', 'Plains', 5),
  ('The Queen', 'Mistlands', 6),
  ('Fader', 'Ashlands', 7),
  ('The Bog Witch', 'Deep North', 8);

-- Enable RLS
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE bosses ENABLE ROW LEVEL SECURITY;
ALTER TABLE roadmap ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_status ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "public read players" ON players FOR SELECT USING (true);
CREATE POLICY "public read sessions" ON sessions FOR SELECT USING (true);
CREATE POLICY "public read events" ON events FOR SELECT USING (true);
CREATE POLICY "public read player_stats" ON player_stats FOR SELECT USING (true);
CREATE POLICY "public read bosses" ON bosses FOR SELECT USING (true);
CREATE POLICY "public read roadmap" ON roadmap FOR SELECT USING (true);
CREATE POLICY "public read server_status" ON server_status FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- END VERBATIM EXPORT
-- ---------------------------------------------------------------------------
