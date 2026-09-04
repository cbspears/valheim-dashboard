-- Hot-path indexes for `events` + the four unindexed foreign keys.
--
-- WHY: pg_stat_user_tables showed events at 638,565 sequential scans vs 15 index
-- scans (players 176,791, bosses 207,192, identity_claims 154,480, sessions
-- 13,340 with 0 index scans) — every table beyond its primary key is a seq scan.
-- Trivial at ~100 rows, but EVERY client POST does 3-5 of these lookups
-- (confirmOnThisServer, dropStaleLeavers, both death-dedupe windows, the webhook
-- death dedupe) and `events` grows with every join, leave and death for the whole
-- playthrough. Add the indexes before launch week rather than after.
--
-- The two events indexes match the exact predicates in the code:
--   • (character_name, created_at desc) — lib/deaths.ts nearby/eilif window
--     lookups, app/api/webhook death dedupe, gs-ingest presence checks.
--   • (type, created_at desc)          — getEventsSince(), the Saga, How We Die,
--     the bot's relay cursor and recap windows.
-- The four FK indexes are exactly what Supabase's performance advisor lists
-- (an unindexed FK makes every parent delete scan the child table).
--
-- Pure additive DDL, no data change, safe to re-run (`if not exists`), and safe
-- to apply before OR after any deploy — nothing in the code depends on them.
--
-- NOTE: written WITHOUT `concurrently` on purpose — these tables are tiny
-- (~100s of rows) so the brief ACCESS EXCLUSIVE lock is imperceptible, and
-- `create index concurrently` cannot run inside the Supabase SQL editor's
-- implicit transaction.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-04_events_indexes.sql
-- or paste into the Supabase SQL editor.

-- ── events hot paths ────────────────────────────────────────────────────────
create index if not exists events_character_created_idx
  on public.events (character_name, created_at desc);

create index if not exists events_type_created_idx
  on public.events (type, created_at desc);

-- ── unindexed foreign keys (Supabase advisor) ───────────────────────────────
create index if not exists events_player_id_idx
  on public.events (player_id);

create index if not exists oaths_player_id_idx
  on public.oaths (player_id);

create index if not exists sessions_player_id_idx
  on public.sessions (player_id);

create index if not exists title_history_player_id_idx
  on public.title_history (player_id);
