-- APPLIED to production 2026-09-06 ~12:35 CT (Fable session).
-- STATUS: UNAPPLIED. Hand-applied by Charlie (AGENTS.md "Database / migrations").
-- Tales of the hall: public.tales.
--
-- WHY. `boss_tellings` (db/2026-09-06_boss_tellings.sql) is bound to a boss:
-- every row hangs off a forsaken that fell. Most of what happens on this server
-- is not a boss. Charlie: "the Storyteller should also be able to recount server
-- events like a game night or a fun rp event. those should be logged somewhere
-- maybe the daily summaries in Saga."
--
-- So a tale is a telling with a DAY instead of a boss. `told_for` is the
-- America/Chicago calendar day the tale is ABOUT, which is the same key the
-- Saga's episodes are bucketed by (lib/episodes.ts ctDayKey), so attaching a
-- tale to its episode is a string comparison and never a timezone conversion.
-- It is deliberately a `date` and not a timestamp: a night is a day, not an
-- instant, and a tale written at 02:00 about the evening before must not be
-- re-bucketed by whoever renders it.
--
-- NO `chosen` FLAG, and that is the difference from boss_tellings. A boss has
-- one canonical saga and the war room shows one of them; a day can hold as many
-- tales as the hall wants to tell, and every one of them is a tale of record.
-- There is nothing to choose between, so there is no partial unique index here
-- and no two-statement swap.
--
-- WRITERS: the Discord bot only (service role), and only for two people: the
-- Storyteller of Eilif while that office is held (db/2026-09-06_offices.sql) or
-- a jarl of the hall (services/discord-bot/src/tales.js). Anyone else is told
-- whose job it is and nothing is stored.
-- READERS: the public site, through the anon key.
--
-- Applying this file changes nothing on its own. Before it runs, every verb
-- answers "the ledgers are still being carved" and the Saga renders exactly as
-- it does today (lib/data.ts getTales returns [] on PGRST205 / 42P01).
--
-- Idempotent: `if not exists` throughout and a guarded policy, so re-running is
-- safe. Reversible with
--   drop table public.tales;
-- which loses the tales and nothing else.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_tales.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.tales (
  id uuid primary key default gen_random_uuid(),
  -- The tale's own name, which is what the Saga card leads with and what the
  -- in-game voice line reads out. Bounded at 80 so a title stays a title: it
  -- has to fit on one line of an episode card and inside a 150-character
  -- spoken line with a viking's name beside it.
  title text not null,
  -- The tale itself. 4000 rather than boss_tellings' 2000, because a tale is
  -- an account of a whole evening rather than of one fight, and Discord will
  -- carry 4000 characters in a message from a nitro member. The bot clips to
  -- exactly this number before it writes.
  text text not null,
  -- The teller, as the Hall knows them: the roster `character_name` resolved
  -- from the writer's confirmed Discord link, or their server display name when
  -- a jarl writes one without having linked a viking. Nullable so a row is
  -- never lost to a missing name.
  author_character text,
  -- PII BOUNDARY. The Discord user id behind a tale: needed so its own author
  -- may re-write or withdraw it, never public. Excluded from the anon grant
  -- below, exactly like players.steam_id
  -- (db/2026-07-11_players_pii_revoke.sql), boss_tellings.author_discord_id and
  -- offices.holder_discord_id.
  author_discord_id text,
  -- THE CENTRAL-TIME DAY THE TALE IS ABOUT, not the day it was written. A tale
  -- filed at 01:00 on Sunday about Saturday's game night carries Saturday, and
  -- lands on Saturday's episode.
  told_for date not null,
  created_at timestamptz not null default now(),
  -- btrim first in both checks: a title of forty spaces would otherwise pass a
  -- plain length test and render as a blank heading on the Saga.
  constraint tales_title_len
    check (char_length(btrim(title)) between 1 and 80),
  constraint tales_text_len
    check (char_length(btrim(text)) between 1 and 4000)
);

-- The Saga's read: the newest tales, and the tales of one day. Both are served
-- by leading on told_for descending, with created_at breaking a day's ties so
-- two tales of the same night always come back in the same order.
create index if not exists tales_told_for_created_idx
  on public.tales (told_for desc, created_at desc);

alter table public.tales enable row level security;

drop policy if exists "public read tales" on public.tales;
create policy "public read tales" on public.tales
  for select using (true);

-- COLUMN PRIVACY, the players_pii_revoke pattern. RLS filters ROWS, not
-- columns: with a table-wide SELECT grant, `tales?select=author_discord_id`
-- with the publishable anon key would harvest the Discord id of everyone who
-- ever wrote a tale. Postgres only honours column privileges once the blanket
-- table grant is gone, so revoke it and re-grant every column except that one.
-- The service role is unaffected (it bypasses both RLS and these grants).
revoke select on public.tales from anon;
grant select (
  id, title, text, author_character, told_for, created_at
) on public.tales to anon;

-- No logged-in Supabase users exist today; keep `authenticated` consistent.
revoke select on public.tales from authenticated;
grant select (
  id, title, text, author_character, told_for, created_at
) on public.tales to authenticated;

-- db/2026-09-04_revoke_anon_writes.sql already revoked these from the schema's
-- DEFAULT privileges, so a table created after it should not carry them. Named
-- here anyway: this table's whole point is that only the bot writes to it, on
-- behalf of exactly two people, and that should not depend on a default having
-- been set correctly.
revoke insert, update, delete, truncate, references, trigger
  on public.tales
  from anon, authenticated;

comment on table public.tales is
  'Tales of the hall: a game night, an RP evening, anything that is not a boss falling. One row per tale, written from Discord with `@Eilif tale <Title>: <text>` by the Storyteller of Eilif or a jarl (services/discord-bot/src/tales.js). Attached to the Saga episode whose Central-time day matches told_for.';

comment on column public.tales.told_for is
  'The America/Chicago calendar day the tale is ABOUT, not the day it was written. The same key lib/episodes.ts buckets sessions by, so a tale joins its episode by string equality.';

comment on column public.tales.author_discord_id is
  'Discord user id of the teller. Server-side only (the author may re-write or withdraw their own tale); REVOKEd from anon and authenticated, like players.steam_id.';

comment on column public.tales.title is
  'The tale''s own name, at most 80 characters after trimming. Read out in the in-game voice line, clipped to 60 there.';
