-- STATUS: UNAPPLIED. Nothing in this repo applies it. Charlie's call, by hand.
--
-- ops_size_report(): the exact database and storage sizes, for the cockpit's
-- Performance tab (/admin/ops/performance, "Free plan budget").
--
-- WHY IT IS NEEDED AT ALL. The Supabase free plan gives this project 500 MB of
-- database and 1 GB of storage, and those two ceilings are the real constraint
-- on how long it lives. Nothing in the system watches either one. The cockpit
-- can watch them today only as an ESTIMATE: it counts every table's rows exactly
-- (a head-only COUNT over PostgREST, which transfers no rows) and multiplies by
-- a documented per-row byte constant, then adds a 60 MB floor for the catalogs
-- and the auth, storage and realtime schemas an empty project already carries.
-- The row counts are exact; the byte totals are a guess with a plus or minus of
-- roughly 30%, and the page says so on the number itself.
--
-- The exact answer needs pg_database_size() and a sum over storage.objects, both
-- of which are SQL. PostgREST exposes no route to SQL, and the storage schema is
-- not in the exposed schema list, so there is no way to ask for either from the
-- cockpit as it stands. This function is that route.
--
-- WHAT HAPPENS WHEN IT IS APPLIED. Nothing needs a deploy. The page already
-- calls this function on every render and falls back to the estimate when the
-- call fails, which is what it does today (PostgREST answers PGRST202, "could
-- not find the function"). The first render after this migration lands switches
-- the gauge to the exact number and drops the word "estimated" from the label,
-- by itself.
--
-- WHAT HAPPENS IF IT IS NEVER APPLIED. The page keeps working exactly as it does
-- now. That is a requirement, not a hope: docs/OPS-COCKPIT-V2.md §11 says the
-- budget panel must render correctly whether or not this file is ever run.
--
-- ── The three properties that make it safe to expose ──────────────────────────
--
-- STABLE, and that is load-bearing. PostgREST serves an IMMUTABLE or STABLE
-- function over GET; a VOLATILE one is POST only. The cockpit calls it with
-- supabase-js's `{ get: true }` so that every single request the Performance tab
-- issues is a read at the protocol level and not merely by intention. Marking
-- this VOLATILE would silently turn that call into a POST.
--
-- SECURITY DEFINER, narrowly. pg_database_size() and the storage.objects table
-- are not readable by the anon or authenticated roles, and they should not
-- become so. The function runs as its owner and returns two integers: no table
-- contents, no object names, no paths, nothing that could leak a private object.
-- search_path is pinned so a caller cannot shadow the objects it reads.
--
-- SERVICE ROLE ONLY. EXECUTE is granted to service_role and revoked from public,
-- anon and authenticated. The cockpit is the only caller and it runs server side
-- under the service role. A visitor to the public site cannot reach it.
--
-- ── Verification after applying ──────────────────────────────────────────────
--
--   select * from public.ops_size_report();
--   -- database_bytes | storage_bytes
--   -- ---------------+---------------
--   --        7xxxxxxx |       xxxxxxx
--
-- Then reload /admin/ops/performance: the Database gauge should read a number
-- with no "estimated" prefix, and the Storage gauge no "sampled" prefix.
--
-- Idempotent: create or replace, and the grants are re-run safely.

begin;

create or replace function public.ops_size_report()
returns table (database_bytes bigint, storage_bytes bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, storage
as $$
  select
    pg_database_size(current_database())::bigint as database_bytes,
    -- storage.objects.metadata is the jsonb the Storage API writes on upload; it
    -- carries the byte size under 'size'. coalesce so a bucket with no objects
    -- (or an object uploaded by a path that did not stamp metadata) sums to 0
    -- rather than to NULL and wipes out the whole total.
    coalesce(
      (select sum(coalesce((o.metadata ->> 'size')::bigint, 0)) from storage.objects o),
      0
    )::bigint as storage_bytes;
$$;

comment on function public.ops_size_report() is
  'Exact database and storage bytes for the ops cockpit Performance tab. STABLE so PostgREST serves it over GET; security definer because pg_database_size() and storage.objects are not readable by anon. Returns two integers and nothing else. Added 2026-09-06.';

revoke all on function public.ops_size_report() from public;
revoke all on function public.ops_size_report() from anon;
revoke all on function public.ops_size_report() from authenticated;
grant execute on function public.ops_size_report() to service_role;

commit;

-- To undo:
--   drop function if exists public.ops_size_report();
-- The cockpit falls straight back to the estimate on the next render.
