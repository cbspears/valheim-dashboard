-- Take INSERT/UPDATE/DELETE/TRUNCATE away from anon + authenticated.
--
-- WHY: Supabase's default grants give `anon` and `authenticated` DELETE, INSERT,
-- REFERENCES, SELECT, TRIGGER, TRUNCATE and UPDATE on every table in `public`
-- (information_schema.role_table_grants confirms this on all 20 tables; anon also
-- holds column-level INSERT/UPDATE on players.steam_id). Today those writes are
-- blocked only because every table has RLS with SELECT-only policies — one table
-- created without RLS, or one policy widened by accident, and the publishable
-- anon key (which ships in the browser bundle by design) becomes a write key.
-- TRUNCATE in particular is NOT governed by RLS at all.
--
-- Defence in depth: RLS stays exactly as it is; this removes the underlying
-- privilege so the grant no longer has to be trusted.
--
-- SAFE FOR THE SITE: every public surface READS (lib/data.ts, anon key) and
-- SELECT is deliberately left intact. The service_role key is UNAFFECTED — it
-- bypasses both RLS and these grants — so /api/webhook, /api/gs-ingest,
-- /api/voice, the ops cockpit, the Discord bot and the log poller keep writing
-- exactly as before. Storage and auth schemas are untouched.
--
-- Idempotent (revoking a privilege that is already gone is a no-op) and
-- reversible (`grant insert, update, delete on all tables in schema public to
-- anon, authenticated;`), though there is no reason to.
--
-- ORDER: independent of any deploy — apply whenever.
--
-- AFTER APPLYING, verify the site still renders (it reads only): load /, /players,
-- /world and /events, and re-run
--   select grantee, privilege_type, count(*) from information_schema.role_table_grants
--    where table_schema='public' and grantee in ('anon','authenticated')
--    group by 1,2 order by 1,2;
-- which should show SELECT (and nothing else) for both roles.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-04_revoke_anon_writes.sql
-- or paste into the Supabase SQL editor.

revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public
  from anon, authenticated;

-- Column-level grants are separate objects and survive a table-level revoke,
-- so name the one that exists (players.steam_id — PII, revoked from anon on
-- 2026-07-12) explicitly.
-- (verified 2026-09-04: anon AND authenticated each still hold column-level
-- INSERT, UPDATE and REFERENCES on players.steam_id.)
revoke insert (steam_id), update (steam_id), references (steam_id)
  on public.players
  from anon, authenticated;

-- Stop the default privileges from re-granting writes on tables created later.
-- (These ALTER DEFAULT PRIVILEGES statements must be run by the role that owns
-- the objects — `postgres` in the SQL editor — and are no-ops if already set.)
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables
  from anon, authenticated;
