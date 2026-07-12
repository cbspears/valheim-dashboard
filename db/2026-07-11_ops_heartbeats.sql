-- Ops cockpit heartbeats — liveness reports from the host-side producers.
--
-- Charlie applies this by hand in Supabase — NOT auto-applied (there is no
-- migration runner in this repo). Idempotent: safe to re-run.
--
-- The discord-bot, log poller, and map snapshotter POST to /api/ops/heartbeat on
-- a cadence; that route (service role, Bearer OPS_HEARTBEAT_TOKEN) upserts one
-- row per component here. The /admin/ops cockpit reads it with the service role
-- to decide each component's health. One row per component (the primary key), so
-- an upsert replaces the prior beat rather than accumulating history.
--
-- RLS is enabled with NO anon/public policies — service role only. These rows are
-- operational plumbing (component names, versions, sanitized error summaries,
-- non-secret metrics) and are never exposed to the public site. Every string is
-- redacted BEFORE insert by lib/ops/redact.ts, so a leaked token can't land here,
-- but we still keep the whole table service-role-only as defence in depth.

create table if not exists public.ops_heartbeats (
  component text primary key,
  instance text,
  version text,
  status text not null default 'ok',           -- ok | degraded | error
  last_success timestamptz,
  last_attempt timestamptz not null default now(),
  error_summary text,
  metrics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ops_heartbeats enable row level security;

-- No anon/public policies at all — only the service role (which bypasses RLS)
-- may read or write. The heartbeat ingest route and the cockpit both use it.

comment on table public.ops_heartbeats is
  'Ops cockpit liveness heartbeats (service-role only). One row per component: discord-bot, log-poller, map-snapshot. Written by /api/ops/heartbeat, read by /admin/ops.';
