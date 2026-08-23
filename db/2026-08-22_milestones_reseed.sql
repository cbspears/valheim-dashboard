-- Collective Milestones ("Great Deeds") — LAUNCH RESEED of the definition set.
--
-- ⚠️ UNAPPLIED. Hand-apply against Supabase (project syuwavxpmtdmxupxjzje) when
-- Charlie chooses — there is no migration runner in this repo.
--   psql "$SUPABASE_DB_URL" -f db/2026-08-22_milestones_reseed.sql
-- or paste into the Supabase SQL editor.
--
-- Same engine, same table, same column shape as db/2026-07-05_milestones.sql
-- (the DDL of record). Like db/2026-07-06_milestones_rebalance.sql this is a
-- pure DATA re-seed — delete-all + insert, no schema change, safe to re-run.
--
-- Why (Charlie, 2026-08-22, ahead of the Valheim 1.0 launch world):
--   • The 07-06 set (28 deeds) was calibrated for the pilot's handful of
--     testers on a throwaway world. The launch band is 4–8 concurrent players
--     over a months-long real playthrough, and deeds should feel RARE:
--     roughly one per 1–2 hours of active evening play, a few per evening at
--     the very most. Thresholds are raised accordingly across the board —
--     rarity now lives in the numbers, not in an announce gate.
--   • Deeds announce SEQUENTIALLY: when several cross in one evaluator cycle
--     they are all marked achieved at once, but the Discord bot drains them one
--     per tick with MILESTONE_MIN_GAP_MS (default 1 min) between announcements.
--     The Discord embed and the in-game voice line for a deed now fire TOGETHER
--     at bot announce time — the evaluator no longer queues voice itself, so
--     nothing here needs a "quiet" or "silenced" flag.
--   • NEW metric `fish_total` (2 tiers): total catches summed from every
--     viking's player_stats.gs_stats.fish[] breakdown (see lib/milestones.ts
--     METRICS + config/fish.ts). The Angler board has existed since 07-06;
--     fishing simply had no deed of its own.
--   • Tier counts: kills, deaths and walk/run get a 4th, hardest tier (the
--     "you will not see this before the Ashlands" band); every other metric
--     keeps 3, fish gets 2. 38 deeds across 12 metrics.
--   • The Long March chain now tops out at 10,000 km on foot ("The Ten
--     Thousand") — a deliberately absurd, probably-never tier so the walking
--     chain never runs out of road.
--   • First-biome discovery deeds were considered and DROPPED (they fired far
--     too early and read as noise next to these).
--
-- Distances are metres (vh_Distance* counters). Percentages are 0–100.
-- Equivalences are stored EXACTLY as they should read: the dashboard and the
-- Discord embed print the string verbatim, prefix and all, so any "≈" a deed
-- wants must be written into the value here.
-- Apostrophes are doubled for SQL. Ids stay kebab-case.

-- Wipe the old definitions (and, with them, all pilot achieved/announced state).
delete from public.milestones;

-- ── Definitions ─────────────────────────────────────────────────────────────
insert into public.milestones (id, metric, threshold, title, line, equivalence, sort) values

  -- Boss Slaying — the roster is 8 (Eikthyr … the Bog Witch of the Deep North).
  ('boss-first',              'boss_kills_total',              1,  'First of the Forsaken',      'The first of the Forsaken lies slain. One trophy hangs at the stones, and Eilif has begun to keep count.',                 null,                                        10),
  ('boss-half',              'boss_kills_total',              4,  'Half the Altars Dark',       'Four of the Forsaken are broken. Half their altars stand cold, and no one tends them.',                                   null,                                        20),
  ('boss-all',               'boss_kills_total',              8,  'The Last Altar Dark',        'Every one of the Forsaken has fallen. Not one altar in Eilif''s world still burns.',                                      null,                                        30),

  -- Kills.
  ('kills-thousand',         'kills_total',                1000,  'A Thousand Foes',            'A thousand corpses mark the warband''s road. The skalds will need a longer song.',                                        null,                                        40),
  ('kills-red-harvest',      'kills_total',                5000,  'The Red Harvest',            'Five thousand slain. What was sown in iron has been reaped in blood.',                                                    null,                                        50),
  ('kills-stamford',         'kills_total',               15000,  'Stamford Bridge',            'Fifteen thousand felled — the whole host that met at Stamford Bridge, and then some. An age ended there.',              'combatants at Stamford Bridge, 1066',       60),
  ('kills-silence',          'kills_total',               40000,  'The Silence of the North',   'Forty thousand slain. The woods have gone quiet around Eilif; little out there still dares.',                             null,                                        70),

  -- Deaths (every viking who has fallen — a badge, not a shame).
  ('deaths-first-bench',     'deaths_total',                 25,  'The First Bench',            'Twenty-five of Eilif''s own have supped at Odin''s table — and rowed back for seconds.',                                  'one full mead-bench',                       80),
  ('deaths-village',         'deaths_total',                100,  'A Village of the Fallen',    'One hundred deaths. A whole village has died here, and risen again by the hearth.',                                      'pop. of a small Norse village',             90),
  ('deaths-three-hundred',   'deaths_total',                300,  'The Three Hundred',          'Three hundred deaths, and still the hall fills at dusk. Thermopylae only managed it the once.',                          'the Spartans at Thermopylae, 480 BC',      100),
  ('deaths-devils-tally',    'deaths_total',                666,  'The Devil''s Tally',         'Six hundred and sixty-six falls. Eilif has stopped writing the names and started writing the number.',                    null,                                       110),

  -- Damage dealt (HP). Troll = 600 HP, the yardstick from the old set.
  ('damage-hundred-thousand','damage_total',             100000,  'A Hundred Thousand Wounds',  'A hundred thousand wounds dealt. Every blow struck since the first is counted here.',                                     '166 x troll (600 HP)',                     120),
  ('damage-million',         'damage_total',            1000000,  'The Million',                'A million points of harm dealt by Eilif''s crew. The number has stopped sounding like a number.',                        '1,666 x troll (600 HP)',                   130),
  ('damage-fury',            'damage_total',            5000000,  'The Fury of the North',      'Five million wounds. This is not war any more — it is weather.',                                                          null,                                       140),

  -- Crafting (items_crafted).
  ('crafts-thousand-works',  'crafts_total',               1000,  'A Thousand Works',           'A thousand things made by hand. The forge has not been cold in a long while.',                                            null,                                       150),
  ('crafts-smiths-age',      'crafts_total',               5000,  'The Smiths'' Age',           'Five thousand works shaped, tempered, and carried out the door. Eilif''s smiths have earned their age.',                  null,                                       160),
  ('crafts-master-forged',   'crafts_total',              20000,  'Master-Forged',              'Twenty thousand works. There is nothing left in this world the crew cannot make twice.',                                  null,                                       170),

  -- Builds (pieces placed).
  ('builds-longhouse',       'builds_total',               2500,  'A Longhouse Rises',          'Two and a half thousand pieces raised. A longhouse stands where there was only forest.',                                  'one longhouse, raised',                    180),
  ('builds-stave',           'builds_total',              15000,  'A Stave Church''s Worth',    'Fifteen thousand pieces set. A stave church''s worth of timber, and not a plank wasted.',                                 'a stave church''s timbers',                190),
  ('builds-jomsborg',        'builds_total',              60000,  'Jomsborg',                   'Sixty thousand pieces raised. Eilif''s walls would not shame the Jomsvikings.',                                           'the fortress of Jomsborg',                 200),

  -- Resources harvested.
  ('resources-full-stores',  'resources_total',           25000,  'Full Stores',                'Twenty-five thousand goods gathered. The stores are full; no one goes hungry this winter.',                               null,                                       210),
  ('resources-great-hoard',  'resources_total',          150000,  'The Great Hoard',            'A hundred and fifty thousand goods hauled home. The chests no longer close.',                                             null,                                       220),
  ('resources-kings-hoard',  'resources_total',         1000000,  'A King''s Hoard',            'A million goods gathered. Kings have been buried with less than Eilif keeps in its cellars.',                             'a ship-burial hoard',                      230),

  -- Distance under sail (metres).
  ('sail-skagerrak',         'sail_total',               350000,  'The Skagerrak Crossing',     'Three hundred and fifty kilometers under sail. The Skagerrak crossed, and crossed again.',                                'Skagen to Kristiansand, there and back',   240),
  ('sail-norway-run',        'sail_total',              1750000,  'The Norway Run',             'The length of Norway sailed, keel to keel: Lindesnes to the North Cape.',                                                 'Lindesnes to North Cape',                  250),
  ('sail-vinland',           'sail_total',              5600000,  'Vinland',                    'Five thousand six hundred kilometers under sail — as far west as the vikings ever went. Eilif''s crew has reached Vinland.', 'Norway to Newfoundland',                 260),

  -- Distance on foot (metres).
  ('walk-marathon',          'walk_run_total',            42195,  'The Marathon',               'A marathon on foot, between all of us. Pheidippides had the grace to die at the end of his.',                             'Marathon to Athens, 490 BC',               270),
  ('walk-long-march',        'walk_run_total',           250000,  'The Long March',             'Two hundred and fifty kilometers walked and run. Boots, not sails.',                                                      'a week of hard marching',                  280),
  ('walk-length-of-north',   'walk_run_total',          1000000,  'The Length of the North',    'A thousand kilometers on foot. The crew has walked the length of the North and worn the ground down doing it.',            'Oslo to the Arctic Circle, on foot',       290),
  ('walk-ten-thousand',      'walk_run_total',         10000000,  'The Ten Thousand',           'Ten thousand kilometers marched. Xenophon''s lost army walked less — and they were trying to get home.',                  'Xenophon''s Ten Thousand, 401 BC',         300),

  -- Playtime (hours lived, derived from sessions).
  ('playtime-hundred-oars',  'playtime_total_hours',        100,  'A Hundred Hours at the Oars','A hundred hours lived in this world together. The oars are worn smooth.',                                                  'four days and nights',                     310),
  ('playtime-five-hundred',  'playtime_total_hours',        500,  'The Five Hundred',           'Five hundred hours beneath Eilif''s skies — long enough for the world to start remembering us.',                          'three weeks, day and night',               320),
  ('playtime-forty-days',    'playtime_total_hours',       1000,  'The Forty Days',             'A thousand hours lived here: forty days and forty nights, and no ark in sight.',                                          '40 days and nights',                       330),

  -- Explored (clan average % of the map charted). Percentage — 0–100.
  ('explored-shore',         'explored_avg_pct',             10,  'Beyond the Shore',           'A tenth of the world charted. The crew has stopped hugging the coast.',                                                   null,                                       340),
  ('explored-quarter',       'explored_avg_pct',             25,  'The Quarter Chart',          'A quarter of the world drawn onto the map. Three parts still dark.',                                                      null,                                       350),
  ('explored-half',          'explored_avg_pct',             50,  'Half the World',             'Half of Eilif''s world now lies charted and named. The other half is still listening.',                                   null,                                       360),

  -- Fishing (total catches, summed from gs_stats.fish[]). NEW metric.
  ('fish-first-hundred',     'fish_total',                  100,  'The First Hundred Fish',     'A hundred fish pulled from Eilif''s waters. The nets have paid for themselves.',                                          null,                                       370),
  ('fish-fisher-kings',      'fish_total',                  500,  'The Fisher-Kings',           'Five hundred fish landed. The crew could feed a fleet and still salt some away for winter.',                              null,                                       380)

on conflict (id) do update set
  metric         = excluded.metric,
  threshold      = excluded.threshold,
  title          = excluded.title,
  line           = excluded.line,
  equivalence    = excluded.equivalence,
  sort           = excluded.sort,
  achieved_at    = null,
  achieved_value = null,
  announced_at   = null,
  meta           = '{}'::jsonb;

-- Belt and braces: a fresh reseed already leaves every row unachieved (the
-- delete above drops all state), but state is zeroed explicitly here so the file
-- is a single, self-contained "start the ladder over" operation regardless of
-- how it is applied.
--
-- ⚠️ Re-running this AFTER real deeds have been earned WILL clear those
-- achievements and let them re-announce. That is the intent for the pre-launch
-- reset; do not re-run it on a live launch world without meaning to.
update public.milestones
   set achieved_at = null,
       achieved_value = null,
       announced_at = null,
       meta = '{}'::jsonb;

-- ── Notes for whoever applies this ──────────────────────────────────────────
-- • The evaluator no longer inserts voice_lines (lib/milestones.ts). Voice and
--   the Discord embed both fire from the bot at announce time, so a deed speaks
--   exactly once. Nothing to configure here.
-- • On a world that ALREADY has play on it, run scripts/seed-milestones-backfill.mjs
--   after this file so thresholds already passed are stamped achieved+announced
--   (meta.backfill = true) instead of all firing at once. On a fresh launch
--   world (the intended case) skip it — every counter starts at zero.
-- • MILESTONE_CHANNEL / MILESTONE_MIN_GAP_MS live in the Discord bot's .env,
--   not in this table.
