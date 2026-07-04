-- Automatic boss-kill detection + distance stats for /api/gs-ingest.
--
-- Two halves, both driven off the GsValheimStats mods:
--
--  1. bosses.fight_stats — a jsonb blob holding the fight detail carried by the
--     Emitter/Client `bossKillEvents[]` (fightSec, firstBlood, topDamagePlayer,
--     topDamage, participants, tsUtc, source). The boss-defeat itself (is_killed
--     / killed_at / players_present) is flipped from the server payload's
--     `milestones[]` (the Valheim `defeated_*` global keys) using the EXISTING
--     columns — this only adds the optional enrichment surface for the /boss
--     "Full Record" section.
--
--  2. distance_traveled — ALREADY EXISTS (added by an earlier .fch stats-parser
--     migration; column present on the live project). No DDL needed; the route
--     merges the client's `stats.vh_DistanceTraveled` into it with the same
--     GREATEST semantics as the other cumulative counters. Documented here for
--     completeness only.
--
-- NOT a hard prerequisite: /api/gs-ingest degrades gracefully without
-- fight_stats — the boss flip, timeline event, war-room, bot @everyone and saga
-- all fire from the pre-existing columns; only the extra fight detail is skipped
-- (it falls back to the boss event row's metadata) until this runs. Additive +
-- nullable, safe on the live project, reversible (DROP COLUMN).
--
--   psql "$SUPABASE_DB_URL" -f db/2026-07-04_boss_kills_and_distance.sql
-- or paste into the Supabase SQL editor.

alter table public.bosses
  add column if not exists fight_stats jsonb;

comment on column public.bosses.fight_stats is
  'GsValheimStats bossKillEvents fight detail: {fightSec, firstBlood, topDamagePlayer, topDamage, participants, tsUtc, source}. Server-emitted (server-wide) is preferred over any single client view.';

-- distance_traveled already exists; this is a no-op guard in case a fresh
-- environment is being provisioned from these files in order.
alter table public.player_stats
  add column if not exists distance_traveled bigint not null default 0;

comment on column public.player_stats.distance_traveled is
  'Total metres travelled (Valheim DistanceTraveled stat), cumulative — from the .fch parser or the GsValheimStatsClient stats.vh_DistanceTraveled counter.';
