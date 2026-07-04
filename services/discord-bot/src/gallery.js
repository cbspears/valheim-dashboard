// Photo-gallery ingest. When someone posts an image in Discord and @mentions
// the bot, copy the attachment into Supabase Storage (Discord CDN URLs expire)
// and record it in `gallery_photos` for the dashboard's Gallery page.
//
// No privileged Message Content intent needed: Discord delivers full content +
// attachments for messages that mention the app. We only need GuildMessages.
//
// Gated behind GALLERY_INGEST=1 (see index.js).

import { serviceClient } from './supabase.js';
import { matchPinInCaption } from './pinMatch.js';

const IMAGE_TYPE = /^image\//;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const BUCKET = 'gallery';

// A best-effort insert error that just means the pin_id column isn't there yet
// (migration db/2026-07-04_gallery_pin_link.sql not applied). We retry without it.
const MISSING_PIN_COLUMN = /pin_id|column .* does not exist|schema cache/i;

export function createGalleryIngest({ client, log = console }) {
  const db = serviceClient();

  // The caption is the message text with the bot mention stripped out.
  function captionFrom(message) {
    const text = (message.content ?? '')
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();
    return text || null;
  }

  async function storeOne(att, ctx) {
    // Skip if we've already ingested this exact attachment.
    const { data: existing } = await db
      .from('gallery_photos')
      .select('id')
      .eq('source_attachment_id', att.id)
      .maybeSingle();
    if (existing) return false;

    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const ext = ((att.name?.split('.').pop() || 'png').toLowerCase().match(/[a-z0-9]+/)?.[0]) || 'png';
    const path = `${att.id}.${ext}`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, {
      contentType: att.contentType ?? 'image/png',
      upsert: true,
    });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
    const row = {
      url: pub.publicUrl,
      storage_path: path,
      caption: ctx.caption,
      posted_by: ctx.postedBy,
      discord_user_id: ctx.message.author.id,
      source_attachment_id: att.id,
      source_message_id: ctx.message.id,
      content_type: att.contentType ?? null,
      width: att.width ?? null,
      height: att.height ?? null,
      posted_at: new Date(ctx.message.createdTimestamp).toISOString(),
    };
    // Attach to a map pin if the caption names one (gallery ↔ map link).
    if (ctx.pinId) row.pin_id = ctx.pinId;

    let { error: insErr } = await db.from('gallery_photos').insert(row);
    // Degrade gracefully if the pin_id column isn't live yet: keep the photo.
    if (insErr && row.pin_id && MISSING_PIN_COLUMN.test(insErr.message)) {
      delete row.pin_id;
      ({ error: insErr } = await db.from('gallery_photos').insert(row));
    }
    if (insErr) throw new Error(`insert: ${insErr.message}`);
    return true;
  }

  // Look up the map pin (if any) whose place name appears in the caption.
  async function matchPin(caption) {
    if (!caption) return null;
    try {
      const { data: pins } = await db.from('pins').select('id, name');
      return matchPinInCaption(caption, pins ?? [])?.id ?? null;
    } catch {
      return null; // pins unavailable — just store the photo unlinked
    }
  }

  async function handleMessage(message) {
    try {
      if (message.author?.bot) return;
      if (!message.mentions?.has(client.user)) return;

      const images = [...message.attachments.values()].filter(
        (a) => IMAGE_TYPE.test(a.contentType ?? '') || IMAGE_EXT.test(a.name ?? '')
      );
      if (images.length === 0) return;

      const caption = captionFrom(message);
      const ctx = {
        caption,
        postedBy: message.member?.displayName ?? message.author.username,
        pinId: await matchPin(caption),
        message,
      };

      let added = 0;
      for (const att of images) {
        if (await storeOne(att, ctx)) added++;
      }
      if (added > 0) {
        await message.react('🖼️').catch(() => {});
        log.info?.(`[gallery] stored ${added} photo(s) from ${ctx.postedBy}`);
      }
    } catch (e) {
      log.error?.(`[gallery] ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    log.info?.('[gallery] ingest active — tag the bot with an image to add it');
  }

  return { attach, handleMessage };
}
