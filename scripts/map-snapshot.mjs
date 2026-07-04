// LIVE map snapshot: pull WebMap's map.png + fog.png over SFTP, composite the
// fog-MASKED known world (full map never leaves this machine), upload to the
// public Supabase Storage bucket `map` as current.webp (+ a timestamped frame
// for the future timelapse). Secrecy rules: hard opaque mask, no raw map.png
// ever uploaded, real seed never referenced.
//
// Run once:        node scripts/map-snapshot.mjs
// Run as a loop:   node scripts/map-snapshot.mjs --loop   (every 10 min)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootRequire = createRequire(join(ROOT, 'package.json'));
const pollerRequire = createRequire(join(ROOT, 'services/log-poller/package.json'));

const sharp = rootRequire('sharp');
const SftpClient = pollerRequire('ssh2-sftp-client');
pollerRequire('dotenv').config({ path: join(ROOT, 'services/log-poller/.env') });
pollerRequire('dotenv').config({ path: join(ROOT, '.env.local') });

const REMOTE = '/194.50.234.131_5914/BepInEx/plugins/WebMap/map_data/Dedicated';
const SIZE = 2048;

async function snapshot() {
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.SFTP_HOST,
    port: +process.env.SFTP_PORT,
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
  });
  const [mapPng, fogPng] = await Promise.all([
    sftp.get(REMOTE + '/map.png'),
    sftp.get(REMOTE + '/fog.png'),
  ]);
  await sftp.end();

  const map = await sharp(mapPng).removeAlpha().raw().toBuffer();
  // sharp may expand the 1-channel fog PNG to 3 channels on raw() — honor the
  // actual stride instead of assuming one byte per pixel
  const fogRes = await sharp(fogPng).blur(1.2).raw().toBuffer({ resolveWithObject: true });
  const fog = fogRes.data, fs_ = fogRes.info.channels;
  // a wide, faint gold halo around anything explored — keeps a small young
  // world visible as an ember on the page instead of a black void
  const haloRes = await sharp(fogPng).blur(14).raw().toBuffer({ resolveWithObject: true });
  const halo = haloRes.data, hs_ = haloRes.info.channels;

  // dark blue-slate unexplored texture (matches the site's pitch background)
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = fog[i * fs_] / 255;
    const g = (halo[i * hs_] / 255) * (1 - a) * 0.55; // halo only OUTSIDE the revealed area
    const j = i * 3;
    out[j] = Math.min(255, map[j] * a + 11 * (1 - a) + 200 * g);
    out[j + 1] = Math.min(255, map[j + 1] * a + 14 * (1 - a) + 149 * g);
    out[j + 2] = Math.min(255, map[j + 2] * a + 20 * (1 - a) + 42 * g);
  }

  const webp = await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .webp({ quality: 72 })
    .toBuffer();

  // explored percent (of the world disc, radius ~= SIZE/2 * 0.95)
  let lit = 0;
  for (let i = 0; i < SIZE * SIZE; i++) if (fog[i * fs_] > 40) lit++;
  const discPx = Math.PI * Math.pow((SIZE / 2) * 0.95, 2);
  const revealedPct = +(100 * lit / discPx).toFixed(2);

  // plain Storage REST (supabase-js wants ws in bare Node; fetch is all we need)
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL + '/storage/v1';
  const auth = { Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
  await fetch(base + '/bucket', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'map', name: 'map', public: true }),
  }); // 409 when it already exists — fine
  const put = (path) => fetch(`${base}/object/map/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/webp', 'x-upsert': 'true' },
    body: webp,
  });
  const r1 = await put('current.webp');
  if (!r1.ok) throw new Error('upload current: HTTP ' + r1.status + ' ' + (await r1.text()).slice(0, 120));
  const r2 = await put(`frames/${new Date().toISOString().replace(/[:.]/g, '-')}.webp`);
  if (!r2.ok) console.warn('frame archive failed: HTTP', r2.status);

  console.log(`[map-snapshot] ${new Date().toISOString()} uploaded (${(webp.length / 1024).toFixed(0)}KB, revealed ${revealedPct}%)`);
}

const loop = process.argv.includes('--loop');
await snapshot().catch((e) => { console.error('[map-snapshot] failed:', e.message); if (!loop) process.exit(1); });
if (loop) {
  setInterval(() => snapshot().catch((e) => console.error('[map-snapshot] failed:', e.message)), 10 * 60 * 1000);
}
