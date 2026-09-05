// Rebuild public/downloads/eilif-configs-pack-v<N>.zip - the "Mac bundle" the
// Get Started page hands to anyone who installed the mods by hand (Macheim
// cannot read an r2modman pack code, so those players need the .cfg files
// themselves).
//
//   Node 20:  export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
//
//   Preview:  node scripts/build-config-bundle.mjs --world Eilif \
//               --pack-number 12 --pack-date 'Sep 9, 2026' --dry-run
//   Write:    node scripts/build-config-bundle.mjs --world Eilif \
//               --pack-number 12 --pack-date 'Sep 9, 2026'
//
// The whole point: this renders from scripts/pack-templates through the SAME
// renderer scripts/mint-pack.mjs uses, so the bundle a Mac player unzips and the
// pack an r2modman player imports cannot drift apart. Pass this script the same
// --world and the same version pins you passed the minter and the two agree by
// construction. Pass it different ones and they do not - so run it from the
// docs/PACK.md checklist, right after the mint, with the same flags.
//
// It writes a file and nothing else: no deploy, no edit to config/server.ts, and
// no edit to app/get-started/page.tsx (whose CONFIG_BUNDLE_URL still has to be
// pointed at the new filename by hand - the script prints the reminder).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MODS, OMITTABLE_MODS, ROOT, DEFAULT_INGEST_URL, DEFAULT_FALLBACK, FALLBACK_MODES,
  renderPack, renderReadme, zipSync, unzipSync, banner, firstDiff,
} from './mint-pack.mjs';

const DEFAULT_OUT = path.join(ROOT, 'public', 'downloads');
const ok = (s) => `  ok   ${s}`;
const bad = (s) => `  FAIL ${s}`;

/**
 * The bundle's contents: whatever cfgs the pack itself ships, flat (no config/
 * folder), plus a README.
 *
 * The names come from the rendered file map rather than from CFG_FILES, so a
 * pack minted with --no-vplus produces a bundle with no valheim_plus.cfg in it
 * for free. Reading the constant instead would hand Mac players a config for a
 * mod the pack no longer installs.
 */
export function buildBundle({
  world, versions, cfgVersions, ingestUrl, packNumber, packDate,
  omit = [], fallback = DEFAULT_FALLBACK,
}) {
  const { files } = renderPack({ world, versions, cfgVersions, ingestUrl, omit, fallback });
  const entries = [...files.keys()]
    .filter((k) => k.startsWith('config/'))
    .map((k) => k.slice('config/'.length))
    .sort()
    .map((name) => ({ name, data: files.get(`config/${name}`) }));
  // The README is told what is actually in the zip, so its count and its file
  // list cannot disagree with the entries above.
  entries.push({
    name: 'README.txt',
    data: renderReadme({ packNumber, packDate, cfgs: entries.map((e) => e.name) }),
  });
  return { entries, zip: zipSync(entries) };
}

const USAGE = `
Rebuild the Mac config bundle from the pack templates.

  node scripts/build-config-bundle.mjs --world <World> --pack-number <N> \\
    --pack-date '<Mon D, YYYY>' [version pins] [--dry-run]

Required
  --world <name>              Same world you minted the pack with.
  --pack-number <N>           12 for pack v12. Names the file and the README.
  --pack-date '<Mon D, YYYY>' Publish date shown in the README, e.g. 'Sep 9, 2026'.

Version pins (default to pack v11's; pass the same ones you gave mint-pack)
${MODS.filter((m) => m.cfgVersionVar).map((m) => `  ${m.flag} <x.y.z>`.padEnd(30) + `${m.label} (v11: ${m.baseline})`).join('\n')}

Cfg writer headers (rarely needed - see mint-pack.mjs --help)
${MODS.filter((m) => m.cfgVersionFlag)
    .map((m) => `  ${m.cfgVersionFlag} <x.y.z>`.padEnd(34) + `${m.label} (currently ${m.cfgVersionDefault})`)
    .join('\n')}

Pack contents (pass the same ones you gave mint-pack)
${OMITTABLE_MODS.map((m) => `  ${m.omitFlag}`.padEnd(30) + `Leave ${m.label} out: no ${m.cfg}.`).join('\n')}
  --fallback on|off|none      EilifPaths [VPlusFallback] Enabled. Default ${DEFAULT_FALLBACK}.

Other
  --ingest-url <url>          Dashboard ingest endpoint (default ${DEFAULT_INGEST_URL}).
  --out <dir>                 Default ${path.relative(ROOT, DEFAULT_OUT)}
  --force                     Overwrite an existing bundle zip of that number.
  --compare-to <zip>          Byte-compare the result against an existing bundle
                              zip instead of trusting it blind.
  --dry-run                   Report only; write nothing.
  --help
`;

function parseArgs(argv) {
  const args = {
    versions: {}, cfgVersions: {}, world: null, packNumber: null, packDate: null,
    ingestUrl: DEFAULT_INGEST_URL, out: DEFAULT_OUT, compareTo: null, dryRun: false,
    force: false, omit: [], fallback: DEFAULT_FALLBACK,
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
      case '--world': args.world = next(); break;
      case '--pack-number': args.packNumber = next(); break;
      case '--pack-date': args.packDate = next(); break;
      case '--ingest-url': args.ingestUrl = next(); break;
      case '--out': args.out = next(); break;
      case '--compare-to': args.compareTo = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--force': args.force = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  const missing = ['world', 'packNumber', 'packDate'].filter((k) => !args[k]);
  if (missing.length) {
    console.error(`missing required argument(s): ${missing.map((m) => `--${m.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')}\n${USAGE}`);
    process.exit(2);
  }
  if (!/^\d+$/.test(args.packNumber)) {
    console.error(`--pack-number must be a plain number (got "${args.packNumber}")`);
    process.exit(2);
  }

  banner(`Mac config bundle - pack v${args.packNumber}${args.dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  world      ${args.world}`);
  console.log(`  ingest url ${args.ingestUrl}`);
  if (args.omit.length) {
    console.log(`  dropped    ${args.omit.map((k) => MODS.find((m) => m.key === k).label).join(', ')}`);
  }
  console.log(`  fallback   ${args.fallback}`);

  const { entries, zip } = buildBundle({
    world: args.world,
    versions: args.versions,
    cfgVersions: args.cfgVersions,
    ingestUrl: args.ingestUrl,
    packNumber: args.packNumber,
    packDate: args.packDate,
    omit: args.omit,
    fallback: args.fallback,
  });
  for (const e of entries) console.log(ok(`${e.name.padEnd(42)} ${e.data.length} bytes`));

  let failed = false;
  if (args.compareTo) {
    banner('Compare against an existing bundle');
    const ref = unzipSync(fs.readFileSync(args.compareTo));
    const refNames = [...ref.keys()].sort().join('|');
    const gotNames = entries.map((e) => e.name).sort().join('|');
    if (refNames !== gotNames) {
      failed = true;
      console.log(bad('entry list differs'));
      console.log(`       reference: ${refNames.split('|').join(', ')}`);
      console.log(`       rendered:  ${gotNames.split('|').join(', ')}`);
    }
    for (const e of entries) {
      const r = ref.get(e.name);
      if (!r) { failed = true; console.log(bad(`${e.name.padEnd(42)} not in the reference bundle`)); continue; }
      if (r.equals(e.data)) console.log(ok(`${e.name.padEnd(42)} identical`));
      else { failed = true; console.log(bad(`${e.name.padEnd(42)} ${firstDiff(r, e.data)}`)); }
    }
    console.log(failed ? bad('bundle does NOT match the reference') : ok('bundle matches the reference exactly'));
  }

  const file = path.join(args.out, `eilif-configs-pack-v${args.packNumber}.zip`);
  if (args.dryRun) {
    banner('Dry run complete');
    console.log(`  Would write ${zip.length} bytes to ${file}`);
    if (failed) process.exitCode = 1;
    return;
  }

  // --out defaults to public/downloads, where the live bundle sits. Rehearsing a
  // reproduction and forgetting --dry-run would otherwise rewrite the shipped,
  // committed zip: same contents, different bytes (zipSync stamps a fixed 1980
  // timestamp), so it lands as an unexplained binary diff on the file the Get
  // Started page currently links.
  if (fs.existsSync(file) && !args.force) {
    console.error('');
    console.error(`  ${file} already exists.`);
    console.error('  Re-run with --dry-run to check a reproduction, or --force to replace it.');
    process.exit(2);
  }

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(file, zip);
  banner('Written');
  console.log(ok(`${zip.length} bytes -> ${file}`));
  console.log('');
  console.log('  Still to do by hand:');
  console.log(`    app/get-started/page.tsx: CONFIG_BUNDLE_URL = '/downloads/eilif-configs-pack-v${args.packNumber}.zip'`);
  console.log('    then deploy. The old bundle stays on disk until someone deletes it;');
  console.log('    leave it there until the new one is live so no link 404s mid-deploy.');
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
