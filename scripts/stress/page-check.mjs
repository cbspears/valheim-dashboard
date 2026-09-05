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
//   • an empty <h1>/<h2>, i.e. a heading whose value came back nullish
//
// It prints one line per page and exits non-zero if any page failed, so it can
// be chained. `--dump <dir>` writes the extracted text per page for reading by
// hand, which is the only way to judge "reads right".
//
//   node scripts/stress/page-check.mjs --base http://localhost:3400 \
//     --label day-1 --stale 'Astrid,Bjorn' --dump /tmp/…/pages
//
// Node 20, standard library only.

import { writeFileSync, mkdirSync } from 'node:fs';
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
const STALE = (flag('stale', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const PAGES = [
  { path: '/', name: 'Hall' },
  { path: '/players', name: 'Vikings' },
  { path: '/world', name: 'World' },
  { path: '/map', name: 'Map' },
  { path: '/events', name: 'Events' },
  { path: '/oath', name: 'Oath' },
];

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
];

// English plural agreement at exactly one. Only these nouns: they are the ones
// the day-one pages count.
const PLURAL_NOUNS = [
  'vikings', 'days', 'deaths', 'kills', 'sessions', 'oaths', 'pins', 'events',
  'bosses', 'deeds', 'players', 'hours', 'photos', 'lines', 'frames',
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
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    status = res.status;
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

  if (DUMP) {
    writeFileSync(join(DUMP, `${LABEL}-${page.name}.txt`), text + '\n');
  }
  results.push({ page: page.name, status, problems, notes, chars: text.length, headings: hs.map((h) => h.text) });
}

console.log(`\n── page-check ${LABEL} @ ${BASE} ${'─'.repeat(Math.max(0, 40 - LABEL.length))}`);
let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(r.page).padEnd(9)} HTTP ${r.status}  ${r.chars ?? 0} chars text`);
  for (const p of r.problems) console.log(`        ↳ ${p}`);
  for (const n of r.notes ?? []) console.log(`        · ${n}`);
}
console.log(`  ${results.length - failed}/${results.length} pages clean`);
if (DUMP) console.log(`  text dumped to ${DUMP}/${LABEL}-*.txt`);
process.exit(failed ? 1 : 0);
