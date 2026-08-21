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
