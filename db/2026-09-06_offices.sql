-- APPLIED to production 2026-09-06 ~11:10 CT (Fable session). Feature stays OFF until STORYTELLER=1 in the bot .env.
-- The Storyteller of Eilif: public.offices and public.office_nudges.
--
-- WHY. `boss_tellings` (db/2026-09-06_boss_tellings.sql) lets any linked viking
-- tell a boss's fall, and the war-room shows whichever telling is chosen. What
-- it does not do is make anyone RESPONSIBLE for the ones nobody has told. An
-- office does: the hall elects one viking to keep the tales, that viking may
-- choose which telling stands on any boss, and the bot nudges them about the
-- ones still untold.
--
-- ONE HOLDER AT A TIME, and the database says so: the partial unique index on
-- (office) where `until is null` means a second open term cannot be inserted,
-- so installing a new holder is close-the-old-term-then-insert rather than a
-- read-then-write race. A failure between the two statements leaves the hall
-- with no Storyteller, which is a state the site and the bot both render
-- correctly (no badge, no nudges), and the next `elect` fixes it.
--
-- WRITERS: the Discord bot only, with the service role
-- (services/discord-bot/src/storyteller.js).
-- READERS: the public site through the anon key, minus `holder_discord_id`.
--
-- EVERYTHING THIS FEEDS IS OFF BY DEFAULT (STORYTELLER=1 in the bot's .env).
-- Applying this file changes nothing on its own: with the flag off the verbs
-- are not attached, the nudge loop is not started, and the site reads an empty
-- table and shows exactly what it shows today.
--
-- Idempotent: `if not exists` throughout and guarded policies, so re-running is
-- safe. Reversible with
--   drop table public.office_nudges;
--   drop table public.offices;
-- which loses the roll of Storytellers and nothing else.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_offices.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  -- One office today. The check is the list, so adding a second one later is a
  -- migration rather than a convention nobody remembers.
  office text not null check (office in ('storyteller')),
  -- The holder as the Hall knows them: the roster `character_name` resolved
  -- from the winner's confirmed Discord link. Nullable so a term is never lost
  -- to a missing roster name.
  holder_character text,
  -- PII BOUNDARY. The Discord user id behind the office: the bot needs it to
  -- let the Storyteller keep any telling and to mention them in a nudge, and it
  -- is never public. Excluded from the anon grant below, exactly like
  -- players.steam_id (db/2026-07-11_players_pii_revoke.sql) and
  -- boss_tellings.author_discord_id.
  holder_discord_id text,
  since timestamptz not null default now(),
  -- Null while the term is open. Set to the instant the next holder is
  -- installed, which is what makes the partial unique index below the whole of
  -- the "one holder" rule.
  until timestamptz,
  elected_by text not null check (elected_by in ('vote', 'named')),
  -- Which act of the saga this term covered, for the roll of former holders on
  -- a viking's page ("Storyteller for the Bonemass act"). Written by the bot
  -- from the boss ladder at the moment the term opens, and deliberately plain
  -- text so Charlie can rewrite it into something better later.
  act text,
  created_at timestamptz not null default now()
);

-- AT MOST ONE OPEN TERM PER OFFICE. The rule the whole feature leans on.
create unique index if not exists offices_one_holder_idx
  on public.offices (office)
  where until is null;

-- The roll, newest term first: the viking page's former-holder badge.
create index if not exists offices_office_since_idx
  on public.offices (office, since desc);

alter table public.offices enable row level security;

drop policy if exists "public read offices" on public.offices;
create policy "public read offices" on public.offices
  for select using (true);

-- COLUMN PRIVACY, the players_pii_revoke pattern. RLS filters ROWS, not
-- columns: with a table-wide SELECT grant, `offices?select=holder_discord_id`
-- with the publishable anon key would hand out the Discord id of every viking
-- who has ever held the office. Postgres only honours column privileges once
-- the blanket table grant is gone, so revoke it and re-grant every column
-- except that one. The service role is unaffected (it bypasses both RLS and
-- these grants).
revoke select on public.offices from anon;
grant select (
  id, office, holder_character, since, until, elected_by, act, created_at
) on public.offices to anon;

revoke select on public.offices from authenticated;
grant select (
  id, office, holder_character, since, until, elected_by, act, created_at
) on public.offices to authenticated;

revoke insert, update, delete, truncate, references, trigger
  on public.offices
  from anon, authenticated;

-- WHICH BOSSES THIS TERM HAS ALREADY BEEN NUDGED ABOUT.
--
-- The obvious place for this is a column on boss_tellings, and it is the wrong
-- place: a boss with no telling has no row there to carry it, which is exactly
-- the case a nudge is about. It is also per-TERM rather than per-boss. A viking
-- who takes the office after their predecessor was nudged about Bonemass should
-- hear about Bonemass too, and a composite key of (boss, term) says that in one
-- line: the primary key is the idempotency, so a nudge is sent at most once per
-- boss per term and a restart mid-send cannot double it.
create table if not exists public.office_nudges (
  boss_id uuid not null references public.bosses(id) on delete cascade,
  office_id uuid not null references public.offices(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (boss_id, office_id)
);

-- Bot bookkeeping with nothing in it a reader wants, so RLS is enabled with NO
-- select policy: the anon key sees zero rows and the service role (which
-- bypasses RLS) sees them all. That is deliberate rather than an omission.
alter table public.office_nudges enable row level security;

revoke select, insert, update, delete, truncate, references, trigger
  on public.office_nudges
  from anon, authenticated;

comment on table public.offices is
  'Terms of a hall office. One row per term, at most one open (until is null) per office, enforced by offices_one_holder_idx. Written only by the Discord bot (services/discord-bot/src/storyteller.js) behind STORYTELLER=1.';

comment on column public.offices.holder_discord_id is
  'Discord user id of the holder. Server-side only (the Storyteller may keep any telling, and the nudge mentions them); REVOKEd from anon and authenticated, like players.steam_id.';

comment on column public.offices.until is
  'End of the term. Null means the term is open; the partial unique index offices_one_holder_idx is what keeps that to one row per office.';

comment on column public.offices.act is
  'The act of the saga this term covered, for the former-holder badge. Seeded from the boss ladder when the term opens; free text.';

comment on table public.office_nudges is
  'One row per (boss, term) the bot has already nudged the office holder about. The primary key IS the idempotency; a column on boss_tellings could not carry it, because a boss with no telling has no row there.';
