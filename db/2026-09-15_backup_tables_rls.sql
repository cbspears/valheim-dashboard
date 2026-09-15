-- STATUS: APPLIED 2026-09-15 ~13:40 CT via the Supabase MCP.
--
-- Supabase's security advisor (email of 13 Sep, "Table publicly accessible" +
-- "Sensitive data publicly accessible") flagged the four rollback tables the
-- 2026-09-13 stats-audit repairs created with `create table … as select`. A
-- CTAS table in public has no Row-Level Security and inherits the default
-- grants, so the anon key could read every row through PostgREST — including
-- players_steam_rebind_bak_2026_09_13.steam_id, which is exactly the column
-- db/2026-07-11_players_pii_revoke.sql took away from anon on `players`.
--
-- Fix: RLS on with no policies (the service role bypasses RLS, so rollback
-- still works from an operator session) and an explicit revoke from the two
-- API roles as a second lock. Lesson for future repairs: create backup tables
-- with RLS enabled in the same statement block, or put them in a non-exposed
-- schema. They are KEEP-listed in scripts/launch-wipe-tables.test.mjs and
-- meant to be dropped by hand once the repairs have stood for a week.
alter table public.players_steam_rebind_bak_2026_09_13 enable row level security;
alter table public.player_stats_wiped_rows_bak_2026_09_13 enable row level security;
alter table public.player_stats_gs_baseline_bak_2026_09_13 enable row level security;
alter table public.sessions_backfill_2026_09_13 enable row level security;
revoke all on table
  public.players_steam_rebind_bak_2026_09_13,
  public.player_stats_wiped_rows_bak_2026_09_13,
  public.player_stats_gs_baseline_bak_2026_09_13,
  public.sessions_backfill_2026_09_13
from anon, authenticated;
