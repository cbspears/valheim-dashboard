// extract-stat-enum.mjs — recover the PlayerStatType enum (ordinal -> name, in
// declaration order) directly from the live game assembly by parsing ECMA-335
// CLI metadata. Run this after a Valheim update to refresh STAT_TYPES in
// src/fch.js, so the stat mapping always matches the build the server writes.
//
// Usage:
//   node scripts/extract-stat-enum.mjs [path/to/assembly_valheim.dll]
//
// Default path is the Linux Steam (snap) install. It prints a ready-to-paste
// JS array plus the member count (the file stores count-1 floats — the trailing
// `Count` sentinel is not serialized).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DLL = join(
  homedir(),
  'snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll'
);

const path = process.argv[2] || DEFAULT_DLL;
const data = readFileSync(path);

// ── PE: sections + CLI header (data directory #14) ──────────────────────────
const peOff = data.readUInt32LE(0x3c);
if (data.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('not a PE file');
const coff = peOff + 4;
const numSections = data.readUInt16LE(coff + 2);
const optSize = data.readUInt16LE(coff + 16);
const optOff = coff + 20;
const pe32plus = data.readUInt16LE(optOff) === 0x20b;
const ddOff = optOff + (pe32plus ? 112 : 96);
const cliRva = data.readUInt32LE(ddOff + 14 * 8);
const secOff = optOff + optSize;
const sections = [];
for (let i = 0; i < numSections; i++) {
  const b = secOff + i * 40;
  sections.push({
    vsize: data.readUInt32LE(b + 8),
    vaddr: data.readUInt32LE(b + 12),
    rawptr: data.readUInt32LE(b + 20),
    rawsize: data.readUInt32LE(b + 16),
  });
}
const rva2off = (rva) => {
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawsize)) return s.rawptr + (rva - s.vaddr);
  }
  throw new Error('bad rva ' + rva.toString(16));
};

const cliOff = rva2off(cliRva);
const metaRva = data.readUInt32LE(cliOff + 8);
const metaOff = rva2off(metaRva);

// ── Metadata root + stream headers ──────────────────────────────────────────
if (data.toString('ascii', metaOff, metaOff + 4) !== 'BSJB') throw new Error('bad metadata signature');
const verLen = data.readUInt32LE(metaOff + 12);
let p = metaOff + 16 + verLen + 2; // skip version string + flags
const nStreams = data.readUInt16LE(p);
p += 2;
const streams = {};
for (let i = 0; i < nStreams; i++) {
  const soff = data.readUInt32LE(p);
  const ssize = data.readUInt32LE(p + 4);
  p += 8;
  let name = '';
  while (data[p] !== 0) name += String.fromCharCode(data[p++]);
  p++;
  p = (p + 3) & ~3; // 4-byte align
  streams[name] = { off: metaOff + soff, size: ssize };
}
const tildeOff = streams['#~'].off;
const stringsOff = streams['#Strings'].off;
const cstr = (idx) => {
  let e = stringsOff + idx;
  while (data[e] !== 0) e++;
  return data.toString('utf8', stringsOff + idx, e);
};

// ── #~ table stream ─────────────────────────────────────────────────────────
const heapSizes = data[tildeOff + 6];
const validLo = data.readUInt32LE(tildeOff + 8);
const validHi = data.readUInt32LE(tildeOff + 12);
const present = [];
for (let i = 0; i < 64; i++) {
  const bit = i < 32 ? validLo & (1 << i) : validHi & (1 << (i - 32));
  if (bit) present.push(i);
}
const rows = {};
let rcOff = tildeOff + 24;
for (const tid of present) {
  rows[tid] = data.readUInt32LE(rcOff);
  rcOff += 4;
}
const tablesOff = rcOff;

const strIdx = heapSizes & 0x01 ? 4 : 2;
const guidIdx = heapSizes & 0x02 ? 4 : 2;
const blobIdx = heapSizes & 0x04 ? 4 : 2;
const simpleIdx = (tid) => ((rows[tid] || 0) >= 1 << 16 ? 4 : 2);

const CODED = {
  TypeDefOrRef: [[2, 1, 0x1b], 2],
  HasConstant: [[4, 8, 0x17], 2],
  ResolutionScope: [[0, 0x1a, 0x23, 1], 2],
  MemberRefParent: [[2, 1, 0x1a, 6, 0x1b], 3],
};
const codedIdx = (name) => {
  const [tids, bits] = CODED[name];
  const maxRows = Math.max(0, ...tids.map((t) => rows[t] || 0));
  return maxRows >= 1 << (16 - bits) ? 4 : 2;
};

// Column byte-widths for tables 0x00..0x0B (enough to reach Field=0x04).
const schema = (tid) => {
  switch (tid) {
    case 0x00: return [2, strIdx, guidIdx, guidIdx, guidIdx];
    case 0x01: return [codedIdx('ResolutionScope'), strIdx, strIdx];
    case 0x02: return [4, strIdx, strIdx, codedIdx('TypeDefOrRef'), simpleIdx(0x04), simpleIdx(0x06)];
    case 0x03: return [simpleIdx(0x04)];
    case 0x04: return [2, strIdx, blobIdx];
    case 0x05: return [simpleIdx(0x06)];
    case 0x06: return [4, 2, 2, strIdx, blobIdx, simpleIdx(0x08)];
    case 0x07: return [simpleIdx(0x08)];
    case 0x08: return [2, 2, strIdx];
    case 0x09: return [simpleIdx(0x02), codedIdx('TypeDefOrRef')];
    case 0x0a: return [codedIdx('MemberRefParent'), strIdx, blobIdx];
    case 0x0b: return [2, codedIdx('HasConstant'), blobIdx];
    default: throw new Error('no schema for table 0x' + tid.toString(16));
  }
};
const rowSize = (tid) => schema(tid).reduce((a, b) => a + b, 0);

const offsets = {};
let cur = tablesOff;
for (const tid of present) {
  if (tid > 0x0b) break;
  offsets[tid] = cur;
  cur += rows[tid] * rowSize(tid);
}
const readRow = (tid, row) => {
  const cols = schema(tid);
  let o = offsets[tid] + (row - 1) * rowSize(tid);
  return cols.map((c) => {
    const v = c === 2 ? data.readUInt16LE(o) : data.readUInt32LE(o);
    o += c;
    return v;
  });
};

// ── Find PlayerStatType, read its field range ───────────────────────────────
const nTypeDef = rows[0x02];
let start = null;
let end = null;
for (let r = 1; r <= nTypeDef; r++) {
  const [, nameI, , , fieldList] = readRow(0x02, r);
  if (cstr(nameI) === 'PlayerStatType') {
    start = fieldList;
    end = r < nTypeDef ? readRow(0x02, r + 1)[4] : rows[0x04] + 1;
    break;
  }
}
if (start == null) throw new Error('PlayerStatType not found in ' + path);

const names = [];
for (let f = start; f < end; f++) names.push(cstr(readRow(0x04, f)[1]));
if (names[0] !== 'value__') throw new Error('unexpected first field ' + names[0]);
const members = names.slice(1).filter((n) => n !== 'Count');

console.log(`// ${members.length} stored stat ordinals (PlayerStatType, minus Count) from`);
console.log(`// ${path}`);
console.log('export const STAT_TYPES = [');
for (let i = 0; i < members.length; i += 6) {
  console.log('  ' + members.slice(i, i + 6).map((m) => `'${m}'`).join(', ') + ',');
}
console.log('];');
