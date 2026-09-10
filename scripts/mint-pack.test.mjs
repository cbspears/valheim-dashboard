// Tests for the pack minter's offline half (no network, no Thunderstore).
//
// The load-bearing assertion is the first one: rendering scripts/pack-templates
// with the baseline pins must reproduce pack v11 (the published pack, code
// 01a0440c-…) byte for byte. Those hashes are the tripwire — if someone edits a
// template by hand and gets a byte wrong, a launch-day re-mint would quietly
// ship a different pack than the one the crew has been playing, and this fails
// instead. Re-baseline the hashes ONLY together with a deliberate cfg change.
//
// The baseline is still a plain default render: `--fallback` defaults to 'none'
// precisely so that stays true, because pack v11 shipped EilifPaths 1.4.0, which
// had no [VPlusFallback] section to write. A second assertion right after it
// proves that turning the section ON changes that one section of that one file
// and nothing else, so the tripwire did not get weaker when the option was added.
//
// The rest covers the substitution rules (world, version pins, README rule
// length), minting without any of the three droppable mods (--no-vplus,
// --no-plant, --no-azu) including what the Mac README then says, the shape pack
// v12 mints on Valheim 1.0 with all three gone, the shape pack v14 mints once
// ValheimPlus 10.0.2 comes back (including the cfg RENAME that came with it and
// the refusal to stack --fallback on against a pinned V+), the [VPlusFallback]
// switch and its version guard, the {{#SECTION}} marker machinery, the zip
// writer/reader pair, and the argument guards.
//
// Run: npx tsx scripts/mint-pack.test.mjs
import assert from 'node:assert';
import crypto from 'node:crypto';

import {
  MODS, CFG_FILES, DEFAULT_INGEST_URL, DEFAULT_FALLBACK, FALLBACK_MODES, OMITTABLE_MODS,
  OPTIONAL_MODS, SECTIONED_MODS,
  renderPack, renderReadme, parseSemver, compareSemver, zipSync, unzipSync, crc32, firstDiff,
  bundleArgs, applySections, cfgFor, cfgFilesFor, cfgNamesFor,
} from './mint-pack.mjs';
import { buildBundle } from './build-config-bundle.mjs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// How many mods a render gets WITHOUT being asked for anything optional - which
// is what every count below is really about. MODS.length stopped being that
// number on 2026-09-10, when Unshamed arrived as the first `optional: true` row:
// it is absent unless --unshamed pins it, precisely so the v11 tripwire above
// stays a tripwire.
const DEFAULT_MOD_COUNT = MODS.length - OPTIONAL_MODS.length;

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

// Nothing but a world: the defaults ARE pack v11's, down to `fallback: 'none'`,
// because EilifPaths 1.4.0 had no [VPlusFallback] section to write.
const { files: v11 } = renderPack({ world: 'EilifRehearsal' });
assert.deepEqual(
  [...v11.keys()].sort(),
  Object.keys(V11).sort(),
  'the rendered pack contains exactly the files pack v11 shipped',
);
for (const [rel, hash] of Object.entries(V11)) {
  assert.equal(sha(v11.get(rel)), hash, `${rel} renders byte-identical to pack v11`);
}

// The tripwire above covers the default, so this one covers the option: writing
// the section must change the paths cfg and NOTHING else. Without it, adding a
// second templated section could quietly change six other files and no assertion
// would notice. (Writing the section requires the 1.5.0 pin - see the guard
// further down - which also moves that cfg's writer header, so the header line
// is the one other expected difference.)
const { files: withSection } = renderPack({
  world: 'EilifRehearsal', fallback: 'off', versions: { paths: '1.5.0' },
});
assert.deepEqual([...withSection.keys()].sort(), [...v11.keys()].sort(), 'the fallback render ships the same file list');
for (const [rel, data] of withSection) {
  if (rel === 'config/net.eilif.paths.cfg') {
    assert.ok(!data.equals(v11.get(rel)), 'it DOES add the fallback section to the paths cfg');
  } else if (rel === 'export.r2x') {
    continue; // the 1.5.0 pin lives here on purpose
  } else {
    assert.ok(data.equals(v11.get(rel)), `${rel} is untouched by the fallback section: ${firstDiff(v11.get(rel), data)}`);
  }
}
assert.equal(
  withSection.get('config/net.eilif.paths.cfg').toString('latin1')
    .replace(/\n\[VPlusFallback\][\s\S]*?\nEnabled = false\n\n/, '\n')
    .replace('Eilif Paths v1.5.0', 'Eilif Paths v1.4.0'),
  v11.get('config/net.eilif.paths.cfg').toString('latin1'),
  'and the paths cfg differs from v11 by exactly that one section plus its writer header',
);
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
assert.equal(
  (r2x.match(/- name: /g) || []).length, DEFAULT_MOD_COUNT,
  'every non-optional mod in MODS is in export.r2x',
);
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
  ingestUrl: undefined, packNumber: 11, packDate: 'Aug 27, 2026', fallback: 'none',
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

// ── minting without ValheimPlus ─────────────────────────────────────────────
// Grantapher 9.17.1 targets 0.221.10 and has no 1.0 build, so pack v12 has to be
// able to ship without it. V+ enforceMod is a two-way check, which is what makes
// the "no entry AND no cfg" pairing load-bearing rather than tidy: a client that
// installs V+ from a leftover pack entry is refused by a server without it, and
// a leftover valheim_plus.cfg is a config for a mod that is not there.
const { files: noVplus, omitted } = renderPack({ world: 'Eilif', omit: ['vplus'] });
assert.deepEqual(omitted, ['vplus'], 'renderPack reports what it dropped');
assert.ok(!noVplus.has('config/valheim_plus.cfg'), '--no-vplus drops config/valheim_plus.cfg');
assert.deepEqual(
  [...noVplus.keys()].sort(),
  [...v11.keys()].filter((k) => k !== 'config/valheim_plus.cfg').sort(),
  'and drops nothing else',
);
const noVplusR2x = noVplus.get('export.r2x').toString('latin1');
assert.doesNotMatch(noVplusR2x, /ValheimPlus/, 'no ValheimPlus entry survives in export.r2x');
assert.doesNotMatch(noVplusR2x, /Grantapher/, 'not under its namespace either');
assert.equal(
  (noVplusR2x.match(/- name: /g) || []).length, DEFAULT_MOD_COUNT - 1,
  'export.r2x lists every mod but the dropped one',
);
assert.doesNotMatch(noVplusR2x, /\{\{|\}\}/, 'the section markers leave no residue in export.r2x');
// The dropped block must vanish cleanly: what is left has to be byte-identical
// to the same render with V+ kept, minus exactly those six lines.
const vplusEntry = `  - name: Grantapher-ValheimPlus_Grantapher_Temporary
    version:
      major: 9
      minor: 17
      patch: 1
    enabled: true
`;
const withVplusR2x = renderPack({ world: 'Eilif' }).files.get('export.r2x').toString('latin1');
assert.ok(withVplusR2x.includes(vplusEntry), 'the kept render still carries the V+ entry verbatim');
assert.equal(
  withVplusR2x.replace(vplusEntry, ''), noVplusR2x,
  'dropping V+ removes exactly its entry and no surrounding whitespace',
);
// Three mods are droppable, each only through its own flag. The two added on
// 2026-09-09 are there because their embedded ServerSync reads
// ZRoutedRpc.Everybody, which Valheim 1.0 made a constant, so both throw at
// startup on 1.0 - proved by a load test that launch morning.
assert.deepEqual(
  OMITTABLE_MODS.map((m) => m.key), ['vplus', 'plant', 'companionClient', 'azu'],
  'the droppable set is ValheimPlus, PlantEverything, EilifCompanionClient and AzuCraftyBoxes',
);
for (const mod of OMITTABLE_MODS) {
  assert.ok(mod.cfg, `${mod.label} declares the cfg that leaves with it`);
  assert.ok(mod.section, `${mod.label} declares its export.r2x section marker`);
  assert.ok(CFG_FILES.includes(mod.cfg), `${mod.label}'s cfg is one the pack actually ships`);
}
assert.throws(() => renderPack({ world: 'Eilif', omit: ['gs'] }), /cannot be dropped/, 'a non-droppable mod is refused');
assert.throws(() => renderPack({ world: 'Eilif', omit: ['nope'] }), /unknown mod key/, 'an unknown key is refused');

// The Mac bundle follows the pack, because it reads the rendered file list
// rather than the CFG_FILES constant.
const noVplusBundle = buildBundle({
  world: 'Eilif', versions: { paths: '1.5.0' }, cfgVersions: {}, ingestUrl: undefined,
  packNumber: 12, packDate: 'Sep 9, 2026', omit: ['vplus'], fallback: 'on',
});
assert.ok(
  !noVplusBundle.entries.some((e) => e.name === 'valheim_plus.cfg'),
  'a Mac player gets no valheim_plus.cfg from a pack that has no ValheimPlus',
);
assert.deepEqual(
  noVplusBundle.entries.map((e) => e.name),
  CFG_FILES.filter((n) => n !== 'valheim_plus.cfg').sort().concat('README.txt'),
  'and gets every other cfg exactly as before',
);

// The README is the only instructions a Mac player gets, and it is the half that
// is easy to leave behind: removing the file while the text still says "all seven"
// and lists valheim_plus.cfg sends them hunting for a missing file, or off to
// install ValheimPlus - which enforceMod then uses to refuse them the server.
const noVplusReadme = noVplusBundle.entries.at(-1).data.toString('latin1');
assert.doesNotMatch(noVplusReadme, /valheim_plus/, 'the README of a V+-less bundle never names valheim_plus.cfg');
assert.doesNotMatch(noVplusReadme, /\bseven\b/, 'and does not still say seven');
assert.equal((noVplusReadme.match(/\bsix\b/g) || []).length, 2, 'it says six, in both places that count the files');
assert.doesNotMatch(noVplusReadme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
const v11Readme = renderReadme({ packNumber: 11, packDate: 'Aug 27, 2026' }).toString('latin1');
assert.equal((v11Readme.match(/\bseven\b/g) || []).length, 2, 'a full bundle still says seven, in both places');
assert.match(v11Readme, /^  valheim_plus\.cfg /m, 'and still lists valheim_plus.cfg');
// The count is read off the zip's own entry list, not off a flag passed twice.
assert.equal(
  renderReadme({ packNumber: 12, packDate: 'Sep 9, 2026', cfgs: noVplusBundle.entries.slice(0, -1).map((e) => e.name) })
    .toString('latin1'),
  noVplusReadme,
  'the bundle README is exactly renderReadme() over the entries sitting next to it',
);
assert.throws(
  () => renderReadme({ packNumber: 12, packDate: 'Sep 9, 2026', cfgs: new Array(11).fill('x.cfg') }),
  /no word for 11 cfg files/,
  'a bundle bigger than the word list is refused rather than rendering "{{CFG_COUNT_WORD}}"',
);

// ── every drop behaves the same way ─────────────────────────────────────────
// --no-plant and --no-azu were added on 2026-09-09: both mods embed a ServerSync
// that reads ZRoutedRpc.Everybody, which Valheim 1.0 turned into a constant, so
// both throw at startup on 1.0. What the loop below asserts is that they are not
// special cases of --no-vplus but the same mechanism - one export.r2x entry, one
// cfg, nothing else touched - because a half-dropped mod (entry without cfg, or
// cfg without entry) is exactly the failure no round trip and no boot can see.
const R2X_ENTRIES = {
  vplus: vplusEntry,
  plant: `  - name: Advize-PlantEverything
    version:
      major: 1
      minor: 20
      patch: 0
    enabled: true
`,
  companionClient: `  - name: Eilif-EilifCompanionClient
    version:
      major: 0
      minor: 2
      patch: 0
    enabled: true
`,
  azu: `  - name: Azumatt-AzuCraftyBoxes
    version:
      major: 1
      minor: 8
      patch: 15
    enabled: true
`,
};
for (const mod of OMITTABLE_MODS) {
  const { files: without } = renderPack({ world: 'EilifRehearsal', omit: [mod.key] });
  assert.ok(!without.has(`config/${mod.cfg}`), `${mod.omitFlag} drops config/${mod.cfg}`);
  assert.deepEqual(
    [...without.keys()].sort(),
    [...v11.keys()].filter((k) => k !== `config/${mod.cfg}`).sort(),
    `${mod.omitFlag} drops nothing else`,
  );
  const r2xOut = without.get('export.r2x').toString('latin1');
  assert.ok(!r2xOut.includes(mod.name), `no ${mod.label} entry survives in export.r2x`);
  // The namespace check only means something when no kept mod shares it:
  // Eilif-EilifPaths stays when Eilif-EilifCompanionClient is dropped.
  const nsShared = MODS.some((m) => m.key !== mod.key && m.ns === mod.ns);
  assert.ok(nsShared || !r2xOut.includes(mod.ns), 'not under its namespace either');
  assert.ok(!r2xOut.includes(`${mod.ns}-${mod.name}`), 'and not as a full package name');
  assert.equal(
    (r2xOut.match(/- name: /g) || []).length, DEFAULT_MOD_COUNT - 1,
    `${mod.omitFlag} leaves every mod but the dropped one in export.r2x`,
  );
  assert.doesNotMatch(r2xOut, /\{\{|\}\}/, 'the section markers leave no residue in export.r2x');
  assert.equal(
    withVplusR2x.replace(R2X_ENTRIES[mod.key], ''), r2xOut,
    `dropping ${mod.label} removes exactly its entry and no surrounding whitespace`,
  );
  // Every file that stays is the same bytes the full pack shipped: a drop must
  // not disturb the cfg of any mod that is still in the pack.
  for (const [rel, data] of without) {
    if (rel === 'export.r2x') continue;
    assert.ok(data.equals(v11.get(rel)), `${rel} is untouched by ${mod.omitFlag}: ${firstDiff(v11.get(rel), data)}`);
  }
  // ...and the Mac bundle follows, README count included.
  const dropBundle = buildBundle({
    world: 'EilifRehearsal', versions: {}, cfgVersions: {}, ingestUrl: undefined,
    packNumber: 12, packDate: 'Sep 9, 2026', omit: [mod.key], fallback: 'none',
  });
  assert.ok(!dropBundle.entries.some((e) => e.name === mod.cfg), `the Mac bundle drops ${mod.cfg} too`);
  const dropReadme = dropBundle.entries.at(-1).data.toString('latin1');
  assert.ok(!dropReadme.includes(mod.cfg), `and its README never names ${mod.cfg}`);
  assert.equal((dropReadme.match(/\bsix\b/g) || []).length, 2, 'the README says six, in both places that count');
  assert.doesNotMatch(dropReadme, /\bseven\b/, 'and never still says seven');
  assert.doesNotMatch(dropReadme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
}

// ── the shape pack v12 mints on 1.0 ─────────────────────────────────────────
// All three mods that cannot run on Valheim 1.0 gone at once, leaving BepInEx,
// the stats client and the two Eilif plugins. --fallback on is what puts back the
// client half of what ValheimPlus was doing, and it needs the 1.6.0 pin.
const launchOmit = ['vplus', 'plant', 'azu']; // tonight's pack keeps the Companion Client; --no-companion-client is insurance only
const launchVersions = { paths: '1.6.0', companionClient: '0.3.4' };
const { files: launch } = renderPack({
  world: 'Eilif', omit: launchOmit, versions: launchVersions, fallback: 'on',
});
const launchR2x = launch.get('export.r2x').toString('latin1');
assert.deepEqual(
  [...launchR2x.matchAll(/^ {2}- name: (.+)$/gm)].map((m) => m[1]),
  [
    'denikson-BepInExPack_Valheim',
    'Proudlock_Technology-GsValheimStatsClient',
    'Eilif-EilifPaths',
    'Eilif-EilifCompanionClient',
  ],
  'four mods survive, in the order export.r2x lists them',
);
assert.deepEqual(
  [...launch.keys()].sort(),
  [
    'config/BepInEx.cfg',
    'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/net.eilif.companionclient.cfg',
    'config/net.eilif.paths.cfg',
    'doorstop_config.ini',
    'export.r2x',
  ],
  'four mods leave four cfgs, plus export.r2x and doorstop_config.ini',
);
assert.match(
  launchR2x,
  /- name: Eilif-EilifPaths\n {4}version:\n {6}major: 1\n {6}minor: 6\n {6}patch: 0\n/,
  'the 1.6.0 EilifPaths pin lands',
);
assert.match(
  launchR2x,
  /- name: Eilif-EilifCompanionClient\n {4}version:\n {6}major: 0\n {6}minor: 3\n {6}patch: 4\n/,
  'and the 0.3.4 companion client pin with it',
);
assert.doesNotMatch(launchR2x, /\{\{|\}\}/, 'three stacked drops still leave no marker residue');
assert.match(
  launch.get('config/net.eilif.paths.cfg').toString('latin1'), /^Enabled = true$/m,
  '--fallback on still writes the section when three mods are dropped at once',
);
// A dropped mod's cfgVersionVar simply goes unused - it must not become an error.
for (const key of launchOmit) {
  const mod = MODS.find((m) => m.key === key);
  if (mod.cfgVersionVar) {
    assert.doesNotThrow(
      () => renderPack({ world: 'Eilif', omit: launchOmit, versions: launchVersions, fallback: 'on' }),
      `${mod.label} is dropped, so ${mod.cfgVersionVar} is unused rather than fatal`,
    );
  }
}

const launchBundle = buildBundle({
  world: 'Eilif', versions: launchVersions, cfgVersions: {}, ingestUrl: undefined,
  packNumber: 12, packDate: 'Sep 9, 2026', omit: launchOmit, fallback: 'on',
});
assert.deepEqual(
  launchBundle.entries.map((e) => e.name),
  [
    'BepInEx.cfg',
    'net.cproudlock.gsvalheimstatsclient.cfg',
    'net.eilif.companionclient.cfg',
    'net.eilif.paths.cfg',
    'README.txt',
  ],
  'the Mac bundle is the same four cfgs, README last',
);
const launchReadme = launchBundle.entries.at(-1).data.toString('latin1');
for (const gone of [
  'valheim_plus', 'ValheimPlus', 'PlantEverything', 'AzuCraftyBoxes', 'Azumatt', 'Advize', 'Alt+O',
]) {
  assert.ok(!launchReadme.includes(gone), `the README of the 1.0 bundle never mentions ${gone}`);
}
assert.equal((launchReadme.match(/\bfour\b/g) || []).length, 2, 'it says four, in both places that count the files');
assert.doesNotMatch(launchReadme, /\bseven\b|\bsix\b|\bfive\b/, 'and no stale count survives');
assert.ok(
  launchReadme.includes('records will\nnot reach the dashboard.\n\nWhere they go'),
  'the sentence that named the Alt+O hotkey ends cleanly once AzuCraftyBoxes is gone',
);
assert.doesNotMatch(launchReadme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: launchOmit, fallback: 'on' },
    MODS.filter((m) => !launchOmit.includes(m.key))
      .map((mod) => ({ mod, version: launchVersions[mod.key] ?? mod.baseline }))),
  "--world 'Eilif' --paths 1.6.0 --companion-client 0.3.4 --no-vplus --no-plant --no-azu --fallback on",
  'and the printed bundle command carries all three drop flags, in MODS order',
);

// ── the [VPlusFallback] switch ──────────────────────────────────────────────
// Writing the section at all needs the build that has the code behind it, so
// every render here that is not 'none' pins EilifPaths 1.5.0.
// Every render here drops ValheimPlus, because since 2026-09-10 `--fallback on`
// with V+ still pinned is a hard refusal of its own (see the V+ guard below) and
// would mask the guard these assertions are about. The paths cfg is byte-identical
// either way: dropping V+ takes its export.r2x entry and its cfg, nothing else.
const pathsCfg = (fallback) => renderPack({
  world: 'Eilif', fallback, omit: ['vplus'], versions: fallback === 'none' ? {} : { paths: '1.5.0' },
}).files.get('config/net.eilif.paths.cfg').toString('latin1');

assert.equal(DEFAULT_FALLBACK, 'none', 'the section is absent unless someone asks for it, which is what v11 was');
assert.match(pathsCfg('on'), /^\[VPlusFallback\]$/m, "--fallback on writes the section");
assert.match(pathsCfg('on'), /^Enabled = true$/m, '--fallback on flips Enabled to true');
assert.match(pathsCfg('off'), /^\[VPlusFallback\]$/m, '--fallback off still writes the section');
assert.match(pathsCfg('off'), /^Enabled = false$/m, '...with Enabled = false');
assert.doesNotMatch(pathsCfg('none'), /VPlusFallback/, "--fallback none leaves the section out entirely");
assert.equal(pathsCfg(undefined), pathsCfg('none'), 'no flag means none');

// The guard that makes the switch impossible to ship dead. EilifPaths 1.4.0 has
// no [VPlusFallback] code, so a cfg carrying the key against a 1.4.0 pin is an
// orphaned BepInEx entry: every restored comfort silently absent, nothing
// anywhere erroring. This is the one failure mode the round trip cannot see.
for (const mode of ['on', 'off']) {
  assert.throws(
    () => renderPack({ world: 'Eilif', fallback: mode, omit: ['vplus'] }),
    /has no such section - it arrived in 1\.5\.0/,
    `--fallback ${mode} against the default 1.4.0 pin is refused`,
  );
  assert.throws(
    () => renderPack({ world: 'Eilif', fallback: mode, omit: ['vplus'], versions: { paths: '1.4.9' } }),
    /has no such section/,
    `--fallback ${mode} against any pre-1.5.0 pin is refused`,
  );
  // ...and the writer header follows the section rather than needing
  // --paths-cfg-version passed by hand on every launch-day command.
  assert.match(
    renderPack({ world: 'Eilif', fallback: mode, omit: ['vplus'], versions: { paths: '1.6.0' } })
      .files.get('config/net.eilif.paths.cfg').toString('latin1'),
    /^## Settings file was created by plugin Eilif Paths v1\.5\.0$/m,
    `--fallback ${mode} stamps the cfg header at the build that introduced the section`,
  );
}
assert.match(
  renderPack({ world: 'Eilif', fallback: 'on', omit: ['vplus'], versions: { paths: '1.5.0' }, cfgVersions: { paths: '1.6.1' } })
    .files.get('config/net.eilif.paths.cfg').toString('latin1'),
  /^## Settings file was created by plugin Eilif Paths v1\.6\.1$/m,
  'and --paths-cfg-version still wins when a real capture says otherwise',
);
assert.equal(compareSemver('1.20.0', '1.5.0'), 1, 'version parts compare numerically, not as strings');
assert.equal(compareSemver('1.5.0', '1.5.0'), 0);
assert.equal(compareSemver('1.4.9', '1.5.0'), -1);
// BepInEx writes sections in alphabetical order, so a hand-added section in the
// wrong place would be silently rewritten the first time the game saves the cfg.
const sectionOrder = [...pathsCfg('on').matchAll(/^\[([A-Za-z]+)\]$/gm)].map((m) => m[1]);
assert.deepEqual(
  sectionOrder,
  ['HardWood', 'Iron', 'Path', 'PavedRoad', 'Stone', 'VPlusFallback', 'Wood'],
  'the fallback section sits where BepInEx sorts it, between Stone and Wood',
);
assert.throws(() => renderPack({ world: 'Eilif', fallback: 'true' }), /fallback must be one of/, 'a bogus mode is refused');
assert.deepEqual(FALLBACK_MODES, ['on', 'off', 'none'], 'the three modes are the documented ones');
// Only the paths cfg carries it.
for (const [rel, data] of renderPack({ world: 'Eilif', fallback: 'on', omit: ['vplus'], versions: { paths: '1.5.0' } }).files) {
  if (rel === 'config/net.eilif.paths.cfg') continue;
  assert.doesNotMatch(data.toString('latin1'), /VPlusFallback/, `${rel} has no fallback section`);
}

// ── section markers ─────────────────────────────────────────────────────────
assert.equal(applySections('a\n{{#X}}\nb\n{{/X}}\nc\n', { X: true }, 't'), 'a\nb\nc\n', 'a kept block loses only its markers');
assert.equal(applySections('a\n{{#X}}\nb\n{{/X}}\nc\n', { X: false }, 't'), 'a\nc\n', 'a dropped block takes its body with it');
assert.equal(applySections('a\r\n{{#X}}\r\nb\r\n{{/X}}\r\nc\r\n', { X: false }, 't'), 'a\r\nc\r\n', 'CRLF templates work too');
assert.throws(() => applySections('{{#X}}\nb\n', { X: true }, 't'), /unbalanced/, 'an opener with no closer is a template bug, not a shipped literal');
assert.throws(() => applySections('{{#Y}}\nb\n{{/Y}}\n', { X: true }, 't'), /unknown section marker/, 'a marker nobody declared is caught before it ships');

// ── the bundle command carries the two new switches ─────────────────────────
assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: ['vplus'], fallback: 'on' },
    MODS.filter((m) => m.key !== 'vplus').map((mod) => ({ mod, version: mod.baseline }))),
  "--world 'Eilif' --no-vplus --fallback on",
  'a pack minted without V+ rebuilds a bundle without V+',
);
assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: [], fallback: DEFAULT_FALLBACK },
    MODS.map((mod) => ({ mod, version: mod.baseline }))),
  "--world 'Eilif'",
  'and the defaults are still forwarded as nothing at all',
);
assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: [], fallback: 'off' },
    MODS.map((mod) => ({ mod, version: mod.key === 'paths' ? '1.5.0' : mod.baseline }))),
  "--world 'Eilif' --paths 1.5.0 --fallback off",
  'a non-default fallback travels even when it is only writing Enabled = false',
);

// ── ValheimPlus 10 renamed its cfg, so the filename follows the pin ─────────
// V+ 10 reads BepInEx/config/org.bepinex.plugins.valheim_plus.cfg and imports the
// old valheim_plus.cfg once before renaming it .migrated. A pack pinning 10.x that
// shipped the old name would therefore drop a file the plugin reads once, next to
// the file it actually reads, with every setting silently at its default - which is
// exactly the class of failure no round trip and no boot can see.
const vplusMod = MODS.find((m) => m.key === 'vplus');
assert.equal(cfgFor(vplusMod, '9.17.1'), 'valheim_plus.cfg', 'a pre-10 pin ships the legacy name');
assert.equal(cfgFor(vplusMod, '9.99.99'), 'valheim_plus.cfg', '...right up to the boundary');
assert.equal(cfgFor(vplusMod, '10.0.0'), 'org.bepinex.plugins.valheim_plus.cfg', '10.0.0 is where it changes');
assert.equal(cfgFor(vplusMod, '10.0.2'), 'org.bepinex.plugins.valheim_plus.cfg', 'and 10.0.2 is what v14 pins');
assert.equal(cfgFor(vplusMod), 'valheim_plus.cfg', 'no version means the baseline, which is v11 s');
assert.deepEqual(
  cfgNamesFor(vplusMod),
  ['valheim_plus.cfg', 'org.bepinex.plugins.valheim_plus.cfg'],
  'both names are declared, newest last, so the README can recognise either',
);
for (const mod of MODS.filter((m) => m.cfg && m.key !== 'vplus')) {
  assert.equal(cfgFor(mod, '99.0.0'), mod.cfg, `${mod.label} has one cfg name at every version`);
}
assert.deepEqual(cfgFilesFor(), CFG_FILES, 'the baseline pins render exactly the v11 cfg list');
assert.deepEqual(
  cfgFilesFor({ vplus: '10.0.2' }),
  CFG_FILES.map((n) => (n === 'valheim_plus.cfg' ? 'org.bepinex.plugins.valheim_plus.cfg' : n)),
  'and a 10.x pin swaps the name IN PLACE, so the zip entry order does not move',
);

// ── the shape pack v14 mints: ValheimPlus is back ───────────────────────────
// Grantapher published 10.0.2 on 2026-09-10, a real 1.0 build with a working
// CraftFromChest, so V+ returns and takes AzuCraftyBoxes' job with it.
// PlantEverything stays out (still no 1.0 build), and BOTH fallbacks go off.
const V14 = {
  versions: { vplus: '10.0.2', bepinex: '5.4.2350', paths: '1.7.1', companionClient: '0.4.0' },
  omit: ['plant', 'azu'],
  fallback: 'off',
};
const { files: v14 } = renderPack({ world: 'Eilif', ...V14 });
assert.deepEqual(
  [...v14.keys()].sort(),
  [
    'config/BepInEx.cfg',
    'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/net.eilif.companionclient.cfg',
    'config/net.eilif.paths.cfg',
    'config/org.bepinex.plugins.valheim_plus.cfg',
    'doorstop_config.ini',
    'export.r2x',
  ],
  'v14 ships the V+ 10 cfg under its new name and four others',
);
assert.ok(!v14.has('config/valheim_plus.cfg'), 'and never the legacy name alongside it');
const v14R2x = v14.get('export.r2x').toString('latin1');
assert.match(
  v14R2x,
  /- name: Grantapher-ValheimPlus_Grantapher_Temporary\n {4}version:\n {6}major: 10\n {6}minor: 0\n {6}patch: 2\n/,
  'the 10.0.2 ValheimPlus pin lands in export.r2x',
);
assert.match(
  v14R2x,
  /- name: denikson-BepInExPack_Valheim\n {4}version:\n {6}major: 5\n {6}minor: 4\n {6}patch: 2350\n/,
  'against BepInExPack 5.4.2350, the version V+ 10.0.2 declares',
);
assert.match(
  v14R2x,
  /- name: Eilif-EilifPaths\n {4}version:\n {6}major: 1\n {6}minor: 7\n {6}patch: 1\n/,
  'EilifPaths 1.7.1',
);
assert.match(
  v14R2x,
  /- name: Eilif-EilifCompanionClient\n {4}version:\n {6}major: 0\n {6}minor: 4\n {6}patch: 0\n/,
  'and Companion Client 0.4.0',
);
assert.doesNotMatch(v14R2x, /PlantEverything|AzuCraftyBoxes/, 'the two 1.0 casualties stay out');
assert.doesNotMatch(v14R2x, /\{\{|\}\}/, 'no marker residue');

// The client half of the fallback must be visibly, deliberately false rather than
// absent: EilifPaths 1.7.1 HAS the section, so leaving it out would mean the key
// arrives at the plugin default on first run instead of at our decision.
const v14Paths = v14.get('config/net.eilif.paths.cfg').toString('latin1');
assert.match(v14Paths, /^\[VPlusFallback\]$/m, 'v14 writes the [VPlusFallback] section');
assert.match(v14Paths, /^Enabled = false$/m, '...with Enabled = false, because V+ is doing that job again');

// The shipped V+ cfg is the box's own file verbatim - V+ syncs server config to
// clients, so anything else would be a second opinion nobody asked for.
const v14Vplus = v14.get('config/org.bepinex.plugins.valheim_plus.cfg').toString('latin1');
assert.match(
  v14Vplus, /^## Settings file was created by plugin Valheim Plus v0\.10\.0\.2$/m,
  'the cfg carries the assembly version 10.0.2 ships as',
);
assert.match(v14Vplus, /^maxPlayers = 24$/m, 'the cap now lives in V+ [Server] maxPlayers');
assert.match(v14Vplus, /^enforceMod = true$/m, 'enforceMod stays on, which is what makes the pack all-or-nothing');
assert.match(v14Vplus, /^serverSyncsConfig = true$/m, 'and the server is the one that decides');
assert.equal(
  section(v14Vplus, 'CraftFromChest').enabled, 'true',
  'CraftFromChest is ON - it is what replaces AzuCraftyBoxes',
);
assert.equal(section(v14Vplus, 'CraftFromChest').range, '30', '...at the 30m range the box is set to');

/** The `key = value` pairs of one BepInEx cfg section, comments and blanks dropped. */
function section(cfg, name) {
  const body = cfg.split(`\n[${name}]\n`)[1];
  assert.ok(body !== undefined, `${name} is a section in the shipped cfg`);
  const out = {};
  for (const line of body.split('\n')) {
    if (/^\[/.test(line)) break;
    const m = /^([A-Za-z][\w.]*) = (.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
assert.match(v14Vplus, /^workbenchAttachmentRange = 20$/m, 'and the workbench range the crew has been playing');

// The rename must not disturb the zip's entry order: V+ sits where it always sat.
assert.deepEqual(
  centralNames(zipSync([...v14].map(([name, data]) => ({ name, data })))),
  [
    'export.r2x', 'doorstop_config.ini', 'config/',
    'config/net.eilif.paths.cfg', 'config/BepInEx.cfg',
    'config/net.eilif.companionclient.cfg', 'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/org.bepinex.plugins.valheim_plus.cfg',
  ],
  'the renamed cfg keeps the ValheimPlus slot in the order r2modman writes',
);

// ── the v14 Mac bundle ──────────────────────────────────────────────────────
const v14Bundle = buildBundle({
  world: 'Eilif', versions: V14.versions, cfgVersions: {}, ingestUrl: undefined,
  packNumber: 14, packDate: 'Sep 10, 2026', omit: V14.omit, fallback: V14.fallback,
});
assert.deepEqual(
  v14Bundle.entries.map((e) => e.name),
  [
    'BepInEx.cfg',
    'net.cproudlock.gsvalheimstatsclient.cfg',
    'net.eilif.companionclient.cfg',
    'net.eilif.paths.cfg',
    'org.bepinex.plugins.valheim_plus.cfg',
    'README.txt',
  ],
  'the Mac bundle is the same five cfgs, README last',
);
const v14Readme = v14Bundle.entries.at(-1).data.toString('latin1');
assert.match(
  v14Readme, /^  org\.bepinex\.plugins\.valheim_plus\.cfg {6}the server overrides most of this$/m,
  'the README names the file that is actually in the zip, still aligned at column 44',
);
assert.doesNotMatch(v14Readme, /^ {2}valheim_plus\.cfg /m, 'and never the legacy name on its own');
assert.equal((v14Readme.match(/\bfive\b/g) || []).length, 2, 'it says five, in both places that count the files');
assert.doesNotMatch(v14Readme, /\bseven\b|\bsix\b|\bfour\b/, 'and no stale count survives');
for (const gone of ['PlantEverything', 'AzuCraftyBoxes', 'Azumatt', 'Advize', 'Alt+O']) {
  assert.ok(!v14Readme.includes(gone), `the v14 README never mentions ${gone}`);
}
assert.doesNotMatch(v14Readme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
// The v11 README is the byte tripwire for the same line, so prove the padding is
// computed rather than typed: both names land their description at column 44.
assert.match(
  renderReadme({ packNumber: 11, packDate: 'Aug 27, 2026' }).toString('latin1'),
  /^ {2}valheim_plus\.cfg {26}the server overrides most of this$/m,
  'the legacy name keeps the v11 spacing exactly',
);

assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: V14.omit, fallback: V14.fallback },
    MODS.filter((m) => !V14.omit.includes(m.key))
      .map((mod) => ({ mod, version: V14.versions[mod.key] ?? mod.baseline }))),
  "--world 'Eilif' --bepinex 5.4.2350 --vplus 10.0.2 --paths 1.7.1 --companion-client 0.4.0 "
  + '--no-plant --no-azu --fallback off',
  'the printed bundle command reproduces the v14 pack exactly',
);

// ── --fallback on is refused while ValheimPlus is in the pack ───────────────
// [VPlusFallback] is the CLIENT half of what V+ itself does. With both present
// they patch the same methods and stack, and EilifPaths detects V+ at boot and
// refuses to apply the section anyway, logging a warning nobody reads. Either way
// the pack lies about what it does, so the render refuses instead.
assert.throws(
  () => renderPack({ world: 'Eilif', versions: { vplus: '10.0.2', paths: '1.7.1' }, fallback: 'on' }),
  /still pins ValheimPlus/,
  '--fallback on with V+ pinned is refused',
);
assert.throws(
  () => renderPack({ world: 'Eilif', versions: { paths: '1.7.1' }, fallback: 'on' }),
  /still pins ValheimPlus/,
  '...at the old pin too, so this is about presence, not version',
);
assert.doesNotThrow(
  () => renderPack({ world: 'Eilif', ...V14 }),
  '--fallback off with V+ pinned is the v14 pairing and is fine',
);
assert.doesNotThrow(
  () => renderPack({ world: 'Eilif', versions: V14.versions, omit: V14.omit, fallback: 'none' }),
  'and --fallback none is fine too: no section at all is off',
);
assert.doesNotThrow(
  () => renderPack({ world: 'Eilif', versions: { paths: '1.7.1' }, omit: ['vplus'], fallback: 'on' }),
  'while --no-vplus --fallback on stays exactly as it was on launch night',
);

// ── Unshamed: the first OPTIONAL mod ────────────────────────────────────────
// Valheim 1.0 refuses Steam achievements to any modded client (IsCheatedAtAll()
// ORs Game.isModded), and Unshamed postfixes that one check. It was not in pack
// v11, so unlike every droppable mod it defaults to ABSENT: the v11 tripwire at
// the top of this file is only a tripwire while a bare `--world X` render still
// produces exactly v11's file list, and an eighth mod appearing by default would
// have quietly re-baselined it.
const unshamedMod = MODS.find((m) => m.key === 'unshamed');
assert.deepEqual(
  OPTIONAL_MODS.map((m) => m.key), ['plantFork', 'unshamed'],
  'the optional set is the PlantEverything rebuild and Unshamed, in MODS order',
);
assert.equal(unshamedMod.baseline, null, 'an optional mod has no baseline: there is no v11 pin to fall back to');
assert.ok(!unshamedMod.omitFlag, 'and no --no- flag, because absent is already its default');
assert.ok(unshamedMod.section, 'it declares its export.r2x section marker like every other decided mod');
assert.equal(unshamedMod.cfg, 'Azumatt.Unshamed.cfg', 'and the cfg that arrives with it');
assert.ok(!CFG_FILES.includes(unshamedMod.cfg), 'which is NOT in the v11 cfg list, because v11 never shipped it');
assert.deepEqual(
  SECTIONED_MODS.map((m) => m.key).slice().sort(),
  [...OMITTABLE_MODS.map((m) => m.key), ...OPTIONAL_MODS.map((m) => m.key)].sort(),
  'droppable and optional mods are the same mechanism, resolved through one set',
);

// Absent by default, in every artifact.
assert.ok(!v11.has(`config/${unshamedMod.cfg}`), 'a default render ships no Unshamed cfg');
assert.doesNotMatch(v11.get('export.r2x').toString('latin1'), /Unshamed/, 'and no export.r2x entry');
assert.deepEqual(cfgFilesFor(), CFG_FILES, 'cfgFilesFor still returns exactly the v11 list when nothing optional is pinned');
assert.deepEqual(
  cfgFilesFor({ unshamed: '1.0.0' }),
  [...CFG_FILES, 'Azumatt.Unshamed.cfg'],
  'a pin APPENDS its cfg, so the seven v11 entries keep their positions in the zip',
);
assert.ok(
  !renderReadme({ packNumber: 11, packDate: 'Aug 27, 2026' }).toString('latin1').includes('Unshamed'),
  'and the v11 Mac README never mentions it',
);

// Present the moment it is pinned, entry and cfg together.
const { files: withUnshamed } = renderPack({ world: 'EilifRehearsal', versions: { unshamed: '1.0.0' } });
assert.deepEqual(
  [...withUnshamed.keys()].sort(),
  [...v11.keys(), 'config/Azumatt.Unshamed.cfg'].sort(),
  '--unshamed 1.0.0 adds exactly one file to the v11 set',
);
const unshamedR2x = withUnshamed.get('export.r2x').toString('latin1');
assert.match(
  unshamedR2x,
  /- name: Azumatt-Unshamed\n {4}version:\n {6}major: 1\n {6}minor: 0\n {6}patch: 0\n/,
  'the 1.0.0 pin lands in export.r2x as Azumatt-Unshamed',
);
assert.equal(
  (unshamedR2x.match(/- name: /g) || []).length, DEFAULT_MOD_COUNT + 1,
  'and it is an addition, not a replacement',
);
assert.doesNotMatch(unshamedR2x, /\{\{|\}\}/, 'no marker residue when an optional block is kept');
// Everything else is untouched: an optional mod arriving must not disturb a
// single byte of what the pack already shipped.
for (const [rel, data] of withUnshamed) {
  if (rel === 'export.r2x' || rel === 'config/Azumatt.Unshamed.cfg') continue;
  assert.ok(data.equals(v11.get(rel)), `${rel} is untouched by --unshamed: ${firstDiff(v11.get(rel), data)}`);
}

// ── the pinned cfg is the whole point ───────────────────────────────────────
// Unshamed's OWN defaults wipe the character's cheat flag on load, on save and
// after a dev command, and zero the Cheats stat with it. That is cheat-flag
// washing, and Eilif wants none of it: a viking who typed a cheat command stays
// disqualified exactly as in vanilla. Only "Ignore Modded Flag" is on, which is
// the one thing this mod is here to do. If this ever renders On, the pack is
// laundering saves and nothing downstream would say so.
const unshamedCfg = withUnshamed.get('config/Azumatt.Unshamed.cfg').toString('latin1');
assert.match(
  unshamedCfg, /^## Settings file was created by plugin Unshamed v1\.0\.0$/m,
  'the cfg carries the writer header of the build that wrote it',
);
assert.match(unshamedCfg, /^## Plugin GUID: Azumatt\.Unshamed$/m, 'and the plugin GUID BepInEx writes under it');
const unshamedValues = Object.fromEntries(
  [...unshamedCfg.matchAll(/^([A-Z][A-Za-z ]*[a-z]) = (.*)$/gm)].map((m) => [m[1], m[2]]),
);
assert.deepEqual(
  unshamedValues,
  {
    Enabled: 'On',
    'Clear On Load': 'Off',
    'Clear On Save': 'Off',
    'Clear After Command': 'Off',
    'Clear Cheat Stat': 'Off',
    'Ignore Modded Flag': 'On',
    'Show Popups': 'Off',
    'Force True Methods': '',
    'Force False Methods': '',
    'Enable Retroactive': 'Off',
  },
  'every Clear switch is pinned Off against the mod\'s own On defaults, and the overrides stay empty',
);
// BepInEx orders sections alphabetically and writes entries in Bind order, so a
// hand-edited template in the wrong order would be silently rewritten the first
// time the game saves the file.
assert.deepEqual(
  [...unshamedCfg.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]),
  ['1 - General', '2 - Overrides', '3 - Retroactive'],
  'the three sections sit where BepInEx sorts them',
);

// ── the v14 shape with Unshamed in it ───────────────────────────────────────
const V14U = {
  versions: {
    vplus: '10.0.2', bepinex: '5.4.2350', paths: '1.7.1', companionClient: '0.4.1', unshamed: '1.0.0',
  },
  omit: ['plant', 'azu'],
  fallback: 'off',
};
const { files: v14u } = renderPack({ world: 'Eilif', ...V14U });
assert.deepEqual(
  [...v14u.keys()].sort(),
  [
    'config/Azumatt.Unshamed.cfg',
    'config/BepInEx.cfg',
    'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/net.eilif.companionclient.cfg',
    'config/net.eilif.paths.cfg',
    'config/org.bepinex.plugins.valheim_plus.cfg',
    'doorstop_config.ini',
    'export.r2x',
  ],
  'six mods, six cfgs, plus export.r2x and doorstop_config.ini',
);
assert.deepEqual(
  [...v14u.get('export.r2x').toString('latin1').matchAll(/^ {2}- name: (.+)$/gm)].map((m) => m[1]),
  [
    'denikson-BepInExPack_Valheim',
    'Grantapher-ValheimPlus_Grantapher_Temporary',
    'Proudlock_Technology-GsValheimStatsClient',
    'Eilif-EilifPaths',
    'Eilif-EilifCompanionClient',
    'Azumatt-Unshamed',
  ],
  'and Unshamed sits last, where its template block was appended',
);
assert.match(
  v14u.get('export.r2x').toString('latin1'),
  /- name: Eilif-EilifCompanionClient\n {4}version:\n {6}major: 0\n {6}minor: 4\n {6}patch: 1\n/,
  'the 0.4.1 companion client pin lands alongside it',
);

const v14uBundle = buildBundle({
  world: 'Eilif', versions: V14U.versions, cfgVersions: {}, ingestUrl: undefined,
  packNumber: 14, packDate: 'Sep 10, 2026', omit: V14U.omit, fallback: V14U.fallback,
});
assert.deepEqual(
  v14uBundle.entries.map((e) => e.name),
  [
    'Azumatt.Unshamed.cfg',
    'BepInEx.cfg',
    'net.cproudlock.gsvalheimstatsclient.cfg',
    'net.eilif.companionclient.cfg',
    'net.eilif.paths.cfg',
    'org.bepinex.plugins.valheim_plus.cfg',
    'README.txt',
  ],
  'the Mac bundle carries the Unshamed cfg too, README last',
);
const v14uReadme = v14uBundle.entries.at(-1).data.toString('latin1');
assert.equal((v14uReadme.match(/\bsix\b/g) || []).length, 2, 'it says six, in both places that count the files');
assert.doesNotMatch(v14uReadme, /\bseven\b|\bfive\b|\bfour\b/, 'and no stale count survives');
assert.match(
  v14uReadme, /^ {2}Azumatt\.Unshamed\.cfg {22}keeps Steam achievements working$/m,
  'the README names the cfg sitting next to it, aligned at column 44 like the rest',
);
assert.doesNotMatch(v14uReadme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
// ...and the same bundle WITHOUT the pin neither counts nor names it, which is
// the failure the count/name pair exists to catch.
assert.ok(!v14Readme.includes('Unshamed'), 'a bundle built without the pin never names Unshamed');

assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: V14U.omit, fallback: V14U.fallback },
    MODS.filter((m) => !V14U.omit.includes(m.key) && (!m.optional || V14U.versions[m.key]))
      .map((mod) => ({ mod, version: V14U.versions[mod.key] ?? mod.baseline }))),
  "--world 'Eilif' --bepinex 5.4.2350 --vplus 10.0.2 --paths 1.7.1 --companion-client 0.4.1 "
  + '--unshamed 1.0.0 --no-plant --no-azu --fallback off',
  'the printed bundle command carries the optional pin, so the Mac bundle cannot lose it',
);
// It is not droppable, because it was never there to drop.
assert.throws(
  () => renderPack({ world: 'Eilif', omit: ['unshamed'] }),
  /cannot be dropped/,
  'omitting an optional mod is refused: leaving out its pin is the way to not have it',
);


// ── the PlantEverything rebuild: one cfg, two possible owners ───────────────
// fedorovdgap/PlantEverything 1.21.1 (2026-09-10) is Advize's own master branch
// republished: same plugin GUID, same internal settings schema, same cfg FILE NAME
// as Advize/PlantEverything. That makes it the first row in MODS whose `cfg` is not
// unique, and the whole risk lives there. `--no-plant --plant-fork 1.21.1` asks the
// machinery to drop a cfg (with the Advize package) and to add the same cfg (with
// the fork) in one render, and either half winning alone is a silent failure: two
// zip entries with one name, or a farming mod that arrives unconfigured.
const forkMod = MODS.find((m) => m.key === 'plantFork');
const plantMod = MODS.find((m) => m.key === 'plant');
assert.equal(forkMod.baseline, null, 'the fork is optional, so it has no v11 pin');
assert.ok(forkMod.optional && !forkMod.omitFlag, 'and no --no- flag: absent is already its default');
assert.equal(forkMod.cfg, plantMod.cfg, 'it contributes the SAME cfg file the Advize package does');
assert.equal(forkMod.ns, 'fedorovdgap', 'under its own Thunderstore namespace');
assert.equal(forkMod.name, plantMod.name, 'with the same package name');

// Absent by default: the v11 tripwire at the top of this file already proved the
// default render is v11, so this only has to prove the fork did not sneak in.
assert.doesNotMatch(v11.get('export.r2x').toString('latin1'), /fedorovdgap/, 'a default render has no fork entry');
assert.deepEqual(cfgFilesFor(), CFG_FILES, 'and cfgFilesFor is still exactly the v11 list');
// The dedupe: asking for the fork does NOT append a second copy of a name the list
// already carries, and the name keeps its v11 slot rather than moving to the end.
assert.deepEqual(
  cfgFilesFor({ plantFork: '1.21.1' }), CFG_FILES,
  'the fork claims a cfg the list already has, so nothing is appended and nothing moves',
);
assert.deepEqual(
  cfgFilesFor({ plantFork: '1.21.1', unshamed: '1.0.0' }),
  [...CFG_FILES, 'Azumatt.Unshamed.cfg'],
  'while a genuinely new optional cfg is still appended',
);

// ── the v15 shape: the fork replaces Advize ─────────────────────────────────
const V15 = {
  versions: {
    vplus: '10.0.2', bepinex: '5.4.2350', paths: '1.7.1', companionClient: '0.4.2',
    unshamed: '1.0.0', plantFork: '1.21.1',
  },
  omit: ['plant', 'azu'],
  fallback: 'off',
};
const { files: v15 } = renderPack({ world: 'Eilif', ...V15 });
assert.deepEqual(
  [...v15.keys()].sort(),
  [
    'config/Azumatt.Unshamed.cfg',
    'config/BepInEx.cfg',
    'config/advize.PlantEverything.cfg',
    'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/net.eilif.companionclient.cfg',
    'config/net.eilif.paths.cfg',
    'config/org.bepinex.plugins.valheim_plus.cfg',
    'doorstop_config.ini',
    'export.r2x',
  ],
  'seven mods, seven cfgs: the plant cfg is still there, having changed owner rather than left',
);
// The load-bearing one. A Map cannot hold the name twice, so the zip is where a
// double would show, and the drop/append pair is where a LOSS would.
assert.deepEqual(
  centralNames(zipSync([...v15].map(([name, data]) => ({ name, data })))),
  [
    'export.r2x', 'doorstop_config.ini', 'config/',
    'config/net.eilif.paths.cfg', 'config/BepInEx.cfg', 'config/advize.PlantEverything.cfg',
    'config/net.eilif.companionclient.cfg', 'config/net.cproudlock.gsvalheimstatsclient.cfg',
    'config/org.bepinex.plugins.valheim_plus.cfg', 'config/Azumatt.Unshamed.cfg',
  ],
  'config/advize.PlantEverything.cfg appears exactly once, in the slot v11 gave it',
);
// Same template, same bytes: the fork's settings schema has not moved, so a player
// swapping packages gets the file they already had.
assert.equal(
  sha(v15.get('config/advize.PlantEverything.cfg')),
  V11['config/advize.PlantEverything.cfg'],
  'and it is byte-identical to the cfg pack v11 shipped',
);

const v15R2x = v15.get('export.r2x').toString('latin1');
assert.match(
  v15R2x,
  /- name: fedorovdgap-PlantEverything\n {4}version:\n {6}major: 1\n {6}minor: 21\n {6}patch: 1\n/,
  'the 1.21.1 pin lands in export.r2x under the fedorovdgap namespace',
);
assert.doesNotMatch(v15R2x, /Advize/, 'and the Advize entry is gone, so no client installs both');
assert.equal(
  (v15R2x.match(/- name: PlantEverything|PlantEverything/g) || []).length, 1,
  'PlantEverything is named once in export.r2x, not twice',
);
assert.deepEqual(
  [...v15R2x.matchAll(/^ {2}- name: (.+)$/gm)].map((m) => m[1]),
  [
    'denikson-BepInExPack_Valheim',
    'Grantapher-ValheimPlus_Grantapher_Temporary',
    'fedorovdgap-PlantEverything',
    'Proudlock_Technology-GsValheimStatsClient',
    'Eilif-EilifPaths',
    'Eilif-EilifCompanionClient',
    'Azumatt-Unshamed',
  ],
  'and the fork sits where the Advize entry sat, right after ValheimPlus',
);
assert.doesNotMatch(v15R2x, /\{\{|\}\}/, 'no marker residue');
// Nothing else moved: v15 is v14-with-Unshamed plus exactly one file back, and the
// file that came back is the one pack v11 shipped. (export.r2x carries the pins, and
// v14u pinned Companion Client 0.4.1.)
assert.deepEqual(
  [...v15.keys()].sort(),
  [...v14u.keys(), 'config/advize.PlantEverything.cfg'].sort(),
  'v15 adds exactly one file to the v14 set',
);
for (const [rel, data] of v15) {
  if (rel === 'export.r2x' || rel === 'config/advize.PlantEverything.cfg') continue;
  assert.ok(data.equals(v14u.get(rel)), `${rel} is the same file v14 shipped: ${firstDiff(v14u.get(rel), data)}`);
}

// ── pinning both PlantEverythings is refused ────────────────────────────────
// The fork is not an eighth mod, it is the same plugin GUID under another
// namespace. r2modman would install two copies and BepInEx would load whichever it
// saw last - and neither the mint, the round trip nor the boot would say so.
assert.throws(
  () => renderPack({ world: 'Eilif', versions: { plantFork: '1.21.1' } }),
  /pins BOTH PlantEverythings/,
  '--plant-fork without --no-plant is refused, because plant is in the pack by default',
);
assert.throws(
  () => renderPack({ world: 'Eilif', versions: { plant: '1.20.0', plantFork: '1.21.1' } }),
  /pins BOTH PlantEverythings/,
  '...and explicitly pinning both is the same refusal',
);
assert.throws(
  () => renderPack({ world: 'Eilif', versions: { plantFork: '1.21.1' } }),
  /--no-plant --plant-fork 1\.21\.1/,
  'and the message names the flag pair that does work',
);
assert.doesNotThrow(
  () => renderPack({ world: 'Eilif', versions: { plantFork: '1.21.1' }, omit: ['plant'] }),
  '--no-plant --plant-fork is the v15 pairing and is fine',
);
assert.doesNotThrow(
  () => renderPack({ world: 'Eilif' }),
  'and a pack with only the Advize package is untouched by any of this',
);

// ── the v15 Mac bundle ──────────────────────────────────────────────────────
const v15Bundle = buildBundle({
  world: 'Eilif', versions: V15.versions, cfgVersions: {}, ingestUrl: undefined,
  packNumber: 15, packDate: 'Sep 10, 2026', omit: V15.omit, fallback: V15.fallback,
});
assert.deepEqual(
  v15Bundle.entries.map((e) => e.name),
  [
    'Azumatt.Unshamed.cfg',
    'BepInEx.cfg',
    'advize.PlantEverything.cfg',
    'net.cproudlock.gsvalheimstatsclient.cfg',
    'net.eilif.companionclient.cfg',
    'net.eilif.paths.cfg',
    'org.bepinex.plugins.valheim_plus.cfg',
    'README.txt',
  ],
  'the Mac bundle carries the plant cfg once, README last',
);
const v15Readme = v15Bundle.entries.at(-1).data.toString('latin1');
// The README is derived from the bundle's own entry list, so the {{#PLANT}} line
// survives the namespace change with no template edit - and must survive it, or a
// Mac player is handed a file the instructions never mention.
assert.equal(
  (v15Readme.match(/^ {2}advize\.PlantEverything\.cfg {16}farming settings, synced by server$/gm) || []).length,
  1,
  'the README names the plant cfg exactly once, still aligned at column 44',
);
assert.equal((v15Readme.match(/\bseven\b/g) || []).length, 2, 'it says seven, in both places that count the files');
assert.doesNotMatch(v15Readme, /\bsix\b|\bfive\b|\bfour\b|\beight\b/, 'and no stale count survives');
assert.doesNotMatch(v15Readme, /\{\{|\}\}/, 'no marker or placeholder residue survives into the README');
assert.equal(
  renderReadme({ packNumber: 15, packDate: 'Sep 10, 2026', cfgs: v15Bundle.entries.slice(0, -1).map((e) => e.name) })
    .toString('latin1'),
  v15Readme,
  'the bundle README is exactly renderReadme() over the entries sitting next to it',
);

assert.equal(
  bundleArgs({ world: 'Eilif', ingestUrl: DEFAULT_INGEST_URL, cfgVersions: {}, omit: V15.omit, fallback: V15.fallback },
    MODS.filter((m) => !V15.omit.includes(m.key) && (!m.optional || V15.versions[m.key]))
      .map((mod) => ({ mod, version: V15.versions[mod.key] ?? mod.baseline }))),
  "--world 'Eilif' --bepinex 5.4.2350 --vplus 10.0.2 --plant-fork 1.21.1 --paths 1.7.1 "
  + '--companion-client 0.4.2 --unshamed 1.0.0 --no-plant --no-azu --fallback off',
  'the printed bundle command carries both halves of the swap, so the Mac bundle cannot lose either',
);

console.log('OK — all pack minter assertions passed');
