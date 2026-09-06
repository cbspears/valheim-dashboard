-- APPLIED to production 2026-09-06 ~11:10 CT (Fable session). Feature stays OFF until TELLING_VOTES=1 in the bot .env.
-- One new column: public.boss_tellings.standing.
--
-- WHY. When a boss has two or more player tellings, the hall can vote on which
-- one stands (`@Eilif vote tellings <Boss>`, services/discord-bot/src/
-- tellings-vote.js, behind TELLING_VOTES=1). `chosen` already says which
-- telling the war-room shows, and it cannot say why. `standing` records the
-- vote's verdict: the winner is 'canon' and the runner-up is 'apocryphal', and
-- the war-room gives the apocryphal one its own heading instead of folding it
-- in with the rest. Null means no vote has ruled on this telling, which is
-- every row that exists today.
--
-- PREREQUISITE: db/2026-09-06_boss_tellings.sql. Running this file before that
-- one fails on a missing table, which is the correct answer.
--
-- THE GRANT IS NOT OPTIONAL. boss_tellings had its blanket SELECT grant revoked
-- so that author_discord_id could be withheld from anon, and Postgres does not
-- extend a column grant to a column added afterwards. Without the two grants at
-- the bottom of this file the anon key gets `permission denied for column
-- standing` on every war-room read and the site loses every telling it shows,
-- not just the new column.
--
-- Idempotent: `add column if not exists` and a guarded constraint, so
-- re-running is safe. Reversible with
--   alter table public.boss_tellings drop column standing;
-- which loses the verdicts and nothing else (`chosen` still says which telling
-- the page shows).
--
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_telling_votes.sql
-- or paste into the Supabase SQL editor.

alter table public.boss_tellings
  add column if not exists standing text;

-- Guarded rather than `add constraint if not exists`, which Postgres does not
-- have for table constraints. Null stays legal: it is what every existing row
-- carries and it means "no vote has ruled on this".
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'boss_tellings_standing_check'
       and conrelid = 'public.boss_tellings'::regclass
  ) then
    alter table public.boss_tellings
      add constraint boss_tellings_standing_check
      check (standing is null or standing in ('canon', 'apocryphal'));
  end if;
end
$$;

-- See the note at the top: a column added after the blanket grant was revoked
-- carries no grant of its own, and the site reads `standing` by name.
grant select (standing) on public.boss_tellings to anon;
grant select (standing) on public.boss_tellings to authenticated;

comment on column public.boss_tellings.standing is
  'Verdict of a telling vote: canon = the hall chose it, apocryphal = the hall did not. Null = no vote has ruled on this telling. Independent of `chosen`, which is only ever about which telling the war-room shows.';
