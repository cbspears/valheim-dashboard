-- Community photo gallery. The bot fills it when someone posts an image in
-- Discord and @mentions the bot; it copies the attachment into the public
-- 'gallery' storage bucket (Discord CDN URLs expire) and inserts a row here.
-- Demo rows have source_attachment_id null.
--
-- Applied to prod 2026-06-25 via the Supabase MCP.

create table if not exists public.gallery_photos (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  storage_path text,
  caption text,
  posted_by text,
  discord_user_id text,
  source_attachment_id text unique,
  source_message_id text,
  content_type text,
  width integer,
  height integer,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.gallery_photos enable row level security;

drop policy if exists "public read gallery_photos" on public.gallery_photos;
create policy "public read gallery_photos" on public.gallery_photos
  for select using (true);

create index if not exists gallery_photos_posted_at_idx on public.gallery_photos (posted_at desc);

-- Public bucket for re-hosted images (the dashboard reads the public URL directly).
insert into storage.buckets (id, name, public)
values ('gallery', 'gallery', true)
on conflict (id) do update set public = true;
