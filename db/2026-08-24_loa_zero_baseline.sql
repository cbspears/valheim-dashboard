-- NOT APPLIED. Charlie's call.
--
-- PURPOSE. Lóa (player_stats.player_id = 280f67f0-1310-4b1f-9ea8-01b67c2a88a4,
-- gs_reporter 'Lóa') was baselined 2026-08-23T22:53:31.464Z at kills 68 /
-- deaths 1 / builds 211 / resources 90 / crafts 11 / distance 10,886 m / 7
-- creature types. Per db/2026-08-23_gs_baselines.sql, that zero-point means
-- none of it has been credited to player_stats — it was treated as a lifetime
-- import and subtracted off. If Lóa is in fact a fresh character whose whole
-- history was earned on THIS server (not an imported veteran profile), the
-- operator may choose to credit it after all. This file documents that option;
-- it does not decide it.
--
-- WHY `gs_baseline = null` (the migration's documented "forgive" path, bottom
-- of db/2026-08-23_gs_baselines.sql) DOES NOT DO THIS. Clearing the column
-- doesn't restore anything — it just deletes the zero-point. Her next client
-- post then re-captures a fresh baseline at her CURRENT raw totals (see
-- lib/gs-baseline.ts applyBaseline, path 1: "first zero-point"), which credits
-- that post exactly zero, same as the first time. The 68/211/90/11/10,886 she
-- already earned becomes the new floor she starts crediting ABOVE, not a
-- lump sum credited to her. Forgiving swaps one zero-point for another; it
-- never retroactively pays out the difference.
--
-- WHY A ZERO BASELINE DOES. Setting gs_baseline's counters (and every
-- counterMaps entry) to 0 makes her existing raw totals the FULL delta on her
-- next post: raw − 0 is credited in one shot, on the next client POST while
-- she's online (~120s cadence). player_stats columns are then Math.max-merged
-- (GREATEST) against what's already stored (lib/gs-baseline.ts applyBaseline,
-- row-building step), so the credit is ONE-WAY: once it lands, re-applying the
-- old non-zero baseline afterward cannot claw the merged columns back down —
-- see the revert note at the bottom of this file.

-- ── 1. THE APPLY ──────────────────────────────────────────────────────────
--
-- Every counterMaps group below is present as `{}` rather than omitted.
-- readBaseline/reconcileBaseline (lib/gs-baseline.ts) treat a group ABSENT
-- from the blob as MALFORMED, not "zero groups" — the next qualifying
-- snapshot silently REPAIRS it from her live raw reading, crediting nothing
-- that cycle. Same zero-crediting *outcome* as an explicit `{}`, but it would
-- log a "BASELINE REPAIRED" line and hide a typo behind an unrelated code
-- path, so every group gets an explicit `{}` instead. No "holes" key: this is
-- a complete zero-point, not a partial one.
--
-- `distances` / `distancesRaw` deliberately OMIT the `sail` / `vh_DistanceSail`
-- key. Those two are the CLOSED-key maps (lib/gs-baseline.ts BASELINE_GROUPS,
-- `closedKeys: true`, doc ~lines 118-133): every key present is read as a real
-- zero, but a key that's simply ABSENT is a per-key hole that fills silently
-- on first sighting — one cycle of zero credit, no repair-log noise. Her
-- client has never reported sail distance, so writing an explicit `0` there
-- would assert a reading nobody has taken; omitting it is the honest "no data
-- yet" state and costs nothing (one cycle of zero sail credit, the first time she sails).
--
-- `craftsSource: "vh_Crafts"` is kept so a future itemsCrafted delta compares
-- like against like (rule 4, applyBaseline) — a snapshot parsed from the other
-- source would otherwise credit itemsCrafted as zero until sources realign.
--
-- No `pendingReset`, no `superseded`: this is a fresh, healthy zero-point, not
-- a re-baseline replacing a suspected reset.
--
-- gs_baselined_at is DELIBERATELY left untouched. The route only rewrites it
-- when it writes a new `nextBaseline` (capture / repair / rebaseline — see
-- applyBaseline's row-building step, "Only written when it actually changed");
-- a healthy career with nothing to fill or repair leaves it alone entirely.
-- The stored value already reads 2026-08-23T22:53:31.464Z, which IS the real
-- moment this zero-point was captured — this update changes what was credited
-- from that capture, not when the capture happened, so the timestamp stays
-- accurate and is kept on purpose.

update public.player_stats
   set gs_baseline = '{"v":1,"capturedAt":"2026-08-23T22:53:31.464Z","reporter":"Lóa","world":"EilifRehearsal","craftsSource":"vh_Crafts","counters":{"kills":0,"deaths":0,"bossKills":0,"resourcesHarvested":0,"itemsCrafted":0,"structuresBuilt":0,"damageDealt":0,"distanceTraveled":0},"counterMaps":{"weaponDamage":{},"weaponKills":{},"creatureKills":{},"bossDamage":{},"bossFightSec":{},"materials":{},"fish":{},"distances":{"total":0,"walk":0,"run":0,"air":0},"distancesRaw":{"vh_DistanceTraveled":0,"vh_DistanceWalk":0,"vh_DistanceRun":0,"vh_DistanceAir":0}},"records":{"longestLifeSec":0,"bestKillsBeforeDeath":0},"recordMaps":{"weaponHardestHit":{},"weaponBiggestSwing":{},"skills":{}}}'::jsonb
 where player_id = '280f67f0-1310-4b1f-9ea8-01b67c2a88a4';

-- ── 2. MANDATORY READ-BACK ────────────────────────────────────────────────
--
-- Run this immediately after the update. Every column should read `true`; a
-- `false` anywhere means the write was malformed — re-apply immediately.
-- Also: after her NEXT client post, a Vercel log line "[gs-ingest] BASELINE
-- CAPTURED" or "BASELINE REPAIRED" for "Lóa" (app/api/gs-ingest/route.ts)
-- means the stored blob still had something wrong with it — re-apply then too.

select
  jsonb_typeof(gs_baseline->'v') = 'number'                         as v_is_number,
  (gs_baseline->>'v')::int = 1                                      as v_is_one,
  jsonb_typeof(gs_baseline->'counters') = 'object'                  as counters_is_object,
  jsonb_typeof(gs_baseline->'counters'->'kills') = 'number'
    and (gs_baseline->'counters'->>'kills')::numeric = 0            as kills_zero,
  jsonb_typeof(gs_baseline->'counters'->'deaths') = 'number'
    and (gs_baseline->'counters'->>'deaths')::numeric = 0           as deaths_zero,
  jsonb_typeof(gs_baseline->'counters'->'bossKills') = 'number'
    and (gs_baseline->'counters'->>'bossKills')::numeric = 0        as boss_kills_zero,
  jsonb_typeof(gs_baseline->'counters'->'resourcesHarvested') = 'number'
    and (gs_baseline->'counters'->>'resourcesHarvested')::numeric = 0 as resources_zero,
  jsonb_typeof(gs_baseline->'counters'->'itemsCrafted') = 'number'
    and (gs_baseline->'counters'->>'itemsCrafted')::numeric = 0     as crafts_zero,
  jsonb_typeof(gs_baseline->'counters'->'structuresBuilt') = 'number'
    and (gs_baseline->'counters'->>'structuresBuilt')::numeric = 0  as builds_zero,
  jsonb_typeof(gs_baseline->'counters'->'damageDealt') = 'number'
    and (gs_baseline->'counters'->>'damageDealt')::numeric = 0      as damage_zero,
  jsonb_typeof(gs_baseline->'counters'->'distanceTraveled') = 'number'
    and (gs_baseline->'counters'->>'distanceTraveled')::numeric = 0 as distance_zero,
  (select array_agg(k order by k) from jsonb_object_keys(gs_baseline->'counterMaps') as k)
    = array['bossDamage','bossFightSec','creatureKills','distances','distancesRaw',
             'fish','materials','weaponDamage','weaponKills']       as counter_maps_keys_ok,
  (select array_agg(k order by k) from jsonb_object_keys(gs_baseline->'recordMaps') as k)
    = array['skills','weaponBiggestSwing','weaponHardestHit']       as record_maps_keys_ok,
  not (gs_baseline ? 'holes')                                       as holes_absent
  from public.player_stats
 where player_id = '280f67f0-1310-4b1f-9ea8-01b67c2a88a4';

-- ── 3. EXPECTED EFFECTS ───────────────────────────────────────────────────
--
-- On her next client post (~120s while online): columns jump to roughly
-- kills ~78 / builds ~380 / resources ~100 / crafts 12 / distance ~14.8 km —
-- exact values depend on what she's played since 2026-08-23T22:53:31.464Z,
-- credited as the GREATEST merge, not a hard overwrite.
--
-- Living Titles: she crosses the 50-kill floor and will likely take "Bane of
-- Beasts" — an announcement in #server plus an in-game voice line.
--
-- Great Deeds: no ladder threshold crosses from this alone (checked
-- 2026-08-24 ~02:30 UTC against live clan totals).
--
-- Reset protection is PERMANENTLY off for her under a zero baseline: with no
-- `superseded` ceiling, a different character file later named "Lóa" would be
-- credited in full rather than held down. Re-baseline by hand (clear
-- gs_baseline per the "forgive" recipe in db/2026-08-23_gs_baselines.sql) if
-- that ever matters.
--
-- Prefer applying while she is OFFLINE. A concurrent client post that lands
-- mid-write could fill a closed-key hole (e.g. sail, the moment she first
-- sails) against the wrong version of this row and clobber the intended
-- write. Re-run the read-back (section 2) after her first post either way.

-- ── 4. REVERT ──────────────────────────────────────────────────────────────
--
-- Verbatim original gs_baseline this replaces (her real 2026-08-23 capture).
-- Restores the non-zero zero-point going forward, but CANNOT lower the
-- player_stats columns the zero baseline already Math.max-merged upward —
-- those stay at whatever they climbed to; only future crediting is affected.

-- update public.player_stats
--    set gs_baseline = '{"v":1,"world":"EilifRehearsal","records":{"longestLifeSec":0,"bestKillsBeforeDeath":0},"counters":{"kills":68,"deaths":1,"bossKills":0,"damageDealt":0,"itemsCrafted":11,"structuresBuilt":211,"distanceTraveled":10886,"resourcesHarvested":90},"reporter":"Lóa","capturedAt":"2026-08-23T22:53:31.464Z","recordMaps":{"skills":{"Run":5,"Axes":7,"Jump":9,"Clubs":13,"Sneak":6,"Cooking":2,"Farming":4,"Blocking":2,"Crafting":7,"WoodCutting":13},"weaponHardestHit":{},"weaponBiggestSwing":{}},"counterMaps":{"fish":{},"distances":{"air":1344,"run":592,"walk":8948,"total":10886},"materials":{},"bossDamage":{},"weaponKills":{},"bossFightSec":{},"distancesRaw":{"vh_DistanceAir":1344,"vh_DistanceRun":592,"vh_DistanceWalk":8948,"vh_DistanceTraveled":10886},"weaponDamage":{},"creatureKills":{"$enemy_boar":7,"$enemy_deer":2,"$enemy_neck":3,"$enemy_greyling":24,"$enemy_greydwarf":22,"$enemy_greydwarfbrute":6,"$enemy_greydwarfshaman":4}},"craftsSource":"vh_Crafts"}'::jsonb
--  where player_id = '280f67f0-1310-4b1f-9ea8-01b67c2a88a4';
