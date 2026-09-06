-- 2026-09-06 · ingest_death(): per-character death ceiling (T-3 audit, data area).
--
-- STATUS: RE-APPLIED to production 2026-09-06 13:45 CT (returns 'capped' on a ceiling refusal).
-- "you decide"; ceiling 5 per 2-minute span), but this file changed afterwards: the
-- ceiling now returns 'capped' where it used to return 'ignored', so production and
-- this file disagree until someone re-runs it. Re-apply before launch -- lib/deaths.ts
-- keys its per-character warning on 'capped', and until this is re-applied a ceiling
-- refusal is still logged as "no players row yet", which is the wrong story.
-- Re-applying is safe at any time: create or replace, no data touched, no downtime.
-- Idempotent: create or replace; safe to run twice; safe while the bot and site run.
--
-- WHAT: anyone holding the public modpack can post client death reports with
-- reporter = victim for any viking who is online, and every identity gate passes
-- because the client path is unauthenticated by design. This re-creates
-- ingest_death() with one added rule: a character cannot record more than 5
-- deaths within a two-minute span (60 s either side of the reported time).
-- Honest play never reaches that (respawn plus the walk back takes longer);
-- a forger is bounded to a few rows a minute instead of thousands, and each
-- refusal raises a Postgres WARNING that the database log shows.
--
-- WHY THE RETURN WORD CHANGED (2026-09-06, T-3 audit site-3). This returned
-- 'ignored', which ingest_death already used for "there is no players row to hang
-- this death on" -- an outcome that self-heals the moment the poller's join path
-- creates the row. lib/deaths.ts therefore reported every ceiling refusal to the
-- Vercel log as "no players row yet", and on the gs batch path did not report it at
-- all. Two causes with opposite meanings behind one word, and the only honest record
-- of the refusal was a Postgres WARNING in a log nobody watches on launch night. The
-- ceiling now returns its own word, 'capped'; 'ignored' keeps its old meaning
-- exactly. Nothing else in the function changed.
--
-- Everything else is byte-for-byte db/2026-09-04_ingest_death.sql (advisory
-- lock, replay idempotency, eilif/gs cross-upgrade). If that file changes,
-- regenerate this one from it rather than editing both.
--
-- Apply: paste into the Supabase SQL editor, or psql -f this file.
-- Rollback: re-run db/2026-09-04_ingest_death.sql.
-- Verified 2026-09-06 on the local rehearsal stack (rolled back): seven rapid gs
-- deaths for one character -> inserted x5, capped x2; five rows stored.

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
  v_ceiling constant integer := 5;
  v_ceiling_window constant interval := interval '60 seconds';
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
    -- PER-CHARACTER CEILING (2026-09-06, T-3 audit). The client death path is
    -- unauthenticated by design (the pack ships the token), so a forged report
    -- with reporter = victim passes every identity gate. This bounds the damage:
    -- more than v_ceiling deaths for one character inside +/- v_ceiling_window of
    -- the reported time is not how Valheim works (respawn alone takes longer), so
    -- the report is refused with 'capped' and a WARNING lands in the Postgres log.
    if (select count(*) from public.events
          where type = 'death'
            and character_name = p_name
            and created_at >= p_at - v_ceiling_window
            and created_at <= p_at + v_ceiling_window) >= v_ceiling then
      raise warning 'ingest_death: ceiling for % (% deaths within % of %); report capped',
        p_name, v_ceiling, v_ceiling_window, p_at;
      return 'capped';
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
  -- PER-CHARACTER CEILING (2026-09-06, T-3 audit). The client death path is
  -- unauthenticated by design (the pack ships the token), so a forged report
  -- with reporter = victim passes every identity gate. This bounds the damage:
  -- more than v_ceiling deaths for one character inside +/- v_ceiling_window of
  -- the reported time is not how Valheim works (respawn alone takes longer), so
  -- the report is refused with 'capped' and a WARNING lands in the Postgres log.
  if (select count(*) from public.events
        where type = 'death'
          and character_name = p_name
          and created_at >= p_at - v_ceiling_window
          and created_at <= p_at + v_ceiling_window) >= v_ceiling then
    raise warning 'ingest_death: ceiling for % (% deaths within % of %); report capped',
      p_name, v_ceiling, v_ceiling_window, p_at;
    return 'capped';
  end if;
  insert into public.events (type, player_id, character_name, metadata, created_at)
  values ('death', p_player_id, p_name, v_meta, p_at);
  return 'inserted';
end;
$$;

comment on function public.ingest_death(text, uuid, timestamptz, jsonb, text) is
  'Atomic cross-producer death ingest for /api/gs-ingest (lib/deaths.ts). Serializes per character with pg_advisory_xact_lock so two simultaneous reports of one death cannot both insert. Returns inserted|upgraded|dropped|duplicate|capped|ignored. ''capped'' is the per-character ceiling refusing a report; ''ignored'' means there was no players row to hang it on.';

-- service_role ONLY. The site reads with the anon key under RLS and must never
-- be able to write events through an RPC.
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from public;
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from anon;
revoke all on function public.ingest_death(text, uuid, timestamptz, jsonb, text) from authenticated;
grant execute on function public.ingest_death(text, uuid, timestamptz, jsonb, text) to service_role;
