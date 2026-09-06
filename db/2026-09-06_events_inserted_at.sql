-- APPLIED to production 2026-09-05 ~23:50 CT (Fable session) via SQL; backfill verified. Idempotent; safe to re-run.
-- events.inserted_at — an INSERTION-ORDER column for the #server relay cursor.
--
-- STATUS: APPLIED (see line 1). Idempotent; safe to re-run.
-- like every other file in db/. Idempotent: safe to run twice, safe to run after
-- the relay is already on the new code, safe to run while the bot is running.
--
-- WHAT IT FIXES (found by the launch rehearsal, 2026-09-06: `join 20/20 ·
-- leave 0/20 · death 2/3 — 21 of 43 feed rows NEVER POSTED, silently`).
--
-- The relay cursored on `events.created_at`, which is PRODUCER-supplied:
--
--   • the log poller stamps a join/leave with the LOG LINE's time and only
--     ships it on its next 20 s SFTP poll, so its rows routinely land 20-30 s
--     after the instant they claim;
--   • gs-ingest (client deaths, boss kills, Great Deeds) and the bot's own rows
--     land with created_at = real now.
--
-- So: a client death at 12:00:00 is relayed at 12:00:05 and parks the cursor at
-- 12:00:00; the poller then writes a leave stamped 11:59:50 at 12:00:08;
-- `.gt('created_at', '12:00:00')` never matches it. That row is gone from
-- #server forever, and silently — a tick that posts nothing is a success, so
-- the ops heartbeat and the watchdog both stay green.
--
-- `events.id` is a UUID (db/0000_initial_schema.sql), so before this column
-- there was no insertion-order key to cursor on at all.
--
-- WHY THE BACKFILL. Right after the ALTER, every EXISTING row carries the
-- column default — the migration's own clock — so they would all sort together
-- at "now", ahead of the relay's saved cursor, and the bot's first tick after
-- the migration would replay the entire table into #server. Setting them to
-- created_at preserves the order history already had AND keeps the relay's
-- existing created_at cursor meaningful across the switch (services/discord-bot/
-- src/relay.js seeds lastInsertedAt from lastEventAt on its first tick).
--
-- The `inserted_at > now() - interval '5 minutes'` guard is what makes a re-run
-- safe: on a second run the rows already fixed carry a REAL (older) value and
-- are not touched, so genuine insertion order is never clobbered by created_at.
-- The `created_at < inserted_at` guard is the second lock, and it does one more
-- job on purpose: a row whose created_at is in the FUTURE (a pre-clamp forged
-- row still sitting in the table) fails it and keeps inserted_at = now, so a
-- poisoned created_at cannot be copied into the new cursor column and freeze
-- the feed the same way all over again.

begin;

alter table public.events
  add column if not exists inserted_at timestamptz not null default now();

update public.events
   set inserted_at = created_at
 where inserted_at > now() - interval '5 minutes'
   and created_at < inserted_at;

-- The relay's only query is `inserted_at >= cursor order by inserted_at,
-- created_at limit N`. Without this it is a seq scan on every 15 s tick.
create index if not exists events_inserted_at_idx on public.events (inserted_at);

commit;

-- Verify (should be 0, and the max should be recent rather than the migration
-- timestamp on every row):
--   select count(*) from public.events where inserted_at is null;
--   select min(inserted_at), max(inserted_at), count(*) from public.events;
