-- 2026-09-06 · A second, off-PC watchdog pinger inside Supabase (pg_cron + pg_net).
--
-- STATUS: UNAPPLIED. Needs one paste from Charlie (the WATCHDOG_TOKEN value lives
-- only in Vercel and the GitHub secret; nothing on this PC holds it).
--
-- WHY: the GitHub-scheduled watchdog is declared '*/15 * * * *' but GitHub runs it
-- roughly every four hours on this repo (observed 2026-09-06: 00:07, 04:38, 08:56,
-- 12:43 UTC). If the PC goes down, Discord finds out up to four hours later. This
-- job pings the same route every five minutes from the database itself, which is
-- off the PC and always up while the site is. The route de-duplicates alerts in
-- ops_alerts, so two pingers cannot double-post.
--
-- HOW TO APPLY (Supabase SQL editor, as the project owner), in order:
--   1. run this whole file once (extensions + schedule; the schedule references the
--      secret by NAME, so it is safe to create before the secret exists);
--   2. paste the token ONCE, replacing the placeholder, and run:
--        select vault.create_secret('PASTE-WATCHDOG-TOKEN-HERE', 'watchdog_token',
--                                   'Bearer for /api/ops/watchdog');
--   3. verify within ten minutes:
--        select status_code, created from net._http_response order by id desc limit 3;
--      expect 200s. A 401 means the secret is wrong; 'discord not configured' in the
--      body means WATCHDOG_CHANNEL_ID is missing on Vercel.
-- Remove: select cron.unschedule('eilif-watchdog-ping');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'eilif-watchdog-ping',
  '*/5 * * * *',
  $job$
  select net.http_get(
    url := 'https://valheim-dashboard.vercel.app/api/ops/watchdog',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'watchdog_token' limit 1), 'missing-secret')
    ),
    timeout_milliseconds := 60000
  );
  $job$
);
