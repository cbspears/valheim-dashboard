-- APPLIED to production 2026-09-06 ~09:35 CT (Fable session): table, RLS, anon column grants, backfill verified.
-- Player retellings of a boss fall: public.boss_tellings.
--
-- WHY. `bosses.retelling` holds exactly ONE saga per boss and only the Skald
-- may write it (services/discord-bot/src/retelling.js, once per kill). Charlie:
-- "I want to be able to update the boss kill stories with manual retellings
-- that players make. the auto generated one is fine but I want to be able to
-- update it later." One column cannot hold two authors, so the saga moves from
-- a column to a small table with a byline, and the war-room renders whichever
-- row is `chosen`.
--
-- `bosses.retelling` IS UNCHANGED and still written on every kill. It stays the
-- pre-migration fallback for the war-room, so applying this file is not a
-- prerequisite for anything: without the table the page renders exactly as it
-- does today (lib/data.ts getBossTellings returns [] on PGRST205 / 42P01).
--
-- WRITERS: the Discord bot only (service role) — the Skald on a kill, and
-- `@Eilif retell <Boss>: <text>` from a viking whose Discord is linked to a
-- character (services/discord-bot/src/tellings.js).
-- READERS: the public site, through the anon key.
--
-- Idempotent: `if not exists` throughout, a guarded policy, and a backfill that
-- inserts nothing on a second run. Reversible with
--   drop table public.boss_tellings;
-- which loses the player tellings and nothing else (the Skald's own text is
-- still on `bosses.retelling`).
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_boss_tellings.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.boss_tellings (
  id uuid primary key default gen_random_uuid(),
  boss_id uuid not null references public.bosses(id) on delete cascade,
  -- The teller, as the Hall knows them: the roster `character_name` resolved
  -- from the sender's confirmed Discord link, or 'The Skald' for a generated
  -- one. Nullable so a row is never lost to a missing roster name.
  author_character text,
  -- PII BOUNDARY. The Discord user id behind a telling: needed so its own
  -- author may re-choose it, never public. Excluded from the anon grant below,
  -- exactly like players.steam_id (db/2026-07-11_players_pii_revoke.sql).
  author_discord_id text,
  text text not null,
  source text not null check (source in ('skald', 'player', 'admin')),
  chosen boolean not null default false,
  created_at timestamptz not null default now(),
  -- 2000 is the Discord message ceiling, so a telling that fits in the message
  -- that carried it fits here. The bot clips to the same number before it
  -- writes, including the Skald's TEMPLATE fallback, which is bounded by
  -- sentence count rather than by length and can name twenty vikings.
  constraint boss_tellings_text_len check (char_length(text) <= 2000),
  -- An empty telling would blank the war-room's saga slot for that boss.
  constraint boss_tellings_text_nonempty check (btrim(text) <> '')
);

-- The war-room's read: this boss's tellings, newest first.
create index if not exists boss_tellings_boss_created_idx
  on public.boss_tellings (boss_id, created_at desc);

-- AT MOST ONE CHOSEN PER BOSS, enforced by the database rather than by the
-- bot's care. It is what makes "choose this telling" a two-statement operation
-- (clear the boss's chosen flag, then set the new one) instead of a race, and
-- it is why the bot always INSERTS with chosen = false and sets the flag after.
create unique index if not exists boss_tellings_one_chosen_idx
  on public.boss_tellings (boss_id)
  where chosen;

alter table public.boss_tellings enable row level security;

drop policy if exists "public read boss_tellings" on public.boss_tellings;
create policy "public read boss_tellings" on public.boss_tellings
  for select using (true);

-- COLUMN PRIVACY, the players_pii_revoke pattern. RLS filters ROWS, not
-- columns: with a table-wide SELECT grant, `boss_tellings?select=author_discord_id`
-- with the publishable anon key would harvest the Discord id of everyone who
-- ever told a story. Postgres only honours column privileges once the blanket
-- table grant is gone, so revoke it and re-grant every column except that one.
-- The service role is unaffected (it bypasses both RLS and these grants).
revoke select on public.boss_tellings from anon;
grant select (
  id, boss_id, author_character, text, source, chosen, created_at
) on public.boss_tellings to anon;

-- No logged-in Supabase users exist today; keep `authenticated` consistent.
revoke select on public.boss_tellings from authenticated;
grant select (
  id, boss_id, author_character, text, source, chosen, created_at
) on public.boss_tellings to authenticated;

-- db/2026-09-04_revoke_anon_writes.sql already revoked these from the schema's
-- DEFAULT privileges, so a table created after it should not carry them. Named
-- here anyway: this table's whole point is that only the bot writes to it, and
-- that should not depend on a default having been set correctly.
revoke insert, update, delete, truncate, references, trigger
  on public.boss_tellings
  from anon, authenticated;

-- BACKFILL. Every boss that already carries a Skald retelling gets it as its
-- first telling, marked chosen, so the war-room reads the same the moment this
-- lands. Guarded on the boss having NO telling at all, so a re-run inserts
-- nothing and a boss that a player has already retold is never touched.
-- `left(..., 2000)` because a template retelling naming a full war party can
-- run past the length check above.
insert into public.boss_tellings (boss_id, author_character, text, source, chosen, created_at)
select b.id,
       'The Skald',
       left(btrim(b.retelling), 2000),
       'skald',
       true,
       coalesce(b.retelling_generated_at, b.killed_at, now())
  from public.bosses b
 where b.retelling is not null
   and btrim(b.retelling) <> ''
   and not exists (
     select 1 from public.boss_tellings t where t.boss_id = b.id
   );

comment on table public.boss_tellings is
  'Saga retellings of a boss fall, one row per telling. The Skald writes one per kill; a viking with a confirmed Discord link writes one with `@Eilif retell <Boss>: <text>`. The war-room renders the row where chosen is true (falling back to the newest, then to bosses.retelling).';

comment on column public.boss_tellings.author_discord_id is
  'Discord user id of the teller. Server-side only (the author may re-choose their own telling); REVOKEd from anon and authenticated, like players.steam_id.';

comment on column public.boss_tellings.chosen is
  'The telling the war-room shows. At most one per boss (partial unique index boss_tellings_one_chosen_idx); a new player telling takes the flag and the previous one stays as an older telling.';

comment on column public.boss_tellings.source is
  'skald = generated by the bot on the kill, player = told in Discord by a linked viking, admin = reserved for a hand-written correction.';
