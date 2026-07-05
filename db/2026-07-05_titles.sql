-- Living titles registry.
--
-- The epithet engine (lib/epithets.ts) generates every viking's title from their
-- deeds + rank against the warband; the Discord bot's titles announcer polls the
-- shared /api/titles endpoint and, when a viking's computed title changes, writes
-- it here and announces it (⚔️ #server line + an in-game voice line). This
-- migration adds the persistence:
--   • players.current_title       — the title the hall currently knows them by
--                                   (also the incumbent that feeds the engine's
--                                   hysteresis, so titles never flap on noise).
--   • players.title_updated_at    — when that title last changed.
--   • title_history               — every title a viking has ever earned, in order.
--
-- HARD PREREQUISITE for the announcer, not for the site: the dashboard renders
-- titles live from the shared engine (it never reads current_title), so it works
-- with or without this migration. The bot's titles loop degrades gracefully until
-- these columns exist — it detects the missing column, logs, and skips (no seed,
-- no announcement). Once applied, the bot's FIRST pass SEEDS every player's
-- current_title silently (no announcement storm), then announces only real
-- changes thereafter.
--
-- Additive + nullable/defaulted, safe on the live project, reversible.
-- Seeded/preview rows are wiped with the rest of the demo data before launch:
--   delete from public.title_history where awarded_at < '2026-09-09';
--   update public.players set current_title = null, title_updated_at = null;
--
--   psql "$SUPABASE_DB_URL" -f db/2026-07-05_titles.sql
-- or paste into the Supabase SQL editor.

alter table public.players
  add column if not exists current_title text,
  add column if not exists title_updated_at timestamptz;

comment on column public.players.current_title is 'The viking''s current living title (lib/epithets.ts), maintained by the Discord bot titles announcer. Also the hysteresis incumbent.';
comment on column public.players.title_updated_at is 'When current_title last changed (was announced).';

create table if not exists public.title_history (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  title text not null,
  awarded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.title_history enable row level security;

drop policy if exists "public read title_history" on public.title_history;
create policy "public read title_history" on public.title_history
  for select using (true);

create index if not exists title_history_player_idx on public.title_history (player_id, awarded_at desc);
