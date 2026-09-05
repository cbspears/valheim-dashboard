-- Live map pins: named by players via /pin (shouted, captured server-side by
-- the Eilif companion plugin's Harmony patch — see plugins/eilif-companion).
-- x/y are 0-1 fractions of the map image (derived from world_x/world_z at
-- ingest time in app/api/webhook/route.ts); kept alongside the raw world
-- coords so the fraction can be recomputed if the conversion needs tuning.
create table public.pins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'poi', -- 'base' | 'poi'
  by_character_name text,
  world_x double precision not null,
  world_z double precision not null,
  x double precision not null,
  y double precision not null,
  day integer,
  created_at timestamptz not null default now()
);
alter table public.pins enable row level security;
create policy "public read pins" on public.pins for select using (true);
