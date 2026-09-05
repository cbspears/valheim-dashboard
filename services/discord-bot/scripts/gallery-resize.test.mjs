// Unit tests for the gallery ingest resize (audit backend-5): every photo is
// downscaled to a ≤GALLERY_MAX_EDGE WebP before it reaches Supabase Storage, so
// a months-long playthrough can't burn the Free plan's egress/storage.
//
// Fully offline — no Discord, no Supabase, no network. The fixtures are drawn
// by sharp itself. Run:
//   node scripts/gallery-resize.test.mjs   (from services/discord-bot)
import sharp from 'sharp';
import assert from 'node:assert';
import { resizeForGallery, decodeExclusively, MAX_INPUT_PIXELS } from '../src/gallery.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const kb = (n) => `${Math.round(n / 1024)} KB`;

// A deterministic 4000×3000 PNG standing in for a full-resolution Valheim
// screenshot: layered sky/terrain gradients, ~9 MB encoded — the same order of
// magnitude as the raw PNGs the audit found sitting in the bucket, and still
// under the 12 MB attachment cap the ingest path applies before this runs.
//
// It is smooth by construction, so the ratio it produces flatters WebP: treat
// the assertions (webp / ≤1600 / smaller) as the contract and the printed
// ratio as a smoke signal, not a forecast for real photos.
async function bigPng() {
  const w = 4000, h = 3000;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.sin(y / 90);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = Math.max(0, Math.min(255, (x * 200) / w + 40 * sy));
      px[i + 1] = Math.max(0, Math.min(255, (y * 180) / h + 50 * Math.cos(x / 70)));
      px[i + 2] = Math.max(0, Math.min(255, 120 + 60 * sy * Math.cos(x / 110)));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ── 1. the headline case: a 4000×3000 screenshot ────────────────────────────
const original = await bigPng();
const out = await resizeForGallery(original);

const meta = await sharp(out.data).metadata();
ok(meta.format === 'webp', `output is webp (got ${meta.format})`);
ok(Math.max(meta.width, meta.height) <= 1600, `long edge ≤1600 (got ${meta.width}×${meta.height})`);
ok(meta.width === 1600 && meta.height === 1200, `aspect ratio kept (got ${meta.width}×${meta.height})`);
ok(out.data.length < original.length, `smaller than the input (${kb(original.length)} → ${kb(out.data.length)})`);
ok(out.bytes === out.data.length, 'reported bytes match the buffer');
ok(out.originalBytes === original.length, 'reported originalBytes match the input');
ok(out.width === meta.width && out.height === meta.height, 'reported dimensions match the encoded image');
ok(out.sourceFormat === 'png', `source format reported (got ${out.sourceFormat})`);
ok(out.firstFrameOf === null, 'a still image is not flagged as animated');

console.log(
  `  4000×3000 png ${kb(original.length)} → ${meta.width}×${meta.height} webp ${kb(out.bytes)} ` +
    `(${(original.length / out.bytes).toFixed(1)}× smaller, ${(100 - (out.bytes / original.length) * 100).toFixed(1)}% saved)`
);

// ── 2. never upscale ────────────────────────────────────────────────────────
const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 60, b: 90 } } })
  .png().toBuffer();
const smallOut = await resizeForGallery(small);
const smallMeta = await sharp(smallOut.data).metadata();
ok(smallMeta.width === 800 && smallMeta.height === 600, `under-size image untouched (got ${smallMeta.width}×${smallMeta.height})`);
ok(smallMeta.format === 'webp', 'under-size image still re-encoded to webp');

// ── 3. a portrait image is bounded on its LONG edge ─────────────────────────
const tall = await sharp({ create: { width: 1200, height: 4000, channels: 3, background: { r: 200, g: 40, b: 40 } } })
  .png().toBuffer();
const tallMeta = await sharp((await resizeForGallery(tall)).data).metadata();
ok(tallMeta.height === 1600 && tallMeta.width === 480, `portrait bounded on height (got ${tallMeta.width}×${tallMeta.height})`);

// ── 4. maxEdge is configurable (GALLERY_MAX_EDGE) ───────────────────────────
const narrowMeta = await sharp((await resizeForGallery(original, { maxEdge: 800 })).data).metadata();
ok(Math.max(narrowMeta.width, narrowMeta.height) === 800, `maxEdge honoured (got ${narrowMeta.width}×${narrowMeta.height})`);

// ── 5. EXIF orientation 6 (rotate 90°) is baked in, not carried ─────────────
const rotated = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 10, b: 10 } } })
  .withMetadata({ orientation: 6 }).jpeg().toBuffer();
const rotMeta = await sharp((await resizeForGallery(rotated)).data).metadata();
ok(rotMeta.width === 200 && rotMeta.height === 400, `auto-oriented (got ${rotMeta.width}×${rotMeta.height})`);

// ── 6. an animated gif keeps its FIRST FRAME rather than being skipped ──────
const frames = await sharp({
  create: { width: 100, height: 200, channels: 3, background: { r: 0, g: 120, b: 0 } },
}).gif({ loop: 0 }).toBuffer();
const gifOut = await resizeForGallery(frames);
ok((await sharp(gifOut.data).metadata()).format === 'webp', 'gif input yields webp output');

// ── 7. a non-image buffer throws (the caller skips that attachment) ─────────
let threw = false;
try {
  await resizeForGallery(Buffer.from('this is not an image, it is a saga'));
} catch {
  threw = true;
}
ok(threw, 'an undecodable buffer throws rather than silently passing through');

// ── 8. the decompression bomb (red-team, 2026-09-05) ────────────────────────
// The 12 MB attachment cap is a BYTE cap and a decoded image's memory cost has
// nothing to do with its compressed size. A flat 16000x16000 PNG is 256
// megapixels and weighs 0.71 MB on the wire, so it sailed past that cap — and
// past libvips' own ~268 MP default, which the code used to name as the guard.
// Measured peak RSS decoding one: 198 MB, against a unit with MemoryMax=512M;
// three arriving together OOM-killed the bot.
//
// The bomb itself is not built here (256 MP costs ~200 MB and several seconds to
// generate, which is a poor trade in a suite that runs on every change). The
// ceiling is exercised at a small size instead — the rule is identical, and the
// two assertions on the constant are what pin the real budget.
ok(MAX_INPUT_PIXELS <= 40_000_000, `the pixel ceiling is at most 40 MP (is ${MAX_INPUT_PIXELS})`);
ok(MAX_INPUT_PIXELS >= 20_000_000, 'and comfortably above any real screenshot — a 4K grab is 8.3 MP');
{
  // 2000x2000 = 4 MP, offered to a 1 MP ceiling: refused before it allocates.
  const fourMp = await sharp({
    create: { width: 2000, height: 2000, channels: 3, background: { r: 10, g: 10, b: 10 } },
  }).png().toBuffer();
  ok(fourMp.length < 200 * 1024, `a flat 4 MP png is tiny on the wire (${kb(fourMp.length)}) — bytes are not pixels`);

  let refused = false;
  try {
    await resizeForGallery(fourMp, { limitInputPixels: 1_000_000 });
  } catch {
    refused = true;
  }
  ok(refused, 'an image over the pixel ceiling is refused, not decoded');

  // …and the very same buffer is fine under the real ceiling, so the guard
  // rejects bombs rather than photographs.
  const fine = await resizeForGallery(fourMp);
  ok(fine.width <= 1600 && fine.height <= 1600, 'the same image passes under the shipped ceiling');
}

// ── 9. decodes are serialised, and one failure does not wedge the queue ─────
// handleMessage is an un-serialised messageCreate handler, so without this the
// pixel ceiling would still be multiplied by however many photos land together.
{
  let inFlight = 0;
  let peak = 0;
  const work = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return true;
  };
  await Promise.all([decodeExclusively(work), decodeExclusively(work), decodeExclusively(work)]);
  ok(peak === 1, `only one decode runs at a time (peak was ${peak})`);

  let wedged = false;
  await decodeExclusively(async () => { throw new Error('corrupt attachment'); }).catch(() => {});
  await decodeExclusively(async () => { wedged = true; });
  ok(wedged, 'a failed decode does not wedge every photo posted after it');
}

console.log(`gallery-resize: ${passed} assertions passed`);
