// Mint the Eilif r2modman pack: render the pinned config templates, prove every
// pinned version is really installable, zip, upload to Thunderstore, then pull
// the minted profile back down and byte-compare it against what went up.
//
//   Node 20:  export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//
//   Preview:  node scripts/mint-pack.mjs --world Eilif --companion-client 0.3.1 \
//               --paths 1.5.0 --dry-run
//   Test:     node scripts/mint-pack.mjs --world Eilif --companion-client 0.3.1 --paths 1.5.0
//   Real:     node scripts/mint-pack.mjs --world Eilif --companion-client 0.3.1 \
//               --paths 1.5.0 --publish --version-label 'Pack v12 · Sep 9'
//
// See docs/PACK.md for the full launch-day cutover. Short version of why this
// script exists rather than a by-hand r2modman export:
//
//   * The Thunderstore package API knows about an upload the moment it lands,
//     but the package-listing-index the mod managers actually read is a set of
//     pre-baked gzipped chunks that lag uploads by 40-80 minutes. A pack code
//     minted in that window looks fine to us and fails for every player with
//     "mod not found". So a version has to pass BOTH checks before it is minted
//     (see verifyVersions) - that is the single most important thing in here.
//   * AzuCraftyBoxes must move in lockstep with the server's copy, and the
//     Mac config bundle on /get-started must match the pack exactly. Both come
//     off the same rendered templates now (scripts/build-config-bundle.mjs
//     imports this file), so they cannot drift apart.
//
// This script never edits config/server.ts and never deploys. It prints the
// exact lines to change; publishing the code is Charlie's call.
//
// No dependencies: the zip writer/reader below is ~100 lines of zlib, which is
// cheaper than adding a package to a repo that has none for this.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const TEMPLATE_DIR = path.join(__dirname, 'pack-templates');

// ── the pack ────────────────────────────────────────────────────────────────
// v11 (2026-08-27) is the baseline: the templates in scripts/pack-templates are
// v11's own files, so rendering with these defaults reproduces v11 byte for
// byte.
//
// `baseline`         the version pack v11 pinned. Override per mod with `flag`.
// `cfgVersionVar`    the "## Settings file was created by plugin X vN" header
//                    inside that mod's .cfg.
// `cfgVersionDefault` which build actually WROTE the template body we ship.
//                    That header is a BepInEx writer stamp, not a pin, so it
//                    never follows `--<mod> <ver>`: bumping a pin without
//                    re-capturing the cfg would otherwise stamp a version that
//                    did not write the file. Move it only with
//                    `cfgVersionFlag`, and only when the template is re-captured
//                    from a real r2modman run of that build.
//
// NOTE: scripts/launch-preflight.mjs keeps its own PACK_V12_PINS list and walks
// the same Thunderstore endpoints. It is the twin of this table - if you change
// a `baseline` here, change that list in the same commit (or better, have it
// import MODS from this file), or preflight will green-light a pin the minter
// refuses.
export const MODS = [
  {
    key: 'bepinex', flag: '--bepinex', label: 'BepInExPack',
    ns: 'denikson', name: 'BepInExPack_Valheim', tmpl: 'BEPINEX', baseline: '5.4.2333',
  },
  {
    key: 'vplus', flag: '--vplus', label: 'ValheimPlus (Grantapher)',
    ns: 'Grantapher', name: 'ValheimPlus_Grantapher_Temporary', tmpl: 'VPLUS', baseline: '9.17.1',
    // The only droppable mod. Grantapher 9.17.1 targets 0.221.10 and has no 1.0
    // build, so pack v12 has to be able to ship without it (see --no-vplus).
    // `cfg` is the file that leaves the pack with it; `section` is the
    // {{#NAME}}..{{/NAME}} block in export.r2x.tmpl that holds its entry.
    omitFlag: '--no-vplus', cfg: 'valheim_plus.cfg', section: 'VPLUS',
  },
  {
    key: 'plant', flag: '--plant', label: 'PlantEverything',
    ns: 'Advize', name: 'PlantEverything', tmpl: 'PLANT', baseline: '1.20.0',
    cfgVersionVar: 'PLANT_CFG_VERSION',
    cfgVersionDefault: '1.20.0', cfgVersionFlag: '--plant-cfg-version',
  },
  {
    key: 'gs', flag: '--gs', label: 'GsValheimStatsClient',
    ns: 'Proudlock_Technology', name: 'GsValheimStatsClient', tmpl: 'GS', baseline: '0.2.12',
    cfgVersionVar: 'GS_CFG_VERSION',
    cfgVersionDefault: '0.2.12', cfgVersionFlag: '--gs-cfg-version',
  },
  {
    key: 'paths', flag: '--paths', label: 'EilifPaths',
    ns: 'Eilif', name: 'EilifPaths', tmpl: 'PATHS', baseline: '1.4.0',
    cfgVersionVar: 'PATHS_CFG_VERSION',
    cfgVersionDefault: '1.4.0', cfgVersionFlag: '--paths-cfg-version',
    // [VPlusFallback] is EilifPaths 1.5.0 code. Writing that section into the cfg
    // while the pack pins an older build ships a switch with nothing behind it:
    // BepInEx files the key as an orphan, every restored comfort is silently
    // absent, and NOTHING errors - not the mint, not the round trip, not the
    // r2modman import, not the boot. So the render refuses that pairing outright
    // (see renderPack), and a pack that does carry the section stamps its writer
    // header 1.5.0 without being asked.
    fallbackMinVersion: '1.5.0',
  },
  {
    key: 'companionClient', flag: '--companion-client', label: 'EilifCompanionClient',
    ns: 'Eilif', name: 'EilifCompanionClient', tmpl: 'COMPANION', baseline: '0.2.0',
    cfgVersionVar: 'COMPANION_CFG_VERSION',
    // The clearest example of why cfg headers do not follow pins: the shipped
    // net.eilif.companionclient.cfg was written by the 0.1.0 build and its
    // settings schema (Url / Token / IntervalSeconds) has not changed since, so
    // its header reads v0.1.0 while the pack pins 0.2.0.
    cfgVersionDefault: '0.1.0',
    cfgVersionFlag: '--companion-cfg-version',
  },
  {
    key: 'azu', flag: '--azu', label: 'AzuCraftyBoxes',
    ns: 'Azumatt', name: 'AzuCraftyBoxes', tmpl: 'AZU', baseline: '1.8.15',
    cfgVersionVar: 'AZU_CFG_VERSION',
    cfgVersionDefault: '1.8.15', cfgVersionFlag: '--azu-cfg-version',
  },
];

export const DEFAULT_PROFILE_NAME = 'Eilif';
// Both client plugins POST here. Change only if the dashboard's public hostname
// changes; the pack ships no token (the ingest token is server-only by design -
// anything put here is public the moment the code is shared).
export const DEFAULT_INGEST_URL = 'https://valheim-dashboard.vercel.app/api/gs-ingest';

const PROFILE_PREFIX = '#r2modman\n';
const TS_CREATE = 'https://thunderstore.io/api/experimental/legacyprofile/create/';
const TS_GET = 'https://thunderstore.io/api/experimental/legacyprofile/get/';
const TS_PACKAGE = 'https://thunderstore.io/api/experimental/package/';
const TS_LISTING_INDEX = 'https://thunderstore.io/c/valheim/api/v1/package-listing-index/';
const USER_AGENT = 'eilif-dashboard-pack-minter/1.0 (+https://valheim-dashboard.vercel.app)';

// Files that go into the profile zip, in the order r2modman itself writes them.
const PACK_FILES = [
  { out: 'export.r2x', tmpl: 'export.r2x.tmpl' },
  { out: 'doorstop_config.ini', tmpl: 'doorstop_config.ini.tmpl' },
];
export const CFG_FILES = [
  'net.eilif.paths.cfg',
  'BepInEx.cfg',
  'advize.PlantEverything.cfg',
  'net.eilif.companionclient.cfg',
  'net.cproudlock.gsvalheimstatsclient.cfg',
  'valheim_plus.cfg',
  'Azumatt.AzuCraftyBoxes.cfg',
];

// EilifPaths' [VPlusFallback] section. 'off' and 'on' both WRITE the section
// (with Enabled = false / true); 'none' leaves it out of the cfg altogether,
// which is what a pre-1.5.0 EilifPaths build wrote.
//
// The default is 'none' because the default pins are pack v11's, and v11 pinned
// EilifPaths 1.4.0. Any other default would make a bare `--world X` render a
// section the pinned build never wrote - which is exactly the pairing renderPack
// now refuses - and would break this file's oldest promise, that rendering with
// the defaults reproduces published pack v11 byte for byte.
export const FALLBACK_MODES = ['on', 'off', 'none'];
export const DEFAULT_FALLBACK = 'none';

/** Mod keys this pack can be minted without, e.g. Set{'vplus'}. */
export const OMITTABLE_MODS = MODS.filter((m) => m.omitFlag);

// ── tiny console helpers (same shape as scripts/launch-wipe.mjs) ────────────
export function banner(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}
const ok = (s) => `  ok   ${s}`;
const bad = (s) => `  FAIL ${s}`;

// ── templates ───────────────────────────────────────────────────────────────
// Templates are read and written as latin1 so every byte survives untouched:
// valheim_plus.cfg carries a UTF-8 BOM and doorstop_config.ini is CRLF, and a
// utf8 round trip would quietly "fix" both.
function readTemplate(rel) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'latin1');
}

/**
 * Resolve the {{#NAME}} ... {{/NAME}} block markers, each of which sits alone on
 * its own line. A kept block loses only its two marker lines; a dropped block
 * takes its whole body with it, so the result is byte-identical to a template
 * written without that block at all.
 *
 * This exists for exactly one reason: pack v12 may have to ship without
 * ValheimPlus (no 1.0 build), and the difference has to be a rendering option
 * rather than a second copy of export.r2x.tmpl that drifts.
 */
export function applySections(text, sections, where) {
  let out = text;
  for (const [name, keep] of Object.entries(sections)) {
    const re = new RegExp(`\\{\\{#${name}\\}\\}\r?\n([\\s\\S]*?)\\{\\{/${name}\\}\\}\r?\n`, 'g');
    let seen = 0;
    out = out.replace(re, (_m, body) => { seen += 1; return keep ? body : ''; });
    // An opener with no closer (or the reverse) would otherwise render as
    // literal "{{#VPLUS}}" inside a shipped cfg, which BepInEx reads as a
    // setting. Catch it here, where it is a template bug, not in the game.
    if (seen === 0 && (out.includes(`{{#${name}}}`) || out.includes(`{{/${name}}}`))) {
      throw new Error(`${where}: unbalanced {{#${name}}} / {{/${name}}} markers`);
    }
  }
  const stray = [...new Set(out.match(/\{\{[#/][A-Za-z0-9_]+\}\}/g) || [])];
  if (stray.length) throw new Error(`${where}: unknown section marker(s): ${stray.join(', ')}`);
  return out;
}

function fill(text, vars, where) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  const leftover = [...new Set(out.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
  if (leftover.length) {
    throw new Error(`${where}: template placeholders never filled: ${leftover.join(', ')}`);
  }
  return Buffer.from(out, 'latin1');
}

export function parseSemver(v, flag) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`${flag}: expected a three-part version like 1.4.0, got "${v}"`);
  return { major: m[1], minor: m[2], patch: m[3] };
}

/** -1 / 0 / 1, comparing each part NUMERICALLY (so 1.20.0 sorts above 1.5.0). */
export function compareSemver(a, b) {
  const pa = parseSemver(a, 'compareSemver');
  const pb = parseSemver(b, 'compareSemver');
  for (const part of ['major', 'minor', 'patch']) {
    const d = Number(pa[part]) - Number(pb[part]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Render every file that goes into the pack.
 * Returns { files: Map<relPath, Buffer>, vars } - `files` keys are zip paths
 * ('export.r2x', 'config/BepInEx.cfg', ...).
 */
export function renderPack({
  world,
  versions = {},
  cfgVersions = {},
  ingestUrl = DEFAULT_INGEST_URL,
  profileName = DEFAULT_PROFILE_NAME,
  omit = [],
  fallback = DEFAULT_FALLBACK,
} = {}) {
  if (!world || !String(world).trim()) throw new Error('renderPack: --world is required');
  if (!FALLBACK_MODES.includes(fallback)) {
    throw new Error(`renderPack: fallback must be one of ${FALLBACK_MODES.join(', ')}, got "${fallback}"`);
  }
  const dropped = new Set(omit);
  for (const key of dropped) {
    const mod = MODS.find((m) => m.key === key);
    if (!mod) throw new Error(`renderPack: unknown mod key "${key}"`);
    if (!mod.omitFlag) throw new Error(`renderPack: ${mod.label} cannot be dropped from the pack`);
  }

  const vars = {
    PROFILE_NAME: profileName,
    WORLD: String(world).trim(),
    INGEST_URL: ingestUrl,
    PATHS_FALLBACK_ENABLED: fallback === 'on' ? 'true' : 'false',
  };
  for (const mod of MODS) {
    const v = versions[mod.key] ?? mod.baseline;
    const { major, minor, patch } = parseSemver(v, mod.flag);
    vars[`${mod.tmpl}_MAJOR`] = major;
    vars[`${mod.tmpl}_MINOR`] = minor;
    vars[`${mod.tmpl}_PATCH`] = patch;

    // A pack that writes the [VPlusFallback] section has to pin a build that has
    // the code behind it. Nothing downstream can catch this: an orphaned BepInEx
    // key is not an error to anyone, so `--fallback on` against a 1.4.0 pin would
    // mint clean, import clean, boot clean, and quietly restore nothing.
    const writesFallback = mod.fallbackMinVersion && fallback !== 'none';
    if (writesFallback && compareSemver(v, mod.fallbackMinVersion) < 0) {
      throw new Error(
        `renderPack: --fallback ${fallback} writes the [VPlusFallback] section into `
        + `the ${mod.label} cfg, but this pack pins ${mod.label} ${v}, which has no such `
        + `section - it arrived in ${mod.fallbackMinVersion}. The switch would be inert and `
        + `nothing would say so. Pass "${mod.flag} ${mod.fallbackMinVersion}" (or newer), `
        + 'or --fallback none.',
      );
    }

    if (mod.cfgVersionVar) {
      // Deliberately NOT `?? v`: the cfg header records the build that wrote the
      // template body, so it must not drift just because the pin moved. The one
      // exception is the section above - a cfg carrying [VPlusFallback] could only
      // have been written by a build that has it, so the stamp follows the section
      // rather than needing --paths-cfg-version passed by hand every time.
      if (!mod.cfgVersionDefault) {
        throw new Error(`renderPack: ${mod.label} has cfgVersionVar but no cfgVersionDefault`);
      }
      const writerDefault = writesFallback ? mod.fallbackMinVersion : mod.cfgVersionDefault;
      const cfgV = cfgVersions[mod.key] ?? writerDefault;
      parseSemver(cfgV, mod.cfgVersionFlag);
      vars[mod.cfgVersionVar] = cfgV;
    }
  }

  // A dropped mod loses BOTH its export.r2x entry and its cfg. Half of either
  // is worse than neither: an r2x entry with no cfg installs a mod nobody
  // configured, and a cfg with no entry is a file r2modman writes into the
  // profile for a mod that is not there.
  const sections = { FALLBACK: fallback !== 'none' };
  for (const mod of OMITTABLE_MODS) sections[mod.section] = !dropped.has(mod.key);
  const droppedCfgs = new Set(
    OMITTABLE_MODS.filter((m) => dropped.has(m.key) && m.cfg).map((m) => m.cfg),
  );

  const render = (text, where) => fill(applySections(text, sections, where), vars, where);

  const files = new Map();
  for (const f of PACK_FILES) files.set(f.out, render(readTemplate(f.tmpl), f.tmpl));
  for (const cfg of CFG_FILES) {
    if (droppedCfgs.has(cfg)) continue;
    files.set(`config/${cfg}`, render(readTemplate(path.join('config', `${cfg}.tmpl`)), cfg));
  }
  return { files, vars, omitted: [...dropped], fallback };
}

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
];

/**
 * The Mac bundle's README, rendered off the same template set and through the
 * same section markers.
 *
 * It takes the bundle's cfg list because the README is the only instructions a
 * Mac player gets: a bundle built without ValheimPlus that still says "drop all
 * seven files" and lists valheim_plus.cfg sends them looking for a file that is
 * not there - or, worse, off to install ValheimPlus, which enforceMod then uses
 * to refuse them the server.
 */
export function renderReadme({ packNumber, packDate, cfgs = CFG_FILES }) {
  // `cfgs` is the bundle's OWN entry list, not a flag to interpret: buildBundle
  // reads it off the rendered pack, so the README counts and names exactly the
  // files sitting next to it in the zip. Passing --no-vplus twice, to two
  // functions, is how the count and the file list drift apart.
  const names = [...cfgs];
  if (!NUMBER_WORDS[names.length]) throw new Error(`renderReadme: no word for ${names.length} cfg files`);
  const sections = {};
  for (const mod of OMITTABLE_MODS) sections[mod.section] = names.includes(mod.cfg);
  const title = `Eilif config bundle - Pack v${packNumber} (${packDate})`;
  return fill(applySections(readTemplate('README.txt.tmpl'), sections, 'README.txt'), {
    BUNDLE_TITLE: title,
    BUNDLE_TITLE_RULE: '='.repeat(title.length),
    CFG_COUNT_WORD: NUMBER_WORDS[names.length],
    PACK_NUMBER: String(packNumber),
    PACK_DATE: packDate,
  }, 'README.txt');
}

// ── zip (write) ─────────────────────────────────────────────────────────────
// Deterministic on purpose: a fixed DOS timestamp means the same inputs always
// produce the same bytes, so two mints of "the same pack" are diffable by hash.
const ZIP_DOS_TIME = 0x0000; // 00:00:00
const ZIP_DOS_DATE = 0x0021; // 1980-01-01

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a zip. `entries` is [{ name, data }] plus implicit directory entries
 * for any 'dir/file' name.
 *
 * Each directory record is emitted immediately before its first child, and every
 * ancestor segment gets one ('a/b/c.txt' emits 'a/' then 'a/b/'), which is the
 * order r2modman's own export writes: export.r2x, doorstop_config.ini, config/,
 * config/*.cfg. Readers resolve through the central directory so order is inert
 * to them, but matching the real thing keeps a byte-diff against a published
 * pack meaningful.
 */
export function zipSync(entries) {
  const records = [];
  const seenDirs = new Set();
  for (const e of entries) {
    const segments = e.name.split('/');
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix += `${segments[i]}/`;
      if (segments[i] === '' || seenDirs.has(prefix)) continue;
      seenDirs.add(prefix);
      records.push({ name: prefix, data: Buffer.alloc(0), isDir: true });
    }
    records.push({ name: e.name, data: e.data, isDir: false });
  }

  const locals = [];
  const central = [];
  let offset = 0;
  for (const r of records) {
    const nameBuf = Buffer.from(r.name, 'utf8');
    const stored = r.isDir ? Buffer.alloc(0) : zlib.deflateRawSync(r.data, { level: 9 });
    const method = r.isDir ? 0 : 8;
    const crc = r.isDir ? 0 : crc32(r.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(ZIP_DOS_TIME, 10);
    lh.writeUInt16LE(ZIP_DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(r.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra len
    locals.push(lh, nameBuf, stored);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(ZIP_DOS_TIME, 12);
    ch.writeUInt16LE(ZIP_DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(r.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(r.isDir ? 0x10 : 0, 38); // external attrs (MS-DOS dir bit)
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + stored.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── zip (read) ──────────────────────────────────────────────────────────────
/** Read a zip into Map<name, Buffer>. Directory entries are skipped. */
export function unzipSync(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('unzipSync: no end-of-central-directory record (not a zip?)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('unzipSync: bad central directory header');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`unzipSync: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unzipSync: unsupported compression method ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`unzipSync: size mismatch for ${name}`);
    out.set(name, data);
  }
  return out;
}

// ── Thunderstore ────────────────────────────────────────────────────────────
// Node's fetch has no default timeout, so without a signal a half-open socket
// hangs the mint forever with no output - which, on a launch night spent
// re-running the dry run every 15 minutes waiting for the index, reads exactly
// like "still working". Every call gets a deadline; the listing chunks get a
// longer one because they are ~730 KB each.
const FETCH_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 60_000;

async function tsFetch(url, { timeoutMs = FETCH_TIMEOUT_MS, ...init } = {}) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
  });
}

function maybeGunzip(buf) {
  // The listing chunks are gzip *bodies* served as application/octet-stream, so
  // fetch does not decompress them. If Thunderstore ever switches to a
  // content-encoding header, fetch will have already unwrapped it - handle both.
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
}

/** Does <ns>/<name>/<version> exist at all? 200 = yes, 404 = no. */
export async function checkPackageApi(mod, version) {
  const url = `${TS_PACKAGE}${mod.ns}/${mod.name}/${version}/`;
  try {
    const res = await tsFetch(url);
    return { ok: res.status === 200, status: res.status, url };
  } catch (err) {
    return { ok: false, status: `network: ${err.message}`, url };
  }
}

/**
 * Has the pre-baked listing index (what r2modman actually reads when it resolves
 * a profile code) caught up with those uploads yet? Returns
 * Map<'ns/name', Set<version>> for the wanted packages only.
 */
export async function loadListingVersions(wanted, { log = () => {} } = {}) {
  const res = await tsFetch(TS_LISTING_INDEX);
  if (!res.ok) throw new Error(`listing index: HTTP ${res.status}`);
  const chunks = JSON.parse(maybeGunzip(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  log(`  listing index: ${chunks.length} chunks`);

  const want = new Map(); // lowercased 'ns/name' -> canonical key
  for (const k of wanted) want.set(k.toLowerCase(), k);
  const found = new Map();

  for (let i = 0; i < chunks.length; i++) {
    const cres = await tsFetch(chunks[i], { timeoutMs: CHUNK_TIMEOUT_MS });
    if (!cres.ok) throw new Error(`listing chunk ${i}: HTTP ${cres.status}`);
    const list = JSON.parse(maybeGunzip(Buffer.from(await cres.arrayBuffer())).toString('utf8'));
    for (const entry of list) {
      const key = want.get(`${entry.owner}/${entry.name}`.toLowerCase());
      if (!key || found.has(key)) continue;
      found.set(key, new Set(entry.versions.map((v) => v.version_number)));
    }
    log(`  chunk ${i + 1}/${chunks.length}: ${found.size}/${want.size} packages located`);
    if (found.size === want.size) break;
  }
  return found;
}

/**
 * Every pinned version must be BOTH published (package API) and visible in the
 * listing index. The second check is the one that matters: the index lags
 * uploads by 40-80 minutes and a code minted inside that window fails to import
 * for players even though the package page looks perfect.
 */
export async function verifyVersions(pins, { log = console.log } = {}) {
  const rows = [];
  for (const { mod, version } of pins) {
    const api = await checkPackageApi(mod, version);
    rows.push({ mod, version, api, listed: null, listedVersions: null });
  }

  let listing;
  try {
    listing = await loadListingVersions(pins.map(({ mod }) => `${mod.ns}/${mod.name}`), { log });
  } catch (err) {
    log(`  listing index unavailable: ${err.message}`);
    listing = null;
  }

  for (const row of rows) {
    if (!listing) { row.listed = null; continue; }
    const versions = listing.get(`${row.mod.ns}/${row.mod.name}`);
    row.listedVersions = versions ? [...versions] : null;
    row.listed = Boolean(versions && versions.has(row.version));
  }
  return { rows, listingLoaded: Boolean(listing) };
}

export async function mintProfile(zipBuf) {
  const body = PROFILE_PREFIX + zipBuf.toString('base64');
  // r2modman posts this as octet-stream; text/plain is accepted too on some
  // deployments. Try the manager's own content type first, then fall back so a
  // launch-day mint is never blocked by a 415.
  const attempts = ['application/octet-stream', 'text/plain'];
  const errors = [];
  for (const contentType of attempts) {
    const res = await tsFetch(TS_CREATE, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    const text = await res.text();
    if (res.ok) {
      let key;
      try { key = JSON.parse(text).key; } catch { /* fall through */ }
      if (!key) throw new Error(`mint: 200 but no key in response: ${text.slice(0, 300)}`);
      return { key, contentType, uploadedBytes: body.length };
    }
    errors.push(`${contentType} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  throw new Error(`mint failed:\n    ${errors.join('\n    ')}`);
}

export async function fetchProfile(key) {
  const res = await tsFetch(`${TS_GET}${key}/`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch profile ${key}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith(PROFILE_PREFIX.trimEnd())) {
    throw new Error(`fetch profile ${key}: missing "#r2modman" prefix`);
  }
  // The guard above accepts '#r2modman' with or without its newline, so check
  // for the newline before slicing: indexOf returning -1 would otherwise feed
  // the marker itself into the base64 decode and surface as "not a zip?".
  const nl = text.indexOf('\n');
  if (nl < 0) {
    throw new Error(`fetch profile ${key}: response has no payload after the "#r2modman" marker`);
  }
  const b64 = text.slice(nl + 1).trim();
  return Buffer.from(b64, 'base64');
}

// ── file comparison ─────────────────────────────────────────────────────────
/** Compare a rendered file map against a directory on disk, byte for byte. */
export function compareToDir(files, dir) {
  const results = [];
  for (const [rel, data] of files) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) { results.push({ rel, status: 'missing', detail: p }); continue; }
    const disk = fs.readFileSync(p);
    results.push(
      disk.equals(data)
        ? { rel, status: 'same', detail: `${data.length} bytes` }
        : { rel, status: 'differs', detail: firstDiff(disk, data) },
    );
  }
  return results;
}

export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const ctx = (buf) => JSON.stringify(buf.toString('latin1', Math.max(0, i - 30), i + 30));
      return `first difference at byte ${i}\n         reference: ${ctx(a)}\n         rendered:  ${ctx(b)}`;
    }
  }
  return `identical for ${n} bytes then length differs (${a.length} vs ${b.length})`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `
Mint the Eilif r2modman pack.

  node scripts/mint-pack.mjs --world <World> [version pins] [--dry-run|--publish]

Required
  --world <name>              World name written into the stats client cfg.
                              MUST match the server's world exactly.

Version pins (default to pack v11's)
${MODS.map((m) => `  ${m.flag} <x.y.z>`.padEnd(30) + `${m.label} (v11: ${m.baseline})`).join('\n')}

Pack contents
${OMITTABLE_MODS.map((m) => `  ${m.omitFlag}`.padEnd(30) + `Mint without ${m.label}.\n`
    + ' '.repeat(30) + `Drops its export.r2x entry AND config/${m.cfg}.\n`
    + ' '.repeat(30) + 'The SERVER must then not run it either.').join('\n')}
  --fallback on|off|none      EilifPaths [VPlusFallback] Enabled, in the rendered
                              net.eilif.paths.cfg. Default ${DEFAULT_FALLBACK}: the section is
                              left out, which is what EilifPaths 1.4.0 wrote and what
                              reproduces pack v11. Turn it 'on' when the pack ships
                              without ValheimPlus. 'on' and 'off' both WRITE the
                              section, so both require --paths 1.5.0 or newer and
                              both stamp that cfg's writer header 1.5.0.
  --cap <n>                   The player cap the box will actually enforce, used only
                              in the printed checklist (config/server.ts MAX_PLAYERS).
                              Without ValheimPlus that is 10 unless Eilif Companion's
                              [ServerFallback] is switched on in the box's cfg.

Cfg writer headers (rarely needed - a header records the build that WROTE the
shipped template, not the pin, so it never moves on its own. Pass one of these
only when you have re-captured that cfg from a real r2modman run.)
${MODS.filter((m) => m.cfgVersionFlag)
    .map((m) => `  ${m.cfgVersionFlag} <x.y.z>`.padEnd(34) + `${m.label} (currently ${m.cfgVersionDefault})`)
    .join('\n')}

Modes
  --dry-run                   Render, verify, zip, write to --out. No upload.
  (no flag)                   TEST mint: uploads and round-trips, but the code
                              is labelled TEST and must not be given to players.
  --publish                   Real mint. Requires --version-label and refuses if
                              any version check failed.

Other
  --version-label <text>      e.g. 'Pack v12 · Sep 9'. Printed in the cutover
                              checklist; required with --publish.
  --profile-name <name>       r2modman profile name (default ${DEFAULT_PROFILE_NAME}).
  --ingest-url <url>          Dashboard ingest endpoint written into both client
                              cfgs (default ${DEFAULT_INGEST_URL}).
  --compare-to <dir>          Byte-compare the rendered files against an
                              unpacked reference pack (e.g. the decoded v11).
  --out <dir>                 Where the zip / rendered files / receipt go.
  --skip-index-check          Debugging only. Refused with --publish.
  --help
`;

function parseArgs(argv) {
  const args = {
    versions: {}, cfgVersions: {}, dryRun: false, publish: false,
    skipIndexCheck: false, out: null, compareTo: null, versionLabel: null,
    world: null, profileName: DEFAULT_PROFILE_NAME, ingestUrl: DEFAULT_INGEST_URL,
    omit: [], fallback: DEFAULT_FALLBACK, cap: null,
  };
  const byFlag = new Map(MODS.map((m) => [m.flag, m]));
  const byCfgFlag = new Map(MODS.filter((m) => m.cfgVersionFlag).map((m) => [m.cfgVersionFlag, m]));
  const byOmitFlag = new Map(OMITTABLE_MODS.map((m) => [m.omitFlag, m]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (byFlag.has(a)) { args.versions[byFlag.get(a).key] = next(); continue; }
    if (byCfgFlag.has(a)) { args.cfgVersions[byCfgFlag.get(a).key] = next(); continue; }
    if (byOmitFlag.has(a)) {
      const key = byOmitFlag.get(a).key;
      if (!args.omit.includes(key)) args.omit.push(key);
      continue;
    }
    switch (a) {
      case '--fallback': {
        const v = String(next()).toLowerCase();
        if (!FALLBACK_MODES.includes(v)) {
          throw new Error(`--fallback expects ${FALLBACK_MODES.join(' | ')}, got "${v}"`);
        }
        args.fallback = v;
        break;
      }
      case '--cap': {
        const v = String(next()).trim();
        if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error(`--cap expects a whole number, got "${v}"`);
        args.cap = Number(v);
        break;
      }
      case '--world': args.world = next(); break;
      case '--profile-name': args.profileName = next(); break;
      case '--ingest-url': args.ingestUrl = next(); break;
      case '--version-label': args.versionLabel = next(); break;
      case '--compare-to': args.compareTo = next(); break;
      case '--out': args.out = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--publish': args.publish = true; break;
      case '--skip-index-check': args.skipIndexCheck = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

/**
 * The one thing this script cannot check and nobody can undo by re-minting: V+
 * `enforceMod = true` is a two-way version check, so a server still running
 * ValheimPlus refuses every client that does not have it, and a pack minted
 * with --no-vplus hands out exactly that client. Printed twice on purpose (once
 * before the work, once in the result), because the middle of the run is 60
 * lines of Thunderstore rows and this is what scrolls away.
 *
 * The replacement is TWO switches, not one, and this script only owns the client
 * half. The server half is a cfg file on the box, and it defaults to off, so
 * "delete ValheimPlus" on its own leaves the cap at the vanilla 10.
 */
function printNoVplusReminder(cap) {
  banner('ValheimPlus is NOT in this pack');
  console.log('  The SERVER must not run ValheimPlus either.');
  console.log('  V+ enforceMod = true is a version check in both directions: a box with V+');
  console.log('  loaded refuses every client without it, and this pack ships none. Delete');
  console.log('  BepInEx/plugins/ValheimPlus/ on the GTX box in the same stopped window, and');
  console.log('  do not put valheim_plus.cfg back.');
  console.log('');
  console.log('  Two switches replace it. Both ship OFF, and only the first is in this pack:');
  console.log('    client  EilifPaths [VPlusFallback] Enabled = true   <- --fallback on');
  console.log('    server  Eilif Companion [ServerFallback] Enabled = true, MaxPlayers = N, in');
  console.log('            BepInEx/config/media.blockspace.eilif.companion.cfg on the box.');
  console.log('            That file is only WRITTEN on the first boot of the new DLL, so it');
  console.log('            has to be uploaded by hand in the same stopped window as the DLL,');
  console.log('            or the cap sits at the vanilla 10 all night.');
  console.log('');
  console.log('  What --fallback on puts back, client side: infinite fireplace, oven, hot tub');
  console.log('  and shield-generator fuel; station build range 30m and attachment range 20m,');
  console.log('  no roof check; +30% gathering, picking and loot amount; shared map');
  console.log('  exploration. Objects the SERVER owns (roughly the zones around world origin)');
  console.log('  keep vanilla behaviour, because that half runs on the box, not the client.');
  console.log('');
  console.log('  Everything else V+ was doing goes with it and is NOT restored: weather damage');
  console.log('  on buildings, area repair, floating dropped items, sleeping in unclaimed beds,');
  console.log('  grid snapping, map-wide shouts and pings, camera zoom and FOV, comfort radius,');
  console.log('  full resource refund on deconstruct, carts and boats on the map.');
  console.log('  docs/PACK.md rule 6 has the full list. The GO post has to name them.');
  console.log('');
  console.log('  Player cap: vanilla dedicated is 10. [ServerFallback] is the only thing that');
  console.log('  lifts it (its own default is MaxPlayers = 20).');
  if (cap) {
    console.log(`  config/server.ts MAX_PLAYERS = ${cap}, matching --cap ${cap}. Set the box's`);
    console.log(`  [ServerFallback] MaxPlayers to ${cap} in the same edit or the site lies.`);
  } else {
    console.log("  config/server.ts MAX_PLAYERS must equal the box's real cap: 10 if");
    console.log('  [ServerFallback] stays off, otherwise its MaxPlayers value. Re-run with');
    console.log('  --cap <n> and this line prints the number instead of the rule.');
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  if (!args.world) { console.error(`--world is required.\n${USAGE}`); process.exit(2); }
  if (args.dryRun && args.publish) { console.error('--dry-run and --publish are mutually exclusive.'); process.exit(2); }
  if (args.publish && !args.versionLabel) {
    console.error("--publish requires --version-label (e.g. --version-label 'Pack v12 · Sep 9').");
    console.error('The label is what tells a returning player whether their pack is current.');
    process.exit(2);
  }
  if (args.publish && args.skipIndexCheck) {
    console.error('--skip-index-check cannot be combined with --publish. The index check is the whole point.');
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY RUN' : args.publish ? 'PUBLISH' : 'TEST MINT';
  const outDir = args.out || path.join(os.tmpdir(), `eilif-pack-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Omitted mods are not pinned, so they are not verified either: asking
  // Thunderstore whether ValheimPlus 9.17.1 exists is a true answer to a
  // question this pack no longer asks.
  const kept = MODS.filter((mod) => !args.omit.includes(mod.key));
  const pins = kept.map((mod) => ({ mod, version: args.versions[mod.key] ?? mod.baseline }));

  banner(`Eilif pack minter - ${mode}`);
  console.log(`  world        ${args.world}`);
  console.log(`  profile name ${args.profileName}`);
  console.log(`  ingest url   ${args.ingestUrl}`);
  console.log(`  contents     ${pins.length} mods${args.omit.length
    ? `, dropped: ${args.omit.map((k) => MODS.find((m) => m.key === k).label).join(', ')}`
    : ''}`);
  console.log(`  fallback     EilifPaths [VPlusFallback] ${args.fallback === 'none'
    ? 'section omitted (pack v11 / EilifPaths 1.4.0 shape)'
    : `Enabled = ${args.fallback === 'on'}`}`);
  console.log(`  out dir      ${outDir}`);

  if (args.omit.includes('vplus')) printNoVplusReminder(args.cap);
  if (args.fallback === 'on' && !args.omit.includes('vplus')) {
    banner('Check this pairing');
    console.log('  --fallback on while ValheimPlus is still pinned. Both patch the same');
    console.log('  methods, so their effects stack: ranges and multipliers come out roughly');
    console.log('  double. Use --fallback on only for a pack that ships without V+.');
  }

  // 1. render ---------------------------------------------------------------
  banner('1. Render templates');
  const { files } = renderPack({
    world: args.world,
    versions: args.versions,
    cfgVersions: args.cfgVersions,
    ingestUrl: args.ingestUrl,
    profileName: args.profileName,
    omit: args.omit,
    fallback: args.fallback,
  });
  for (const [rel, buf] of files) {
    const p = path.join(outDir, 'rendered', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  console.log(ok(`${files.size} files rendered to ${path.join(outDir, 'rendered')}`));

  // 2. compare against a reference pack, if asked ---------------------------
  let compareFailed = false;
  if (args.compareTo) {
    banner('2. Compare rendered files to reference');
    for (const r of compareToDir(files, args.compareTo)) {
      if (r.status === 'same') console.log(ok(`${r.rel.padEnd(46)} ${r.detail}`));
      else { compareFailed = true; console.log(bad(`${r.rel.padEnd(46)} ${r.status}: ${r.detail}`)); }
    }
    console.log(compareFailed ? bad('rendered pack does NOT match the reference') : ok('every rendered file matches the reference'));
  }

  // 3. verify every pin ------------------------------------------------------
  banner(`${args.compareTo ? 3 : 2}. Verify pinned versions on Thunderstore`);
  let verifyFailed = false;
  let verification = { rows: [], listingLoaded: false };
  if (args.skipIndexCheck) {
    console.log('  --skip-index-check: package API only. NEVER ship a code minted this way.');
    for (const { mod, version } of pins) {
      const api = await checkPackageApi(mod, version);
      verification.rows.push({ mod, version, api, listed: null, listedVersions: null });
    }
  } else {
    verification = await verifyVersions(pins, { log: console.log });
  }

  console.log('');
  console.log(`  ${'mod'.padEnd(24)} ${'pinned'.padEnd(10)} ${'v11'.padEnd(10)} ${'package'.padEnd(9)} listing index`);
  for (const row of verification.rows) {
    const changed = row.version !== row.mod.baseline;
    const apiCell = row.api.ok ? 'ok' : String(row.api.status);
    const listCell = row.listed === null
      ? (args.skipIndexCheck ? 'skipped' : 'UNKNOWN')
      : row.listed ? 'ok' : 'NOT LISTED';
    if (!row.api.ok || row.listed === false || (row.listed === null && !args.skipIndexCheck)) verifyFailed = true;
    console.log(
      `  ${row.mod.label.padEnd(24)} ${row.version.padEnd(10)} ${(changed ? row.mod.baseline : '=').padEnd(10)} ` +
      `${apiCell.padEnd(9)} ${listCell}`,
    );
  }
  for (const key of args.omit) {
    const mod = MODS.find((m) => m.key === key);
    console.log(`  ${mod.label.padEnd(24)} ${'DROPPED'.padEnd(10)} ${mod.baseline.padEnd(10)} ${'-'.padEnd(9)} not in this pack`);
  }
  for (const row of verification.rows) {
    if (row.listed === false) {
      const seen = row.listedVersions ? row.listedVersions.slice(0, 6).join(', ') : 'package not in the index at all';
      console.log(bad(`${row.mod.ns}/${row.mod.name} ${row.version} is not in the r2modman listing index.`));
      console.log(`       index currently offers: ${seen}`);
      console.log(row.api.ok
        ? '       The upload landed but the index has not rebuilt yet (40-80 min). Wait and re-run.'
        : '       The package API does not have this version either - check the version number.');
    }
  }
  if (verifyFailed) {
    console.log(bad('one or more pins failed verification - refusing to mint'));
    console.log('  A code minted now imports as "mod not found" for every player.');
    process.exitCode = 1;
    if (!args.dryRun) return;
  } else {
    console.log(ok('every pinned version is published AND visible to mod managers'));
  }

  // 4. zip -------------------------------------------------------------------
  banner(`${args.compareTo ? 4 : 3}. Build profile zip`);
  const zipBuf = zipSync([...files].map(([name, data]) => ({ name, data })));
  const zipPath = path.join(outDir, 'profile.zip');
  fs.writeFileSync(zipPath, zipBuf);
  console.log(ok(`${zipBuf.length} bytes -> ${zipPath}`));

  if (args.dryRun) {
    banner('Dry run complete');
    console.log('  Nothing was uploaded. Re-run without --dry-run to mint a TEST code,');
    console.log("  or with --publish --version-label '...' for the real one.");
    if (compareFailed || verifyFailed) process.exitCode = 1;
    return;
  }
  if (compareFailed) {
    console.log(bad('reference comparison failed - refusing to mint'));
    process.exitCode = 1;
    return;
  }

  // 5. mint ------------------------------------------------------------------
  banner(`${args.compareTo ? 5 : 4}. Mint`);
  const { key, contentType } = await mintProfile(zipBuf);
  console.log(ok(`minted (${contentType}) -> ${key}`));

  // 6. round trip ------------------------------------------------------------
  banner(`${args.compareTo ? 6 : 5}. Round trip: download the minted profile and compare`);
  const downloaded = await fetchProfile(key);
  console.log(downloaded.equals(zipBuf)
    ? ok('downloaded zip is byte-identical to the uploaded zip')
    : `  note  downloaded zip bytes differ from the upload (${downloaded.length} vs ${zipBuf.length}); comparing entries`);

  const back = unzipSync(downloaded);
  let roundTripFailed = false;
  const expectedNames = [...files.keys()].sort();
  const gotNames = [...back.keys()].sort();
  if (expectedNames.join('|') !== gotNames.join('|')) {
    roundTripFailed = true;
    console.log(bad('entry list differs'));
    console.log(`       uploaded:   ${expectedNames.join(', ')}`);
    console.log(`       downloaded: ${gotNames.join(', ')}`);
  }
  for (const [rel, data] of files) {
    const got = back.get(rel);
    if (!got) { roundTripFailed = true; console.log(bad(`${rel.padEnd(46)} missing from the downloaded profile`)); continue; }
    if (got.equals(data)) console.log(ok(`${rel.padEnd(46)} ${data.length} bytes`));
    else { roundTripFailed = true; console.log(bad(`${rel.padEnd(46)} ${firstDiff(got, data)}`)); }
  }
  if (roundTripFailed) {
    console.log(bad('ROUND TRIP FAILED - do not hand this code to anyone'));
    process.exitCode = 1;
  } else {
    console.log(ok('round trip clean: what players import is exactly what was rendered'));
  }

  // 7. receipt + next steps ---------------------------------------------------
  const receipt = {
    mode,
    mintedAt: new Date().toISOString(),
    profileCode: key,
    world: args.world,
    profileName: args.profileName,
    ingestUrl: args.ingestUrl,
    versionLabel: args.versionLabel,
    pins: Object.fromEntries(pins.map(({ mod, version }) => [`${mod.ns}/${mod.name}`, version])),
    dropped: args.omit.map((k) => {
      const mod = MODS.find((m) => m.key === k);
      return `${mod.ns}/${mod.name}`;
    }),
    fallback: args.fallback,
    zipBytes: zipBuf.length,
    roundTrip: roundTripFailed ? 'FAILED' : 'clean',
    verification: verification.rows.map((r) => ({
      package: `${r.mod.ns}/${r.mod.name}`, version: r.version,
      packageApi: r.api.ok ? 'ok' : r.api.status,
      listingIndex: r.listed === null ? 'skipped' : r.listed ? 'ok' : 'NOT LISTED',
    })),
  };
  fs.writeFileSync(path.join(outDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

  banner('Result');
  if (args.publish && roundTripFailed) {
    // Never end on a publish checklist for a code the round trip just condemned:
    // the refusal would be scrolled off above it.
    console.log(`  Minted code: ${key}`);
    console.log(bad('The round trip FAILED. Do NOT publish this code and do NOT post it.'));
    console.log('  Re-run the mint. If it fails again, compare the receipt against a');
    console.log('  --dry-run render before touching config/server.ts.');
  } else if (args.publish) {
    console.log(`  Pack code: ${key}`);
    console.log('');
    console.log('  Next, in order (docs/PACK.md has the long form):');
    console.log(`    1. config/server.ts: MODPACK_PROFILE_CODE = '${key}'`);
    console.log(`    2. config/server.ts: MODPACK_VERSION_LABEL = '${args.versionLabel}'`);
    console.log(`    3. config/mods.ts: bump the version shown for every mod that moved${args.omit.length
      ? ', and drop the ones this pack no longer ships'
      : ''}`);
    if (args.omit.includes('vplus')) {
      console.log(`    3b. config/server.ts: MAX_PLAYERS = ${args.cap
        ? args.cap
        : "<the box's real cap: 10, or [ServerFallback] MaxPlayers if it is on>"}`);
      console.log("    3c. app/get-started/page.tsx: the Mac \"install these seven\" list still");
      console.log('        names ValheimPlus. A Mac player who follows it installs V+ and is');
      console.log('        then refused by the box. Drop the name, and the count word with it.');
    }
    console.log(`    4. node scripts/build-config-bundle.mjs ${bundleArgs(args, pins)} \\`);
    console.log('         --pack-number <N> --pack-date "<Mon D, YYYY>"');
    console.log('    5. app/get-started/page.tsx: point CONFIG_BUNDLE_URL at the new bundle file');
    console.log('    6. deploy, then Stop/Start the server, then tell the crew to re-import');
    if (args.omit.includes('vplus')) printNoVplusReminder(args.cap);
  } else {
    console.log(`  TEST code: ${key}`);
    console.log('  This is a TEST mint. Nothing on Thunderstore marks it as one - the bytes');
    console.log('  are deliberately identical to what --publish would upload, so a stray');
    console.log('  paste is unrecoverable and cannot be spotted by eye. Do not put it in');
    console.log('  config/server.ts, Discord, or anywhere a player can reach it.');
    console.log('  To read it back before you throw it away:');
    console.log(`    curl -sL -H 'User-Agent: eilif-pack-check' ${TS_GET}${key}/ | tail -n +2 | base64 -d > profile.zip`);
    console.log("  Re-run with --publish --version-label '...' to mint the real one.");
  }
  console.log(`  Receipt: ${path.join(outDir, 'receipt.json')}`);
}

/**
 * The build-config-bundle.mjs flags that reproduce THIS mint's cfgs. Forwarding
 * only --world and the changed pins would silently rebuild the Mac bundle with
 * default ingest/cfg-header values - the exact drift the two scripts exist to
 * prevent. Quoted because a world name may contain a space.
 */
export function bundleArgs(args, pins) {
  const parts = [`--world '${args.world}'`];
  if (args.ingestUrl !== DEFAULT_INGEST_URL) parts.push(`--ingest-url '${args.ingestUrl}'`);
  for (const { mod, version } of pins) {
    if (version !== mod.baseline) parts.push(`${mod.flag} ${version}`);
  }
  for (const mod of MODS) {
    const v = args.cfgVersions[mod.key];
    if (v) parts.push(`${mod.cfgVersionFlag} ${v}`);
  }
  // A dropped mod and the fallback switch both change what the Mac bundle
  // contains, so they travel with the rest. Forgetting either would ship Mac
  // players a valheim_plus.cfg for a mod the pack no longer has.
  for (const mod of OMITTABLE_MODS) {
    if ((args.omit || []).includes(mod.key)) parts.push(mod.omitFlag);
  }
  if (args.fallback && args.fallback !== DEFAULT_FALLBACK) parts.push(`--fallback ${args.fallback}`);
  return parts.join(' ');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\nmint-pack failed: ${err.message}`);
    process.exit(1);
  });
}
