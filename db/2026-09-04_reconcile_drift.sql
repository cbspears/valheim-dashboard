-- APPLIED TO PROD 2026-09-04 (Supabase MCP apply_migration, recorded as `reconcile_drift_2026_09_04` in supabase_migrations.schema_migrations).
-- Reconcile the three places where db/*.sql and PRODUCTION disagree (backend-8).
--
-- Some migrations were applied by hand through the Supabase SQL editor rather
-- than through the MCP, so `supabase_migrations.schema_migrations` never recorded
-- them and, in three cases, what the repo file DECLARES is not what the live
-- project HAS. Verified read-only on 2026-09-04 against syuwavxpmtdmxupxjzje.
-- Each statement below is idempotent and safe to re-run.
--
-- ORDER: independent of any deploy — apply whenever. Nothing in the running code
-- depends on these; they close the gap between the files and reality so a
-- rebuild from db/*.sql lands on the same schema prod actually runs.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-04_reconcile_drift.sql
-- or paste into the Supabase SQL editor.

-- ── 1. title_history: the declared index was never created ──────────────────
-- db/2026-07-05_titles.sql ends with this index, but pg_indexes on
-- title_history shows ONLY title_history_pkey — the applied `living_titles`
-- migration differed from the file. (The file's `player_id NOT NULL` and its
-- `created_at` column are likewise absent in prod; both are deliberately left
-- alone here — tightening a live column's nullability and adding a column the
-- code never reads is a change to make on purpose, not as drift cleanup. The
-- repo file should be read as "what a rebuild would create", and prod as
-- "player_id nullable, no created_at".)
create index if not exists title_history_player_idx
  on public.title_history (player_id, awarded_at desc);

-- ── 2. gallery_photos.discord_author_id exists in prod, in no db/*.sql ──────
-- Added by hand when the bot started recording who posted a photo. Declaring it
-- here so a rebuild from these files produces the column the bot writes.
alter table public.gallery_photos
  add column if not exists discord_author_id text;

comment on column public.gallery_photos.discord_author_id is
  'Discord user id of the poster, recorded by the bot''s gallery ingest. Added by hand in prod; declared in db/ as of 2026-09-04.';

-- ── 3. player_stats.distance_traveled is real (float4) in prod ──────────────
-- db/2026-07-04_boss_kills_and_distance.sql describes it as `bigint`; the column
-- was actually created by the initial schema as REAL. float4 carries only a
-- 24-bit mantissa, so metres stop being exact above ~16.7 million — reachable
-- over a months-long playthrough (16,777,217 m would store as 16,777,216) and it
-- silently rounds every cumulative merge near that ceiling. Widen to double
-- precision: lossless for every value currently stored, no rewrite risk at this
-- row count, and the column stays a float so nothing that reads it changes.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'player_stats'
       and column_name = 'distance_traveled'
       and data_type = 'real'
  ) then
    alter table public.player_stats
      alter column distance_traveled type double precision;
  end if;
end;
$$;

comment on column public.player_stats.distance_traveled is
  'Total metres travelled (Valheim DistanceTraveled), cumulative — from the .fch parser or GsValheimStatsClient stats.vh_DistanceTraveled. double precision since 2026-09-04 (was real: only ~7 significant digits).';
