-- STATUS: DRAFT, NOT APPLIED. Waits on Charlie's decision (open since 2026-09-12).
--
-- Drops the builds / crafts / distance / pickups / kills zero-points so a launch-fresh
-- character's WHOLE Eilif history counts. Deaths/damage/fish are not touched.
--
-- WHY. Every character on Eilif was made for launch (2026-09-09), so the profile
-- counters ARE the Eilif history. But the builds/crafts/distance zero-point was
-- taken late: the v15 reset (09-11) holed the groups and they were re-captured
-- from the first ACCEPTED profile-only post (09-12 14:36+, after the ingest fix),
-- so the columns only count growth since then. Example at drafting time:
-- Kætiløy's zero-point holds 12,702 builds and 230 km she earned here, and the
-- Stonewright / Far-Strider boards will never see them.
--
-- WHAT IT DOES, per player_stats row that has a gs_baseline (excluded players
-- such as Steward are left alone):
--   counters.structuresBuilt / itemsCrafted / distanceTraveled  -> 0
--   counterMaps.distances / counterMaps.distancesRaw            -> {}
--       (PRESENT and empty: a key missing from a present map is credited in
--        full, lib/gs-baseline.ts reconcileBaseline doc; a holed map would be
--        re-captured from the next post at its lifetime value instead)
--   those six paths leave `holes`      (they are readings now, not gaps)
--   the same keys leave `superseded`   (absent key = no ceiling, rule 2)
--   craftsSource  -> 'vh_Crafts'       (the 2026-09-13 audit: every GS-captured zero-point
--                                       carried craftsSource 'crafts' from an EMPTY 1.0 list,
--                                       so the profile's vh_Crafts was "not comparable" and
--                                       items_crafted froze at 0 for 29 of 30 players; the
--                                       profile post is the only crafts reading on 1.0)
--   pickupsSource -> 'vh_ItemsPickedUp' with resourcesHarvested 0 (same story for rows
--                                       baselined after the 09-12 pickups guard; pickups are
--                                       credited lifetime by decision, like the older rows)
--   killsSource   -> 'profile' with counters.kills 0, and the weapons-era
--                                       superseded.counters.kills ceiling dropped (Companion
--                                       Client 0.4.5 posts vh_EnemyKills; without this the first
--                                       profile post re-takes the kills zero-point at the lifetime
--                                       total and credits 0 that cycle, growth after — see
--                                       lib/gs-baseline withProfileKillsZeroPoint). RUN ONLY AFTER
--                                       the 0.4.5 dashboard code is live (deployed 2026-09-13).
-- The player_stats COLUMNS are not touched: the next profile post from each
-- character merges raw − 0 through GREATEST (rule 3), so every board climbs on
-- its own the next time that viking plays. Nothing is announced by the ingest
-- for a baseline change; Great Deeds may fire as the clan totals jump.
--
-- BACKUP FIRST (one table, cheap, so the old zero-points can be restored):
create table if not exists player_stats_gs_baseline_bak_2026_09_13 as
  select player_id, gs_baseline, now() as taken_at
  from player_stats where gs_baseline is not null;

-- THE CHANGE.
update player_stats ps
set gs_baseline = (
  with b as (select ps.gs_baseline as j),
  stripped as (
    select (j
      #- '{superseded,counters,structuresBuilt}'
      #- '{superseded,counters,itemsCrafted}'
      #- '{superseded,counters,distanceTraveled}'
      #- '{superseded,counters,resourcesHarvested}'
      #- '{superseded,counters,kills}'
      #- '{superseded,counterMaps,distances}'
      #- '{superseded,counterMaps,distancesRaw}'
      #- '{holes}') as j, b.j as orig from b
  ),
  remaining_holes as (
    select jsonb_agg(h) as arr
    from stripped, jsonb_array_elements_text(coalesce(stripped.orig->'holes', '[]'::jsonb)) h
    where h not in ('counters.structuresBuilt', 'counters.itemsCrafted', 'counters.distanceTraveled',
                    'counters.resourcesHarvested', 'counters.kills', 'counterMaps.distances', 'counterMaps.distancesRaw')
  )
  select stripped.j
    || jsonb_build_object(
         'counters',
           coalesce(stripped.j->'counters', '{}'::jsonb)
           || '{"structuresBuilt":0,"itemsCrafted":0,"distanceTraveled":0,"resourcesHarvested":0,"kills":0}'::jsonb,
         'counterMaps',
           coalesce(stripped.j->'counterMaps', '{}'::jsonb)
           || '{"distances":{},"distancesRaw":{}}'::jsonb,
         'craftsSource', 'vh_Crafts',
         'pickupsSource', 'vh_ItemsPickedUp',
         'killsSource', 'profile')
    || case when remaining_holes.arr is null then '{}'::jsonb
            else jsonb_build_object('holes', remaining_holes.arr) end
  from stripped, remaining_holes
)
from players p
where p.id = ps.player_id
  and ps.gs_baseline is not null
  and coalesce(p.excluded, false) = false;

-- VERIFY: every non-excluded row now reads 0 / {} for the six paths and lists
-- none of them as a hole. Expect zero rows back.
select p.character_name, ps.gs_baseline->'counters' as counters, ps.gs_baseline->'holes' as holes
from player_stats ps join players p on p.id = ps.player_id
where ps.gs_baseline is not null and coalesce(p.excluded, false) = false
  and ( (ps.gs_baseline->'counters'->>'structuresBuilt')::numeric <> 0
     or (ps.gs_baseline->'counters'->>'itemsCrafted')::numeric <> 0
     or (ps.gs_baseline->'counters'->>'distanceTraveled')::numeric <> 0
     or ps.gs_baseline->'counterMaps'->'distances' <> '{}'::jsonb
     or ps.gs_baseline->'counterMaps'->'distancesRaw' <> '{}'::jsonb
     or coalesce(ps.gs_baseline->'holes', '[]'::jsonb) ?| array['counters.structuresBuilt','counters.itemsCrafted','counters.distanceTraveled','counters.resourcesHarvested','counterMaps.distances','counterMaps.distancesRaw']
     or ps.gs_baseline->>'craftsSource' is distinct from 'vh_Crafts'
     or ps.gs_baseline->>'killsSource' is distinct from 'profile'
     or (ps.gs_baseline->'counters'->>'kills')::numeric <> 0
     or ps.gs_baseline->>'pickupsSource' is distinct from 'vh_ItemsPickedUp'
     or ps.gs_baseline->'superseded'->'counters' ?| array['structuresBuilt','itemsCrafted','distanceTraveled'] );

-- ROLLBACK (only if the old zero-points are wanted back; the columns keep
-- whatever GREATEST has merged since, which cannot be lowered):
--   update player_stats ps set gs_baseline = bak.gs_baseline
--   from player_stats_gs_baseline_bak_2026_09_13 bak where bak.player_id = ps.player_id;
