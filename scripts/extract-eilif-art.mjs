#!/usr/bin/env node
/*
  extract-eilif-art.mjs — pull the finished Eilif art out of the handoff .docx.

  The handoff doc lays each image directly ABOVE its label paragraph, where a
  label looks like `00_reference_style_image`. This script:

    1. Unzips the .docx (adm-zip if installed, else the `unzip` CLI) to a temp dir.
    2. Walks word/document.xml IN DOCUMENT ORDER, collecting a stream of tokens:
         - image tokens   (a:blip r:embed="rIdN")
         - label tokens   (paragraph text matching /^\d{2}_[a-z0-9_]+$/i)
    3. Pairs each image with the label paragraph that FOLLOWS it.
    4. Resolves each rId → media file via word/_rels/document.xml.rels.
    5. Copies each media file to public/images/eilif/<label>.jpg.
    6. Prints a mapping table and warns about any unpaired images/labels,
       duplicate labels, or labels that are not known art ids.
    7. With --write-manifest, rewrites ART_AVAILABLE in config/art.ts to the
       set of successfully extracted ids.

  Defensive: it never overwrites config on ambiguity — if any problem is
  detected it prints the problems and exits non-zero without writing the
  manifest.

  Usage:
    node scripts/extract-eilif-art.mjs <path/to/handoff.docx> [--write-manifest]
*/

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ART_CONFIG = path.join(REPO_ROOT, 'config', 'art.ts');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'images', 'eilif');

const LABEL_RE = /^\d{2}_[a-z0-9_]+$/i;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const writeManifest = args.includes('--write-manifest');
const docxPath = args.find((a) => !a.startsWith('--'));

if (!docxPath) {
  fail('Usage: node scripts/extract-eilif-art.mjs <path/to/handoff.docx> [--write-manifest]');
}
if (!existsSync(docxPath)) {
  fail(`No such file: ${docxPath}`);
}

// ── unzip the docx ───────────────────────────────────────────────────────────
async function unzipDocx(src) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eilif-art-'));
  let admZip = null;
  try {
    ({ default: admZip } = await import('adm-zip'));
  } catch {
    admZip = null;
  }
  if (admZip) {
    new admZip(src).extractAllTo(tmp, true);
  } else {
    try {
      execFileSync('unzip', ['-o', '-q', src, '-d', tmp], { stdio: 'inherit' });
    } catch (e) {
      fail(`unzip failed (install adm-zip or the unzip CLI): ${e.message}`);
    }
  }
  return tmp;
}

// ── known ids (parse config/art.ts so we validate against the manifest) ──────
async function readKnownIds() {
  const src = await fs.readFile(ART_CONFIG, 'utf8');
  // Grab the EILIF_ART block and pull every quoted key.
  const block = src.match(/EILIF_ART[^{]*\{([\s\S]*?)\n\};/);
  if (!block) fail('Could not locate EILIF_ART in config/art.ts');
  const ids = new Set();
  for (const m of block[1].matchAll(/'([^']+)'\s*:\s*\{/g)) ids.add(m[1]);
  return ids;
}

// ── parse document.xml in order → tokens ─────────────────────────────────────
function tokenize(documentXml) {
  const tokens = [];
  // Split into paragraphs, preserving order.
  const paras = documentXml.split(/<w:p[\s>]/).slice(1);
  for (const rawTail of paras) {
    const p = '<w:p ' + rawTail; // restore the tag we split on (content only needs body)
    // images in this paragraph, in order
    for (const m of p.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)) {
      tokens.push({ kind: 'image', rId: m[1] });
    }
    // paragraph text = all <w:t> runs concatenated
    let text = '';
    for (const m of p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) text += m[1];
    text = text.trim();
    if (text && LABEL_RE.test(text)) {
      tokens.push({ kind: 'label', text: text.toLowerCase() });
    }
  }
  return tokens;
}

// ── pair each image with the label that follows it ───────────────────────────
function pair(tokens) {
  const pairs = [];
  const unpairedImages = [];
  const unpairedLabels = [];
  let pending = null;
  for (const t of tokens) {
    if (t.kind === 'image') {
      if (pending) unpairedImages.push(pending); // image with no label before the next image
      pending = t;
    } else {
      if (pending) {
        pairs.push({ rId: pending.rId, label: t.text });
        pending = null;
      } else {
        unpairedLabels.push(t);
      }
    }
  }
  if (pending) unpairedImages.push(pending);
  return { pairs, unpairedImages, unpairedLabels };
}

// ── resolve rId → media path via document.xml.rels ───────────────────────────
function relsMap(relsXml) {
  const map = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
    map.set(m[1], m[2]);
  }
  // Also handle attribute order Target-before-Id.
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

// ── manifest rewrite ─────────────────────────────────────────────────────────
async function rewriteManifest(ids) {
  const src = await fs.readFile(ART_CONFIG, 'utf8');
  const arrLiteral =
    ids.length === 0
      ? '[]'
      : '[\n' + ids.map((id) => `  '${id}',`).join('\n') + '\n]';
  const re = /export const ART_AVAILABLE: string\[\] = \[[\s\S]*?\];/;
  if (!re.test(src)) fail('Could not locate ART_AVAILABLE in config/art.ts to rewrite.');
  const next = src.replace(re, `export const ART_AVAILABLE: string[] = ${arrLiteral};`);
  await fs.writeFile(ART_CONFIG, next, 'utf8');
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const knownIds = await readKnownIds();
  const tmp = await unzipDocx(docxPath);
  const docXmlPath = path.join(tmp, 'word', 'document.xml');
  const relsPath = path.join(tmp, 'word', '_rels', 'document.xml.rels');
  if (!existsSync(docXmlPath)) fail(`Not a valid .docx (no word/document.xml): ${docxPath}`);
  if (!existsSync(relsPath)) fail(`Missing word/_rels/document.xml.rels in ${docxPath}`);

  const documentXml = await fs.readFile(docXmlPath, 'utf8');
  const relsXml = await fs.readFile(relsPath, 'utf8');

  const tokens = tokenize(documentXml);
  const { pairs, unpairedImages, unpairedLabels } = pair(tokens);
  const rels = relsMap(relsXml);

  await fs.mkdir(OUT_DIR, { recursive: true });

  const problems = [];
  const extracted = [];
  const table = [];
  const seenLabels = new Set();

  for (const { rId, label } of pairs) {
    const target = rels.get(rId);
    if (!target) {
      problems.push(`No media relationship for ${rId} (label ${label}).`);
      continue;
    }
    if (seenLabels.has(label)) {
      problems.push(`Duplicate label "${label}" — refusing to overwrite ambiguously.`);
      continue;
    }
    seenLabels.add(label);
    if (!knownIds.has(label)) {
      problems.push(`Label "${label}" is not a known art id in config/art.ts (skipped).`);
      continue;
    }
    const srcMedia = path.join(tmp, 'word', target.replace(/^\.?\//, ''));
    if (!existsSync(srcMedia)) {
      problems.push(`Media file missing on disk for ${label}: ${target}`);
      continue;
    }
    const dest = path.join(OUT_DIR, `${label}.jpg`);
    await fs.copyFile(srcMedia, dest);
    extracted.push(label);
    table.push([label, rId, path.basename(target)]);
  }

  for (const img of unpairedImages) {
    problems.push(`Image ${img.rId} has no label paragraph beneath it.`);
  }
  for (const lbl of unpairedLabels) {
    problems.push(`Label "${lbl.text}" has no image above it.`);
  }

  // Report
  console.log('\nExtracted images → public/images/eilif/');
  console.log('  ' + 'label'.padEnd(34) + 'rId'.padEnd(12) + 'source');
  console.log('  ' + '-'.repeat(60));
  for (const [label, rId, source] of table) {
    console.log('  ' + label.padEnd(34) + rId.padEnd(12) + source);
  }
  console.log(`\n  ${extracted.length} image(s) extracted.`);

  if (problems.length) {
    console.error('\n⚠ Problems:');
    for (const p of problems) console.error('   - ' + p);
  }

  // Cleanup temp dir
  await fs.rm(tmp, { recursive: true, force: true });

  if (writeManifest) {
    if (problems.length) {
      console.error(
        '\n✖ Refusing to rewrite ART_AVAILABLE while problems exist. Resolve them and re-run.',
      );
      process.exit(1);
    }
    extracted.sort();
    await rewriteManifest(extracted);
    console.log(`\n✔ Rewrote ART_AVAILABLE in config/art.ts with ${extracted.length} id(s).`);
  } else {
    console.log('\n(dry run — pass --write-manifest to update config/art.ts)');
  }

  if (problems.length) process.exit(1);
}

main().catch((e) => fail(e.stack || e.message));
