-- APPLIED TO PROD. Settled 2026-09-06 (T-3 audit): `players_character_name_key` EXISTS on
-- production — verified by the coordinator against the live project, which is the check
-- db/2026-09-06_perf_indexes.sql asked for (`select indexname from pg_indexes where
-- tablename = 'players'`). The constraint is in force; nothing to apply.
--
-- STATUS: APPLIED (see line 1). Idempotent (`create unique index if not exists`).
-- This file had carried no status marker at all since it was written, which made it the
-- one migration nobody could state the state of — and launch night is exactly the
-- condition it guards: after the wipe the `players` table is empty while twenty vikings
-- connect at once, the same shape as the 07-25 incident below.
--
-- 2026-07-25 · players.character_name must be unique.
--
-- Incident: the stats webhook's find-or-create looked the player up with
-- .maybeSingle() and never checked the error. Once a second "Testman" row
-- existed, maybeSingle() returned error+null on every sweep, so the handler
-- inserted a fresh duplicate every 15 minutes (325 rows by 07-25). When the
-- shared title flipped, the titles announcer proclaimed once PER ROW and
-- flooded #server. Every consumer already treats character_name as unique —
-- enforce it so a race can only error, never silently fork a viking.
--
-- Prereq (done during the incident cleanup): dedupe players by
-- character_name before applying, keeping the oldest row per name.

create unique index if not exists players_character_name_key
  on players (character_name);
