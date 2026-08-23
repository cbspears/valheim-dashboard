-- Collective Milestones ("Great Deeds") — COPY-ONLY pass over the launch set.
--
-- ⚠️ UNAPPLIED. Hand-apply against Supabase (project syuwavxpmtdmxupxjzje) when
-- Charlie chooses — there is no migration runner in this repo.
--   psql "$SUPABASE_DB_URL" -f db/2026-08-23_milestones_copy_pass.sql
-- or paste into the Supabase SQL editor.
--
-- WHAT THIS IS: a rewrite of the two prose columns only — `line` (the
-- ceremonial announcement) and `equivalence` (the "that is" comparison) — for
-- all 38 deeds seeded by db/2026-08-22_milestones_reseed.sql. Nothing else is
-- touched.
--
-- SAFE TO RUN ON THE LIVE LADDER. This file contains no delete, no insert, and
-- no write to any state column: achieved_at, achieved_value, announced_at and
-- meta are left exactly as they are. A deed already earned stays earned and
-- will not re-announce; a deed already announced keeps its announced_at. Only
-- the words change. Re-running the file is a no-op (idempotent: every statement
-- sets the same literal values).
--
-- WHY (Charlie, 2026-08-23):
--   • Voice: zero em-dashes anywhere, varied sentence rhythm, skaldic but
--     human, readable in about three seconds. No AI-flavored vocabulary and no
--     wink-at-the-camera quip on every single line.
--   • Equivalences now surface in THREE places: the /world ledger, the Discord
--     embed ("That is" field, services/discord-bot/src/milestones.js) and, as of
--     this launch cycle, appended to the in-game voice line. So they are written
--     to be SPOKEN: casual, short, and numerically honest. Each one is checked
--     arithmetic, not vibes — the working is in the comment above each block.
--   • Coverage went from 17 equivalences to 28. The remaining 10 are null on
--     purpose: for those deeds every comparison anyone could reach for was a
--     stretch, and a wrong number read aloud in the hall is worse than silence.
--
-- Yardsticks used, stated once so they can be argued with:
--   troll = 600 HP · Yagluth = 15,000 HP · reinforced chest = 24 slots x 50 = 1,200 items
--   Valheim world = ~10 km radius = ~314 km² · Earth's circumference = 40,075 km
--   longship crew = ~30 · marching day = ~30 km
--
-- Distances are metres (vh_Distance* counters). Percentages are 0–100.
-- Equivalences are stored EXACTLY as they should read: every surface prints the
-- string verbatim, so any hedge ("about", "roughly") must be written in here.
-- Apostrophes are doubled for SQL. Ids stay kebab-case.


-- ── Boss Slaying ────────────────────────────────────────────────────────────
-- No equivalence: the roster is 8 and every comparison to it ("half the
-- Forsaken") only restates the threshold. Left null.

update public.milestones set
  line        = 'The first of the Forsaken is down. One trophy hangs at the stones, and Eilif has started counting.',
  equivalence = null
where id = 'boss-first';

update public.milestones set
  line        = 'Four of the Forsaken lie broken. Half the altars in this world stand cold now, and no one tends them.',
  equivalence = null
where id = 'boss-half';

update public.milestones set
  line        = 'Every one of the Forsaken has fallen. Not a single altar still burns anywhere in Eilif''s world.',
  equivalence = null
where id = 'boss-all';


-- ── Kills ───────────────────────────────────────────────────────────────────
-- 1,000 / 30 per longship crew = 33 crews.
-- 5,000 ~ the population of Viking-age Dublin (commonly put near 4,500).
-- 15,000 = both hosts at Stamford Bridge (Hardrada landed ~7-9k, Godwinson
--   brought a comparable army).
-- 40,000 ~ everyone alive in Iceland around the year 1000 (estimates run
--   40,000-60,000).

update public.milestones set
  line        = 'A thousand foes have fallen to Eilif''s warband. The skalds are going to need a longer song.',
  equivalence = 'about thirty longship crews'
where id = 'kills-thousand';

update public.milestones set
  line        = 'Five thousand slain. What was sown in iron has come up red.',
  equivalence = 'the whole population of Viking-age Dublin'
where id = 'kills-red-harvest';

update public.milestones set
  line        = 'Fifteen thousand felled. Every one of them thought it would go otherwise.',
  equivalence = 'the whole host at Stamford Bridge, 1066'
where id = 'kills-stamford';

update public.milestones set
  line        = 'Forty thousand slain. The woods have gone quiet around Eilif, and very little out there still tries.',
  equivalence = 'about every soul alive in Iceland, year 1000'
where id = 'kills-silence';


-- ── Deaths (a badge, not a shame) ───────────────────────────────────────────
-- 25 = a twelve-bench ship: 24 oars plus the man on the steering board.
-- 100 ~ a small Norse village, whole.
-- 300 = Thermopylae, exactly.
-- 666 has no honest comparison. It is a joke about a number; left null.

update public.milestones set
  line        = 'Twenty-five of Eilif''s own have supped at Odin''s table and rowed back for seconds.',
  equivalence = 'twelve rowing benches and a steersman'
where id = 'deaths-first-bench';

update public.milestones set
  line        = 'One hundred deaths. A whole village has died here, and walked back in through the door.',
  equivalence = 'the whole of a small Norse village'
where id = 'deaths-village';

update public.milestones set
  line        = 'Three hundred falls, and the hall still fills at dusk. Death has stopped being an argument.',
  equivalence = 'the Spartans at Thermopylae, 480 BC'
where id = 'deaths-three-hundred';

update public.milestones set
  line        = 'Six hundred and sixty-six. Eilif has stopped writing down the names and started writing down the number.',
  equivalence = null
where id = 'deaths-devils-tally';


-- ── Damage dealt (HP) ───────────────────────────────────────────────────────
-- 100,000 / 600 (troll) = 166.7. 1,000,000 / 600 = 1,666.7.
-- 5,000,000 / 15,000 (Yagluth) = 333.3 — the yardstick changes because at five
--   million a troll is no longer a unit anyone can picture.

update public.milestones set
  line        = 'A hundred thousand wounds dealt. Every swing since the first day ashore is in that number.',
  equivalence = 'about 166 trolls of hurt'
where id = 'damage-hundred-thousand';

update public.milestones set
  line        = 'A million points of harm, dealt by hand. It has stopped sounding like a number.',
  equivalence = 'about 1,666 trolls of hurt'
where id = 'damage-million';

update public.milestones set
  line        = 'Five million wounds. This stopped being war a while ago. Now it is weather.',
  equivalence = 'about 333 Yagluths, start to finish'
where id = 'damage-fury';


-- ── Crafting ────────────────────────────────────────────────────────────────
-- 1,000 ~ 3 a day for a year (1,095). 20,000 ~ 55 a day for a year (20,075).
-- 5,000 sits between two clean rates and only produced a third "per year" line,
--   so it is left null rather than padded.

update public.milestones set
  line        = 'A thousand things made by hand. The forge has not been cold in a long while.',
  equivalence = 'three things made every day for a year'
where id = 'crafts-thousand-works';

update public.milestones set
  line        = 'Five thousand works shaped, tempered and carried out the door. Eilif''s smiths have earned their age.',
  equivalence = null
where id = 'crafts-smiths-age';

update public.milestones set
  line        = 'Twenty thousand works. There is nothing left in this world the crew cannot make twice.',
  equivalence = 'fifty-five a day, every day, for a year'
where id = 'crafts-master-forged';


-- ── Builds (pieces placed) ──────────────────────────────────────────────────
-- These three are structure-scale comparisons, not arithmetic, and are hedged
-- accordingly. A Valheim longhouse runs a couple of thousand pieces; the stave
-- church and Jomsborg tiers are scale-of-thing claims, deliberately loose.

update public.milestones set
  line        = 'Two and a half thousand pieces raised. There is a longhouse standing where there was only forest.',
  equivalence = 'about one full longhouse'
where id = 'builds-longhouse';

update public.milestones set
  line        = 'Fifteen thousand pieces set true, and not a plank of it wasted.',
  equivalence = 'a stave church, timber for timber'
where id = 'builds-stave';

update public.milestones set
  line        = 'Sixty thousand pieces raised. Whatever this started out as, it is a stronghold now.',
  equivalence = 'a fortress the size of Jomsborg'
where id = 'builds-jomsborg';


-- ── Resources harvested ─────────────────────────────────────────────────────
-- Reinforced chest = 24 slots x 50 per stack = 1,200 items, so:
--   25,000 / 1,200 = 20.8 chests · 1,000,000 / 1,200 = 833 chests.
-- (Ore and metal stack to 30, so the real chest count is HIGHER — "about" and
-- "over" keep both claims safe.)
-- 150,000 lands between them and only gave a third chest line; left null.

update public.milestones set
  line        = 'Twenty-five thousand goods gathered in. The stores are full, and nobody goes hungry this winter.',
  equivalence = 'about twenty chests, packed to the lid'
where id = 'resources-full-stores';

update public.milestones set
  line        = 'A hundred and fifty thousand hauled home. The chests do not close any more.',
  equivalence = null
where id = 'resources-great-hoard';

update public.milestones set
  line        = 'A million goods gathered. Kings have been buried with less than Eilif keeps in the cellar.',
  equivalence = 'over eight hundred chests, every one full'
where id = 'resources-kings-hoard';


-- ── Distance under sail (metres) ────────────────────────────────────────────
-- 350 km: Skagen to Kristiansand is ~160 km, so there and back is ~320 km.
-- 1,750 km: Lindesnes to the North Cape is ~1,720 km as the raven flies.
-- 5,600 km: Norway to Newfoundland the way it was actually done, hopping
--   Shetland-Faroes-Iceland-Greenland, runs ~5,000-5,600 km. The direct
--   great-circle is only ~3,760 km, which is why the wording says "the way
--   they actually went".

update public.milestones set
  line        = 'Three hundred and fifty kilometers under sail. Open water has stopped frightening anyone.',
  equivalence = 'Skagen to Kristiansand, there and back'
where id = 'sail-skagerrak';

update public.milestones set
  line        = 'Seventeen hundred and fifty kilometers of wake behind the warband. Eilif''s crew has stopped asking how far is too far.',
  equivalence = 'Lindesnes to the North Cape, the length of Norway'
where id = 'sail-norway-run';

update public.milestones set
  line        = 'Five thousand six hundred kilometers under sail. As far west as anyone ever went, and this crew has gone it.',
  equivalence = 'Norway to Newfoundland, the way they actually went'
where id = 'sail-vinland';


-- ── Distance on foot (metres) ───────────────────────────────────────────────
-- 42,195 m is the marathon distance to the metre.
-- 250 km / ~30 km a marching day = 8.3 days.
-- 1,000 km: Oslo to the Arctic Circle is ~760 km straight, ~1,100 km by road,
--   so "on foot" lands right on a thousand.
-- 10,000,000 m / 40,075 km (Earth's circumference) = 24.95%.

update public.milestones set
  line        = 'Forty-two kilometers on foot, between all of us. Pheidippides had the grace to die at the end of his.',
  equivalence = 'one full marathon, to the meter'
where id = 'walk-marathon';

update public.milestones set
  line        = 'Two hundred and fifty kilometers walked and run. Boots, not sails.',
  equivalence = 'eight days of hard marching'
where id = 'walk-long-march';

update public.milestones set
  line        = 'A thousand kilometers on foot. The crew has worn a road into a world that never had one.',
  equivalence = 'Oslo to the Arctic Circle, on foot'
where id = 'walk-length-of-north';

update public.milestones set
  line        = 'Ten thousand kilometers marched. Xenophon''s Ten Thousand walked less than this, and they were trying to get home.',
  equivalence = 'a quarter of the way around the world'
where id = 'walk-ten-thousand';


-- ── Playtime (hours lived) ──────────────────────────────────────────────────
-- 100 / 24 = 4.2 days · 500 / 24 = 20.8 days (three weeks is 504 h)
-- 1,000 / 24 = 41.7 days.

update public.milestones set
  line        = 'A hundred hours lived in this world together. The oars are worn smooth.',
  equivalence = 'four days and nights without sleep'
where id = 'playtime-hundred-oars';

update public.milestones set
  line        = 'Five hundred hours under Eilif''s sky. Long enough that the world has started remembering us.',
  equivalence = 'three straight weeks, day and night'
where id = 'playtime-five-hundred';

update public.milestones set
  line        = 'A thousand hours lived here. Somewhere out there a whole month went by without us.',
  equivalence = 'forty days and nights straight'
where id = 'playtime-forty-days';


-- ── Explored (clan average % of the map charted) ────────────────────────────
-- The Valheim world is a ~10 km radius disc, about 314 km². Malta is 316 km²,
-- which makes the half-the-map tier a genuinely tidy comparison. The 10% and
-- 25% tiers would just be "a tenth of Malta", which nobody can picture, so
-- they are left null rather than repeat the joke three times.

update public.milestones set
  line        = 'A tenth of the world charted. The crew has stopped hugging the coast.',
  equivalence = null
where id = 'explored-shore';

update public.milestones set
  line        = 'A quarter of the world drawn onto the map. Three parts of it are still dark.',
  equivalence = null
where id = 'explored-quarter';

update public.milestones set
  line        = 'Half of Eilif''s world now lies charted and named. The other half is still listening.',
  equivalence = 'half a world roughly the size of Malta'
where id = 'explored-half';


-- ── Fishing (total catches) ─────────────────────────────────────────────────
-- No honest yardstick exists here. A medieval barrel of salt herring held
-- somewhere between 500 and 1,000 fish depending on who is counting, which is
-- too loose to say out loud in the hall. Both tiers left null.

update public.milestones set
  line        = 'A hundred fish out of Eilif''s water. The nets have paid for themselves.',
  equivalence = null
where id = 'fish-first-hundred';

update public.milestones set
  line        = 'Five hundred fish landed. The crew could feed a fleet and still salt some away for winter.',
  equivalence = null
where id = 'fish-fisher-kings';


-- ── Check after applying ────────────────────────────────────────────────────
-- Expect 38 rows, 28 with an equivalence, 0 containing an em-dash, and the
-- achieved/announced columns untouched:
--
--   select count(*) as deeds,
--          count(equivalence) as with_equivalence,
--          count(*) filter (where line like '%' || chr(8212) || '%') as em_dashes,
--          count(achieved_at) as still_achieved
--     from public.milestones;
