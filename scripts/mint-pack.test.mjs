// Tests for the pack minter's offline half (no network, no Thunderstore).
//
// The load-bearing assertion is the first one: rendering scripts/pack-templates
// with the baseline pins must reproduce pack v11 (the published pack, code
// 01a0440c-…) byte for byte. Those hashes are the tripwire — if someone edits a
// template by hand and gets a byte wrong, a launch-day re-mint would quietly
// ship a different pack than the one the crew has been playing, and this fails
// instead. Re-baseline the hashes ONLY together with a deliberate cfg change.
//
// The rest covers the substitution rules (world, version pins, README rule
// length), the zip writer/reader pair, and the argument guards.
//
// Run: npx tsx scripts/mint-pack.test.mjs
import assert from 'node:assert';
import crypto from 'node:crypto';

import {
  MODS, CFG_FILES, DEFAULT_INGEST_URL,
  renderPack, renderReadme, parseSemver, zipSync, unzipSync, crc32, firstDiff, bundleArgs,
} from './mint-pack.mjs';
import { buildBundle } from './build-config-bundle.mjs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── pack v11, as published on 2026-08-27 ────────────────────────────────────
const V11 = {
  'export.r2x': 'd2bcf821f69cd04d7d77158b68e9727c8bb9e58bcdfceef8b84690a74ec88946',
  'doorstop_config.ini': '4d5c6dfa0f771c6a5b1b0c559aca0bd0ece7d08b08fff894708dc3b73ce73cfc',
  'config/advize.PlantEverything.cfg': 'db6a6d43c16d73c653a04e231ebb574dd3c3ce60d08e8eb3dd2170c7ceebbc81',
  'config/Azumatt.AzuCraftyBoxes.cfg': '53d7af609594328146e930066ae2f2b09549b37e639e6c82b495a81903ac439c',
  'config/BepInEx.cfg': 'e05e67031fb33decebdd9f560e1ce011582ef1bbc9a67c503a105561e4e6a376',
  'config/net.cproudlock.gsvalheimstatsclient.cfg': '60803da27943d77a150f1cc90dd655ccdb0556c04ec40c6c5dfadf7a44eba185',
  'config/net.eilif.companionclient.cfg': '8d3272a9d745a05056b24279117a73686ee60951b2bd634e66e2bf1756c979d6',
  'config/net.eilif.paths.cfg': '6d971c796689bb7412e44f8f4f144e51be55736f3267386bfdd74dc6ea910692',
  'config/valheim_plus.cfg': '62abb6322c9b0aa0093bb6641f630b4e83845da9cfd85b9b1c0221c792d6dd96',
};
const V11_README = '918fc816520e521d5b2e1073cfb7f2685c75d1b17808e25b119049e9966765de';

const { files: v11 } = renderPack({ world: 'EilifRehearsal' });
assert.deepEqual(
  [...v11.keys()].sort(),
  Object.keys(V11).sort(),
  'the rendered pack contains exactly the files pack v11 shipped',
);
for (const [rel, hash] of Object.entries(V11)) {
  assert.equal(sha(v11.get(rel)), hash, `${rel} renders byte-identical to pack v11`);
}
assert.equal(
  sha(renderReadme({ packNumber: 11, packDate: 'Aug 27, 2026' })),
  V11_README,
  'the Mac bundle README renders byte-identical to the one in eilif-configs-pack-v11.zip',
);

// ── substitutions ───────────────────────────────────────────────────────────
const { files: custom } = renderPack({
  world: 'Eilif',
  versions: { companionClient: '0.3.1', paths: '1.5.0', azu: '1.9.0' },
  ingestUrl: 'https://eilif-dashboard.vercel.app/api/gs-ingest',
  profileName: 'EilifLaunch',
});
const gs = custom.get('config/net.cproudlock.gsvalheimstatsclient.cfg').toString('latin1');
const comp = custom.get('config/net.eilif.companionclient.cfg').toString('latin1');
const r2x = custom.get('export.r2x').toString('latin1');

assert.match(gs, /^World = Eilif$/m, 'the world lands in the stats client cfg');
assert.doesNotMatch(gs, /^World = EilifRehearsal$/m, 'the rehearsal world is gone');
assert.match(gs, /^# Default value: vhserver3$/m, 'the commented-out default World is left alone');
assert.match(
  gs, /^Url = https:\/\/eilif-dashboard\.vercel\.app\/api\/gs-ingest$/m,
  'the ingest url lands in the stats client cfg',
);
assert.match(
  gs, /^# Default value: https:\/\/gs\.proudtech\.net\/api\/valheim\/ingest$/m,
  "the upstream mod's own default url comment is left alone",
);
assert.match(
  comp, /^Url = https:\/\/eilif-dashboard\.vercel\.app\/api\/gs-ingest$/m,
  'the ingest url lands in the companion client cfg',
);
assert.match(
  comp, /^# Default value: https:\/\/valheim-dashboard\.vercel\.app\/api\/gs-ingest$/m,
  "the companion cfg's default-value comment is a comment, not a setting, and is untouched",
);
assert.match(comp, /^Token = $/m, 'no token is ever written into the pack: a pack code is public');
assert.match(gs, /^Token = $/m, 'same for the stats client');

// The cfg header records the plugin build that WROTE the shipped template, not
// the pin, so bumping a pin must never move it - for ANY mod. `custom` above
// pins companionClient 0.3.1, paths 1.5.0 and azu 1.9.0.
assert.match(
  comp, /^## Settings file was created by plugin Eilif Companion Client v0\.1\.0$/m,
  'the companion cfg keeps its 0.1.0 writer header until the schema actually changes',
);
assert.match(
  custom.get('config/net.eilif.paths.cfg').toString('latin1'),
  /^## Settings file was created by plugin Eilif Paths v1\.4\.0$/m,
  'the paths cfg header stays on the build that wrote the template, not the 1.5.0 pin',
);
assert.match(
  custom.get('config/Azumatt.AzuCraftyBoxes.cfg').toString('latin1'),
  /^## Settings file was created by plugin AzuCraftyBoxes v1\.8\.15$/m,
  'same for AzuCraftyBoxes: a 1.9.0 pin must not stamp a header over the 1.8.15 capture',
);
// ...and every one of them has an explicit escape hatch for when the cfg IS
// re-captured, so no mod is a special case.
for (const mod of MODS.filter((m) => m.cfgVersionVar)) {
  assert.ok(mod.cfgVersionFlag, `${mod.label} has a --*-cfg-version flag`);
  assert.ok(mod.cfgVersionDefault, `${mod.label} declares which build wrote its cfg`);
}
assert.match(
  renderPack({ world: 'Eilif', cfgVersions: { companionClient: '0.3.1' } })
    .files.get('config/net.eilif.companionclient.cfg').toString('latin1'),
  /^## Settings file was created by plugin Eilif Companion Client v0\.3\.1$/m,
  '--companion-cfg-version can move that header when a re-captured cfg needs it',
);
assert.match(
  renderPack({ world: 'Eilif', cfgVersions: { paths: '1.5.0' } })
    .files.get('config/net.eilif.paths.cfg').toString('latin1'),
  /^## Settings file was created by plugin Eilif Paths v1\.5\.0$/m,
  '--paths-cfg-version moves the paths header',
);
assert.throws(
  () => renderPack({ world: 'Eilif', cfgVersions: { azu: '1.9' } }),
  /three-part version/,
  'a cfg header version is validated like a pin',
);

assert.match(r2x, /^profileName: EilifLaunch$/m, 'the profile name is settable');
assert.match(
  r2x,
  /- name: Eilif-EilifCompanionClient\n {4}version:\n {6}major: 0\n {6}minor: 3\n {6}patch: 1\n/,
  'a semver pin is split into r2modman major/minor/patch',
);
assert.match(
  r2x,
  /- name: Azumatt-AzuCraftyBoxes\n {4}version:\n {6}major: 1\n {6}minor: 9\n {6}patch: 0\n/,
  'AzuCraftyBoxes is pinnable (it has to move in lockstep with the server copy)',
);
assert.equal((r2x.match(/- name: /g) || []).length, MODS.length, 'every mod in MODS is in export.r2x');
for (const buf of custom.values()) {
  assert.doesNotMatch(buf.toString('latin1'), /\{\{[A-Z0-9_]+\}\}/, 'no unfilled placeholder survives');
}

// ── README rule tracks the title length ─────────────────────────────────────
const readme = renderReadme({ packNumber: 12, packDate: 'September 9, 2026' }).toString('latin1').split('\n');
assert.equal(readme[1], '='.repeat(readme[0].length), 'the README underline matches the retitled heading');
assert.match(readme[0], /^Eilif config bundle - Pack v12 \(September 9, 2026\)$/, 'the README heading is retitled');
assert.ok(readme.some((l) => /modpack v12 \(published September 9, 2026\)/.test(l)), 'the version section is retitled too');

// ── guards ──────────────────────────────────────────────────────────────────
assert.throws(() => renderPack({}), /--world is required/, 'a pack with no world is refused');
assert.throws(() => parseSemver('1.4', '--paths'), /three-part version/, 'a two-part version is refused');
assert.throws(() => parseSemver('v1.4.0', '--paths'), /three-part version/, 'a v-prefixed version is refused');
assert.deepEqual(parseSemver('5.4.2333', '--bepinex'), { major: '5', minor: '4', patch: '2333' });

// ── zip writer / reader ─────────────────────────────────────────────────────
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'crc32 matches the standard check value');

const zip = zipSync([...v11].map(([name, data]) => ({ name, data })));
assert.equal(zip.readUInt32LE(0), 0x04034b50, 'the zip starts with a local file header');
const back = unzipSync(zip);
assert.deepEqual([...back.keys()].sort(), [...v11.keys()].sort(), 'every entry survives the zip round trip');
for (const [rel, data] of v11) {
  assert.ok(back.get(rel).equals(data), `${rel} survives the zip round trip: ${firstDiff(back.get(rel), data)}`);
}
assert.ok(
  zipSync([...v11].map(([name, data]) => ({ name, data }))).equals(zip),
  'zipping is deterministic, so the same pack always mints the same bytes',
);
assert.throws(() => unzipSync(Buffer.from('not a zip')), /end-of-central-directory/, 'garbage is rejected');

// Entry ORDER matches the published pack v11 (`unzip -l` on the decoded profile):
// a directory record sits immediately before its first child, not hoisted to the
// front. Readers do not care, but a byte-diff against a real pack does.
assert.deepEqual(
  centralNames(zip),
  [
    'export.r2x', 'doorstop_config.ini', 'config/',
    'config/net.eilif.paths.cfg', 'config/BepInEx.cfg', 'config/advize.PlantEverything.cfg',
    'config/net.eilif.companionclient.cfg', 'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/valheim_plus.cfg', 'config/Azumatt.AzuCraftyBoxes.cfg',
  ],
  "the zip's entry order is r2modman's own, matching published pack v11",
);
assert.deepEqual(
  centralNames(zipSync([{ name: 'a/b/c.txt', data: Buffer.from('x') }])),
  ['a/', 'a/b/', 'a/b/c.txt'],
  'every ancestor directory gets a record, not just the immediate parent',
);

/** Entry names in central-directory order. */
function centralNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

// ── the bundle command the publish checklist prints ─────────────────────────
// It must carry every flag that changes what a cfg says, or step 6 rebuilds the
// Mac bundle with defaults and the two artifacts silently disagree.
const pins = MODS.map((mod) => ({ mod, version: mod.key === 'paths' ? '1.5.0' : mod.baseline }));
assert.equal(
  bundleArgs({
    world: 'Eilif Rehearsal',
    ingestUrl: 'https://eilif-dashboard.vercel.app/api/gs-ingest',
    cfgVersions: { companionClient: '0.3.2' },
  }, pins),
  "--world 'Eilif Rehearsal' --ingest-url 'https://eilif-dashboard.vercel.app/api/gs-ingest' " +
  '--paths 1.5.0 --companion-cfg-version 0.3.2',
  'the printed bundle command forwards world, ingest url, changed pins and cfg headers',
);
assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {} },
    MODS.map((mod) => ({ mod, version: mod.baseline }))),
  "--world 'Eilif'",
  'nothing at its default is forwarded, and a world is always quoted',
);

// ── Mac bundle ──────────────────────────────────────────────────────────────
const bundle = buildBundle({
  world: 'EilifRehearsal', versions: {}, cfgVersions: {},
  ingestUrl: undefined, packNumber: 11, packDate: 'Aug 27, 2026',
});
assert.deepEqual(
  bundle.entries.map((e) => e.name),
  [...CFG_FILES].sort().concat('README.txt'),
  'the bundle is the seven cfgs flat, README last, no config/ folder',
);
for (const e of bundle.entries.slice(0, -1)) {
  assert.ok(e.data.equals(v11.get(`config/${e.name}`)), `${e.name} in the bundle is the same file the pack ships`);
}
assert.equal(sha(bundle.entries.at(-1).data), V11_README, 'the bundle README is the published one');

console.log('OK — all pack minter assertions passed');
