// Generates the DEMO assets for the /map page: a procedural Valheim-style
// world + a simulated 100-day exploration history, rendered as pre-masked
// frames (public/map-demo/day-NNN.webp) + config/map-demo.generated.ts.
//
// The masking model mirrors production: unexplored terrain is composited to
// an opaque fog texture BEFORE anything is published, so the full map never
// reaches the browser. At launch the real pipeline (WebMap map.png/fog.png
// over SFTP) replaces this generator; the page/component stay the same.
//
// Run: node scripts/generate-map-demo.mjs   (needs node 20 / sharp)

import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'map-demo');
const SIZE = 1024;
const WORLD_R = 486; // world disc radius in px
const DAYS = 100;
const REVEAL_R = 13; // exploration reveal radius per step, px

// ── seeded RNG ──────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xe111f);

// ── value noise (fBm) ───────────────────────────────────────────────────────
function makeNoise(seed, gridSize) {
  const g = new Float32Array(gridSize * gridSize);
  const r = mulberry32(seed);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const gx = ((x % gridSize) + gridSize) % gridSize;
    const gy = ((y % gridSize) + gridSize) % gridSize;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = (x0 + 1) % gridSize, y1 = (y0 + 1) % gridSize;
    const fx = smooth(gx - x0), fy = smooth(gy - y0);
    const v00 = g[y0 * gridSize + x0], v10 = g[y0 * gridSize + x1];
    const v01 = g[y1 * gridSize + x0], v11 = g[y1 * gridSize + x1];
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };
}
function fbm(noise, x, y, octaves, freq) {
  let v = 0, amp = 0.5, f = freq;
  for (let o = 0; o < octaves; o++) {
    v += amp * noise(x * f, y * f);
    amp *= 0.5; f *= 2;
  }
  return v; // ~[0, 1)
}

const landNoise = makeNoise(101, 64);
const bumpNoise = makeNoise(202, 64);
const elevNoise = makeNoise(303, 64);
const fogNoise = makeNoise(404, 64);

// ── build the base world (never published unmasked) ─────────────────────────
const C = SIZE / 2;
const base = new Uint8Array(SIZE * SIZE * 3);
const isLand = new Uint8Array(SIZE * SIZE);

function biomeColor(px, py, r01, land, elev, bump) {
  // r01: 0 center → 1 world edge. Sector: north = deep north, south = ashlands.
  const angle = Math.atan2(py - C, px - C); // -PI..PI, -y is north (screen up)
  const northness = -Math.sin(angle + Math.PI / 2 - Math.PI / 2); // ≈ -(dy/r)
  const dy = (py - C) / Math.max(1, Math.hypot(px - C, py - C));
  if (!land) {
    // ocean, lighter near shore-ish noise
    const deep = 0.55 + 0.45 * r01;
    return [Math.round(22 + 14 * (1 - deep) + 6 * bump), Math.round(40 + 22 * (1 - deep) + 6 * bump), Math.round(61 + 26 * (1 - deep) + 8 * bump)];
  }
  const j = (bump - 0.5) * 0.16; // biome-band jitter
  const rr = r01 + j;
  let c;
  if (dy < -0.45 && r01 > 0.62) c = [223, 231, 238];               // deep north snow
  else if (dy > 0.5 && r01 > 0.66) c = [122, 52, 40];              // ashlands
  else if (elev > 0.66 && rr > 0.3) c = [185, 195, 205];           // mountains
  else if (rr < 0.22) c = [74, 122, 58];                            // meadows
  else if (rr < 0.38) c = [44, 74, 46];                             // black forest
  else if (rr < 0.52) c = bump > 0.5 ? [77, 68, 51] : [44, 74, 46]; // swamp / forest mix
  else if (rr < 0.68) c = [168, 154, 78];                           // plains
  else c = [93, 90, 102];                                           // mistlands
  const b = 1 + (bump - 0.5) * 0.22; // texture
  return [Math.min(255, c[0] * b), Math.min(255, c[1] * b), Math.min(255, c[2] * b)];
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    const dx = x - C, dy = y - C;
    const r = Math.hypot(dx, dy);
    const r01 = r / WORLD_R;
    const bump = fbm(bumpNoise, x / SIZE, y / SIZE, 5, 24);
    if (r01 > 1) {
      // beyond the edge of the world
      base[i * 3] = 14; base[i * 3 + 1] = 22; base[i * 3 + 2] = 33;
      continue;
    }
    const n = fbm(landNoise, x / SIZE, y / SIZE, 5, 5.2);
    // more ocean toward the rim; a solid starting continent near center
    const landThreshold = 0.36 + 0.34 * r01 * r01 - 0.18 * Math.max(0, 0.25 - r01);
    const land = n > landThreshold ? 1 : 0;
    isLand[i] = land;
    const elev = fbm(elevNoise, x / SIZE, y / SIZE, 4, 7);
    const [cr, cg, cb] = biomeColor(x, y, r01, land, elev, bump);
    base[i * 3] = cr; base[i * 3 + 1] = cg; base[i * 3 + 2] = cb;
  }
}

// fog texture (what unexplored area looks like) — matches the site's pitch bg
const fogTex = new Uint8Array(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    const n = fbm(fogNoise, x / SIZE, y / SIZE, 4, 6);
    const v = 10 + n * 9; // very dark blue-slate mottling
    fogTex[i * 3] = Math.round(v);
    fogTex[i * 3 + 1] = Math.round(v + 4);
    fogTex[i * 3 + 2] = Math.round(v + 10);
  }
}

// ── exploration simulation ──────────────────────────────────────────────────
const mask = new Uint8Array(SIZE * SIZE); // cumulative revealed
function stamp(cx, cy, rad) {
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(SIZE - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(SIZE - 1, Math.ceil(cy + rad));
  const r2 = rad * rad;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * SIZE + x] = 255;
    }
  }
}

const BOSS_DAYS = [12, 27, 45, 64, 83];
const parties = [
  { x: C, y: C, heading: rng() * Math.PI * 2 },
  { x: C, y: C, heading: rng() * Math.PI * 2 },
];
const labelDefs = [
  { name: 'Midgard', day: 1 },
  { name: 'Juno Beach II', day: 9 },
  { name: "Eikthyr's Ring", day: 12 },
  { name: 'Draugheim', day: 31 },
  { name: 'The Dark Chapel', day: 50 },
  { name: "Benson's Folly", day: 68 },
  { name: "Skald's Rest", day: 86 },
];
const labels = [{ name: 'Midgard', day: 1, x: C / SIZE, y: C / SIZE }];

function landAt(x, y) {
  return isLand[Math.round(y) * SIZE + Math.round(x)] === 1;
}

// Exploration expands with the season: parties can't roam past a frontier
// radius that grows day by day (mirrors biome progression), and they strongly
// prefer land — sailing legs happen, but they seek a coast instead of open sea.
function stepParty(p, steps, dayMaxR) {
  for (let s = 0; s < steps; s++) {
    const onWater = !landAt(p.x, p.y);
    const len = (onWater ? 6.5 : 4) + rng() * 2.5;
    let nx = 0, ny = 0, ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const wobble = (rng() - 0.5) * (attempt === 0 ? 0.8 : 2.4);
      const h = p.heading + wobble;
      nx = p.x + Math.cos(h) * len;
      ny = p.y + Math.sin(h) * len;
      const nr = Math.hypot(nx - C, ny - C);
      if (nr > dayMaxR) continue; // past this season's frontier
      const targetLand = landAt(nx, ny);
      if (onWater) {
        // sailing: any heading is fine, but hitting a coast always wins
        ok = targetLand || attempt >= 2;
      } else {
        // on land: stay ashore unless a rare sailing trip begins
        ok = targetLand || rng() < 0.12;
      }
      if (ok) p.heading = h;
    }
    if (!ok) {
      p.heading = Math.atan2(C - p.y, C - p.x) + (rng() - 0.5); // head home
      continue;
    }
    p.x = Math.min(SIZE - 2, Math.max(1, nx));
    p.y = Math.min(SIZE - 2, Math.max(1, ny));
    stamp(p.x, p.y, REVEAL_R);
  }
}

// per-day frame rendering with a soft (feathered) mask edge
const soft = new Uint8Array(SIZE * SIZE);
const tmp = new Uint16Array(SIZE * SIZE);
function featherMask() {
  const R = 2, W = 2 * R + 1;
  // horizontal box blur
  for (let y = 0; y < SIZE; y++) {
    let acc = 0;
    for (let x = -R; x <= R; x++) acc += mask[y * SIZE + Math.min(SIZE - 1, Math.max(0, x))];
    for (let x = 0; x < SIZE; x++) {
      tmp[y * SIZE + x] = acc;
      const xa = Math.max(0, x - R), xb = Math.min(SIZE - 1, x + R + 1);
      acc += mask[y * SIZE + xb] - mask[y * SIZE + xa];
    }
  }
  // vertical box blur
  for (let x = 0; x < SIZE; x++) {
    let acc = 0;
    for (let y = -R; y <= R; y++) acc += tmp[Math.min(SIZE - 1, Math.max(0, y)) * SIZE + x];
    for (let y = 0; y < SIZE; y++) {
      soft[y * SIZE + x] = Math.round(acc / (W * W));
      const ya = Math.max(0, y - R), yb = Math.min(SIZE - 1, y + R + 1);
      acc += tmp[yb * SIZE + x] - tmp[ya * SIZE + x];
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const frame = new Uint8Array(SIZE * SIZE * 3);
let revealedPx = 0;

async function renderFrame(day) {
  featherMask();
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = soft[i] / 255;
    const j = i * 3;
    frame[j] = base[j] * a + fogTex[j] * (1 - a);
    frame[j + 1] = base[j + 1] * a + fogTex[j + 1] * (1 - a);
    frame[j + 2] = base[j + 2] * a + fogTex[j + 2] * (1 - a);
  }
  const name = `day-${String(day).padStart(3, '0')}.webp`;
  await sharp(Buffer.from(frame), { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .webp({ quality: 66 })
    .toFile(join(OUT_DIR, name));
}

// private full-map preview for local inspection only (never into public/)
if (process.env.MAP_DEMO_PREVIEW) {
  await sharp(Buffer.from(base), { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png()
    .toFile(process.env.MAP_DEMO_PREVIEW);
}

console.time('generate');
stamp(C, C, REVEAL_R * 2.2); // launch night around spawn
for (let day = 1; day <= DAYS; day++) {
  const isBossDay = BOSS_DAYS.includes(day);
  // the frontier creeps outward over the season
  const dayMaxR = WORLD_R * (0.14 + 0.82 * Math.pow(day / DAYS, 0.75));
  for (const p of parties) stepParty(p, 18 + Math.floor(rng() * 18) + (isBossDay ? 16 : 0), dayMaxR);
  // homebody puttering near spawn
  stamp(C + (rng() - 0.5) * 60, C + (rng() - 0.5) * 60, REVEAL_R * 0.8);
  if (isBossDay && parties.length < 6) {
    const src = parties[Math.floor(rng() * parties.length)];
    parties.push({ x: src.x, y: src.y, heading: rng() * Math.PI * 2 });
  }
  // drop the next label at the lead party's position on its appointed day
  const def = labelDefs.find((d) => d.day === day && d.name !== 'Midgard');
  if (def) {
    const p = parties[parties.length - 1];
    labels.push({ name: def.name, day, x: p.x / SIZE, y: p.y / SIZE });
  }
  await renderFrame(day);
}
revealedPx = mask.reduce((n, v) => n + (v ? 1 : 0), 0);
console.timeEnd('generate');

const worldPx = Math.PI * WORLD_R * WORLD_R;
const meta = {
  days: DAYS,
  revealedPct: Math.round((revealedPx / worldPx) * 100),
  labels,
};
writeFileSync(
  join(ROOT, 'config', 'map-demo.generated.ts'),
  `// AUTO-GENERATED by scripts/generate-map-demo.mjs — do not edit by hand.
// Demo data for the /map timelapse; replaced by the real WebMap pipeline at launch.

export interface MapLabel {
  name: string;
  /** in-game day the place was named */
  day: number;
  /** position as a fraction of the map image (0–1) */
  x: number;
  y: number;
}

export const MAP_DEMO_DAYS = ${DAYS};
export const MAP_DEMO_REVEALED_PCT = ${meta.revealedPct};
export const MAP_DEMO_LABELS: MapLabel[] = ${JSON.stringify(
    labels.map((l) => ({ ...l, x: Number(l.x.toFixed(4)), y: Number(l.y.toFixed(4)) })),
    null,
    2,
  )};
`,
);
console.log(`done: ${DAYS} frames, ${meta.revealedPct}% of the world revealed, ${labels.length} labels`);
