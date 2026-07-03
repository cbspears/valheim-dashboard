-- Applied to prod 2026-07-03 (migration: voice_lines_and_oath_announce).
-- The Voice of the Hall: the bot queues lines; the Eilif companion plugin
-- polls GET /api/voice (x-voice-token) and speaks them in-game.
-- No public-read policy on purpose — lines are surprise content until spoken.
create table public.voice_lines (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  speaker text not null default 'Eilif',
  kind text not null default 'ambient', -- ambient | event | manual
  status text not null default 'queued', -- queued | spoken
  meta jsonb not null default '{}'::jsonb,
  queued_at timestamptz not null default now(),
  spoken_at timestamptz
);
alter table public.voice_lines enable row level security;

-- bot cross-post tracking for in-game oaths
alter table public.oaths add column if not exists announced_at timestamptz;
