-- 2026-09-06 · Great Deeds: retire the "Bosses slain" chain, add "The First Mile".
--
-- STATUS: APPLIED to production 2026-09-06 ~10:05 CT (Fable session), Charlie's call:
-- "remove the bosses slain milestone, it's redundant" (the boss timeline already tells
-- it) and "Map explored should have a first mile percent".
-- Idempotent: the deletes are by id, the insert is on conflict do nothing.
--
-- Leaves lib/milestones.ts's boss_kills_total metric in place (it costs nothing and a
-- future deed may use it); with no rows on the metric the ledger shows no tracker row.

delete from public.milestones where id in ('boss-first', 'boss-half', 'boss-all');

insert into public.milestones (id, metric, threshold, title, line, equivalence, sort) values
  ('explored-first-mile', 'explored_avg_pct', 1, 'The First Mile',
   'One part in a hundred of the world charted. The first mile is the one that counts.',
   null, 335)
on conflict (id) do nothing;
