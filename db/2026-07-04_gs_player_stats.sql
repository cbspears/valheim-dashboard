-- GsValheimStatsClient per-player cumulative stats merge.
--
-- The 0.2.9 client mod POSTs a per-player snapshot to /api/gs-ingest every ~120s.
-- The route already consumed deathEvents (real cause of death); this migration
-- adds the columns needed to persist the *cumulative* per-player stats the mod
-- reads out of the local .fch profile + its own combat tracking.
--
-- HARD PREREQUISITE for the stats half of /api/gs-ingest: without these columns
-- the route falls back to writing only the pre-existing base columns (kills /
-- deaths / resources_harvested / items_crafted / structures_built), so the merge
-- degrades gracefully — but damage_dealt, boss records, weapon/creature/boss
-- breakdowns, and the viking "Feats of Arms" section stay empty until this runs.
--
-- Additive + nullable/defaulted, safe on the live project, reversible (DROP COLUMN).
--
--   psql "$SUPABASE_DB_URL" -f db/2026-07-04_gs_player_stats.sql
-- or paste into the Supabase SQL editor.

alter table public.player_stats
  -- Headline (Charlie's named stats — damage done joins resources_harvested +
  -- structures_built, which already exist).
  add column if not exists damage_dealt bigint not null default 0,
  -- Cheap-to-store extras from the client snapshot.
  add column if not exists boss_kills integer not null default 0,
  add column if not exists longest_life_sec integer not null default 0,
  add column if not exists best_kills_before_death integer not null default 0,
  -- Long-tail breakdown (per-weapon records, top creatures slain, boss damage,
  -- skills, top materials, derived records) — a snapshot blob for the rich
  -- "Feats of Arms" surfacing without a column explosion.
  add column if not exists gs_stats jsonb,
  -- Provenance: which character last reported, under which world, and when.
  add column if not exists gs_reporter text,
  add column if not exists gs_world text,
  add column if not exists gs_updated_at timestamptz;

comment on column public.player_stats.damage_dealt is 'Total damage dealt (sum of GsValheimStatsClient per-weapon damageDealt), cumulative.';
comment on column public.player_stats.boss_kills is 'Boss creature kills (GsValheimStatsClient players[].bossKills), cumulative.';
comment on column public.player_stats.longest_life_sec is 'Longest single life in seconds (client-tracked, active playtime).';
comment on column public.player_stats.best_kills_before_death is 'Most kills racked up in a single life (client-tracked).';
comment on column public.player_stats.gs_stats is 'GsValheimStatsClient long-tail breakdown: weapons/creatureKills/bossDamage/skills/materials/records snapshot.';
comment on column public.player_stats.gs_reporter is 'Character name that last reported client stats for this row.';
comment on column public.player_stats.gs_world is 'World name the client filed these stats under.';
comment on column public.player_stats.gs_updated_at is 'When the client last reported cumulative stats for this row.';
