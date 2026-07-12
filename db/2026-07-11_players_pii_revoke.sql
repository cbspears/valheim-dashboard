-- PII boundary: stop exposing players.steam_id to the anon (public) role.
--
-- Background: the whole public site reads via the anon key (NEXT_PUBLIC_*), and
-- players had a table-wide SELECT grant to anon (RLS filtered rows, not columns).
-- So a direct PostgREST call `players?select=steam_id` with the public key could
-- harvest every viking's Steam account id. "Selecting fewer columns" in the app
-- does NOT enforce column privacy — only the grant does.
--
-- Postgres column privileges only take effect once the blanket table-level SELECT
-- is removed, so we REVOKE it and re-GRANT SELECT on every column EXCEPT steam_id.
-- steam_id is used only server-side (stats-parser + webhook 'stats' branch, both
-- service role, which bypasses these grants). discord_user_id / discord_username
-- stay readable on purpose — the /viking page renders/needs them.
--
-- ORDER: apply AFTER deploying the lib/data.ts change (PLAYERS_PUBLIC_COLS), which
-- switches the site's player reads off `select('*')`. If applied first, the live
-- site's select('*') would hit "permission denied for column steam_id".
--
-- Idempotent-ish: re-running is harmless (revoke then re-grant the same set).

revoke select on public.players from anon;
grant select (
  id, character_name, discord_id, first_seen_at, last_seen_at,
  total_playtime_minutes, is_online, bio, role,
  discord_user_id, discord_username, current_title, title_updated_at
) on public.players to anon;

-- No logged-in Supabase users exist today, but keep `authenticated` consistent.
revoke select on public.players from authenticated;
grant select (
  id, character_name, discord_id, first_seen_at, last_seen_at,
  total_playtime_minutes, is_online, bio, role,
  discord_user_id, discord_username, current_title, title_updated_at
) on public.players to authenticated;
