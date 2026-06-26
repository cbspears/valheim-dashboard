-- Player-of-the-Day archive. The Discord bot inserts one row each EVENING recap
-- (10 PM Central) naming that day's crowned viking + the award they earned, so
-- the dashboard's Vikings page can show a historical log + a "most-crowned"
-- tally. Written by the bot via the service-role key (services/discord-bot/
-- src/recap.js -> postRecap); read publicly by the dashboard (anon, RLS below).
--
-- Recaps are gated until launch (RECAPS_START), so NO real rows exist before
-- then. Any demo rows seeded for the live preview are therefore "awarded before
-- launch" — WIPE before go-live:
--   delete from public.poty_history where awarded_at < '2026-09-09';
--
-- Applied to prod 2026-06-25 via the Supabase MCP.

create table if not exists public.poty_history (
  id uuid primary key default gen_random_uuid(),
  character_name text not null,
  award_category text not null,   -- 'boss_kill' | 'most_deaths' | 'underdog' | ...
  award_label text not null,      -- '👑 Bane of Beasts (Boss-Slayer)' | '🌟 Unsung Hero' | ...
  world_day integer,
  awarded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.poty_history enable row level security;

drop policy if exists "public read poty_history" on public.poty_history;
create policy "public read poty_history" on public.poty_history
  for select using (true);

create index if not exists poty_history_awarded_at_idx on public.poty_history (awarded_at desc);
