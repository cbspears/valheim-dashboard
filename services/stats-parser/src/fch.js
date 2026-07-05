// fch.js — parser for Valheim character profiles (`.fch`).
//
// A `.fch` is the full vanilla player profile. The `ServerCharacters` mod keeps
// each player's profile server-side, so pulling and parsing it is the only way
// to get the complete stat suite (kills, builds, distance, …) — none of which
// appears in the server log.
//
// ── File layout ───────────────────────────────────────────────────────────
// The whole file is a Valheim `ZPackage` (a length-prefixed byte blob):
//
//   [int32 dataLen][data … dataLen bytes][int32 hashLen=64][SHA-512 of data]
//
// `data` is itself a ZPackage written by PlayerProfile.SavePlayerData:
//
//   int32   dataVersion                    (43 in the live build; 39 in 2024)
//   PlayerStats stats                      (see below)
//   bool    usedTeleportItems              (present in v43; absent in v39 —
//                                            an example of a field appearing
//                                            mid-history; see readWorlds)
//   int32   worldCount
//     repeated worldCount times:
//       int64    worldUID
//       bool     haveCustomSpawn; Vector3 spawnPoint
//       bool     haveLogoutPoint; Vector3 logoutPoint
//       bool     haveDeathPoint;  Vector3 deathPoint   (>= v30)
//       Vector3  homePoint
//       bool     haveMapData; if set: byte[] mapData   (>= v29; see decodeMap)
//   string  playerName
//   int64   playerID
//   string  startSeed
//   bool    havePlayerData; if set: byte[] playerData  (inventory/skills blob)
//
// PlayerStats (>= v36) is a flat float array indexed by the PlayerStatType
// enum ordinal:
//
//   int32   statCount                      (105 — one per enum member, sans Count)
//   float32 value  × statCount
//
// ── Version fragility ───────────────────────────────────────────────────────
// A Valheim patch can bump `dataVersion` and append PlayerStatType members
// (1.0 / Deep North is the known risk). This parser reads `statCount`
// DYNAMICALLY and maps by ordinal, so extra trailing stats are ignored rather
// than fatal. `STAT_TYPES` was extracted from the live assembly_valheim.dll —
// re-run scripts/extract-stat-enum.mjs after a game update to refresh it.

import { gunzipSync } from 'node:zlib';

// PlayerStatType, in declaration (= ordinal) order, extracted from
// assembly_valheim.dll (build that writes dataVersion 43). The trailing `Count`
// sentinel is the enum terminator and is NOT stored in the file.
export const STAT_TYPES = [
  'Deaths', 'CraftsOrUpgrades', 'Builds', 'Jumps', 'Cheats', 'EnemyHits',
  'EnemyKills', 'EnemyKillsLastHits', 'PlayerHits', 'PlayerKills',
  'HitsTakenEnemies', 'HitsTakenPlayers', 'ItemsPickedUp', 'Crafts', 'Upgrades',
  'PortalsUsed', 'DistanceTraveled', 'DistanceWalk', 'DistanceRun',
  'DistanceSail', 'DistanceAir', 'TimeInBase', 'TimeOutOfBase', 'Sleep',
  'ItemStandUses', 'ArmorStandUses', 'WorldLoads', 'TreeChops', 'Tree',
  'TreeTier0', 'TreeTier1', 'TreeTier2', 'TreeTier3', 'TreeTier4', 'TreeTier5',
  'LogChops', 'Logs', 'MineHits', 'Mines', 'MineTier0', 'MineTier1',
  'MineTier2', 'MineTier3', 'MineTier4', 'MineTier5', 'RavenHits', 'RavenTalk',
  'RavenAppear', 'CreatureTamed', 'FoodEaten', 'SkeletonSummons', 'ArrowsShot',
  'TombstonesOpenedOwn', 'TombstonesOpenedOther', 'TombstonesFit',
  'DeathByUndefined', 'DeathByEnemyHit', 'DeathByPlayerHit', 'DeathByFall',
  'DeathByDrowning', 'DeathByBurning', 'DeathByFreezing', 'DeathByPoisoned',
  'DeathBySmoke', 'DeathByWater', 'DeathByEdgeOfWorld', 'DeathByImpact',
  'DeathByCart', 'DeathByTree', 'DeathBySelf', 'DeathByStructural',
  'DeathByTurret', 'DeathByBoat', 'DeathByStalagtite', 'DoorsOpened',
  'DoorsClosed', 'BeesHarvested', 'SapHarvested', 'TurretAmmoAdded',
  'TurretTrophySet', 'TrapArmed', 'TrapTriggered', 'PlaceStacks',
  'PortalDungeonIn', 'PortalDungeonOut', 'BossKills', 'BossLastHits',
  'SetGuardianPower', 'SetPowerEikthyr', 'SetPowerElder', 'SetPowerBonemass',
  'SetPowerModer', 'SetPowerYagluth', 'SetPowerQueen', 'SetPowerAshlands',
  'SetPowerDeepNorth', 'UseGuardianPower', 'UsePowerEikthyr', 'UsePowerElder',
  'UsePowerBonemass', 'UsePowerModer', 'UsePowerYagluth', 'UsePowerQueen',
  'UsePowerAshlands', 'UsePowerDeepNorth',
];

// ── ZPackage reader ─────────────────────────────────────────────────────────
// Mirrors Valheim's ZPackage / C# BinaryReader: little-endian, strings are a
// 7-bit-encoded length prefix + UTF-8, byte arrays are an int32 length + bytes.
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }
  remaining() {
    return this.buf.length - this.off;
  }
  byte() {
    return this.buf[this.off++];
  }
  bool() {
    return this.buf[this.off++] !== 0;
  }
  int() {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  long() {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  float() {
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }
  // C# BinaryReader.Read7BitEncodedInt — used for string lengths.
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
  string() {
    const n = this.varint();
    const s = this.buf.toString('utf8', this.off, this.off + n);
    this.off += n;
    return s;
  }
  bytes() {
    const n = this.int();
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
  skip(n) {
    this.off += n;
  }
}

// Fraction of the Valheim world a player has uncovered, 0–100.
//
// The minimap fog is a square `size × size` texture, but the actual world is
// the disc inscribed in it (radius = size / 2); the square's corners are
// endless ocean. We therefore count explored pixels INSIDE the disc over the
// total pixels inside the disc — so a fully-explored map reads ~100%, not >100%
// from ocean tiles uncovered out in the corners.
function exploredPercent(mapData) {
  // mapData blob: [int32 mapVersion][int32 gzipLen][gzip stream].
  if (!mapData || mapData.length < 8) return null;
  const gzipLen = mapData.readInt32LE(4);
  let raw;
  try {
    raw = gunzipSync(mapData.subarray(8, 8 + gzipLen));
  } catch {
    return null;
  }
  // Decompressed: [int32 textureSize][byte explored × size²][byte exploredOthers × size²][pins…]
  const size = raw.readInt32LE(0);
  if (size <= 0 || raw.length < 4 + size * size) return null;
  const own = raw.subarray(4, 4 + size * size);
  const r = size / 2;
  const r2 = r * r;
  let explored = 0;
  let discPixels = 0;
  for (let y = 0; y < size; y++) {
    const dy = y - r;
    const rowMax = r2 - dy * dy;
    if (rowMax < 0) continue; // whole row is outside the disc
    const half = Math.sqrt(rowMax);
    const x0 = Math.max(0, Math.ceil(r - half));
    const x1 = Math.min(size - 1, Math.floor(r + half));
    const rowBase = y * size;
    for (let x = x0; x <= x1; x++) {
      discPixels++;
      if (own[rowBase + x] !== 0) explored++;
    }
  }
  if (discPixels === 0) return null;
  return Math.min(100, (explored / discPixels) * 100);
}

/**
 * Parse a `.fch` buffer into a structured profile.
 * @param {Buffer} fileBuf raw file contents
 * @returns {{
 *   version: number,
 *   playerName: string,
 *   playerId: bigint,
 *   statCount: number,
 *   stats: Record<string, number>,   // by PlayerStatType name (known ordinals only)
 *   rawStats: number[],              // every float, by ordinal
 *   worlds: Array<{ uid: bigint, exploredPct: number|null }>,
 *   maxExploredPct: number|null,
 * }}
 */
export function parseProfile(fileBuf) {
  // Outer wrapper: [int32 dataLen][data][int32 hashLen][hash].
  const outer = new Reader(fileBuf);
  const data = outer.bytes();
  const r = new Reader(data);

  const version = r.int();
  if (version < 36) {
    // Pre-v36 profiles predate the stat array entirely.
    return {
      version, playerName: '', playerId: 0n, statCount: 0,
      stats: {}, rawStats: [], worlds: [], maxExploredPct: null,
    };
  }

  // PlayerStats: count + that many floats, mapped by ordinal.
  const statCount = r.int();
  const rawStats = new Array(statCount);
  const stats = {};
  for (let i = 0; i < statCount; i++) {
    const v = r.float();
    rawStats[i] = v;
    const name = STAT_TYPES[i];
    if (name) stats[name] = v;
  }

  // The world block is preceded by a variable number of scalar flags that have
  // come and gone across versions (e.g. a `usedTeleportItems` bool exists in
  // v43 but not v39). Rather than track exact thresholds — which the next game
  // patch can invalidate — we self-synchronize: try parsing the world block at
  // the current offset and at the next few byte offsets, and accept the first
  // alignment that reads back a sane player name. This also tolerates a future
  // patch inserting another flag here.
  const { worlds, playerName, playerId } = readWorlds(r, version);

  const explored = worlds.map((x) => x.exploredPct).filter((x) => x != null);
  const maxExploredPct = explored.length ? Math.max(...explored) : null;

  return { version, playerName, playerId, statCount, stats, rawStats, worlds, maxExploredPct };
}

// Parse the world block + trailing playerName/playerID, self-correcting for a
// small unknown number of leading flag bytes. Returns the candidate whose
// trailing playerName validates, preferring the smallest skip.
function readWorlds(r, version) {
  const start = r.off;
  let best = null;
  for (let skip = 0; skip <= 4; skip++) {
    try {
      r.off = start + skip;
      const candidate = parseWorldBlock(r, version);
      if (isPlausibleName(candidate.playerName)) return candidate;
      best = best || candidate; // remember a parse that at least stayed in bounds
    } catch {
      // out-of-bounds / bad length at this alignment — try the next.
    }
  }
  if (best) return best;
  return { worlds: [], playerName: '', playerId: 0n };
}

function parseWorldBlock(r, version) {
  const worldCount = r.int();
  if (worldCount < 0 || worldCount > 256) throw new Error('implausible worldCount');
  const worlds = [];
  for (let w = 0; w < worldCount; w++) {
    const uid = r.long();
    r.bool(); r.skip(12); // custom spawn + Vector3
    r.bool(); r.skip(12); // logout point
    if (version >= 30) {
      r.bool(); r.skip(12); // death point
    }
    r.skip(12); // home Vector3
    let exploredPct = null;
    if (version >= 29 && r.bool()) {
      exploredPct = exploredPercent(r.bytes());
    }
    if (r.off > r.buf.length) throw new Error('overran world block');
    worlds.push({ uid, exploredPct });
  }
  const playerName = r.string();
  const playerId = r.long();
  return { worlds, playerName, playerId };
}

// A real Valheim character name: non-empty, short, and printable.
function isPlausibleName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    // no control chars (mojibake from a wrong alignment trips this here-ok)
    !/[\x00-\x1f\x7f]/.test(name)
  );
}

/**
 * Reduce a parsed profile to the row we store in `player_stats`.
 *
 * `resources_harvested` is a composite of the deliberate gathering actions
 * (trees felled + ore deposits mined + bees + sap) — Valheim has no single
 * "resources gathered" counter. `map_explored_pct` is the player's best-explored
 * world unless `worldUid` pins a specific one (the live server's world) — in
 * which case it is that world's coverage, or `null` if the profile never
 * visited it.
 *
 * @param {ReturnType<typeof parseProfile>} profile
 * @param {bigint} [worldUid] restrict exploration % to this world if present
 */
export function toPlayerStats(profile, worldUid) {
  const s = profile.stats;
  const get = (k) => Math.round(s[k] ?? 0);

  // When a world is pinned (the live server), report ONLY that world's
  // coverage. If this profile has never touched that world, coverage is `null`
  // — NOT the player's best other world, which would leak singleplayer /
  // off-server exploration onto the server's Cartographer board.
  let mapExploredPct;
  if (worldUid != null) {
    const match = profile.worlds.find((w) => w.uid === worldUid);
    mapExploredPct = match ? match.exploredPct : null;
  } else {
    mapExploredPct = profile.maxExploredPct;
  }

  return {
    character_name: profile.playerName,
    kills: get('EnemyKills'),
    deaths: get('Deaths'),
    resources_harvested:
      get('Tree') + get('Mines') + get('BeesHarvested') + get('SapHarvested'),
    items_crafted: get('Crafts'),
    distance_traveled: Math.round(profile.stats.DistanceTraveled ?? 0),
    structures_built: get('Builds'),
    map_explored_pct: mapExploredPct == null ? null : Math.round(mapExploredPct * 10) / 10,
  };
}

export { Reader };
