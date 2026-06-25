-- Upcoming community events shown on the dashboard (Hall "Coming Up" card +
-- World "Scheduled Gatherings"). Rows are synced from Discord scheduled events
-- by the bot (discord_event_id set); demo rows have it null.
--
-- Recurring rows carry recurrence_days (7 = weekly); the dashboard rolls them
-- forward to their next occurrence, so weekly nights never look stale.
--
-- Applied to prod 2026-06-25 via the Supabase MCP.

create table if not exists public.discord_events (
  id uuid primary key default gen_random_uuid(),
  discord_event_id text unique,
  name text not null,
  description text,
  host text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status text not null default 'scheduled',     -- scheduled | active | completed | canceled
  user_count integer not null default 0,
  cover_url text,
  url text,
  recurrence text,                              -- display label (null = one-off)
  recurrence_days integer,                      -- roll-forward interval in days (null = one-off)
  updated_at timestamptz not null default now()
);

alter table public.discord_events enable row level security;

drop policy if exists "public read discord_events" on public.discord_events;
create policy "public read discord_events" on public.discord_events
  for select using (true);

create index if not exists discord_events_starts_at_idx on public.discord_events (starts_at);
