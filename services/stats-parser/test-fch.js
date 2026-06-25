// Tests for the .fch parser. Two layers:
//   1. A self-contained synthetic round-trip: build a profile with known values
//      (incl. a tiny gzipped map) and assert the parser reads them back. Always
//      runs — no game files required.
//   2. An optional smoke test over real profiles: set STATS_TEST_DIR to a folder
//      of .fch files and it asserts every one parses to plausible output.
//
// Run: npm test   (or: STATS_TEST_DIR=/path/to/characters npm test)

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfile, toPlayerStats, STAT_TYPES } from './src/fch.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// ── ZPackage writer (mirrors the C# format the game writes) ─────────────────
class Writer {
  constructor() {
    this.parts = [];
  }
  int(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
    return this;
  }
  long(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    this.parts.push(b);
    return this;
  }
  float(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    this.parts.push(b);
    return this;
  }
  bool(v) {
    this.parts.push(Buffer.from([v ? 1 : 0]));
    return this;
  }
  varint(n) {
    const out = [];
    let v = n >>> 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    this.parts.push(Buffer.from(out));
    return this;
  }
  string(s) {
    const b = Buffer.from(s, 'utf8');
    return this.varint(b.length).raw(b);
  }
  bytes(b) {
    return this.int(b.length).raw(b);
  }
  raw(b) {
    this.parts.push(Buffer.from(b));
    return this;
  }
  vec3(x = 0, y = 0, z = 0) {
    return this.float(x).float(y).float(z);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

// Build a tiny map blob with `exploredInDisc` explored pixels inside the disc.
function buildMapBlob(size, explored) {
  const inner = new Writer().int(size);
  const own = Buffer.alloc(size * size, 0);
  for (let i = 0; i < explored; i++) own[i] = 1; // top-left corner = outside disc
  // mark center pixels (definitely inside the disc) explored
  const c = Math.floor(size / 2) * size + Math.floor(size / 2);
  own[c] = 1;
  inner.raw(own);
  inner.raw(Buffer.alloc(size * size, 0)); // exploredOthers
  const gz = gzipSync(inner.done());
  return new Writer().int(8).int(gz.length).raw(gz).done();
}

// Assemble a full .fch buffer.
function buildFch({ version = 43, stats = [], teleportBool = true, worlds = [], name = 'Tester', id = 123n }) {
  const w = new Writer().int(version);
  w.int(stats.length);
  for (const s of stats) w.float(s);
  if (teleportBool) w.bool(false);
  w.int(worlds.length);
  for (const world of worlds) {
    w.long(world.uid);
    w.bool(false).vec3(); // custom spawn
    w.bool(false).vec3(); // logout
    w.bool(false).vec3(); // death (v>=30)
    w.vec3(); // home
    if (world.map) w.bool(true).bytes(world.map);
    else w.bool(false);
  }
  w.string(name).long(id).string(''); // name, id, seed
  w.bool(false); // no playerData
  const inner = w.done();
  // Outer wrapper: [int len][inner][int hashLen][hash] — hash ignored by parser.
  return new Writer().bytes(inner).bytes(Buffer.alloc(64, 0)).done();
}

// ── 1. Synthetic round-trip ─────────────────────────────────────────────────
console.log('synthetic round-trip:');

// Known stat values keyed by ordinal name.
const known = {
  Deaths: 7, Builds: 4242, EnemyKills: 99, Crafts: 314,
  DistanceTraveled: 123456, Tree: 100, Mines: 50, BeesHarvested: 10, SapHarvested: 5,
};
const statArr = STAT_TYPES.map((name) => known[name] ?? 0);

test('stat ordinals map to the right names', () => {
  const p = parseProfile(buildFch({ stats: statArr }));
  assert.equal(p.statCount, STAT_TYPES.length);
  assert.equal(p.stats.EnemyKills, 99);
  assert.equal(p.stats.Builds, 4242);
  assert.equal(p.stats.Deaths, 7);
});

test('toPlayerStats maps columns correctly', () => {
  const p = parseProfile(buildFch({ stats: statArr }));
  const m = toPlayerStats(p);
  assert.equal(m.kills, 99);
  assert.equal(m.deaths, 7);
  assert.equal(m.structures_built, 4242);
  assert.equal(m.items_crafted, 314);
  assert.equal(m.distance_traveled, 123456);
  assert.equal(m.resources_harvested, 100 + 50 + 10 + 5);
  assert.equal(m.character_name, 'Tester');
});

test('parses a profile WITHOUT the leading teleport bool (older layout)', () => {
  const p = parseProfile(buildFch({ stats: statArr, teleportBool: false, name: 'OldViking' }));
  assert.equal(p.playerName, 'OldViking');
  assert.equal(p.stats.EnemyKills, 99);
});

test('map exploration decodes and is a sane percentage', () => {
  const map = buildMapBlob(64, 200);
  const p = parseProfile(buildFch({ stats: statArr, worlds: [{ uid: 555n, map }] }));
  assert.equal(p.worlds.length, 1);
  const pct = p.worlds[0].exploredPct;
  assert.ok(pct != null && pct > 0 && pct <= 100, `pct=${pct}`);
});

test('worldUid pins exploration to the matching world', () => {
  const map = buildMapBlob(64, 500);
  const worlds = [{ uid: 111n, map: buildMapBlob(64, 5) }, { uid: 222n, map }];
  const p = parseProfile(buildFch({ stats: statArr, worlds }));
  const pinned = toPlayerStats(p, 222n).map_explored_pct;
  const other = toPlayerStats(p, 111n).map_explored_pct;
  assert.ok(pinned > other, `pinned=${pinned} other=${other}`);
});

test('empty/legacy profile (no stats) is handled gracefully', () => {
  const p = parseProfile(buildFch({ version: 37, stats: [], teleportBool: false, name: 'Ghost' }));
  const m = toPlayerStats(p);
  assert.equal(m.kills, 0);
  assert.equal(m.map_explored_pct, null);
});

// ── 2. Optional real-file smoke test ────────────────────────────────────────
const realDir = process.env.STATS_TEST_DIR;
if (realDir && existsSync(realDir)) {
  console.log(`\nreal profiles in ${realDir}:`);
  const files = readdirSync(realDir).filter((f) => f.toLowerCase().endsWith('.fch'));
  for (const f of files) {
    test(f, () => {
      const p = parseProfile(readFileSync(join(realDir, f)));
      const m = toPlayerStats(p);
      // Every numeric column is a finite, non-negative number.
      for (const k of ['kills', 'deaths', 'resources_harvested', 'items_crafted', 'distance_traveled', 'structures_built']) {
        assert.ok(Number.isFinite(m[k]) && m[k] >= 0, `${k}=${m[k]}`);
      }
      assert.ok(m.map_explored_pct == null || (m.map_explored_pct >= 0 && m.map_explored_pct <= 100));
    });
  }
} else {
  console.log('\n(set STATS_TEST_DIR to also smoke-test real .fch files)');
}

console.log(`\n${passed} test(s) passed`);
