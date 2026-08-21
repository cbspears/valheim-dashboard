-- Ops watchdog alert state — the memory that stops GET /api/ops/watchdog from
-- re-spamming Discord.
--
-- Charlie applies this by hand in Supabase — NOT auto-applied (there is no
-- migration runner in this repo). Idempotent: safe to re-run.
--
-- The watchdog route is pinged every 15 minutes by an EXTERNAL scheduler
-- (.github/workflows/watchdog.yml) so it keeps working when Charlie's PC — which
-- hosts every producer — is off. 96 pings a day must not become 96 Discord
-- messages a day, so the route keeps exactly ONE row here (key = 'watchdog')
-- recording whether we are currently alerting, WHAT is broken (`signature`), and
-- when we last spoke. From that it alerts only on:
--   • a transition from ok → unhealthy,
--   • a change in which components are unhealthy (`signature` changes), or
--   • a re-alert, at most every 6h while it stays unhealthy,
-- plus one recovery message on the way back to healthy.
--
-- Until this table exists the watchdog answers 5xx (its GitHub job then fails and
-- emails) rather than alerting with no memory — see app/api/ops/watchdog/route.ts.
--
-- RLS is enabled with NO anon/public policies — service role only, like
-- ops_heartbeats. Nothing here is ever exposed to the public site. The stored
-- strings are component keys and states this repo generates (never producer
-- free-text), so there is no secret-bearing string to redact.

create table if not exists public.ops_alerts (
  key text primary key,                          -- 'watchdog' (one row today)
  state text not null default 'ok',              -- ok | alerting
  signature text,                                -- 'log-poller:stale,game-server:stale'
  since timestamptz,                             -- when the CURRENT state began
  last_alert_at timestamptz,                     -- last message actually posted
  alert_count integer not null default 0,        -- messages sent this episode
  updated_at timestamptz not null default now()
);

alter table public.ops_alerts enable row level security;

-- No anon/public policies at all — only the service role (which bypasses RLS)
-- may read or write. Only /api/ops/watchdog touches this table.

comment on table public.ops_alerts is
  'Ops watchdog alert state (service-role only). One row per alert channel (key=''watchdog''): current state, the unhealthy-set signature, and when we last posted — the dedupe memory for /api/ops/watchdog.';
