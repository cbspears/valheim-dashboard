#!/usr/bin/env node
// Day-one page check: fetch the player-facing pages off the LOCAL site and read
// the text a player would actually see.
//
// This is not a screenshot test and not a snapshot test. It looks for the
// specific ways a day-one dashboard goes wrong, all of which are text:
//
//   • a render artefact leaking through — `undefined`, `NaN`, `Invalid Date`,
//     `[object Object]`, a bare `null`
//   • `Day 0` / `day 0`, which is what an un-reported world day looks like once
//     a `?? 0` has swallowed it
//   • `1 vikings`, `1 days`, `1 deaths` — plural agreement, which only ever
//     breaks at exactly one, i.e. only on day one
//   • names from the previous world still on the page after a wipe (pass
//     --stale <name,name,...>)
//   • an em or en dash, `Milestones` (the site says Great Deeds) or the previous
//     world's name — the copy doctrine, which until 2026-09-06 was enforced by
//     a person reading the dumps
//   • an empty <h1>/<h2>, i.e. a heading whose value came back nullish
//
// It prints one line per page and exits non-zero if any page failed, so it can
// be chained. `--dump <dir>` writes the extracted text per page for reading by
// hand, which is the only way to judge "reads right". `--also <path>,<path>`
// adds paths for one invocation — that is how /viking/<slug> gets read, since it
// 404s until somebody has joined and so cannot sit in the fixed list.
//
//   node scripts/stress/page-check.mjs --base http://localhost:3400 \
//     --site-dir /tmp/…/site --label day-1 --stale 'Astrid,Bjorn' \
//     --also /viking/alvis --dump /tmp/…/pages
//
// ── ISR, AND WHY --site-dir IS NOT OPTIONAL (found in the round-3 rehearsal) ──
//
// The 2026-09-05 perf pass put /world, /events, /events/storyteller, /gallery,
// /map and /boss/[slug] behind `export const revalidate = 60` (/oath carried it
// too until the wall folded into /players#oaths on 2026-09-06). A prerendered ISR page is
// served from the build-time render until a request arrives MORE than 60 s after
// the last one, and even that request is served the STALE copy while the
// regeneration happens behind it. The whole day-one rehearsal runs in about
// twenty seconds, so every one of those pages answered with the same build-time
// HTML at all six checkpoints, and this script reported "6/6 pages clean" for
// pages that had never rendered a single row of the evening. Byte-identical
// dumps at boot and after the boss kill are what gave it away.
//
// So: a cached render is NOT evidence. Point `--site-dir` at the built copy and
// this reads `previewModeId` out of `.next/prerender-manifest.json` and sends it
// as `x-prerender-revalidate`, which is the header Next.js itself uses to force a
// synchronous regeneration (`x-nextjs-cache: REVALIDATED`). Without it, any page
// that answers `x-nextjs-cache: HIT` or `STALE` is reported as **STALE, never
// PASS**, and the run exits non-zero — an inconclusive check must not be able to
// look like a clean one.
//
// Node 20, standard library only.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
function flag(name, dflt = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return dflt;
}

const BASE = flag('base', 'http://localhost:3400');
const LABEL = flag('label', 'check');
const DUMP = flag('dump', null);
const SITE_DIR = flag('site-dir', process.env.SITE_DIR || null);
const STALE = (flag('stale', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Extra paths for this invocation only. /viking/<slug> is the reason it exists:
// it carries copy no fixed page does, but it 404s until a viking has joined, so
// it cannot live in PAGES where the post-wipe checkpoint would demand a 200.
const ALSO = (flag('also', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// LOOPBACK ONLY, and since 2026-09-06 that is a hard refusal rather than an
// intention. This script now attaches the built site's `previewModeId` to every
// request as `x-prerender-revalidate` — a Next.js on-demand-revalidation bypass
// token. Before that a mistyped --base sent a stray GET somewhere; now it hands
// a build secret to a stranger. Same rule and same reason as run.mjs and
// rehearse-launch.sh: the HOSTNAME must be loopback, because
// "http://localhost.example.com" contains the substring and is not local.
function isLoopback(u) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}
if (!isLoopback(BASE)) {
  console.error(`Refusing to run: --base ${BASE} is not loopback.`);
  console.error('This sends the build\'s x-prerender-revalidate token with every request.');
  process.exit(2);
}

// Every page a player can reach from the nav that renders world data. Gallery
// and Boss were missing until 2026-09-06 and are both ISR pages named in
// docs/LAUNCH-DAY.md's post-wipe check, so the one list that is supposed to say
// "the pages are right" did not look at two of the six the runbook names.
const PAGES = [
  { path: '/', name: 'Hall' },
  { path: '/players', name: 'Vikings' },
  { path: '/world', name: 'World' },
  { path: '/map', name: 'Map' },
  { path: '/boss/eikthyr', name: 'Boss' },
  { path: '/events', name: 'Events' },
  { path: '/gallery', name: 'Gallery' },
  // --also <path>,<path> appends here. The name is derived from the path so a
  // dump file and a result line can be told apart from the fixed seven.
  ...ALSO.map((p) => ({ path: p, name: p.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-') || 'root' })),
];

// The build secret Next.js accepts as "regenerate this path now". It lives in
// the built tree, never in the repo, and the loopback refusal above is what
// keeps it on this machine.
function prerenderRevalidateId(siteDir) {
  if (!siteDir) return null;
  try {
    const m = JSON.parse(readFileSync(join(siteDir, '.next', 'prerender-manifest.json'), 'utf8'));
    return m?.preview?.previewModeId ?? null;
  } catch (e) {
    console.error(`  ! --site-dir ${siteDir}: cannot read .next/prerender-manifest.json (${e?.message ?? e}).`);
    console.error('    ISR pages will be read from the cache and reported as STALE rather than PASS.');
    return null;
  }
}
const REVALIDATE_ID = prerenderRevalidateId(SITE_DIR);

// Next.js ships the server payload as JSON inside <script> tags. That payload
// legitimately contains the word "undefined" and every raw field name, so
// scanning the whole document produces a false positive on every page. Only the
// rendered body text is evidence about what a player sees.
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function headings(html) {
  const out = [];
  for (const m of html.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    out.push({ level: Number(m[1]), text: visibleText(m[2]) });
  }
  return out;
}

// Word-boundary matches only. "Day 0" must not fire on "Day 01" and "NaN" must
// not fire inside a word.
const ARTEFACTS = [
  { re: /\bundefined\b/i, why: 'undefined' },
  { re: /\bNaN\b/, why: 'NaN' },
  { re: /Invalid Date/i, why: 'Invalid Date' },
  { re: /\[object Object\]/i, why: '[object Object]' },
  { re: /\bDay 0\b(?!\d)/i, why: 'Day 0' },
  { re: /\bday 0\b(?!\d)/, why: 'day 0' },
  { re: /\bnull\b/, why: 'null' },
  // Added 2026-09-06. Until then this gate could not fail on the four things the
  // rehearsal's own task list named, and the copy doctrine's most-violated rule
  // was being enforced by a human reading the dump files by hand — which is how
  // the em dashes on /viking/<slug> were found. visibleText() already decodes
  // &mdash;/&#8212; into a literal dash for exactly this check.
  //
  // The seven fixed pages are clean of all four (verified against the 2026-09-06
  // dumps). /viking/<slug> is not, and that is the point: three of the five
  // BIO_LINES variants in lib/epithets.ts carry an em dash, and every uncaught
  // fish renders one as a placeholder where a 0 belongs.
  { re: /[–—]/, why: 'em/en dash (player-facing copy doctrine)' },
  { re: /\bMilestones\b/, why: '"Milestones" (the site says Great Deeds)' },
  { re: /\bDraugheim\b/i, why: 'Draugheim (the previous world\'s name)' },
];

// English plural agreement at exactly one. Only these nouns: they are the ones
// the day-one pages count.
// THE RULE FOR ADDING ONE: the site must render it as a COUNT — `{n} thing` —
// somewhere. A word that only ever appears as a card heading or in prose
// produces nothing but false positives, and a gate that cries wolf four days
// before launch is a gate the operator learns to scroll past.
//
// `nights`, `episodes` and `screenshots` were added on 2026-09-06 and taken back
// out the same day: none of the three is a count anywhere in app/ or components/
// (they are `<CardHeader title="Screenshots">`, `The Episodes`, "the long
// nights"), and `screenshots` promptly failed a clean /viking/<slug> on the
// string `Day 1 Screenshots` — a pin's day label butted against the next card's
// heading. `trackers` came out too: app/world/page.tsx:43 already renders it
// through a `=== 1 ? 'tracker' : 'trackers'` ternary, so it cannot break.
//
// `catches` stays, because it is a real count with a real bug: the Anglers board
// (app/players/page.tsx:139) and the viking page's Feats of Arms
// (components/viking/FeatsOfArms.tsx:92) both render `L{level} · {n} catches`
// with no singular form, so the first fish anyone lands on launch night reads
// "1 catches" in two places.
const PLURAL_NOUNS = [
  'vikings', 'days', 'deaths', 'kills', 'sessions', 'oaths', 'pins', 'events',
  'bosses', 'deeds', 'players', 'hours', 'photos', 'lines', 'frames',
  'catches',
];
function pluralFaults(text) {
  const bad = [];
  const maybe = [];
  for (const noun of PLURAL_NOUNS) {
    // Two boundary shapes, both seen on these pages, both NOT plural faults:
    //   "All 1 Deaths 0 Boss Kills 0"  — a filter chip row, digit after the noun
    //   "…Greylings 1 Players of the Day…" — a count followed by a HEADING that
    //     happens to start with a plural noun. A real count never reads
    //     "1 players of …", so a following " of " settles it.
    const re = new RegExp(`(^|[^\\d.])1\\s+${noun}\\b(\\s*\\d|\\s+of\\b)?`, 'gi');
    for (const m of text.matchAll(re)) {
      (m[2] ? maybe : bad).push(m[0].trim());
    }
  }
  return { bad: [...new Set(bad)], maybe: [...new Set(maybe)] };
}

function context(text, re, span = 70) {
  const m = text.match(re);
  if (!m) return '';
  const i = m.index ?? 0;
  return text.slice(Math.max(0, i - span), i + m[0].length + span).replace(/\s+/g, ' ');
}

const results = [];
if (DUMP) mkdirSync(DUMP, { recursive: true });

for (const page of PAGES) {
  if (ONLY.length && !ONLY.includes(page.name)) continue;
  const url = `${BASE}${page.path}`;
  let html = '';
  let status = 0;
  let isrCache = null;
  try {
    const headers = { 'cache-control': 'no-cache' };
    if (REVALIDATE_ID) headers['x-prerender-revalidate'] = REVALIDATE_ID;
    const res = await fetch(url, { headers });
    status = res.status;
    // MISS/REVALIDATED = this response was rendered now. HIT/STALE = it is a
    // cached copy of some earlier render and says nothing about the database.
    isrCache = res.headers.get('x-nextjs-cache');
    html = await res.text();
  } catch (e) {
    results.push({ page: page.name, status: 0, problems: [`fetch failed: ${e?.message ?? e}`] });
    continue;
  }

  const text = visibleText(html);
  const problems = [];
  const notes = [];
  if (status !== 200) problems.push(`HTTP ${status}`);

  for (const a of ARTEFACTS) {
    if (a.re.test(text)) problems.push(`${a.why} :: ${context(text, a.re)}`);
  }
  const plural = pluralFaults(text);
  for (const p of plural.bad) problems.push(`plural :: "${p}"`);
  for (const p of plural.maybe) notes.push(`plural? (adjacent counters, read it) :: "${p}"`);
  for (const name of STALE) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(text)) problems.push(`stale name :: ${name} :: ${context(text, re)}`);
  }
  const hs = headings(html);
  for (const h of hs) {
    if (!h.text) problems.push(`empty <h${h.level}>`);
  }
  if (!hs.length) problems.push('no <h1>/<h2> at all');

  // A cached ISR render is not evidence about this moment's database. Say so
  // instead of grading it, and never let it count as a clean page.
  const cachedRender = isrCache === 'HIT' || isrCache === 'STALE';

  if (DUMP) {
    writeFileSync(join(DUMP, `${LABEL}-${page.name}.txt`), text + '\n');
  }
  results.push({
    page: page.name,
    status,
    problems,
    notes,
    chars: text.length,
    isrCache,
    cachedRender,
    headings: hs.map((h) => h.text),
  });
}

console.log(`\n── page-check ${LABEL} @ ${BASE} ${'─'.repeat(Math.max(0, 40 - LABEL.length))}`);
let failed = 0;
let stale = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  else if (r.cachedRender) stale++;
  const verdict = !ok ? 'FAIL' : r.cachedRender ? 'STALE' : 'PASS';
  const cache = r.isrCache ? `  [isr ${r.isrCache}]` : '';
  console.log(`  ${verdict.padEnd(5)} ${String(r.page).padEnd(9)} HTTP ${r.status}  ${r.chars ?? 0} chars text${cache}`);
  for (const p of r.problems) console.log(`        ↳ ${p}`);
  for (const n of r.notes ?? []) console.log(`        · ${n}`);
  if (ok && r.cachedRender) {
    console.log('        ↳ served from the ISR cache (revalidate 60 s), so this render is NOT evidence');
  }
}
console.log(`  ${results.length - failed - stale}/${results.length} pages read fresh and clean`);
if (stale) {
  console.log(`  ${stale} page(s) answered from the ISR cache and were NOT graded.`);
  console.log(
    REVALIDATE_ID
      ? '  Pass --site-dir at the copy that is actually serving; the id read did not force a regeneration.'
      : '  Pass --site-dir <built site root> (or SITE_DIR=) so a fresh render can be forced.',
  );
}
if (DUMP) console.log(`  text dumped to ${DUMP}/${LABEL}-*.txt`);
process.exit(failed || stale ? 1 : 0);
