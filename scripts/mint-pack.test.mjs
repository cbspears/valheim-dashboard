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
// length), minting without ValheimPlus (--no-vplus) including what the Mac
// README then says, the [VPlusFallback] switch and its version guard, the
// {{#SECTION}} marker machinery, the zip writer/reader pair, and the argument
// guards.
//
// Run: npx tsx scripts/mint-pack.test.mjs
import assert from 'node:assert';
import crypto from 'node:crypto';

import {
  MODS, CFG_FILES, DEFAULT_INGEST_URL, DEFAULT_FALLBACK, FALLBACK_MODES, OMITTABLE_MODS,
  renderPack, renderReadme, parseSemver, compareSemver, zipSync, unzipSync, crc32, firstDiff,
  bundleArgs, applySections,
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
  (noVplusR2x.match(/- name: /g) || []).length, MODS.length - 1,
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
// Only V+ is droppable, and only through its own flag.
assert.deepEqual(OMITTABLE_MODS.map((m) => m.key), ['vplus'], 'ValheimPlus is the only droppable mod');
for (const mod of OMITTABLE_MODS) {
  assert.ok(mod.cfg, `${mod.label} declares the cfg that leaves with it`);
  assert.ok(mod.section, `${mod.label} declares its export.r2x section marker`);
}
assert.throws(() => renderPack({ world: 'Eilif', omit: ['azu'] }), /cannot be dropped/, 'a non-droppable mod is refused');
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

// ── the [VPlusFallback] switch ──────────────────────────────────────────────
// Writing the section at all needs the build that has the code behind it, so
// every render here that is not 'none' pins EilifPaths 1.5.0.
const pathsCfg = (fallback) => renderPack({
  world: 'Eilif', fallback, versions: fallback === 'none' ? {} : { paths: '1.5.0' },
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
    () => renderPack({ world: 'Eilif', fallback: mode }),
    /has no such section - it arrived in 1\.5\.0/,
    `--fallback ${mode} against the default 1.4.0 pin is refused`,
  );
  assert.throws(
    () => renderPack({ world: 'Eilif', fallback: mode, versions: { paths: '1.4.9' } }),
    /has no such section/,
    `--fallback ${mode} against any pre-1.5.0 pin is refused`,
  );
  // ...and the writer header follows the section rather than needing
  // --paths-cfg-version passed by hand on every launch-day command.
  assert.match(
    renderPack({ world: 'Eilif', fallback: mode, versions: { paths: '1.6.0' } })
      .files.get('config/net.eilif.paths.cfg').toString('latin1'),
    /^## Settings file was created by plugin Eilif Paths v1\.5\.0$/m,
    `--fallback ${mode} stamps the cfg header at the build that introduced the section`,
  );
}
assert.match(
  renderPack({ world: 'Eilif', fallback: 'on', versions: { paths: '1.5.0' }, cfgVersions: { paths: '1.6.1' } })
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
for (const [rel, data] of renderPack({ world: 'Eilif', fallback: 'on', versions: { paths: '1.5.0' } }).files) {
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

console.log('OK — all pack minter assertions passed');
