-- STATUS: APPLIED 2026-09-13 ~11:25 CT via the Supabase MCP, with ONE deviation from the text
-- below: Rosir's restored blob took its builds/distance groups (structuresBuilt 2469, the
-- distances maps) from the LIVE zero-point instead of the lineage holes, so his builds keep
-- counting exactly as before the repair instead of re-filling at today's lifetime and
-- stalling. Yunter's lineage blob already carried those groups; Fjällhnot's are near zero.
-- Original text kept for the record. Repairs the three player_stats rows the ingest WIPED on
-- 2026-09-12/13 (see 08-Dashboard tracker, 2026-09-13 stats audit).
--
-- WHAT HAPPENED. app/api/gs-ingest/route.ts read the existing player_stats row with
-- `const { data: prevRows } = ...` and ignored `error`. Supabase REST returned 504 on
-- about 0.3 percent of requests all day (37 player_stats GETs in 24 h). On such a post
-- the route saw prev = null, applyBaseline took a FRESH zero-point at the character's
-- lifetime totals, and mergeIntoRow(prev = null) overwrote every column with the tiny
-- effective values. Fixed in code the same day (fail closed on read errors).
--
-- WHO. Compared against the nightly snapshots in ~/valheim-db-backups (09-10 .. 09-13):
--   Yunter     zero-point re-taken 2026-09-13 10:00Z: kills 132 -> 8, builds 101 -> 1, 52 km -> 2 km
--   Rosir      zero-point re-taken 2026-09-13 01:44Z: kills 103 -> 56
--   Fjällhnot  zero-point re-taken 2026-09-12 07:08Z AND 2026-09-13 00:40Z: kills 249 -> 54 -> 170
-- Six other rows had their capturedAt change (S'aeien, Æymundr, Kætiløy, Imogen, Zærø,
-- Asbjorn) but no column ever went DOWN across the snapshots, so they are left alone.
--
-- WHAT IT DOES, per row: restore gs_baseline + gs_stats + gs_baselined_at from the
-- last snapshot in the ORIGINAL zero-point lineage (holes and all), and floor every
-- cumulative column at the highest value any snapshot or the live row holds. The next
-- client post then credits raw - original zero-point through GREATEST, so the boards
-- climb back on their own. Where the GsValheimStatsClient weapons file was reset by a
-- pack update in between (Fjällhnot), the kills column keeps the floor until raw
-- growth passes it: a stall, not a loss.
--
-- The restored lineage blob still HOLES builds/distance for Rosir (captured before the
-- 09-12 profile-post fix): run db/2026-09-13_drop_profile_zero_points.sql right after
-- this (Charlie's call) or those two groups re-fill at today's lifetime value and stall.
--
-- BACKUP FIRST:
create table if not exists player_stats_wiped_rows_bak_2026_09_13 as
  select ps.*, now() as taken_at from player_stats ps
  where ps.player_id in ('f8c28446-7898-4388-90db-9e50d702e34b', 'f08af9f3-d53e-4906-b157-a4424c74bfa9', '66005161-33e3-4a81-b7c1-e80d156ee166');

-- Yunter: lineage from snapshot 20260913-0337 (zero-point captured 2026-09-10T01:16:49), damaged 2026-09-13T10:00:47
update player_stats set
  gs_baseline = '{"v": 1, "holes": ["counters.fishCaught"], "world": "Eilif", "records": {"longestLifeSec": 0, "bestKillsBeforeDeath": 0}, "counters": {"kills": 1, "deaths": 0, "bossKills": 0, "damageDealt": 0, "itemsCrafted": 0, "structuresBuilt": 509, "distanceTraveled": 79986, "resourcesHarvested": 0}, "reporter": "Yunter", "capturedAt": "2026-09-10T01:16:49.605Z", "recordMaps": {"skills": {}, "weaponHardestHit": {}, "weaponBiggestSwing": {}}, "counterMaps": {"fish": {}, "distances": {"air": 4202, "run": 26622, "sail": 18970, "walk": 30191, "total": 79986}, "materials": {}, "bossDamage": {}, "weaponKills": {}, "bossFightSec": {}, "distancesRaw": {"vh_DistanceAir": 4202, "vh_DistanceRun": 26622, "vh_DistanceSail": 18970, "vh_DistanceWalk": 30191, "vh_DistanceTraveled": 79986}, "weaponDamage": {}, "creatureKills": {}}, "killsSource": "weapons", "craftsSource": "crafts", "pickupsSource": "pickups"}'::jsonb,
  gs_stats = '{"fish": [], "skills": [{"level": 33, "skill": "Run"}, {"level": 25, "skill": "Axes"}, {"level": 23, "skill": "Pickaxes"}, {"level": 23, "skill": "WoodCutting"}, {"level": 17, "skill": "Clubs"}, {"level": 17, "skill": "Jump"}, {"level": 15, "skill": "Bows"}, {"level": 14, "skill": "Swim"}, {"level": 12, "skill": "Crafting"}, {"level": 8, "skill": "Farming"}, {"level": 5, "skill": "Cooking"}, {"level": 5, "skill": "Sneak"}], "records": {"topWeapon": "Axes", "hardestHit": 111, "biggestSwing": 111, "topWeaponDamage": 3816}, "weapons": [{"kills": 90, "weapon": "Axes", "hardestHit": 92, "damageDealt": 3816, "biggestSwing": 92}, {"kills": 16, "weapon": "Bows", "hardestHit": 111, "damageDealt": 1053, "biggestSwing": 111}, {"kills": 28, "weapon": "Clubs", "hardestHit": 24, "damageDealt": 951, "biggestSwing": 25}, {"kills": 0, "weapon": "Unarmed", "hardestHit": 3, "damageDealt": 15, "biggestSwing": 3}, {"kills": 0, "weapon": "Pickaxes", "hardestHit": 4, "damageDealt": 4, "biggestSwing": 4}], "distances": {"air": 1780, "run": 8851, "sail": 32988, "walk": 8009, "total": 51626}, "materials": [], "bossDamage": [{"boss": "Eikthyr", "fightSec": 79, "damageDealt": 213}], "platformId": "-985818353", "distancesRaw": {"vh_DistanceAir": 1780, "vh_DistanceRun": 8851, "vh_DistanceSail": 32988, "vh_DistanceWalk": 8009, "vh_DistanceTraveled": 51626}, "creatureKills": [], "currentLifeStartedUtc": "2026-09-13T04:46:58.6044810Z"}'::jsonb,
  gs_baselined_at = '2026-09-10T01:16:49.605+00:00',
  kills = greatest(coalesce(kills,0), 132),
  deaths = greatest(coalesce(deaths,0), 30),
  resources_harvested = greatest(coalesce(resources_harvested,0), 0),
  items_crafted = greatest(coalesce(items_crafted,0), 0),
  distance_traveled = greatest(coalesce(distance_traveled,0), 51626),
  structures_built = greatest(coalesce(structures_built,0), 101),
  map_explored_pct = greatest(coalesce(map_explored_pct,0), 15),
  damage_dealt = greatest(coalesce(damage_dealt,0), 5570),
  boss_kills = greatest(coalesce(boss_kills,0), 0),
  longest_life_sec = greatest(coalesce(longest_life_sec,0), 0),
  best_kills_before_death = greatest(coalesce(best_kills_before_death,0), 0)
where player_id = 'f8c28446-7898-4388-90db-9e50d702e34b';

-- Rosir: lineage from snapshot 20260912-0335 (zero-point captured 2026-09-09T21:58:16), damaged 2026-09-13T01:44:01
update player_stats set
  gs_baseline = '{"v": 1, "holes": ["counters.structuresBuilt", "counters.distanceTraveled", "counterMaps.distances", "counterMaps.distancesRaw"], "world": "Eilif", "records": {"longestLifeSec": 0, "bestKillsBeforeDeath": 0}, "counters": {"kills": 1, "deaths": 0, "bossKills": 0, "damageDealt": 0, "itemsCrafted": 0, "resourcesHarvested": 0}, "reporter": "Rosir", "capturedAt": "2026-09-09T21:58:16.034Z", "recordMaps": {"skills": {}, "weaponHardestHit": {}, "weaponBiggestSwing": {}}, "counterMaps": {"fish": {}, "materials": {}, "bossDamage": {}, "weaponKills": {}, "bossFightSec": {}, "weaponDamage": {}, "creatureKills": {}}, "killsSource": "weapons", "craftsSource": "crafts"}'::jsonb,
  gs_stats = '{"fish": [], "skills": [{"level": 34, "skill": "WoodCutting"}, {"level": 30, "skill": "Knives"}, {"level": 28, "skill": "Run"}, {"level": 25, "skill": "Pickaxes"}, {"level": 24, "skill": "Bows"}, {"level": 20, "skill": "Axes"}, {"level": 19, "skill": "Jump"}, {"level": 17, "skill": "Crafting"}, {"level": 16, "skill": "Sneak"}, {"level": 12, "skill": "Farming"}, {"level": 7, "skill": "Unarmed"}, {"level": 7, "skill": "Cooking"}], "records": {"topWeapon": "Bows", "hardestHit": 242, "biggestSwing": 242, "topWeaponDamage": 4572}, "weapons": [{"kills": 33, "weapon": "Bows", "hardestHit": 242, "damageDealt": 4572, "biggestSwing": 242}, {"kills": 81, "weapon": "Knives", "hardestHit": 109, "damageDealt": 4470, "biggestSwing": 109}, {"kills": 60, "weapon": "Axes", "hardestHit": 52, "damageDealt": 1650, "biggestSwing": 52}, {"kills": 3, "weapon": "Unarmed", "hardestHit": 10, "damageDealt": 47, "biggestSwing": 10}], "materials": [], "bossDamage": [], "platformId": "-121240223", "creatureKills": [], "currentLifeStartedUtc": "2026-09-12T02:17:45.2293891Z"}'::jsonb,
  gs_baselined_at = '2026-09-09T21:58:16.034+00:00',
  kills = greatest(coalesce(kills,0), 103),
  deaths = greatest(coalesce(deaths,0), 31),
  resources_harvested = greatest(coalesce(resources_harvested,0), 0),
  items_crafted = greatest(coalesce(items_crafted,0), 0),
  distance_traveled = greatest(coalesce(distance_traveled,0), 19646),
  structures_built = greatest(coalesce(structures_built,0), 1233),
  map_explored_pct = greatest(coalesce(map_explored_pct,0), 14.91),
  damage_dealt = greatest(coalesce(damage_dealt,0), 8941),
  boss_kills = greatest(coalesce(boss_kills,0), 0),
  longest_life_sec = greatest(coalesce(longest_life_sec,0), 0),
  best_kills_before_death = greatest(coalesce(best_kills_before_death,0), 0)
where player_id = 'f08af9f3-d53e-4906-b157-a4424c74bfa9';

-- Fjällhnot: lineage from snapshot 20260911-0331 (zero-point captured 2026-09-09T22:20:36), damaged 2026-09-13T00:40:08
update player_stats set
  gs_baseline = '{"v": 1, "world": "Eilif", "records": {"longestLifeSec": 0, "bestKillsBeforeDeath": 0}, "counters": {"kills": 1, "deaths": 0, "bossKills": 0, "damageDealt": 0, "itemsCrafted": 0, "structuresBuilt": 0, "distanceTraveled": 49, "resourcesHarvested": 0}, "reporter": "Fjällhnot", "capturedAt": "2026-09-09T22:20:36.552Z", "recordMaps": {"skills": {}, "weaponHardestHit": {}, "weaponBiggestSwing": {}}, "counterMaps": {"fish": {}, "distances": {"air": 0, "run": 2, "sail": 0, "walk": 48, "total": 49}, "materials": {}, "bossDamage": {}, "weaponKills": {}, "bossFightSec": {}, "distancesRaw": {"vh_DistanceAir": 0, "vh_DistanceRun": 2, "vh_DistanceSail": 0, "vh_DistanceWalk": 48, "vh_DistanceTraveled": 49}, "weaponDamage": {}, "creatureKills": {}}, "killsSource": "weapons", "craftsSource": "crafts"}'::jsonb,
  gs_stats = '{"fish": [], "skills": [{"level": 55, "skill": "Run"}, {"level": 39, "skill": "WoodCutting"}, {"level": 34, "skill": "Axes"}, {"level": 31, "skill": "Pickaxes"}, {"level": 23, "skill": "Jump"}, {"level": 21, "skill": "Crafting"}, {"level": 18, "skill": "Bows"}, {"level": 14, "skill": "Farming"}, {"level": 9, "skill": "Cooking"}, {"level": 9, "skill": "Unarmed"}, {"level": 6, "skill": "Blocking"}, {"level": 2, "skill": "Swim"}], "records": {"topWeapon": "Axes", "hardestHit": 138, "biggestSwing": 141, "topWeaponDamage": 12125}, "weapons": [{"kills": 229, "weapon": "Axes", "hardestHit": 138, "damageDealt": 12125, "biggestSwing": 141}, {"kills": 14, "weapon": "Bows", "hardestHit": 102, "damageDealt": 3118, "biggestSwing": 102}, {"kills": 6, "weapon": "Unarmed", "hardestHit": 11, "damageDealt": 103, "biggestSwing": 11}, {"kills": 1, "weapon": "Pickaxes", "hardestHit": 12, "damageDealt": 12, "biggestSwing": 12}], "distances": {"air": 0, "run": 0, "sail": 0, "walk": 0, "total": 0}, "materials": [], "bossDamage": [], "platformId": "1887007462", "distancesRaw": {"vh_DistanceAir": 0, "vh_DistanceRun": 0, "vh_DistanceSail": 0, "vh_DistanceWalk": 0, "vh_DistanceTraveled": 0}, "creatureKills": [], "currentLifeStartedUtc": "2026-09-10T18:04:49.1166908Z"}'::jsonb,
  gs_baselined_at = '2026-09-09T22:20:36.552+00:00',
  kills = greatest(coalesce(kills,0), 249),
  deaths = greatest(coalesce(deaths,0), 8),
  resources_harvested = greatest(coalesce(resources_harvested,0), 0),
  items_crafted = greatest(coalesce(items_crafted,0), 0),
  distance_traveled = greatest(coalesce(distance_traveled,0), 50603),
  structures_built = greatest(coalesce(structures_built,0), 3383),
  map_explored_pct = greatest(coalesce(map_explored_pct,0), 14.91),
  damage_dealt = greatest(coalesce(damage_dealt,0), 18896),
  boss_kills = greatest(coalesce(boss_kills,0), 0),
  longest_life_sec = greatest(coalesce(longest_life_sec,0), 0),
  best_kills_before_death = greatest(coalesce(best_kills_before_death,0), 0)
where player_id = '66005161-33e3-4a81-b7c1-e80d156ee166';

-- VERIFY (expect the three names with the restored capturedAt and floored kills):
select p.character_name, ps.kills, ps.structures_built, round(ps.distance_traveled) as dist,
       ps.gs_baseline->>'capturedAt' as captured, ps.gs_baseline->'counters'->>'kills' as base_kills, ps.gs_baseline->'holes' as holes
from player_stats ps join players p on p.id = ps.player_id
where ps.player_id in ('f8c28446-7898-4388-90db-9e50d702e34b', 'f08af9f3-d53e-4906-b157-a4424c74bfa9', '66005161-33e3-4a81-b7c1-e80d156ee166');

-- ROLLBACK: update player_stats ps set (gs_baseline, gs_stats, gs_baselined_at, kills, deaths, resources_harvested, items_crafted, distance_traveled, structures_built, map_explored_pct, damage_dealt, boss_kills, longest_life_sec, best_kills_before_death)
--   = (b.gs_baseline, b.gs_stats, b.gs_baselined_at, b.kills, b.deaths, b.resources_harvested, b.items_crafted, b.distance_traveled, b.structures_built, b.map_explored_pct, b.damage_dealt, b.boss_kills, b.longest_life_sec, b.best_kills_before_death)
--   from player_stats_wiped_rows_bak_2026_09_13 b where b.player_id = ps.player_id;
