-- Gallery ↔ map pin link (BIDIRECTIONAL photo↔place).
-- Adds gallery_photos.pin_id so a community photo can be attached to the map
-- marker whose place name appears in its caption. Matching happens in two
-- places, either order working:
--   • forward  : the Discord gallery ingest scans a new photo's caption for any
--     existing pin's name (services/discord-bot/src/gallery.js + pinMatch.js).
--   • retro    : when a NEW pin is created, the webhook back-fills pin_id on
--     existing photos whose caption names it (app/api/webhook/route.ts, pin branch).
--
-- ON DELETE SET NULL: re-pinning a place (delete old row + insert new) simply
-- unlinks the affected photos; the retro-match pass then re-links them to the
-- new pin. Purely additive + idempotent — safe to apply live.
--
-- STATUS: NOT yet applied to prod. Coordinator applies, then the Discord bot
-- can be restarted. The app + bot code both tolerate this column being absent
-- (they fall back to inserting/reading without pin_id), so nothing crashes in
-- the window before it is applied.

alter table public.gallery_photos
  add column if not exists pin_id uuid references public.pins(id) on delete set null;

create index if not exists gallery_photos_pin_id_idx on public.gallery_photos (pin_id);
