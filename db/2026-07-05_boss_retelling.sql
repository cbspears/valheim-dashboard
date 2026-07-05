-- Skald retelling for boss kills — the /boss "Retelling" saga surface.
--
-- Adds two nullable columns to bosses:
--
--  1. bosses.retelling — the LLM-written (or template fallback) 3–5 sentence
--     saga account of the fight, generated ONCE per kill by the Discord bot
--     (services/discord-bot/src/retelling.js) after it announces a newly-felled
--     boss, or on demand via scripts/retell-boss.js. Rendered verbatim as prose
--     in the war-room's "The Retelling" card, attributed "— the Skald".
--
--  2. bosses.retelling_generated_at — when it was written, so a regen can be
--     detected/ordered and the bot can tell "never generated" from "generated,
--     empty on purpose".
--
-- Additive + nullable, safe on the live project, reversible (DROP COLUMN).
-- Everything degrades gracefully pre-migration: the war-room render treats a
-- missing column as "no retelling yet" and the bot/script tolerate the write
-- failing (logged, never fatal) so the announce loop is unaffected.
--
--   psql "$SUPABASE_DB_URL" -f db/2026-07-05_boss_retelling.sql
-- or paste into the Supabase SQL editor.

alter table public.bosses
  add column if not exists retelling text;

alter table public.bosses
  add column if not exists retelling_generated_at timestamptz;

comment on column public.bosses.retelling is
  'Skald-voiced saga retelling of the boss fight, generated once per kill by the Discord bot (LLM via local ollama qwen3.6:27b, with a template fallback). Rendered verbatim in the /boss war-room "Retelling" card.';

comment on column public.bosses.retelling_generated_at is
  'When bosses.retelling was written; lets a regen (scripts/retell-boss.js --force) be detected and ordered.';
