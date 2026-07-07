-- TV Mode data feeds (Charlie greenlit 2026-07-07):
--
--   • chat_lines — in-game SHOUTS mirrored to the site (TV chat rail). This
--     amends the 2026-07-05 "chat never touches the site" decision: shouts
--     already mirror publicly to Discord #server, so the same lines (and ONLY
--     those — the poller's deduped mirror point) may now also land here.
--   • player_positions — live position + biome per character, emitted by
--     Eilif Companion v0.2 ([EILIF_POS] log lines every ~60s) → poller →
--     webhook upsert. DISPLAY DECREE (Charlie): live positions render on /tv
--     ONLY — never on the public /map atlas (same spirit as the "no graves on
--     the atlas" rule). TV shows a position only while fresh (~3 min) and the
--     player is online.
--
-- Writes go through /api/webhook (service role) — no insert policies needed.
-- STATUS: applied to prod 2026-07-07 (Supabase MCP migration `chat_and_positions`).

create table if not exists public.chat_lines (
  id uuid primary key default gen_random_uuid(),
  character_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_lines_created_at_idx on public.chat_lines (created_at desc);
alter table public.chat_lines enable row level security;
drop policy if exists "public read chat_lines" on public.chat_lines;
create policy "public read chat_lines" on public.chat_lines for select using (true);

create table if not exists public.player_positions (
  character_name text primary key,
  x double precision not null,
  z double precision not null,
  biome text,
  updated_at timestamptz not null default now()
);
alter table public.player_positions enable row level security;
drop policy if exists "public read player_positions" on public.player_positions;
create policy "public read player_positions" on public.player_positions for select using (true);
