-- Adds the two columns the ServerCharacters .fch stats parser writes:
--   structures_built  — building pieces placed (Valheim `Builds` stat)
--   map_explored_pct  — % of the world disc a player has uncovered (0–100)
--
-- Additive + nullable, so it's safe to run on the live project and trivially
-- reversible (DROP COLUMN). Apply before bringing the stats parser online.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-06-24_player_stats_extra_columns.sql
-- or paste into the Supabase SQL editor.

alter table public.player_stats
  add column if not exists structures_built integer not null default 0,
  add column if not exists map_explored_pct real;

comment on column public.player_stats.structures_built is 'Building pieces placed (Valheim Builds stat), from the .fch profile.';
comment on column public.player_stats.map_explored_pct is 'Percent of the world disc uncovered on the player''s best world, 0-100.';
