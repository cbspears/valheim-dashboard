-- Collective Milestones ("Great Deeds") — REBALANCE of the 2026-07-05 seed set.
--
-- Same engine, same table, same column shape as db/2026-07-05_milestones.sql —
-- this migration only re-seeds the DEFINITION rows. It does NOT alter schema.
--
-- Why (owner's complaint, 2026-07-06): the original 15 deeds were lopsided —
-- 6 of 15 (40%) were "distance travelled" (4 sail + 2 walk/run), while
-- boss_kills_total and crafts_total had ZERO deeds despite being fully computable
-- today, and damage/resources/builds/playtime/explored each had only ONE. Result:
-- "way too many just running milestones." This set rebalances to ~2–3 tiers per
-- category and adds the two missing ones:
--   • Distance (sail + walk/run) collapsed 6 → 3 (one on foot, two by sea),
--     keeping only the most evocative early/mid/late real-world equivalences.
--   • NEW Boss Slaying (boss_kills_total): first boss → half the roster → all 8,
--     matching the real boss table (Eikthyr … Yagluth … the Queen … Fader …
--     the Bog Witch of the Deep North; 8 total, Deep North lands post-launch).
--   • NEW Crafting (crafts_total): 3 tiers.
--   • deaths_total / kills_total kept at 2 tiers (unchanged numbers).
--   • damage / resources / builds / playtime / explored each expanded 1 → 3
--     (an "achievable soon" tier + the old proud tier + a harder endgame tier).
-- 28 deeds; no single category exceeds 3; distance is now 3/28 (~11%, was 40%).
--
-- Thresholds remain PACING GUESSES for 15–20 players over a months-long final
-- playthrough (same philosophy as the 2026-07-05 seed comment) — spread from
-- "reachable in the first month or two of real play" to "a proud endgame deed."
-- Calibrated against the live pilot's real testers (Testmantwo/Psifour/Steve/
-- Testman) — NOT the stale 'Chærlie' junk row (see note at bottom). Expect to
-- tune after real data; crafts_total is the least-certain (observed craft counts
-- run low relative to kills/builds — watch it). Distances are metres (vh_Distance*).
--
-- The 2026-07-05 file is already applied and stays as the table's DDL of record;
-- this file is a pure data re-seed (delete-all + insert), safe to re-run.
--   psql "$SUPABASE_DB_URL" -f db/2026-07-06_milestones_rebalance.sql
-- or paste into the Supabase SQL editor.

-- Wipe the old definitions. All current achieved/announced state is pilot/test
-- data already slated for the pre-launch wipe, so there is no real loss.
delete from public.milestones;

-- ── Rebalanced definitions ──────────────────────────────────────────────────
-- Flavor numbers are ≈ and editable; equivalences are stored without the "≈"
-- prefix (the UI adds it). Apostrophes are doubled for SQL.
insert into public.milestones (id, metric, threshold, title, line, equivalence, sort) values
  -- Boss Slaying — the roster is 8 (Eikthyr … the Bog Witch of the Deep North).
  ('boss-first',        'boss_kills_total',            1,  'The First Forsaken',       'The first of the Forsaken has fallen. One trophy now hangs at the sacrificial stones.',      null,                                      10),
  ('boss-half',         'boss_kills_total',            4,  'Half the Forsaken',        'Four of the Forsaken lie slain — half their number broken.',                                null,                                      20),
  ('boss-all',          'boss_kills_total',            8,  'The Forsaken Fallen',      'Every one of the Forsaken has fallen, from Eikthyr to the Bog Witch of the Deep North. The saga is complete.', null,                     30),

  -- Distance travelled — one on foot (early), two by sea (mid, endgame).
  ('walk-marathon',     'walk_run_total',          42195,  'The First Marathon',       'A marathon on foot, between all of us.',                                                     'Athens, 490 BC',                          40),
  ('sail-norway',       'sail_total',            1750000,  'The Length of Norway',     'Together we have sailed the length of Norway itself.',                                       'Lindesnes to North Cape',                 50),
  ('sail-vinland',      'sail_total',            5600000,  'The Road to Vinland',      'As far as the vikings ever sailed: to Vinland.',                                             'Norway to Newfoundland',                  60),

  -- Kills.
  ('kills-thousand',    'kills_total',              1000,  'The First Thousand',       'A thousand foes lie behind us.',                                                             null,                                      70),
  ('kills-stamford',    'kills_total',             10000,  'Stamford Bridge',          'Ten thousand slain — a battle to end an age.',                                               'combatants at Stamford Bridge, 1066',     80),

  -- Deaths.
  ('deaths-longtable',  'deaths_total',               13,  'A Full Longtable',         'Thirteen seats now filled at Valhalla''s table.',                                            'one full mead-bench',                     90),
  ('deaths-village',    'deaths_total',              100,  'A Village of the Fallen',  'One hundred deaths. A village''s worth of vikings.',                                          'pop. of a small Norse village',          100),

  -- Damage dealt (HP). Troll = 600 HP for the two lower tiers.
  ('damage-hundred',    'damage_total',            60000,  'A Hundred Trolls'' Worth', 'Fury enough to fell a hundred trolls.',                                                       '100 x troll (600 HP)',                   110),
  ('damage-trolls',     'damage_total',           600000,  'A Thousand Trolls'' Worth','Enough fury to fell a thousand trolls.',                                                      '1,000 x troll (600 HP)',                 120),
  ('damage-fury',       'damage_total',          3000000,  'The Fury of the Aesir',    'Three million wounds dealt — wrath enough to rattle Asgard''s gates.',                        null,                                     130),

  -- Crafting (items_crafted). Least-certain thresholds — see header note.
  ('crafts-forge',      'crafts_total',              500,  'The Forge Roars',          'Five hundred works have left the forge; the anvils ring without pause.',                      null,                                     140),
  ('crafts-smiths',     'crafts_total',             2500,  'The Smiths'' Toil',        'Two and a half thousand items shaped by the crew''s own hands.',                              null,                                     150),
  ('crafts-master',     'crafts_total',            10000,  'Ten Thousand Works',       'Ten thousand works forged, tempered, and carried into battle.',                              null,                                     160),

  -- Builds (structures placed).
  ('builds-longhouse',  'builds_total',             1000,  'The First Longhouse',      'A thousand pieces raised — a longhouse stands against the dark.',                             null,                                     170),
  ('builds-stave',      'builds_total',            10000,  'Stave by Stave',           'Ten thousand pieces raised — a stave church''s worth of work.',                               'a stave church''s timbers',              180),
  ('builds-jomsborg',   'builds_total',            50000,  'The Walls of Jomsborg',    'Fifty thousand pieces raised — walls to rival Jomsborg itself.',                              'the fortress of Jomsborg',               190),

  -- Resources harvested.
  ('resources-stores',  'resources_total',         10000,  'The First Stores',         'Ten thousand goods gathered and laid up in the stores.',                                     null,                                     200),
  ('resources-hoard',   'resources_total',        100000,  'The Great Hoard',          'A hundred thousand goods gathered.',                                                          null,                                     210),
  ('resources-kings',   'resources_total',       1000000,  'A King''s Ransom',         'A million goods gathered — a hoard worthy of a jarl''s hall.',                                null,                                     220),

  -- Playtime (hours lived, derived from sessions).
  ('playtime-hundred',  'playtime_total_hours',      100,  'A Hundred Hours Lived',    'A hundred hours lived together in this world.',                                              'four days and nights',                   230),
  ('playtime-forty',    'playtime_total_hours',     1000,  'Forty Days at Sea',        'A thousand hours lived in this world.',                                                       '40 days and nights',                     240),
  ('playtime-year',     'playtime_total_hours',     8760,  'A Year in Midgard',        'A full year of hours lived beneath these skies.',                                             '365 days and nights',                    250),

  -- Explored (average % of the map charted across vikings). Percentage — 0–100.
  ('explored-edge',     'explored_avg_pct',           10,  'Beyond the First Shore',   'A tenth of Midgard now lies charted.',                                                        null,                                     260),
  ('explored-quarter',  'explored_avg_pct',           25,  'The Charted Quarter',      'A quarter of Midgard now known to us.',                                                       null,                                     270),
  ('explored-half',     'explored_avg_pct',           50,  'Half of Midgard Known',    'Half of all Midgard now lies charted and named.',                                             null,                                     280)
on conflict (id) do nothing;

-- ── Data-quality follow-up (NOT fixed here) ─────────────────────────────────
-- player_stats still carries a stale junk row for character 'Chærlie' (kills
-- 1526, deaths 163, structures_built 27207, gs_updated_at NULL) that does not
-- reflect a real client re-POST — recurring junk (a near-identical row from this
-- same character was deleted once before, commit 4ff40f1). It was EXCLUDED from
-- the calibration above and needs cleaning again before it skews live aggregates
-- (its structures_built 27207 alone would over-fire the builds deeds). Left in
-- place deliberately — flag only, no deletion in this data-migration.
