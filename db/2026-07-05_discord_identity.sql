-- Discord ↔ character identity link.
--
-- The problem: gallery photos + oaths are credited to DISCORD identities, but
-- everything else on the dashboard is keyed by a viking's in-game
-- `character_name`. Fuzzy display-name matching (lib/slug.ts `matchVikingName`)
-- fails whenever the two differ (Discord "Charlie" vs character "Chærlie"), so
-- a viking's own photos never reach their /viking page. This adds an explicit,
-- self-declared link established in Discord with `@Eilif I am <CharacterName>`.
--
-- STATUS: NOT yet applied to prod. Coordinator applies, THEN (no bot restart
-- needed — PostgREST/supabase-js reload the schema cache automatically). ALL
-- code tolerates these columns being absent in the window before it is applied:
--   • the bot's `I am` handler catches the missing-column error and replies
--     that the Hall's ledgers aren't ready yet (services/discord-bot/src/identity.js);
--   • getAllPlayers() selects '*', so `players.discord_user_id` simply reads
--     back undefined and the viking page falls to the "not linked yet" hint;
--   • scripts/backfill-identity.js probes for the column and runs in
--     preview-only mode (no writes) when it's absent.
--
-- Purely additive + idempotent — safe to apply live.

-- One Discord user is linked to at most one character at a time; relinking
-- (`@Eilif I am <someone-else>`) moves the mapping. `discord_username` is the
-- Discord display name captured at link time (for display / audit only).
alter table public.players add column if not exists discord_user_id text;
alter table public.players add column if not exists discord_username text;

-- Unique so a Discord user can't be linked to two characters. A partial index
-- (NULLs excluded) keeps every still-unlinked viking valid; Postgres already
-- treats NULLs as distinct in a unique index, but being explicit documents it.
create unique index if not exists players_discord_user_id_key
  on public.players (discord_user_id)
  where discord_user_id is not null;

-- NOTE: gallery_photos ALREADY carries a stable Discord author id
-- (`gallery_photos.discord_user_id`, populated by the bot's gallery ingest
-- since db/2026-06-25_gallery_photos.sql), so NO new column is needed there.
-- Retro-linking a viking's old photos is therefore structural: once
-- players.discord_user_id is set, the viking page joins photos on
-- discord_user_id — no per-row rewrite of gallery_photos is required.
