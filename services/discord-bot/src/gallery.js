// Photo-gallery ingest. When someone posts an image in Discord and @mentions
// the bot, copy the attachment into Supabase Storage (Discord CDN URLs expire)
// and record it in `gallery_photos` for the dashboard's Gallery page.
//
// Gated to a single channel via CHANNEL_GALLERY (contract C) — messages from
// any other channel are ignored. If unset, ingest stays ungated (any channel)
// like before, with a once-only warning.
//
// An admin (guild permission MANAGE_MESSAGES) can trash a gallery photo by
// reacting 🗑️ on the bot-reacted photo message: this deletes the
// gallery_photos row(s) + storage object(s) for that message.
//
// No privileged Message Content intent needed: Discord delivers full content +
// attachments for messages that mention the app. We only need GuildMessages
// (+ GuildMessageReactions for the trash react — see discord.js).
//
// Gated behind GALLERY_INGEST=1 (see index.js).

import { PermissionFlagsBits } from 'discord.js';
import { serviceClient } from './supabase.js';
import { matchPinInCaption } from './pinMatch.js';

const IMAGE_TYPE = /^image\//;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const BUCKET = 'gallery';
const TRASH_EMOJI = '🗑️';

// Skip attachments over this size — a cap against OOM/storage abuse from a
// single huge "photo" (the bot buffers the whole file in memory to upload it).
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024; // 12 MB

// A best-effort insert error that just means the pin_id column isn't there yet
// (migration db/2026-07-04_gallery_pin_link.sql not applied). We retry without it.
const MISSING_PIN_COLUMN = /pin_id|column .* does not exist|schema cache/i;

export function createGalleryIngest({ client, log = console }) {
  const db = serviceClient();
  const galleryChannelId = process.env.CHANNEL_GALLERY;
  let warnedUngated = false;

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

    if (typeof att.size === 'number' && att.size > MAX_ATTACHMENT_BYTES) {
      log.warn?.(`[gallery] skipped ${att.name || att.id} — ${att.size} bytes over the ${MAX_ATTACHMENT_BYTES} cap`);
      return false;
    }

    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      log.warn?.(`[gallery] skipped ${att.name || att.id} — ${bytes.length} bytes over the ${MAX_ATTACHMENT_BYTES} cap`);
      return false;
    }

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

      if (galleryChannelId) {
        if (message.channelId !== galleryChannelId) return;
      } else if (!warnedUngated) {
        log.warn?.('[gallery] CHANNEL_GALLERY not set — gallery ingest is ungated (any channel accepted)');
        warnedUngated = true;
      }

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

  // Admin cleanup: a MANAGE_MESSAGES react of 🗑️ on a gallery photo message
  // deletes that message's gallery_photos row(s) + storage object(s).
  async function handleReaction(reaction, user) {
    try {
      if (user.bot) return;
      if (reaction.emoji.name !== TRASH_EMOJI) return;
      if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);

      const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
      if (!message?.guild) return;
      if (galleryChannelId && message.channelId !== galleryChannelId) return;

      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return;

      const { data: photos, error } = await db
        .from('gallery_photos')
        .select('id, storage_path')
        .eq('source_message_id', message.id);
      if (error) throw new Error(`lookup: ${error.message}`);
      if (!photos?.length) return;

      for (const photo of photos) {
        if (photo.storage_path) {
          const { error: rmErr } = await db.storage.from(BUCKET).remove([photo.storage_path]);
          if (rmErr) log.error?.(`[gallery] storage remove failed for ${photo.storage_path}: ${rmErr.message}`);
        }
        const { error: delErr } = await db.from('gallery_photos').delete().eq('id', photo.id);
        if (delErr) log.error?.(`[gallery] delete failed for ${photo.id}: ${delErr.message}`);
      }
      log.info?.(`[gallery] ${member.user.username} trashed ${photos.length} photo(s) from message ${message.id}`);
    } catch (e) {
      log.error?.(`[gallery] trash react: ${e.message}`);
    }
  }

  function attach() {
    client.on('messageCreate', handleMessage);
    client.on('messageReactionAdd', handleReaction);
    log.info?.('[gallery] ingest active — tag the bot with an image to add it');
  }

  return { attach, handleMessage, handleReaction };
}
