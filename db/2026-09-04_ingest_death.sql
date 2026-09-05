-- APPLIED TO PROD 2026-09-04 (Supabase MCP apply_migration, recorded as `ingest_death_2026_09_04` in supabase_migrations.schema_migrations).
-- Atomic death ingest — closes the gs↔eilif duplicate-death RACE.
--
-- APPLY WITH THE DEPLOY THAT CARRIES lib/deaths.ts; SAFE IN EITHER ORDER.
-- lib/deaths.ts calls this function through `client.rpc('ingest_death', …)` and
-- FALLS BACK to its previous select-then-insert path on Postgres error 42883
-- (undefined function), so:
--   • migration applied first, code not yet deployed → nothing calls it, no-op.
--   • code deployed first, migration not yet applied → every call 42883s and the
--     old (racy but working) path runs, exactly as it does today.
-- Nothing is lost either way; the race only closes once BOTH are live.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- Every launch player runs BOTH producers: GsValheimStatsClient (deathEvents[])
-- and our own EilifCompanionClient (source:'eilif-death'). Both Harmony-patch
-- Player.OnDeath and POST immediately, so the two requests hit /api/gs-ingest
-- within the ~100-400 ms each handler spends between its dedupe SELECT and its
-- INSERT. Both read "nothing nearby", both insert, and one death becomes two
-- rows — two 💀 lines in #server, two entries in How We Die / the Saga / the
-- per-viking death log, and an inflated recap "most deaths" award. Reproduced
-- live: 4 of 10 dual-producer deaths during the pilot duplicated (ChÆrleif
-- 2026-08-28 02:44:21.895/.899, 09-01 01:32:41.104/.114, 01:44:00.475/.476,
-- 01:52:45.438/.441 — 1-10 ms apart, edge_logs show both reads before both
-- inserts).
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Do the window check and the write INSIDE ONE TRANSACTION, serialized per
-- character by pg_advisory_xact_lock(hashtext('death:'||lower(name))). The lock
-- is released automatically at commit/rollback (xact-scoped), is keyed on the
-- lower-cased name so a case skew still serializes, and only ever contends with
-- another death report for the SAME viking — never with any other traffic.
--
-- NOT a unique index: the natural key would have to be (character_name,
-- created_at) bucketed to the second, but date_trunc('second', timestamptz) is
-- STABLE (not IMMUTABLE) so Postgres refuses it as an index expression, the
-- 3-arg IMMUTABLE form still straddles a second boundary for ~1 % of pairs (the
-- observed gs↔eilif clock skew is 1-13 ms), and the poller's row carries
-- log-line time, which can be seconds out. A lock over the same ±3-minute
-- window the application already uses is the only key that matches reality.
--
-- ── CONTRACT ───────────────────────────────────────────────────────────────
--   ingest_death(p_name, p_player_id, p_at, p_metadata, p_mode) → text
--
--   p_mode = 'eilif'  (our own plugin, the authoritative cause)
--     'duplicate' — this exact eilifDeathId is already recorded (retry).
--     'upgraded'  — a gs/poller row for this viking exists within ±3 min; its
--                   metadata gains cause/hitType/attacker/biome/eilifDeathId +
--                   causeSource='eilif'. `source` (who CREATED the row) is
--                   preserved, and a biome we do not have never blanks one the
--                   other producer knew.
--     'inserted'  — nothing nearby; a fresh row is written.
--     'ignored'   — would have inserted, but p_player_id is null (no players row
--                   yet — the poller's join path owns row creation; self-heals).
--
--   p_mode = 'gs'  (GsValheimStatsClient deathEvents[])
--     'duplicate' — this exact gsDeathId is already recorded.
--     'dropped'   — an eilif-authored row for this viking is within ±3 min, so
--                   this is the SAME death and the eilif row holds a strictly
--                   better cause. The eilif row is stamped with this gsDeathId,
--                   which both marks it CONSUMED (1:1 pairing — one eilif report
--                   can cover at most ONE gs death, so the classic corpse-run
--                   double death still records two rows) and makes the next
--                   ~120 s re-POST of the cumulative snapshot a cheap no-op.
--     'inserted'  — no eilif twin; the gs row is written.
--     'ignored'   — p_player_id is null.
--
-- Rows are matched on character_name EXACTLY (the same rule the application
-- uses); only the LOCK is case-folded.
--
-- security definer + granted to service_role ONLY: this writes `events`, and
-- anon/authenticated must never reach it (they have read-only RLS on the site).
--
-- Idempotent (create or replace + explicit grants), safe to re-run.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-04_ingest_death.sql
-- or paste into the Supabase SQL editor.

create or replace function public.ingest_death(
  p_name text,
  p_player_id uuid,
  p_at timestamptz,
  p_metadata jsonb,
  p_mode text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window constant interval := interval '3 minutes';
  v_meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_eilif_key text := v_meta ->> 'eilifDeathId';
  v_gs_key text := v_meta ->> 'gsDeathId';
  v_id uuid;
  v_patch jsonb;
begin
  if p_name is null or btrim(p_name) = '' or p_at is null then
    return 'ignored';
  end if;
  if p_mode not in ('eilif', 'gs') then
    return 'ignored';
  end if;

  -- Serialize every death report for this viking. Transaction-scoped: released
  -- on commit or rollback, so a failure can never leave the lock held.
  perform pg_advisory_xact_lock(hashtext('death:' || lower(btrim(p_name))));

  if p_mode = 'eilif' then
    -- Idempotency across retries: the exact same report a second time is a no-op.
    if v_eilif_key is not null then
      perform 1 from public.events
        where type = 'death' and metadata ->> 'eilifDeathId' = v_eilif_key
        limit 1;
      if found then
        return 'duplicate';
      end if;
    end if;

    -- Any death already recorded for this viking inside the window is THE SAME
    -- death, whoever wrote it — UNLESS it already carries an eilif-authored
    -- cause, which makes it a DIFFERENT death (our plugin fires exactly once per
    -- death, and true replays were caught above). Nearest in time wins.
    select id into v_id
      from public.events
     where type = 'death'
       and character_name = p_name
       and created_at >= p_at - v_window
       and created_at <= p_at + v_window
       and coalesce(metadata ->> 'causeSource', '') <> 'eilif'
     order by abs(extract(epoch from (created_at - p_at)))
     limit 1;

    if v_id is not null then
      v_patch := jsonb_strip_nulls(jsonb_build_object(
        'eilifDeathId', v_meta -> 'eilifDeathId',
        'causeSource', v_meta -> 'causeSource',
        'cause', v_meta -> 'cause',
        'hitType', v_meta -> 'hitType',
        'attacker', v_meta -> 'attacker',
        -- Only fill a biome we actually have — never blank one the other
        -- producer knew (jsonb_strip_nulls drops the key when it is absent).
        'biome', v_meta -> 'biome'
      ));
      update public.events
         set metadata = coalesce(metadata, '{}'::jsonb) || v_patch
       where id = v_id;
      return 'upgraded';
    end if;

    if p_player_id is null then
      return 'ignored';
    end if;
    insert into public.events (type, player_id, character_name, metadata, created_at)
    values ('death', p_player_id, p_name, v_meta, p_at);
    return 'inserted';
  end if;

  -- ── p_mode = 'gs' ────────────────────────────────────────────────────────
  if v_gs_key is not null then
    perform 1 from public.events
      where type = 'death' and metadata ->> 'gsDeathId' = v_gs_key
      limit 1;
    if found then
      return 'duplicate';
    end if;
  end if;

  -- An UNPAIRED eilif-authored row in the window is this same death: drop the gs
  -- report and stamp the eilif row with this gsDeathId (pairing it 1:1, so a
  -- second genuine death moments later still gets its own row).
  select id into v_id
    from public.events
   where type = 'death'
     and character_name = p_name
     and created_at >= p_at - v_window
     and created_at <= p_at + v_window
     and metadata ->> 'causeSource' = 'eilif'
     and metadata ->> 'gsDeathId' is null
   order by abs(extract(epoch from (created_at - p_at)))
   limit 1;

  if v_id is not null then
    if v_gs_key is not null then
      update public.events
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('gsDeathId', v_gs_key)
       where id = v_id;
    end if;
    return 'dropped';
  end if;

  if p_player_id is null then
    return 'ignored';
  end if;
  insert into public.events (type, player_id, character_name, metadata, created_at)
  values ('death', p_player_id, p_name, v_meta, p_at);
  return 'inserted';
end;
$$;

comment on function public.ingest_death(text, uuid, timestamptz, jsonb, text) is
  'Atomic cross-producer death ingest for /api/gs-ingest (lib/deaths.ts). Serializes per character with pg_advisory_xact_lock so two simultaneous reports of one death cannot both insert. Returns inserted|upgraded|dropped|duplicate|ignored.';

-- service_role ONLY. The site reads with the anon key under RLS and must never
-- be able to write events through an RPC.
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from public;
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from anon;
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from authenticated;
grant execute on function public.ingest_death(text, uuid, timestamptz, jsonb, text) to service_role;
