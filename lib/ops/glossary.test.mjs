// The glossary's coverage contract.
// Run: npx tsx lib/ops/glossary.test.mjs
//
// WHAT THIS FILE IS FOR. The owner asked for an explanation next to every thing
// the cockpit shows. The failure mode of that request is drift: somebody adds a
// consistency check or a component six weeks from now, ships it, and it renders
// as a red row with no caption at 2 am. So the registries are the source of
// truth and this test is the gate:
//
//   • every key in COMPONENTS and BOT_SUBLOOPS      needs component:<key>
//   • every Finding id in lib/ops/consistency.ts    needs check:<id>
//   • every key in WATCHDOG_TARGETS                 needs watchdog:<key>
//
// A new check without an explanation is a failing test, not a silent gap.
//
// The consistency ids are read out of the SOURCE FILE rather than by running the
// checks, on purpose. Running them would only cover the ids that happen to fire
// for whatever input this test fabricates, and several checks are mutually
// exclusive (server status missing versus stale versus very stale), so a
// fabricated input can never fire all of them at once. Scanning the file catches
// a check the moment it is written, including one that has never fired.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { COMPONENTS, BOT_SUBLOOPS } from './health.ts';
import { WATCHDOG_TARGETS } from './watchdog.ts';
import {
  CONSISTENCY_CONDITION_COUNT,
  GLOSSARY,
  GLOSSARY_CATEGORIES,
  allGlossaryEntries,
  glossaryByCategory,
  glossaryCategory,
  glossaryEntry,
  glossaryIdCollisions,
} from './glossary.ts';
import { ACTIVITY_GLOSSARY } from './glossary-activity.ts';
import { HORIZON_GLOSSARY } from './glossary-horizon.ts';
import { PERF_GLOSSARY } from './glossary-performance.ts';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const ids = Object.keys(GLOSSARY);
const entries = Object.values(GLOSSARY);

// The four sets the registry indexes. Sections 5 onward run over ALL of them:
// the three tab sets were folded into the index at integration, so the copy
// discipline they were written under is now something a test can hold them to.
const SETS = [
  ['shared', GLOSSARY],
  ['activity', ACTIVITY_GLOSSARY],
  ['horizon', HORIZON_GLOSSARY],
  ['performance', PERF_GLOSSARY],
];
const everyEntry = SETS.flatMap(([set, obj]) =>
  Object.entries(obj).map(([key, e]) => [`${set}:${key}`, key, e]),
);

// ── 1. Coverage: components and bot loops ────────────────────────────────
{
  ok(COMPONENTS.length === 8, `COMPONENTS has ${COMPONENTS.length} entries (8 expected)`);
  ok(BOT_SUBLOOPS.length === 7, `BOT_SUBLOOPS has ${BOT_SUBLOOPS.length} entries (7 expected)`);

  for (const def of [...COMPONENTS, ...BOT_SUBLOOPS]) {
    const entry = glossaryEntry(`component:${def.key}`);
    ok(
      entry !== undefined,
      `component "${def.key}" (${def.label}) has no glossary entry. Add component:${def.key} to lib/ops/glossary.ts.`,
    );
    // The caption has to name the same thing the roster row names, or the
    // popover reads as if it belongs to a different row.
    ok(
      entry.title.length > 0 && entry.title.toLowerCase() !== def.key,
      `component:${def.key} needs a human title, not its key`,
    );
  }
}

// ── 2. Coverage: every consistency check id in the source ────────────────
{
  const src = readFileSync(new URL('./consistency.ts', import.meta.url), 'utf8');
  const found = [...src.matchAll(/\bid:\s*'([a-z0-9][a-z0-9-]*)'/g)].map((m) => m[1]);
  const checkIds = [...new Set(found)];

  // consistency.ts holds THIRTEEN check functions returning SIXTEEN distinct
  // Finding ids, because several checks report one of two or three mutually
  // exclusive conditions. The page counts conditions, so this counts conditions.
  const arr = src.match(/const checks:[^[]*\[([\s\S]*?)\n  \];/);
  const fnCount = arr ? (arr[1].match(/check[A-Z]\w*\(/g) ?? []).length : 0;
  ok(fnCount >= 13, `runConsistencyChecks calls only ${fnCount} check functions; expected at least 13`);
  ok(
    fnCount <= checkIds.length,
    `${fnCount} check functions cannot report only ${checkIds.length} conditions; every check returns at least one distinct id`,
  );
  ok(
    checkIds.length >= 13,
    `scanned only ${checkIds.length} condition ids out of consistency.ts; the id regex has probably stopped matching`,
  );
  ok(
    CONSISTENCY_CONDITION_COUNT === checkIds.length,
    `the overview prints "${CONSISTENCY_CONDITION_COUNT} conditions checked" but consistency.ts can report ${checkIds.length}. The page derives that number from the check: entries here, so add or remove one.`,
  );
  // Spot-check the scan itself, so a refactor that changes the literal style
  // fails loudly here rather than silently reducing coverage to zero.
  ok(checkIds.includes('future-dated-events'), 'the source scan found the critical relay check');
  ok(checkIds.includes('pilot-flags-enabled'), 'the source scan found the launch-flag check');

  for (const id of checkIds) {
    ok(
      glossaryEntry(`check:${id}`) !== undefined,
      `consistency check "${id}" has no glossary entry. Add check:${id} to lib/ops/glossary.ts.`,
    );
  }
}

// ── 3. Coverage: watchdog targets ────────────────────────────────────────
{
  ok(WATCHDOG_TARGETS.length === 6, `WATCHDOG_TARGETS has ${WATCHDOG_TARGETS.length} entries (6 expected)`);
  for (const t of WATCHDOG_TARGETS) {
    ok(
      glossaryEntry(`watchdog:${t.key}`) !== undefined,
      `watchdog target "${t.key}" has no glossary entry. Add watchdog:${t.key} to lib/ops/glossary.ts.`,
    );
  }
  // game-server is the watchdog's own name for the emitter signal and exists in
  // no other registry; it is the one that would be missed by copying COMPONENTS.
  ok(glossaryEntry('watchdog:game-server') !== undefined, 'the watchdog-only target is covered');
}

// ── 4. The minimum set the v2 spec names for the overview ────────────────
{
  const required = [
    'state-healthy', 'state-degraded', 'state-stale', 'state-disabled', 'state-unknown',
    'stale-vs-unknown', 'consistency-check', 'severity-levels', 'last-success',
    'cadence-vs-stale', 'component-version', 'inferred-vs-measured', 'quiet-hall-rule',
    'bot-subloop', 'subloop-unknown-when-parent-down', 'voice-queue-age', 'steam-mismatch',
    'binding-release', 'render-liveness', 'poller-lag',
  ];
  for (const id of required) {
    ok(glossaryEntry(id) !== undefined, `spec-required entry "${id}" is missing`);
  }
}

// ── 5. Entry shape and copy discipline, across all four sets ─────────────
{
  for (const [label, key, e] of everyEntry) {
    ok(e.id === key, `entry keyed "${label}" carries id "${e.id}"; they must match`);
    for (const field of ['title', 'what', 'why', 'healthy', 'whenRed']) {
      ok(typeof e[field] === 'string' && e[field].trim().length > 0, `${label}.${field} is empty`);
    }
    // Five fields, every time. A one-word "healthy" is a caption that did not
    // get written, and it is the field readers rely on most.
    ok(e.what.length >= 40, `${label}.what is too short to say anything (${e.what.length} chars)`);
    ok(e.healthy.length >= 12, `${label}.healthy is too short (${e.healthy.length} chars)`);
    ok(e.whenRed.length >= 30, `${label}.whenRed is too short (${e.whenRed.length} chars)`);
    // Copy rules for these pages: no em dashes, no placeholders left behind.
    for (const field of ['title', 'what', 'why', 'healthy', 'whenRed']) {
      ok(!e[field].includes('—'), `${label}.${field} contains an em dash`);
      ok(!/\bTODO\b|\bTBD\b/i.test(e[field]), `${label}.${field} still carries a placeholder`);
    }
    if (e.link) {
      ok(typeof e.link.label === 'string' && e.link.label.length > 0, `${label}.link has no label`);
      ok(
        e.link.href.startsWith('http') || e.link.href.startsWith('/'),
        `${label}.link.href must be an absolute URL or an in-app path`,
      );
      // A label naming a heading has to land on that heading. The test for
      // "names a heading" is the comma: "Ops runbook, backups" and "Launch day,
      // step 20b" both promise a part of a document, while "Ops runbook",
      // "Cockpit v2 plan" and "docs/LAUNCH-DAY.md" promise the document. Written
      // as an allowlist of labels this rule went stale the moment the three tab
      // sets joined the index, and eight links promising a section were
      // delivering a whole document by the time it was checked.
      const namesASection = e.link.href.endsWith('.md') && e.link.label.includes(',');
      ok(
        !namesASection,
        `${label}.link.label is "${e.link.label}", which names a section, but the href has no #anchor`,
      );
    }
  }
  ok(entries.length === ids.length, 'every entry is reachable by its key');
  ok(everyEntry.length >= 145, `only ${everyEntry.length} entries across the four sets; the index has lost a whole set`);
}

// ── 5b. No id is registered twice ────────────────────────────────────────
// glossaryEntry() consults the shared registry and then each tab set in order,
// so a duplicate id makes one of the two captions permanently unreachable and
// prints the winner twice in the index, under two different headings. Nine ids
// collided when the four sets first met.
{
  const collisions = glossaryIdCollisions();
  ok(
    collisions.length === 0,
    `${collisions.length} id(s) registered in more than one set: ${collisions
      .map((c) => `${c.id} (${c.sets.join(' + ')})`)
      .join(', ')}`,
  );
  // Two entries with the same TITLE are almost as bad: the index lists them by
  // title, so the reader gets two identical-looking rows and no way to tell
  // which button opens which.
  const byTitle = new Map();
  for (const [label, , e] of everyEntry) {
    const t = e.title.toLowerCase();
    byTitle.set(t, [...(byTitle.get(t) ?? []), label]);
  }
  const dupTitles = [...byTitle.entries()].filter(([, where]) => where.length > 1);
  ok(
    dupTitles.length === 0,
    `${dupTitles.length} title(s) used by more than one entry: ${dupTitles
      .map(([t, where]) => `"${t}" (${where.join(' + ')})`)
      .join(', ')}`,
  );
}

// ── 6. Lookup helpers ────────────────────────────────────────────────────
{
  ok(glossaryEntry('no-such-entry') === undefined, 'an unknown id returns undefined, not a throw');
  const all = allGlossaryEntries();
  ok(
    all.length === everyEntry.length,
    `allGlossaryEntries returns ${all.length} of ${everyEntry.length} entries; the index drops one of the sets`,
  );
  // A caption from each tab set is reachable through the same lookup the
  // shared entries use, which is what the merge is for.
  ok(glossaryEntry('fired-timeline') !== undefined, 'an activity-tab caption is in the index');
  ok(glossaryEntry('launch-countdown') !== undefined, 'a horizon-tab caption is in the index');
  ok(glossaryEntry('lag-window') !== undefined, 'a performance-tab caption is in the index');
  const titles = all.map((e) => e.title);
  ok(
    titles.every((t, i) => i === 0 || titles[i - 1].localeCompare(t) <= 0),
    'allGlossaryEntries is sorted by title',
  );
}

// ── 7. Categories, for the index at the foot of the overview ─────────────
{
  ok(glossaryCategory('component:log-poller') === 'component', 'component prefix groups as component');
  ok(glossaryCategory('bot-subloop') === 'component', 'the bot loop concept groups with the loops');
  ok(glossaryCategory('subloop-unknown-when-parent-down') === 'component', 'so does the loop rule');
  ok(glossaryCategory('check:expired-claims') === 'check', 'check prefix groups as check');
  ok(glossaryCategory('watchdog:game-server') === 'watchdog', 'watchdog target groups as watchdog');
  ok(glossaryCategory('watchdog-re-alert') === 'watchdog', 'watchdog concepts group with it');
  ok(glossaryCategory('arch:zone-game') === 'architecture', 'arch prefix groups as architecture');
  ok(glossaryCategory('poller-lag') === 'concept', 'anything unprefixed and not from a tab set is a concept');
  ok(glossaryCategory('fired-timeline') === 'activity', 'a tab entry is grouped by the tab that wrote it');
  ok(glossaryCategory('launch-countdown') === 'horizon', 'and so is the Coming up tab');
  ok(glossaryCategory('lag-window') === 'performance', 'and so is the Performance tab');

  const grouped = glossaryByCategory();
  const total = grouped.reduce((n, g) => n + g.entries.length, 0);
  ok(
    total === everyEntry.length,
    `every entry lands in exactly one category (${total} of ${everyEntry.length})`,
  );
  ok(grouped.length === GLOSSARY_CATEGORIES.length, 'every declared category has at least one entry');
  const seen = new Set();
  for (const g of grouped) {
    for (const e of g.entries) {
      ok(!seen.has(e.id), `${e.id} appears in more than one category`);
      seen.add(e.id);
    }
  }
  // The categories exist to make the index readable, so each one has to be
  // worth its own heading.
  for (const g of grouped) {
    ok(g.entries.length >= 3, `category "${g.label}" has only ${g.entries.length} entries`);
    ok(g.blurb.length > 20, `category "${g.label}" needs a line of framing`);
  }
}

// ── 8. Every #anchor a caption points at exists in the doc it names ──────
// The links are the caption's escape hatch: "when it is not healthy, read this".
// A heading renamed in docs/ silently turns 70 of them into a link that lands at
// the top of a 500 line document, which is the same as no link at 2 am. The
// anchors are generated by GitHub from the headings, so they can be checked
// against the headings in this repo.
{
  const DOCS = new URL('../../docs/', import.meta.url);
  const cache = new Map();
  const anchorsFor = (file) => {
    if (!cache.has(file)) {
      const md = readFileSync(new URL(file, DOCS), 'utf8');
      const seen = new Set();
      for (const line of md.split('\n')) {
        const m = /^#{1,6}\s+(.*)$/.exec(line);
        if (!m) continue;
        // GitHub's slug: lowercase, inline markdown stripped, everything but
        // word characters, spaces and hyphens dropped, spaces to hyphens. A
        // long dash therefore leaves the two hyphens around it, which is why
        // "5. Deploy order + rollback" is "#5-deploy-order--rollback".
        const slug = m[1]
          .trim()
          .toLowerCase()
          .replace(/[`*_~]/g, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[^\w\s-]/g, '')
          .replace(/\s/g, '-');
        seen.add(slug);
      }
      cache.set(file, seen);
    }
    return cache.get(file);
  };

  let checked = 0;
  for (const [label, , e] of everyEntry) {
    if (!e.link) continue;
    const m = /\/docs\/([A-Za-z0-9._-]+\.md)#(.+)$/.exec(e.link.href);
    if (!m) continue;
    const [, file, anchor] = m;
    ok(
      anchorsFor(file).has(anchor),
      `${label}.link points at ${file}#${anchor}, which is not a heading in that file. Renaming a heading breaks the anchor.`,
    );
    checked++;
  }
  ok(checked >= 60, `only ${checked} in-repo doc anchors were checked; the href pattern has stopped matching`);
}

console.log(
  `glossary.test: ${passed} assertions passed (${everyEntry.length} entries across ${SETS.length} sets, ${ids.length} in the shared registry)`,
);
