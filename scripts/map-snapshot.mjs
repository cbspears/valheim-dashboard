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

// The WebMap plugin's map_data dir is namespaced by WORLD NAME (not save
// file) under a fixed GTXGaming instance path. "Dedicated" is the pre-launch
// TEST world's name — the real 1.0 launch world will be named something else,
// so this MUST be overridden (via the host's systemd env, or
// services/log-poller/.env / .env.local, both loaded above) before/at launch,
// or the pipeline will silently keep polling the old (frozen) test world.
//   MAP_REMOTE_DIR = full override of the remote directory (wins if set)
//   MAP_WORLD      = just the world-name path segment (default: "Dedicated")
const MAP_DATA_BASE = '/194.50.234.131_5914/BepInEx/plugins/WebMap/map_data';
const MAP_WORLD_DEFAULT = 'Dedicated';
const REMOTE = process.env.MAP_REMOTE_DIR
  || `${MAP_DATA_BASE}/${process.env.MAP_WORLD || MAP_WORLD_DEFAULT}`;
console.log(
  `[map-snapshot] remote map dir: ${REMOTE}` +
    (process.env.MAP_REMOTE_DIR
      ? ' (MAP_REMOTE_DIR override)'
      : process.env.MAP_WORLD
        ? ` (MAP_WORLD=${process.env.MAP_WORLD})`
        : ` (default "${MAP_WORLD_DEFAULT}" — set MAP_WORLD or MAP_REMOTE_DIR when the world changes)`)
);
const SIZE = 2048;
const STATE_FILE = join(ROOT, 'scripts', '.map-snapshot-state.json');
const fs = rootRequire('fs');

// --- Ops cockpit heartbeat (best-effort; never blocks or crashes this script) ---
// Uses OPS_HEARTBEAT_TOKEN + the dashboard base URL derived from OPS_HEARTBEAT_URL
// or WEBHOOK_URL (both loaded above from services/log-poller/.env / .env.local).
function sanitizeForHeartbeat(input, max = 200) {
  if (!input) return null;
  let s = String(input);
  s = s.replace(/(token|key|secret|bearer|password)\s*[:=]?\s*\S+/gi, '$1=[redacted]');
  s = s.replace(/[A-Za-z0-9+/_-]{32,}/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function resolveHeartbeatUrl() {
  if (process.env.OPS_HEARTBEAT_URL) return process.env.OPS_HEARTBEAT_URL;
  if (process.env.WEBHOOK_URL) return `${process.env.WEBHOOK_URL.replace(/\/api\/webhook\/?$/, '')}/api/ops/heartbeat`;
  return null;
}
let heartbeatWarned = false;
async function sendHeartbeat({ status = 'ok', error, metrics } = {}) {
  const token = process.env.OPS_HEARTBEAT_TOKEN;
  const url = resolveHeartbeatUrl();
  if (!token || !url) {
    if (!heartbeatWarned) {
      heartbeatWarned = true;
      console.warn(`[map-snapshot] heartbeats disabled (${!token ? 'OPS_HEARTBEAT_TOKEN unset' : 'no dashboard URL — set OPS_HEARTBEAT_URL or WEBHOOK_URL'})`);
    }
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ component: 'map-snapshot', status, error: sanitizeForHeartbeat(error), metrics }),
    });
    if (!res.ok) console.warn(`[map-snapshot] heartbeat POST HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[map-snapshot] heartbeat POST failed: ${e.message}`);
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { days: [] }; }
}
function saveState(st) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

/** The in-game day, from the dashboard's own status API (fed by the Emitter). */
async function currentWorldDay() {
  try {
    const r = await fetch('https://valheim-dashboard.vercel.app/api/status', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.worldDay === 'number' && j.worldDay > 0 ? Math.floor(j.worldDay) : null;
  } catch { return null; }
}

// --- SFTP fetch, hardened against a known ssh2-sftp-client failure mode ---
// 2026-08-17: a transient SFTP read (ETIMEDOUT) fired as a raw EventEmitter
// 'error' event that reached no listener anywhere in the library's or our own
// stack. Node treats that as an uncaught exception and kills the process on
// the spot — it is NOT a rejected promise, so no try/catch around an `await`
// can ever intercept it, no matter how tightly the SFTP calls are wrapped.
//
// Mitigation: (1) attach our own defensive 'error' listener on the client as
// belt-and-suspenders in case the library's own internal listener bookkeeping
// misses a source; (2) scope a temporary `uncaughtException` trap tightly
// around just this fetch, converting that failure mode into an ordinary
// rejection the caller can catch, log, and skip the cycle for; (3) race
// against a timeout so a connection that neither errors nor completes (also
// consistent with ETIMEDOUT) can't wedge the 5-minute loop forever. The trap
// is installed/removed immediately around this one bounded unit of work —
// each cycle builds a fresh SftpClient with no shared state to corrupt, so
// resuming the loop afterward is safe.
const SFTP_TIMEOUT_MS = 30000;
async function fetchMapData() {
  const sftp = new SftpClient();
  sftp.on('error', (err) => console.warn(`[map-snapshot] sftp client error event: ${err.message}`));

  let onTrap;
  const trapped = new Promise((_, reject) => {
    onTrap = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    process.on('uncaughtException', onTrap);
  });
  trapped.catch(() => {}); // never awaited if the fetch finishes cleanly first — prevent an unhandled rejection

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`sftp fetch timed out after ${SFTP_TIMEOUT_MS}ms`)), SFTP_TIMEOUT_MS)
  );

  try {
    const work = (async () => {
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
      return { mapPng, fogPng };
    })();
    return await Promise.race([work, trapped, timeout]);
  } finally {
    process.removeListener('uncaughtException', onTrap);
    try {
      await sftp.end();
    } catch (e) {
      console.warn(`[map-snapshot] sftp.end() failed (ignored): ${e.message}`);
    }
  }
}

async function snapshot() {
  const { mapPng, fogPng } = await fetchMapData();

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

  // ONE frame per IN-GAME day (Charlie's cadence): upsert day-N every cycle
  // while the world is on day N — when the day rolls over, day-N stays frozen
  // at its final state, which makes each frame the day's end-of-day picture.
  const day = await currentWorldDay();
  let dayNote = 'day unknown (frame skipped)';
  let manifestOk = null; // null = day unknown so no manifest attempt was made
  if (day !== null) {
    const dayPath = `frames-by-day/day-${String(day).padStart(4, '0')}.webp`;
    const rd = await put(dayPath);
    if (rd.ok) {
      const st = loadState();
      if (!st.days.includes(day)) { st.days.push(day); st.days.sort((a, b) => a - b); saveState(st); }
      // public manifest the dashboard reads to build the real timelapse
      const manifest = JSON.stringify({
        days: st.days,
        prefix: 'frames-by-day/day-',
        updatedAt: new Date().toISOString(),
      });
      const rm = await fetch(`${base}/object/map/frames-manifest.json`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'x-upsert': 'true' },
        body: manifest,
      });
      manifestOk = rm.ok;
      dayNote = `day ${day} framed${rm.ok ? '' : ' (manifest failed HTTP ' + rm.status + ')'}`;
    } else {
      manifestOk = false;
      dayNote = `day frame failed HTTP ${rd.status}`;
    }
  }

  console.log(`[map-snapshot] ${new Date().toISOString()} uploaded (${(webp.length / 1024).toFixed(0)}KB, revealed ${revealedPct}%, ${dayNote})`);
  return { worldDay: day, revealedPct, manifestOk };
}

const loop = process.argv.includes('--loop');
if (loop) {
  // 5-minute cadence: an in-game day is ~30 real minutes, so each day gets
  // several upserts and its frozen frame lands within minutes of rollover.
  // Ops cockpit heartbeat after every attempt (ok on success, error on
  // failure) — best-effort, sendHeartbeat never throws.
  const runAndHeartbeat = async () => {
    try {
      const result = await snapshot();
      await sendHeartbeat({ status: 'ok', metrics: result });
    } catch (e) {
      console.error('[map-snapshot] failed:', e.message);
      await sendHeartbeat({ status: 'error', error: e.message });
    }
  };
  await runAndHeartbeat();
  setInterval(runAndHeartbeat, 5 * 60 * 1000);
} else {
  await snapshot().catch((e) => { console.error('[map-snapshot] failed:', e.message); process.exit(1); });
}
