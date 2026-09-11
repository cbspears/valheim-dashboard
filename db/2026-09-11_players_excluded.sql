-- STATUS: APPLIED TO PROD 2026-09-11 09:45 CT (column, comment, grants; Steward flipped by hand the same minute). Written 2026-09-11. Apply by hand (Supabase SQL editor or
-- `psql "$SUPABASE_DB_URL" -f db/2026-09-11_players_excluded.sql`), then flip this
-- line to "APPLIED TO PROD <date>" the way every other file in db/ records it.
-- `players.excluded` — the admin flag that keeps a character out of every
-- competitive and public surface without touching a single ingested row.
--
-- WHY. Some characters on the roster are not players competing: the first case
-- is "Steward", an ALT used to run errands in the hall. It joins, it logs
-- sessions, it accrues kills and deaths and playtime like anybody else, and so
-- it lands on the leaderboards, in the roster, in the Player-of-the-Day draw,
-- in the title registry, in the Great Deed aggregates, on the in-game sign
-- boards, and in "who is sailing". None of that is wrong data — it is the wrong
-- QUESTION. The boards ask "which of the vikings is ahead", and an alt is not
-- one of the vikings.
--
-- INGEST IS UNTOUCHED, DELIBERATELY. The webhook and /api/gs-ingest keep
-- creating the row, writing its sessions, its events and its player_stats
-- exactly as before — the log stays a faithful log, the /admin/ops cockpit still
-- sees everything that happened, and nothing has to be un-deleted if the flag is
-- ever cleared. Exclusion happens on READ and on AGGREGATION only (lib/excluded.ts
-- for the site, services/discord-bot/src/excluded.js for the bot).
--
-- THE COLUMN GRANT IS NOT OPTIONAL. db/2026-07-11_players_pii_revoke.sql replaced
-- the table-wide SELECT on public.players with a COLUMN-LEVEL grant list (so
-- steam_id stays unreadable by anon). A column added later is NOT covered by that
-- list: without the grants below, every anon read that names `excluded` fails with
-- "permission denied for column excluded" — i.e. the whole public site. The app is
-- written to survive both halves being late (it asks for `excluded`, and on any
-- error re-reads without it and falls back to config/server.ts
-- EXCLUDED_CHARACTER_NAMES), but the grant is what makes the flag actually work.
--
-- Idempotent: `add column if not exists` plus grants that are safe to re-run.
--
-- Verify after applying:
--   select character_name, excluded, current_title from public.players order by character_name;
--   select column_name, privilege_type from information_schema.column_privileges
--    where table_name = 'players' and column_name = 'excluded';

alter table public.players
  add column if not exists excluded boolean not null default false;

comment on column public.players.excluded is
  'Admin flag. When true this character is left out of every competitive/public surface — site leaderboards and rosters, Player of the Day, the title registry, Great Deed evaluation and progress, the /api/boards in-game sign feed, and presence. Ingest still writes its rows (sessions, events, player_stats) unchanged: exclusion is applied on read/aggregation. Set it for alts and service characters, never as a punishment for a person.';

-- The public site reads with the anon key under RLS; `authenticated` mirrors it.
grant select (excluded) on public.players to anon;
grant select (excluded) on public.players to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- ONE-OFF: exclude the alt character "Steward". NOT PART OF THE MIGRATION.
-- ════════════════════════════════════════════════════════════════════════════
--
-- Left commented out ON PURPOSE. The statements above are structure and are safe
-- on any database; the block below is a DATA decision about one named character,
-- and it has not been run. Uncomment and run it once, by hand, when Charlie says
-- so. `current_title` is cleared in the same statement because the title registry
-- (services/discord-bot/src/titles.js) will stop maintaining the row the moment it
-- is excluded — leaving the last crown behind would freeze an epithet on a
-- character nothing re-evaluates any more, and the bot writes players.current_title
-- straight to the in-game boards and the #server proclamation.
--
-- To exclude a different character later, change the name. To UN-exclude one, set
-- excluded = false; the site and the bot pick it up on their next read (the bot
-- also needs a `sudo systemctl restart eilif-discord-bot` if its name-list
-- fallback in EXCLUDED_CHARACTER_NAMES is what is carrying the exclusion).
--
-- update public.players
--    set excluded = true,
--        current_title = null,
--        title_updated_at = null
--  where character_name = 'Steward';
--
-- Expect: UPDATE 1. UPDATE 0 means no row is named exactly "Steward" —
-- character_name is unique and case-sensitive (db/2026-07-25_players_unique_name.sql),
-- so check the spelling against `select character_name from public.players`
-- rather than loosening the predicate.
