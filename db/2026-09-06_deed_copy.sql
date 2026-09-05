-- Collective Milestones ("Great Deeds") — three copy corrections.
--
-- ⚠️ UNAPPLIED. Hand-apply against Supabase (project syuwavxpmtdmxupxjzje) when
-- Charlie chooses — there is no migration runner in this repo.
--   psql "$SUPABASE_DB_URL" -f db/2026-09-06_deed_copy.sql
-- or paste into the Supabase SQL editor.
--
-- WHAT THIS IS: three `line` rewrites, nothing else. It follows the full copy
-- pass in db/2026-08-23_milestones_copy_pass.sql (whose text IS live on prod,
-- despite that file's header still saying unapplied — verified by reading the
-- ladder on 2026-09-05). The other 35 deeds were re-read line by line in the
-- same pass and need no change: no dashes, no AI tells, no {value} tokens, no
-- pluralisation traps, and every equivalence still checks out arithmetically.
--
-- SAFE TO RUN ON THE LIVE LADDER. No delete, no insert, no write to any state
-- column: achieved_at, achieved_value, announced_at and meta are untouched, so
-- an earned deed stays earned and an announced deed never re-announces. Every
-- statement sets a literal, so re-running the file is a no-op.

-- 1. deaths_total counts FALLS, not people. "Twenty-five of Eilif's own" claims
--    twenty-five different vikings, which the server cannot even hold (the cap
--    is 20) and which is usually not what happened anyway: one unlucky viking
--    can carry the whole tally. The count is now trips, not bodies.
--    Second clause: "every one of them rowed back" would have handed the tally
--    straight back to the people it just took it off, since "them" can only be
--    the trips. Somebody rows back from a trip; a trip does not row.
--    The equivalence (25 seats: twelve benches and a steersman) is untouched
--    and still reads as a crew's worth of the thing being counted.
update public.milestones set
  line = 'Twenty-five trips to Odin''s table, and every one of them ended with somebody rowing back for seconds.'
where id = 'deaths-first-bench';

-- 2. "Two and a half thousand" is the only number on the ladder written that
--    way; every other spelled-out figure uses the hundreds form ("Seventeen
--    hundred and fifty kilometers of wake"). It also reads badly aloud, and
--    this line is spoken in-game as well as printed.
update public.milestones set
  line = 'Twenty-five hundred pieces raised. There is a longhouse standing where there was only forest.'
where id = 'builds-longhouse';

-- 3. A thousand hours is 41.7 days, so "a whole month" undercounts it AND
--    contradicts the deed's own title ("The Forty Days") and its equivalence
--    ("forty days and nights straight") in the same breath. Six weeks is the
--    honest figure, and the second clause carries the joke the old one was
--    reaching for.
update public.milestones set
  line = 'A thousand hours lived here. Six weeks of somebody''s life, and nobody is asking for it back.'
where id = 'playtime-forty-days';
