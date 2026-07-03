// One-off: derive demo "player screenshots" for the map place panels from the
// site's existing art — varied crops + color grades so they read as distinct
// photos. Output: public/map-demo/photos/*.webp (640x360).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const ROOT = '/home/cbspears/Projects/valheim-dashboard';
const OUT = `${ROOT}/public/map-demo/photos`;
mkdirSync(OUT, { recursive: true });

const W = 640, H = 360;

async function shot(src, out, { left = 0.0, top = 0.0, w = 0.6, h = 0.6, mod = {} }) {
  const img = sharp(`${ROOT}/public/${src}`);
  const meta = await img.metadata();
  const region = {
    left: Math.round(meta.width * left),
    top: Math.round(meta.height * top),
    width: Math.round(meta.width * w),
    height: Math.round(meta.height * h),
  };
  await img
    .extract(region)
    .resize(W, H, { fit: 'cover' })
    .modulate({ brightness: 1, saturation: 1, ...mod })
    .webp({ quality: 74 })
    .toFile(`${OUT}/${out}.webp`);
  console.log('wrote', out);
}

// Midgard — five shots, five photographers
await shot('banner-eilif.webp', 'midgard-1', { left: 0.02, top: 0.05, w: 0.5, h: 0.85, mod: { saturation: 1.15 } });
await shot('banner-eilif.webp', 'midgard-2', { left: 0.45, top: 0.1, w: 0.5, h: 0.8, mod: { brightness: 0.82, hue: 15 } });
await shot('bg-eilif.webp', 'midgard-3', { left: 0.1, top: 0.0, w: 0.55, h: 0.6, mod: { hue: 200, saturation: 0.85 } });
await shot('og-eilif.jpg', 'midgard-4', { left: 0.25, top: 0.3, w: 0.6, h: 0.6, mod: { saturation: 0.55, brightness: 1.08 } });
await shot('bg-eilif.webp', 'midgard-5', { left: 0.35, top: 0.35, w: 0.6, h: 0.55, mod: { brightness: 0.6, hue: 250 } });
// Draugheim — a single moody shot
await shot('og-eilif.jpg', 'draugheim-1', { left: 0.05, top: 0.1, w: 0.55, h: 0.7, mod: { hue: 120, saturation: 0.7, brightness: 0.85 } });
