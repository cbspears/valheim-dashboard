-- Applied to prod 2026-07-03 (migration: oaths_and_player_bios).
-- The Oath page: sworn signatures collected via Discord (@Eilif oath — <InGameName>: <text>).
-- match_status: 'exact' | 'fuzzy' (name matched with tolerance) | 'unmatched' (kept, awaiting a fix).
create table public.oaths (
  id uuid primary key default gen_random_uuid(),
  character_name text,
  player_id uuid references public.players(id) on delete set null,
  discord_id text,
  discord_name text,
  oath_text text not null,
  match_status text not null default 'unmatched',
  sworn_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.oaths enable row level security;
create policy "public read oaths" on public.oaths for select using (true);

-- Viking pages: self-described bio + role (via Discord); the epithet/title is
-- always GENERATED from their deeds (players have no control over it).
alter table public.players add column if not exists bio text;
alter table public.players add column if not exists role text;

-- (second migration, oath_source, also applied 2026-07-03:)
-- where the oath was sworn: 'discord' (bot mention) or 'ingame' (/oath chat via the Eilif companion plugin)
alter table public.oaths add column if not exists source text not null default 'discord';
