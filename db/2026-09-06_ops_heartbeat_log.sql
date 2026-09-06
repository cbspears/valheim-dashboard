-- STATUS: UNAPPLIED. Nothing in this repo applies it. Charlie's call, by hand.
--
-- ops_heartbeat_log: an append-only sample of component liveness, so the cockpit
-- can chart a component's silence over the last 24 h instead of only showing its
-- current age.
--
-- THE GAP. public.ops_heartbeats is one UPSERTED row per component: the latest
-- beat and nothing before it. That is the right shape for "is it alive right
-- now", which is what the Overview asks, and it makes a second question
-- unanswerable: has this component been flapping? A process that dies and
-- restarts every four minutes reads healthy at every single glance, and there is
-- no record anywhere that it ever missed a beat.
--
-- The Performance tab renders "no history yet" for every component today and
-- says plainly, in its own glossary, that the history does not exist. That is
-- the honest state and the page is built to stay in it indefinitely. This file
-- exists so the option is written down and reviewable, not so it is applied.
--
-- ── What it costs, before deciding ───────────────────────────────────────────
--
-- Eight components, one sample a minute, is 11,520 rows a day. At roughly 120
-- bytes a row plus its index that is about 1.6 MB a day, or 11 MB for the seven
-- days the pruning function keeps. Against the free plan's 500 MB that is about
-- 2%, which is affordable but is NOT free, and the Performance tab's budget
-- panel will start counting it the moment it exists. If it is applied, add
-- 'ops_heartbeat_log' to BUDGET_TABLES and ROW_BYTES in the cockpit or the size
-- estimate will silently read low.
--
-- ── Who would write it, and why nothing does yet ─────────────────────────────
--
-- Nothing in this repo writes this table. Filling it needs a sampler, and there
-- are two honest ways to have one, neither of which is a code change this file
-- can make on its own:
--
--   1. pg_cron, the way db/2026-09-06_watchdog_pgcron.sql already schedules the
--      watchdog. One statement a minute, entirely inside the database, no
--      process to keep alive. This is the recommended route and the sampling
--      statement is written out below, commented, ready to be scheduled.
--
--   2. A line in an existing host service's loop. Cheaper to reason about and
--      one more thing that can stop without anybody noticing, which is the exact
--      failure mode this table is meant to reveal.
--
-- Applying this migration alone creates an empty table. The cockpit handles that
-- correctly (it renders "no samples for this component in the last 24 h" per
-- component rather than a flat line at zero), but an empty table is worse than
-- no table: it looks like a feature that is broken instead of one that was never
-- switched on. Schedule the sampler in the same sitting or do not apply this.
--
-- Idempotent: every statement is guarded, safe to re-run.

begin;

create table if not exists public.ops_heartbeat_log (
  id bigserial primary key,
  -- Not a foreign key to ops_heartbeats: a component removed from the registry
  -- (as 'stats-parser' was on 2026-09-04) must not take its history with it, and
  -- a cascade on a liveness log is a way to lose exactly the evidence somebody
  -- came looking for.
  component text not null,
  -- When the sample was taken. This is the column every read windows on.
  sampled_at timestamptz not null default now(),
  -- The component's last_success AT THAT MOMENT, copied verbatim.
  last_success timestamptz,
  status text,
  -- sampled_at minus last_success, in seconds, computed once at sample time.
  -- Stored rather than derived on read so a chart is a plain column scan, and so
  -- a row whose last_success was null keeps a null age rather than a zero: an
  -- age of null means "had never reported", which is a different fact from
  -- "reported just now" and the cockpit renders them differently.
  age_sec integer
);

-- The only query shape the cockpit uses: one component's samples inside a time
-- window, oldest first. Component first because the window is wide and the
-- component set is small.
create index if not exists ops_heartbeat_log_component_sampled_idx
  on public.ops_heartbeat_log (component, sampled_at desc);

-- And the pruning function's own shape.
create index if not exists ops_heartbeat_log_sampled_idx
  on public.ops_heartbeat_log (sampled_at);

alter table public.ops_heartbeat_log enable row level security;

-- No policy is created, which with RLS enabled means anon and authenticated can
-- read nothing at all. The cockpit reads under the service role, which bypasses
-- RLS. This table says when each half of the infrastructure was last alive and
-- has no business being public.
revoke all on table public.ops_heartbeat_log from anon;
revoke all on table public.ops_heartbeat_log from authenticated;

comment on table public.ops_heartbeat_log is
  'Append-only samples of ops_heartbeats, so component liveness can be charted over time. ops_heartbeats itself holds only the latest beat per component. Pruned by ops_heartbeat_log_prune(). Added 2026-09-06, UNAPPLIED at the time of writing.';

-- ── Pruning ──────────────────────────────────────────────────────────────────
--
-- An append-only table with no pruning is a slow leak, and on a 500 MB plan a
-- slow leak is the whole plan eventually. Seven days is chosen to match the
-- widest window the cockpit ever asks for; the tab reads 24 h and the extra six
-- days are there so a question asked on Monday about last Tuesday can still be
-- answered.
create or replace function public.ops_heartbeat_log_prune(keep_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  -- greatest(1, ...) so a mistyped 0 or a negative cannot empty the table.
  delete from public.ops_heartbeat_log
   where sampled_at < now() - (greatest(1, keep_days) || ' days')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.ops_heartbeat_log_prune(integer) is
  'Delete ops_heartbeat_log rows older than keep_days (default 7, minimum 1). Returns the number removed. Schedule beside the sampler.';

revoke all on function public.ops_heartbeat_log_prune(integer) from public;
revoke all on function public.ops_heartbeat_log_prune(integer) from anon;
revoke all on function public.ops_heartbeat_log_prune(integer) from authenticated;
grant execute on function public.ops_heartbeat_log_prune(integer) to service_role;

commit;

-- ── The sampler, NOT scheduled by this file ──────────────────────────────────
--
-- Run these two by hand once to see what the table holds, then schedule them if
-- the history is wanted. db/2026-09-06_watchdog_pgcron.sql is the worked example
-- of scheduling under pg_cron in this project.
--
--   insert into public.ops_heartbeat_log (component, sampled_at, last_success, status, age_sec)
--   select h.component,
--          now(),
--          h.last_success,
--          h.status,
--          case when h.last_success is null then null
--               else greatest(0, extract(epoch from (now() - h.last_success)))::integer
--          end
--     from public.ops_heartbeats h;
--
--   select cron.schedule('ops-heartbeat-sample', '* * * * *', $cron$
--     insert into public.ops_heartbeat_log (component, sampled_at, last_success, status, age_sec)
--     select h.component, now(), h.last_success, h.status,
--            case when h.last_success is null then null
--                 else greatest(0, extract(epoch from (now() - h.last_success)))::integer end
--       from public.ops_heartbeats h;
--   $cron$);
--
--   select cron.schedule('ops-heartbeat-prune', '17 4 * * *',
--                        $cron$ select public.ops_heartbeat_log_prune(7); $cron$);
--
-- To undo everything:
--   select cron.unschedule('ops-heartbeat-sample');
--   select cron.unschedule('ops-heartbeat-prune');
--   drop function if exists public.ops_heartbeat_log_prune(integer);
--   drop table if exists public.ops_heartbeat_log;
-- The Performance tab goes back to "no history yet" on the next render.
