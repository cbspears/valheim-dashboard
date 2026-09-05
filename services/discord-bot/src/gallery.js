// Photo-gallery ingest. When someone posts an image in Discord and @mentions
// the bot, copy the attachment into Supabase Storage (Discord CDN URLs expire)
// and record it in `gallery_photos` for the dashboard's Gallery page.
//
// The attachment is NOT stored as posted: it is downscaled to a ≤1600 px WebP
// first (see resizeForGallery) so months of screenshots can't exhaust the
// Supabase Free plan's storage/egress. `url` points at the WebP.
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
// single huge "photo" (the bot buffers the whole file in memory to decode it).
// This is the *download* guard: it applies to the original attachment, before
// the resize below shrinks what actually reaches Supabase.
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024; // 12 MB

// ── Resize on ingest ────────────────────────────────────────────────────────
// Valheim screenshots arrive as 3–7 MB full-resolution PNGs. Stored and served
// raw from Supabase Storage, a single /gallery page view pulls tens of MB, and
// the Free plan's 5 GB/month egress (and 1 GB storage) would be gone inside the
// first month of the playthrough — taking the map, the gallery AND the REST API
// the dashboard depends on down with it.
//
// So every attachment is decoded, auto-oriented, downscaled so its longer edge
// is at most GALLERY_MAX_EDGE (never upscaled) and re-encoded as WebP before
// upload. A 4 MB PNG screenshot lands around 150–300 KB — a ~20× cut — with no
// visible loss at the sizes the masonry grid and the lightbox actually render.
const MAX_EDGE = Math.max(1, Number(process.env.GALLERY_MAX_EDGE) || 1600);
const WEBP_QUALITY = 82;

// ── The decompression-bomb ceiling ──────────────────────────────────────────
// THE BUG THIS FIXES (red-team, 2026-09-05). The 12 MB download cap above is a
// BYTE cap, and a decoded image's memory cost has nothing to do with its
// compressed size: a flat 16000x16000 PNG is 256 megapixels and weighs 0.71 MB
// on the wire, so it sailed past the cap — and past libvips' own ~268 MP
// default, which the comment below used to claim was the guard. Measured peak
// RSS decoding one: 198 MB, against a unit with MemoryMax=512M. `handleMessage`
// is a plain un-serialised messageCreate handler, so three such posts arriving
// together decode concurrently and OOM-kill the bot. Restart=always brings it
// back, but the relay, boss and recap loops blip and the relay cursor is
// mid-batch — a very cheap troll at 20 players.
//
// 40 MP is roughly a 8000x5000 image: far above any Valheim screenshot (a 4K
// grab is 8.3 MP) and far below anything that can exhaust the memory budget.
// libvips refuses a larger input BEFORE allocating for it, so a bomb costs
// nothing at all.
export const MAX_INPUT_PIXELS = Math.max(1, Number(process.env.GALLERY_MAX_INPUT_PIXELS) || 40_000_000);

// Only one attachment is decoded at a time, process-wide. The pixel ceiling
// bounds ONE decode; this bounds the whole service, whatever arrives together.
// Cheap: ingest is a handful of photos an evening, and the queue is only ever
// contended by the abuse case it exists for.
let decodeChain = Promise.resolve();
export function decodeExclusively(fn) {
  const run = decodeChain.then(fn);
  // The chain must survive a failed decode — a corrupt attachment cannot be
  // allowed to wedge every photo posted after it — and must not hold the buffer.
  decodeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

// sharp is this bot's only native dependency, and index.js imports this module
// unconditionally. Load it lazily (and once) so a missing or mismatched binary
// — a fresh `npm install --omit=optional`, a node_modules copied between archs
// — degrades to "photos are skipped, loudly" instead of taking the whole bot
// (event relay, boss announcements, recaps) down at startup.
let sharpPromise = null;
function loadSharp() {
  sharpPromise ??= import('sharp').then((m) => m.default);
  return sharpPromise;
}

/**
 * Decode → auto-orient → downscale → WebP. Pure and offline (no network, no
 * Discord, no Supabase) so `scripts/gallery-resize.test.mjs` can exercise it.
 *
 * Animated GIF/WebP: sharp reads only the **first frame** unless it is opened
 * with `{ animated: true }`, and we deliberately don't — the grid shows a still
 * anyway, and re-encoding an animation would blow through the byte budget this
 * whole function exists to protect. So an animated post is kept as its opening
 * frame rather than skipped.
 *
 * `limitInputPixels` is set to MAX_INPUT_PIXELS, NOT left at libvips' ~268 MP
 * default: at 4 bytes a pixel that default permits a gigabyte of allocation,
 * which is twice this service's whole memory budget. See MAX_INPUT_PIXELS.
 *
 * @throws if the buffer isn't an image sharp/libvips can decode — callers skip
 *         that one attachment rather than falling back to the full-size original.
 */
export async function resizeForGallery(
  input,
  { maxEdge = MAX_EDGE, quality = WEBP_QUALITY, limitInputPixels = MAX_INPUT_PIXELS } = {},
) {
  const sharp = await loadSharp();
  const pipeline = sharp(input, { failOn: 'error', limitInputPixels });
  const meta = await pipeline.metadata();
  const { data, info } = await pipeline
    .rotate() // honour the EXIF orientation tag, then drop it
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    bytes: info.size,
    originalBytes: input.length,
    sourceFormat: meta.format ?? null,
    // Set when the source had more than one frame and we kept only the first.
    firstFrameOf: (meta.pages ?? 1) > 1 ? (meta.format ?? 'animated') : null,
  };
}

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

    // Shrink before upload. A decode failure (corrupt file, or a format libvips
    // can't read) skips this one attachment — we never fall back to uploading
    // the full-size original, which is the thing this exists to prevent.
    const label = att.name || att.id;
    let image;
    try {
      // Serialised: one decode in flight for the whole process, so peak memory
      // is bounded by the pixel ceiling rather than by how many photos happen
      // to arrive at once. See MAX_INPUT_PIXELS.
      image = await decodeExclusively(() => resizeForGallery(bytes));
    } catch (e) {
      log.warn?.(`[gallery] skipped ${label} — could not decode (${e.message})`);
      return false;
    }
    log.info?.(
      `[gallery] resized ${label} ${fmtBytes(image.originalBytes)} → ${fmtBytes(image.bytes)} ` +
        `(${image.originalBytes} → ${image.bytes} bytes, ${image.sourceFormat ?? '?'} → webp q${WEBP_QUALITY} ` +
        `${image.width}×${image.height}` +
        `${image.firstFrameOf ? `, first frame of an animated ${image.firstFrameOf}` : ''})`
    );

    const path = `${att.id}.webp`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, image.data, {
      contentType: 'image/webp',
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
      // These describe the object `url` actually points at (the WebP), not the
      // Discord original — same columns, same shape, no migration.
      content_type: 'image/webp',
      width: image.width,
      height: image.height,
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
      // Strictly one attachment at a time: each one is fully buffered and then
      // decoded into a raw bitmap, so ingesting a 10-image post concurrently
      // would multiply peak memory. A failure on one photo (decode, upload,
      // insert) is logged and the rest of the post still lands.
      for (const att of images) {
        try {
          if (await storeOne(att, ctx)) added++;
        } catch (e) {
          log.error?.(`[gallery] ${att.name || att.id}: ${e.message}`);
        }
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
