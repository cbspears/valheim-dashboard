-- STATUS: READY, NOT APPLIED. Two data repairs from the 2026-09-13 stats audit.
--
-- 1. RE-BIND players.steam_id for names the launch-night join burst paired with the
--    wrong Steam account (2026-09-09 16:35 CT: eight vikings joined inside a minute
--    and the poller's "Got connection SteamID" -> "Got character ZDOID" pairing
--    crossed). Every later join of these names then carried metadata
--    identity = 'steam_mismatch' and the webhook WITHHELD the session (rule 3b),
--    so their hours played stopped counting. Evidence, all from events.metadata
--    fingerprints + the poller journal `[identity] STEAM MISMATCH on join` lines
--    (full ids) + the poller's live state.json pairing:
--      Mikael    seen 76561197994196077 on 20 joins 09-10 .. 09-13 (row held Kætiløy's id)
--      Æymundr   seen 76561198016760141 on 11 joins 09-10 .. 09-13 (row held Mikael's id)
--      Lóa       seen 76561198169390104 on  9 joins 09-10 .. 09-13 (row held Æymundr's id; this id was stored nowhere)
--      Psifour   seen 76561198044041506 on  3 joins 09-10           (row held Mikael's id)
--    Kætiløy keeps 76561198061237866 (her own joins never mismatched). Steward stays
--    on 76561197994196077 (excluded row; no evidence of its true account).
--    Charleif's single 09-09 mismatch and Ræginál's are launch-burst one-offs: untouched.
--
-- 2. BACKFILL the withheld sessions from the join/leave events themselves: one row
--    per mismatched join that has no session within 5 s, closed at that viking's
--    next leave (or next join, whichever came first), left OPEN when neither has
--    happened yet (Mikael's 07:27 CT join today; the normal leave path closes it).
--    Idempotent: re-running inserts nothing.
--
-- Rollback for 1: restore from players_steam_rebind_bak_2026_09_13.
-- Rollback for 2: delete from sessions where id in (select session_id from sessions_backfill_2026_09_13).

create table if not exists players_steam_rebind_bak_2026_09_13 as
  select id, character_name, steam_id, now() as taken_at from players
  where character_name in ('Mikael', 'Æymundr', 'Lóa', 'Psifour');

update players set steam_id = '76561197994196077' where character_name = 'Mikael';
update players set steam_id = '76561198016760141' where character_name = 'Æymundr';
update players set steam_id = '76561198169390104' where character_name = 'Lóa';
update players set steam_id = '76561198044041506' where character_name = 'Psifour';

create table if not exists sessions_backfill_2026_09_13 (
  session_id uuid primary key, player_id uuid, character_name text, joined_at timestamptz, left_at timestamptz, duration_minutes int, inserted_at timestamptz default now());

with j as (
  select e.player_id, e.character_name, e.created_at as joined_at,
         (select min(l.created_at) from events l where l.player_id = e.player_id and l.type = 'leave' and l.created_at > e.created_at) as next_leave,
         (select min(n.created_at) from events n where n.player_id = e.player_id and n.type = 'join'  and n.created_at > e.created_at) as next_join
  from events e
  where e.type = 'join' and e.metadata->>'identity' = 'steam_mismatch'
    and not exists (select 1 from sessions s where s.player_id = e.player_id and abs(extract(epoch from (s.joined_at - e.created_at))) < 5)
),
ins as (
  insert into sessions (player_id, character_name, joined_at, left_at, duration_minutes)
  select player_id, character_name, joined_at,
         least(next_leave, next_join) as left_at,
         case when least(next_leave, next_join) is null then null
              else greatest(0, round(extract(epoch from (least(next_leave, next_join) - joined_at)) / 60))::int end as duration_minutes
  from j
  returning id, player_id, character_name, joined_at, left_at, duration_minutes
)
insert into sessions_backfill_2026_09_13 (session_id, player_id, character_name, joined_at, left_at, duration_minutes)
select id, player_id, character_name, joined_at, left_at, duration_minutes from ins;

-- VERIFY: expect ~44 rows in the backfill log, and hours to climb for the three.
select character_name, count(*) as backfilled, sum(duration_minutes) as minutes from sessions_backfill_2026_09_13 group by 1 order by 2 desc;
select p.character_name, p.steam_id, (select coalesce(sum(duration_minutes),0) from sessions s where s.player_id = p.id) as total_minutes
from players p where p.character_name in ('Mikael', 'Æymundr', 'Lóa', 'Psifour', 'Kætiløy') order by 1;
