-- APPLIED TO PROD 2026-09-04 ~22:45 CT (Supabase MCP apply_migration, `players_steam_id_guard_2026_09_05`).
-- One Steam account may own several vikings: drop UNIQUE (players.steam_id).
--
-- WHY: the identity guard (audit security-3, app/api/webhook/route.ts §3b) binds
-- players.steam_id on FIRST SIGHT — the first Steam account to join under a
-- character name owns that name, and every later join under a different account
-- is refused for oaths, pins and the /oath CODE Discord link. That binding is
-- PER CHARACTER, but db/0000_initial_schema.sql declared the column
-- `steam_id TEXT UNIQUE`, which makes it per ACCOUNT: the constraint
-- (players_steam_id_key) lets a Steam account claim exactly ONE character row.
--
-- Two characters on one account is completely ordinary Valheim — an alt, a
-- mule, a test viking, a re-roll after the launch wipe (the poller's own
-- relog fixture is literally Testman → Testmantwo on one SteamID). With the
-- constraint in place the second character's bind fails with 23505 and that
-- viking simply never gets a binding, i.e. never gets the protection. The
-- route writes the binding as its own statement precisely so this failure can
-- never take the presence update with it, so the site keeps working either
-- way — this migration is what makes the guard cover everybody.
--
-- Nothing else depends on the uniqueness: the column has exactly one reader
-- (the identity guard) and one writer (the webhook). It is REVOKEd from anon
-- (db/2026-07-11_players_pii_revoke.sql, db/2026-09-04_revoke_anon_writes.sql)
-- and never leaves the server.
--
-- Idempotent (guarded drop + `if not exists` index) and reversible while no
-- account owns two characters:
--   alter table public.players add constraint players_steam_id_key unique (steam_id);

alter table public.players drop constraint if exists players_steam_id_key;

-- The constraint was also the column's only index; keep a plain one, since the
-- guard looks a binding up on every oath and pin.
create index if not exists players_steam_id_idx on public.players (steam_id);
