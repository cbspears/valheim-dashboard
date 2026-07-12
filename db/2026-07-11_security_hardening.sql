-- Security hardening pass (identity-claims flow + public-read RLS tightening).
--
-- Charlie applies this by hand in Supabase — NOT auto-applied like the other
-- migrations in this repo (no CI/migration runner wired up yet). Idempotent:
-- safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS throughout).
--
--   1. identity_claims — one-time codes minted by the Discord bot and
--      consumed in-game via a shouted `/oath <CODE> — <text>` to link a
--      Discord user to a character, WITHOUT the bot linking directly (the
--      webhook oath handler is the single place that consumes a code +
--      writes the link). RLS enabled, no anon/public policies at all —
--      service role only, since these rows carry a Discord user id +
--      requested name and the code itself is a bearer credential until
--      consumed. Partial index on unconsumed claims (consumed_at is null)
--      speeds up the webhook's "does this code match a live, unconsumed,
--      unexpired claim" lookup, which is the hot path on every oath.
--
--   2. player_positions / chat_lines — 2026-07-07 shipped these with a
--      "public read" policy (anon key could select directly). Live
--      positions and in-game shouts weren't meant to be broadly queryable
--      via the anon key, so both public-read policies are dropped here.
--      RLS stays enabled with no replacement select policy, so only the
--      service role can read them going forward. The site keeps working
--      because both feeds are already served through server-side routes
--      (service role) rather than direct anon-key client queries — this
--      migration only removes anon/public access that the client-facing
--      code doesn't actually rely on.
--
--   3. oaths and players policies are UNTOUCHED by design: oaths stay
--      publicly readable (the Oath page), and players PII is handled at
--      the query layer (column selection) by other agents, not via RLS.
--
-- FOLLOW-UP: Charlie applies this migration in the Supabase SQL editor
-- (or via the Supabase MCP) — it is not run automatically.

create table if not exists public.identity_claims (
  code text primary key,
  discord_user_id text not null,
  discord_username text,
  requested_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  linked_character text,
  announced_at timestamptz
);
alter table public.identity_claims enable row level security;
-- No anon/public policies — service-role only (bot mints, webhook consumes).
create index if not exists identity_claims_unconsumed_idx
  on public.identity_claims (consumed_at)
  where consumed_at is null;

-- player_positions: /tv live positions were never meant to be readable via
-- the anon key directly; the /tv route reads it server-side with the
-- service role and gates on TV_ACCESS_KEY.
drop policy if exists "public read player_positions" on public.player_positions;

-- chat_lines: mirrored in-game shouts for the TV chat rail; same tightening.
drop policy if exists "public read chat_lines" on public.chat_lines;
