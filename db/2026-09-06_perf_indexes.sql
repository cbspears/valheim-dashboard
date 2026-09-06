-- APPLIED to production 2026-09-05 20:05 CT (Fable session): three additive indexes on sessions, verified present in pg_indexes.
-- 2026-09-06 · Hot-path indexes for `sessions`.
--
-- ⚠️ UNAPPLIED. Nothing in this repo runs migrations; Charlie applies db/*.sql
-- by hand (AGENTS.md → "Database / migrations"). This file has NOT been run
-- against the production project.
--
-- WHY: db/2026-09-04_events_indexes.sql covered `events` and the four unindexed
-- foreign keys, and noted in passing that `sessions` was showing 13,340
-- sequential scans and 0 index scans. It then only added the FK index
-- (`sessions_player_id_idx`), which serves parent deletes — not one of the three
-- shapes the site and the webhook actually read sessions by. Those are:
--
--   1. `joined_at >= <cutoff> order by joined_at`  — lib/data getSessionsSince(),
--      which /players, /events, /viking/[slug], /api/titles and the Great Deeds
--      aggregate all call, and getRecentSessions().
--   2. open session for one player, newest first — app/api/webhook/route.ts
--      §5 runs this on EVERY join and EVERY leave (`left_at is null`,
--      `player_id = …`, `order joined_at desc limit 1`).
--   3. the same by character_name, the fallback the webhook uses when the
--      event carries no player_id.
--
-- `sessions` is the one table that grows strictly with playtime: twenty vikings
-- times a couple of sessions an evening is a few thousand rows by mid-season,
-- and shapes 2 and 3 run on the busiest write path there is. The partial
-- indexes are tiny by construction — they only ever hold the sessions that are
-- open right now, which is at most the player cap.
--
-- Pure additive DDL, no data change, safe to re-run (`if not exists`), and safe
-- to apply before OR after any deploy — nothing in the code depends on them.
-- Written WITHOUT `concurrently` for the same reason the 09-04 file was: these
-- tables are small, and `create index concurrently` cannot run inside the
-- Supabase SQL editor's implicit transaction.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_perf_indexes.sql
-- or paste into the Supabase SQL editor.

-- ── the windowed reads (getSessionsSince / getRecentSessions) ────────────────
create index if not exists sessions_joined_at_idx
  on public.sessions (joined_at desc);

-- ── the webhook's open-session lookup, both keys ────────────────────────────
create index if not exists sessions_open_by_player_idx
  on public.sessions (player_id, joined_at desc)
  where left_at is null;

create index if not exists sessions_open_by_character_idx
  on public.sessions (character_name, joined_at desc)
  where left_at is null;


-- ── DELIBERATELY NOT ADDED, and why ─────────────────────────────────────────
--
-- 1. A case-insensitive index on events.character_name.
--    /api/gs-ingest confirmOnThisServer() matches with ILIKE (a literal, with %
--    and _ escaped), and ILIKE cannot use the btree `events_character_created_idx`
--    that db/2026-09-04_events_indexes.sql added — Postgres does not rewrite
--    ILIKE into lower() equality. So that lookup, which runs on EVERY client
--    payload (one every six seconds at twenty vikings), is a sequential scan of
--    `events`. The fix is a trigram index:
--
--      create extension if not exists pg_trgm with schema extensions;
--      create index if not exists events_character_name_trgm_idx
--        on public.events using gin (character_name extensions.gin_trgm_ops);
--
--    Left commented out on purpose. A GIN index costs something on every insert
--    into the table the poller writes to most, and it will not be chosen while
--    `events` is a few thousand rows — scanning those takes microseconds. Apply
--    it when `events` passes roughly 50k rows (`select count(*) from events;`),
--    or if Supabase's performance advisor starts naming that query.
--
-- 2. An index on players.is_online.
--    Read on every presence event and on every page, but `players` is one row
--    per viking — twenty of them. The planner will keep choosing a sequential
--    scan, correctly, and an index there is maintenance cost for nothing.


-- ── ONE UNKNOWN WORTH SETTLING (not this file's job to fix) ──────────────────
--
-- `players_character_name_key` (db/2026-07-25_players_unique_name.sql) is the
-- only index this codebase has ever assumed and never recorded applying: that
-- file carries no APPLIED marker and no doc mentions it having been run. Its own
-- prereq ("dedupe players by character_name before applying") means it may have
-- been deliberately deferred during the 07-25 incident cleanup.
--
-- No code path depends on it as of 2026-09-06 — /api/webhook's `sync` was briefly
-- written against it with `upsert(..., { onConflict: 'character_name' })`, which
-- would have failed every insert with 42P10 into a console.error if the index is
-- absent, and that was changed back to a plain INSERT for exactly this reason.
-- So this is hygiene, not a blocker. To settle it:
--
--   select indexname from pg_indexes where tablename = 'players';
--
-- If `players_character_name_key` is missing, apply the 07-25 file (it is
-- idempotent, and it is what stops a race forking a viking into two rows).
-- Either way, write the answer into the top of that file so the next reader does
-- not have to guess.
