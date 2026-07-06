-- Collective Milestones ("Great Deeds"): server-wide aggregate thresholds.
--
-- One engine: each row is a DEFINITION (metric + threshold + flavor); the
-- evaluator (lib/milestones.ts, hooked into /api/gs-ingest) sums the metric
-- across every viking and, when a threshold is crossed, stamps achieved_at /
-- achieved_value ON THE SAME ROW (idempotency guard) and fans the deed out to
-- the in-game voice, the Saga feed, and — via announced_at — the Discord bot.
-- Follows the oaths.announced_at pattern for bot cross-posting, so no separate
-- "announced" table is needed. Designed so Server Firsts can later be rows here
-- too (metric: 'first_kill:Troll' style), on hold for now.
--
-- Definitions are seeded below; achieved/announced state lives on the row and
-- starts NULL (unachieved). On first deploy against a non-zero world, run
-- scripts/seed-milestones-backfill.mjs — it stamps already-passed thresholds
-- achieved_at = now() AND announced_at = now() (meta.backfill = true) so only
-- genuinely NEW deeds speak.
--
-- Additive (new table), safe on the live project, reversible (DROP TABLE).
-- The seeded achieved/announced state is wiped with the rest of the demo data
-- before launch (the definitions stay — only the state is zeroed):
--   update public.milestones set achieved_at = null, achieved_value = null,
--     announced_at = null, meta = '{}'::jsonb where (meta->>'backfill') = 'true';
--
--   psql "$SUPABASE_DB_URL" -f db/2026-07-05_milestones.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.milestones (
  id text primary key,                  -- slug: 'sail-norway'
  metric text not null,                 -- evaluator key, see lib/milestones.ts
  threshold numeric not null,
  title text not null,                  -- "The Length of Norway"
  line text not null,                   -- voice/TTS text, {value} interpolated
  equivalence text,                     -- "≈ Lindesnes to North Cape"
  sort integer not null default 0,
  achieved_at timestamptz,              -- evaluator sets (idempotency guard)
  achieved_value numeric,
  announced_at timestamptz,             -- bot cross-post tracking (oaths pattern)
  meta jsonb not null default '{}'::jsonb
);

alter table public.milestones enable row level security;

-- Public read like bosses/roadmap — upcoming deeds are fun to see coming.
-- (If upcoming ones should be a surprise, gate this SELECT to achieved_at is not null.)
drop policy if exists "public read milestones" on public.milestones;
create policy "public read milestones" on public.milestones
  for select using (true);

-- The bot polls achieved-but-unannounced rows every ~2 min; the evaluator reads
-- unachieved rows every ingest cycle. Both stay cheap on a small definition set.
create index if not exists milestones_sort_idx on public.milestones (sort);

-- ── Starter definitions ─────────────────────────────────────────────────────
-- Flavor numbers are ≈ and editable; thresholds are pacing guesses for 15–20
-- players (expect to tune after real data). Distances are metres (vh_Distance*).
insert into public.milestones (id, metric, threshold, title, line, equivalence, sort) values
  ('sail-skagerrak',   'sail_total',           122000,  'Crossing the Skagerrak',   'The fleet has sailed as far as Norway is from Denmark.',        'Skagen to Kristiansand',                  10),
  ('sail-norway',      'sail_total',          1750000,  'The Length of Norway',     'Together we have sailed the length of Norway itself.',          'Lindesnes to North Cape',                 20),
  ('sail-iceland',     'sail_total',          1900000,  'The Iceland Crossing',     'Leif''s own voyage: Bergen to Reykjavik.',                      'Bergen to Reykjavik',                     30),
  ('sail-vinland',     'sail_total',          5600000,  'The Road to Vinland',      'As far as the vikings ever sailed: to Vinland.',                'Norway to Newfoundland',                  40),
  ('walk-marathon',    'walk_run_total',        42195,  'The First Marathon',       'A marathon on foot, between all of us.',                        'Athens, 490 BC',                          50),
  ('walk-camino',      'walk_run_total',       800000,  'The Pilgrims'' Way',       'We have walked the Camino de Santiago.',                        'the full Camino Frances',                 60),
  ('deaths-longtable', 'deaths_total',             13,  'A Full Longtable',         'Thirteen seats now filled at Valhalla''s table.',               'one full mead-bench',                     70),
  ('deaths-village',   'deaths_total',            100,  'A Village of the Fallen',  'One hundred deaths. A village''s worth of vikings.',            'pop. of a small Norse village',           80),
  ('kills-thousand',   'kills_total',            1000,  'The First Thousand',       'A thousand foes lie behind us.',                                 null,                                     90),
  ('kills-stamford',   'kills_total',           10000,  'Stamford Bridge',          'Ten thousand slain — a battle to end an age.',                  'combatants at Stamford Bridge, 1066',    100),
  ('damage-trolls',    'damage_total',         600000,  'A Thousand Trolls'' Worth','Enough fury to fell a thousand trolls.',                        '1,000 x troll (600 HP)',                 110),
  ('resources-hoard',  'resources_total',      100000,  'The Great Hoard',          'A hundred thousand goods gathered.',                             null,                                    120),
  ('builds-stave',     'builds_total',          10000,  'Stave by Stave',           'Ten thousand pieces raised — a stave church''s worth of work.', 'a stave church''s timbers',              130),
  ('playtime-forty',   'playtime_total_hours',   1000,  'Forty Days at Sea',        'A thousand hours lived in this world.',                          '40 days and nights',                    140),
  ('explored-quarter', 'explored_avg_pct',         25,  'The Charted Quarter',      'A quarter of Midgard now known to us.',                          null,                                    150)
on conflict (id) do nothing;

comment on table public.milestones is 'Collective "Great Deeds": server-wide aggregate thresholds. Definitions seeded; achieved/announced state lives on the row (oaths.announced_at pattern). Evaluator: lib/milestones.ts.';
comment on column public.milestones.metric is 'Evaluator key summed across all vikings — see METRICS in lib/milestones.ts.';
comment on column public.milestones.line is 'Ceremonial voice/TTS text; {value} is interpolated with the achieved aggregate when present.';
comment on column public.milestones.achieved_at is 'When the aggregate first crossed the threshold (idempotency guard — set once).';
comment on column public.milestones.announced_at is 'When the Discord bot cross-posted the deed (oaths pattern). Backfilled rows have this pre-set so they never announce.';
