// TRIPWIRE for the Get Started spine (app/get-started/page.tsx, lib/get-started.ts).
//
// The page is the one thing a stranger has to get right, and it is now one
// numbered task with a finish line in the middle of it. Four facts hold that
// shape together and every one of them can rot silently:
//
//   1. There is exactly ONE numbered sequence and its count is stated on every
//      step ("Step 3 of 7"). If a step is added or dropped and the total is
//      typed somewhere, the eyebrows start lying. So no number is typed: the
//      page renders `stepLabel(n)` and this test holds the two together.
//   2. Joining is step five, and the server info card names that number in its
//      own heading. Move the join and the heading must move with it.
//   3. Every step states its success condition. A vanilla launch looks exactly
//      like a modded one until the join is refused five minutes later, which is
//      why each step ends in "You are done when ...".
//   4. Other pages deep-link into this one. An anchor that disappears turns a
//      working link elsewhere on the site into a silent scroll to the top.
//
// It also holds the Mac checklist to config/mods.ts (the versions are derived,
// never retyped) and the launch-day cutover anchor to the phrase docs/LAUNCH-DAY.md
// step 19 tells an editor to search this file for.
//
// Picked up automatically by `npm test`. Run alone:
//   npx tsx scripts/get-started.test.mjs

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOTAL_STEPS,
  JOIN_STEP,
  stepLabel,
  SERVER_INFO_TITLE,
  PLATFORMS,
  DEFAULT_PLATFORM,
  PLATFORM_STORAGE_KEY,
  isPlatformChoice,
  platformName,
  platformFromHash,
  readStoredPlatform,
  storePlatform,
  checklistFrom,
} from '../lib/get-started.ts';
import { CLIENT_MODS, MODS } from '../config/mods.ts';

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};
const eq = (label, a, b) => ok(label, Object.is(a, b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');

const PAGE = 'app/get-started/page.tsx';
const src = read(PAGE);

/* ── 1. the spine counts itself ───────────────────────────────────────────── */

eq('there are seven steps', TOTAL_STEPS, 7);
eq('joining is step five', JOIN_STEP, 5);
ok('the join step is inside the spine', JOIN_STEP >= 1 && JOIN_STEP < TOTAL_STEPS);
eq('the eyebrow reads "Step 3 of 7"', stepLabel(3), 'Step 3 of 7');
eq('the last eyebrow closes the count', stepLabel(TOTAL_STEPS), `Step ${TOTAL_STEPS} of ${TOTAL_STEPS}`);

// No step number is typed into the page. Every eyebrow comes from stepLabel, so
// adding a step is one edit, not eight.
ok('the page renders the eyebrow from stepLabel', /\bstepLabel\(n\)/.test(src));
const prose = stripComments(src);
ok(
  'no step count is hard-coded in the page',
  !/Step \d+ of \d+/.test(prose),
  prose.match(/.{0,40}Step \d+ of \d+.{0,40}/)?.[0] ?? ''
);

// The numbers actually used, read off the JSX. One spine means 1..TOTAL_STEPS,
// each exactly as many times as there are platform paths that carry it.
const used = new Set([...src.matchAll(/<Step\s+n=\{(\d+)\}/g)].map((m) => Number(m[1])));
const wanted = Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1);
eq('every step number 1 to 7 is on the page', [...used].sort((a, b) => a - b).join(','), wanted.join(','));
ok('no step numbered past the total', Math.max(...used) === TOTAL_STEPS);

/* ── 2. the server info card names the join step ──────────────────────────── */

eq('the card heading names step five', SERVER_INFO_TITLE, `Server info (you need this at step ${JOIN_STEP})`);
ok('the page renders that heading rather than retyping it', /SERVER_INFO_TITLE/.test(src));
// The point of the move, held as a real ordering: the card comes AFTER the join
// step it serves. The first version of this check compared against the string
// "PlatformSwitch", which the import statement satisfies on line 25, so it
// stayed green no matter where the card went.
const joinAt = src.indexOf('title={`Join ${SERVER_NAME}`}');
const addressAt = src.indexOf('Server address');
ok('the join step is on the page', joinAt > 0);
ok('the server info card is on the page', addressAt > 0);
ok(
  'the address comes after the join step, not before step one',
  joinAt < addressAt,
  `join at ${joinAt}, address at ${addressAt}`
);
ok(
  'the address is not the first control on the page',
  src.indexOf('<PlatformSwitch') > 0 && src.indexOf('<PlatformSwitch') < addressAt,
  'the chooser is the first thing a reader can touch'
);
ok(
  'the prerequisite stands where the address used to',
  /You cannot join with the address alone/.test(prose)
);
ok('the finish line is on the page', /You are in\. Two things to do once you are ashore\./.test(prose));

/* ── 3. every step states its success condition ───────────────────────────── */

for (const tag of ['Step', 'Meanwhile']) {
  const opens = [...src.matchAll(new RegExp(`<${tag}\\s`, 'g'))].map((m) => m.index);
  ok(`the page has <${tag}> blocks`, opens.length > 0);
  for (const at of opens) {
    const close = src.indexOf(`</${tag}>`, at);
    assert.ok(close > at, `a <${tag}> block is unterminated at ${at}`);
    const block = src.slice(at, close);
    const title = block.match(/title=(?:"([^"]+)"|\{`([^`]+)`\})/);
    const name = title ? (title[1] ?? title[2]) : `${tag}@${at}`;
    ok(`"${name}" states when it is done`, block.includes('<DoneWhen'));
  }
}
ok('the phrase is written once, in the component', /You are done when \{children\}/.test(src));

// Step 3 is the one step with two bodies (there is a pack code, or there is not
// one yet). Its success condition has to be common to both rather than nested
// inside whichever branch happens to be live: a checkpoint that only one
// rendered path states is not a checkpoint, and the scan above cannot see the
// difference because it only looks for the substring somewhere in the block.
const importBlock = src.slice(
  src.indexOf('function StepImportPack'),
  src.indexOf('function RuneMeanwhile')
);
ok('step 3 has both bodies', importBlock.includes(') : ('));
ok(
  'step 3 states its success condition outside the branch',
  importBlock.indexOf('<DoneWhen') > importBlock.indexOf(') : ('),
  'a DoneWhen inside the pack-code branch leaves the other path with none'
);
eq('step 3 states it once', (importBlock.match(/<DoneWhen/g) ?? []).length, 1);

// The update run is folded away below the finish line, so step 3 is the only
// thing that can send a returning player to it. On launch day a new pack code
// is posted and every returning player passes through step 3.
ok('step 3 points at the update run', /Coming back to a newer pack code\?/.test(prose));
ok('the update run is what it points at', src.includes('id="update"'));
// Every path, not just the r2modman ones. A Mac player updates differently and
// still has to be able to find the section that says how.
const reachesUpdate = (block) =>
  block.includes('href="#update"') ||
  (block.includes('<StepImportPack') && importBlock.includes('href="#update"'));
for (const [name, block] of [
  ['windows', between(src, 'const windowsSteps = (', 'const linuxSteps = (')],
  ['linux', between(src, 'const linuxSteps = (', 'const macSteps = (')],
  ['mac', between(src, 'const macSteps = (', '\n  return (')],
]) {
  ok(`the ${name} path can reach the update run`, reachesUpdate(block));
}

/* ── 3b. the spine is one sequence, and the numbering is the eyebrow ──────── */

// The steps used to be <li> inside three separate <ol>s, with the unnumbered
// rune interlude among them. Assistive tech announces list positions, so it
// read "item 4 of 5" over an eyebrow saying "Step 3 of 7", and the join was
// "item 1 of 1" in a list of its own. The eyebrow is the numbering; the spine
// is a plain stack.
const stepBlock = src.slice(src.indexOf('function Step('), src.indexOf('function Meanwhile('));
const meanwhileBlock = src.slice(src.indexOf('function Meanwhile('), src.indexOf('function DoneWhen('));
ok('a step is not a list item', !/<li[\s>]/.test(stepBlock));
ok('the interlude is not a list item', !/<li[\s>]/.test(meanwhileBlock));
for (const region of orderedListRegions(src)) {
  ok(
    'no step is wrapped in an <ol>',
    !region.includes('<Step') && !region.includes('<Meanwhile'),
    region.slice(0, 80)
  );
}

/* ── 3c. the page has a heading outline, not one heading over everything ──── */

// Two h2s went missing in the reorganisation: the finish line became a styled
// <p> and the update run became a <summary>. Neither was reachable by heading
// navigation, and the one surviving h2 ("Install the mods and join") silently
// claimed the finish line and both post-join rites as its own.
ok(
  'the finish line is a heading',
  /<h2[^>]*>\s*You are in\. Two things to do once you are ashore\./.test(prose)
);
ok(
  'the update run is a heading inside its summary',
  /<summary[\s\S]{0,400}?<h2[\s\S]{0,200}?How to update your mods/.test(prose)
);
// A <summary> that renders as a plain bordered bar does not read as something
// that opens, and behind it is the button a returning player needs.
ok('the disclosure shows that it opens', /group-open:rotate-180/.test(src));

/* ── 3d. the update run is the returning player's whole visit ─────────────── */

// LAUNCH NIGHT, 2026-09-09. Whenever a new pack code is minted, most of the
// hall is updating rather than installing, and the update run sits below the
// finish line where they will never scroll. Three facts carry them to it and
// each one was absent at some point:
//   - the disclosure renders OPEN (it stays a <details> so a first-timer can
//     fold it away, but a closed box under the finish line is a box nobody
//     opens),
//   - the top of the page says so, above the steps,
//   - and the run inside it is one r2modman click per line. The four-line
//     version bundled three buttons onto one line, which is how a reader ends
//     up on "Import new profile" and plays the night on the old mods.
ok('the update run is open by default', /<details\s+open\b/.test(src));
const calloutAt = prose.indexOf('You only need to update it.');
ok('a returning-player callout is on the page', calloutAt > 0);
ok(
  'the callout stands above the steps, not below the finish line',
  calloutAt > 0 && calloutAt < prose.indexOf('<PlatformSwitch'),
  `callout at ${calloutAt}, chooser at ${prose.indexOf('<PlatformSwitch')}`
);
ok(
  'the update run is one click per line',
  (src.match(/<UpdateStep[\s>]/g) ?? []).length >= 8,
  'eight or nine steps, each a single r2modman action'
);

/* ── 4. anchors other pages link to still exist ───────────────────────────── */

const linked = new Set();
for (const file of walk(['app', 'components'])) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\/get-started#([A-Za-z0-9_-]+)/g)) linked.add(m[1]);
}
ok('some page deep-links into Get Started', linked.size > 0, [...linked].join(', '));
for (const id of linked) {
  ok(`the anchor #${id} is still on the page`, src.includes(`id="${id}"`));
}
// Held explicitly as well as by the scan: these two survived the reorganisation
// on purpose. #once-you-are-in is the oath wall's link, #mac-setup is what older
// Discord links name.
for (const id of ['once-you-are-in', 'mac-setup', 'trouble']) {
  ok(`the anchor #${id} is on the page`, src.includes(`id="${id}"`));
}

/* ── 5. the platform chooser ──────────────────────────────────────────────── */

eq('three platforms', PLATFORMS.length, 3);
eq('their ids are unique', new Set(PLATFORMS.map((p) => p.id)).size, 3);
ok('the default is a real platform', PLATFORMS.some((p) => p.id === DEFAULT_PLATFORM));
eq('the default is Windows', DEFAULT_PLATFORM, 'windows');
for (const p of PLATFORMS) {
  ok(`"${p.id}" is a valid choice`, isPlatformChoice(p.id));
  ok(`"${p.id}" has one name`, Boolean(p.name));
}
// WCAG 2.5.3 Label in Name: the chooser used to shorten the Linux button to
// "Linux / Deck" below lg while its accessible name stayed "Linux and Steam
// Deck", so a voice-control user could read the button and not be able to say
// it. One name, rendered, with no aria-label over the top of it.
ok(
  'the chooser carries no second, shorter label',
  !/\bshort\b/.test(stripComments(read('lib/get-started.ts')))
);
ok(
  'the chooser buttons render their own name',
  /\{p\.name\}/.test(stripComments(read('components/get-started/PlatformSwitch.tsx')))
);
ok('"all" is the escape hatch', isPlatformChoice('all'));
for (const junk of [null, undefined, '', 'Windows', 'windows ', 'bsd', 0, {}]) {
  ok(`${JSON.stringify(junk)} is rejected`, !isPlatformChoice(junk));
}
eq('platformName knows Mac', platformName('mac'), 'Mac');
eq('platformName covers the escape hatch', platformName('all'), 'All platforms');
ok('the storage key is namespaced', PLATFORM_STORAGE_KEY.startsWith('eilif:'));

// An anchor may ask for a platform, and nothing else may. `#mac-setup` is what
// older Discord links name. Everything else on the page has to answer null:
// when the hash was read live on every snapshot, following the server card's
// own "See the fixes below" link to #trouble fired hashchange, the hash no
// longer said mac, and a Mac reader was quietly moved onto Windows steps.
eq('an old #mac-setup link still means Mac', platformFromHash('#mac-setup'), 'mac');
eq('a panel id selects its platform', platformFromHash('#steps-linux'), 'linux');
eq('so does the Mac panel id', platformFromHash('#steps-mac'), 'mac');
for (const hash of ['', '#', '#trouble', '#once-you-are-in', '#update', '#steps-', '#steps-bsd']) {
  eq(`"${hash}" says nothing about the platform`, platformFromHash(hash), null);
}
ok(
  'the chooser latches the hash rather than re-reading it',
  /latchHash/.test(read('components/get-started/PlatformSwitch.tsx'))
);

// Both storage helpers are called from a browser, and both must be harmless
// anywhere else. There is no `window` in this process, so this is the same code
// path a locked-down browser takes when localStorage throws.
eq('reading storage without a browser returns null', readStoredPlatform(), null);
ok('writing storage without a browser does not throw', (() => {
  storePlatform('mac');
  return true;
})());

// The same helpers against a browser that works. The escape hatch is the point:
// "show all platforms" must not be written over the reader's own platform, or
// leaving it again has nothing to go back to and every future visit opens on
// Windows.
withFakeStorage((store) => {
  storePlatform('mac');
  eq('an explicit choice is remembered', readStoredPlatform(), 'mac');
  storePlatform('all');
  eq('the show-all escape is not remembered', store.get(PLATFORM_STORAGE_KEY), 'mac');
  eq('so the reader still has a platform to go back to', readStoredPlatform(), 'mac');
  storePlatform('linux');
  eq('a later choice replaces the first', readStoredPlatform(), 'linux');
  store.set(PLATFORM_STORAGE_KEY, 'amiga');
  eq('a junk value in storage is ignored', readStoredPlatform(), null);
});
withThrowingStorage(() => {
  eq('a browser that refuses storage reads null', readStoredPlatform(), null);
  ok('and does not throw on a write', (() => {
    storePlatform('mac');
    return true;
  })());
});

const switchSrc = read('components/get-started/PlatformSwitch.tsx');
ok('the chooser is a client component', /^'use client';/.test(switchSrc));
// The remembered choice lives in the browser, so the first client render has to
// be allowed to disagree with the server's HTML. useSyncExternalStore is the one
// hook that does that without a hydration warning or a flash of the wrong path.
ok('the remembered choice is read through useSyncExternalStore', /useSyncExternalStore\(/.test(switchSrc));
ok('it gives the server its own snapshot', /getServerSnapshot/.test(switchSrc));
ok('it never reaches for localStorage itself', !/localStorage/.test(stripComments(switchSrc)));
ok('the page mounts exactly one chooser', (prose.match(/<PlatformSwitch\s/g) ?? []).length === 1);
ok('all three step lists are handed to it', /windows=\{/.test(src) && /linux=\{/.test(src) && /mac=\{/.test(src));
ok('there is a show-all escape', /Show all platforms/.test(switchSrc));
// Leaving the escape hatch goes back to the platform the reader picked, not to
// the default. It used to call choose(DEFAULT_PLATFORM), which repainted a Mac
// reader as Windows and wrote that to storage for every visit after it.
ok('leaving the escape hatch restores the remembered platform', /closeShowAll/.test(switchSrc));
ok(
  'the escape hatch does not reset to the default',
  !/choose\(showAll \? DEFAULT_PLATFORM/.test(switchSrc)
);

/* ── 6. the Mac checklist is derived, never retyped ───────────────────────── */

const list = checklistFrom(CLIENT_MODS);
ok('the checklist has rows', list.length > 0);
eq('one row per pinned client mod', list.length, CLIENT_MODS.filter((m) => m.version).length);
for (const row of list) {
  const source = MODS.find((m) => m.name === row.name);
  ok(`"${row.name}" is a real mod`, Boolean(source));
  eq(`"${row.name}" carries the version config/mods.ts pins`, row.version, source.version);
}
// A row with no pinned version would be a blank a player has to guess at.
ok('no row is missing its version', list.every((r) => Boolean(r.version)));
// Filtering, on a synthetic list so the assertions do not move with the pack.
const synthetic = checklistFrom([
  { name: 'Kept', version: '1.0.0', clientRequired: true, url: 'https://example.invalid/' },
  { name: 'Server only', version: '2.0.0', clientRequired: false },
  { name: 'Still being piloted', version: '3.0.0', clientRequired: true, tentative: true },
  { name: 'No pinned version', clientRequired: true },
]);
eq('server-only, tentative and unpinned mods are all dropped', synthetic.map((m) => m.name).join(','), 'Kept');
eq('the link comes through', synthetic[0].url, 'https://example.invalid/');

const checklistSrc = read('components/get-started/ModChecklist.tsx');
ok('the checklist table hard-codes no version', !/\d+\.\d+\.\d+/.test(checklistSrc));
ok('the page counts the mods rather than saying a number', /MAC_MODS\.length/.test(src));
ok('the checklist is fed from config/mods.ts', /checklistFrom\(CLIENT_MODS\)/.test(src));

// docs/LAUNCH-DAY.md step 19 tells the editor to search this file for this
// phrase. It survives only as a comment now that the versions are derived, and
// it has to keep surviving.
ok('the launch-day cutover anchor is still findable', src.includes('install these seven'));

// Step 19 edit 3, held as a test rather than as a note somebody has to read at
// 15:00 on launch day. MODPACK_VERSION_LABEL moves at the mint and a typed
// version does not, so a "you are current if you see X" sentence starts lying
// the moment the label changes, on the one night an old pack gets a player
// refused. Nothing on this page may retype a pinned version: the checklist is
// derived and the self-check points at /resources.
for (const m of CLIENT_MODS) {
  if (!m.version) continue;
  ok(
    `the page does not retype "${m.name} ${m.version}"`,
    !prose.includes(`${m.name} ${m.version}`),
    'derive it from config/mods.ts or point at /resources#mods'
  );
}
// The count too: "seven" was typed in three places and the pack does not have
// to stay at seven.
ok('the page counts the steps rather than spelling the number', /\{TOTAL_STEPS\}/.test(src));
ok('no mod count is spelled out', !/\b(seven|eight|six) (mods|versions)\b/i.test(prose));

/* ── 7. house style ───────────────────────────────────────────────────────── */

for (const [name, text] of [
  [PAGE, prose],
  ['components/get-started/PlatformSwitch.tsx', stripComments(switchSrc)],
  ['components/get-started/ModChecklist.tsx', stripComments(checklistSrc)],
  ['lib/get-started.ts', stripComments(read('lib/get-started.ts'))],
]) {
  ok(`no em or en dash in ${name}`, !/[—–]/.test(text), text.match(/.{0,40}[—–].{0,40}/)?.[0] ?? '');

  // The SWC/Turbopack transform DROPS the leading space of a JSX text node that
  // contains an HTML entity, so `</strong> Steam&apos;s` renders as
  // "notSteam's". Seven sites were fixed this way on 2026-09-05 (commit
  // 63147a0) and the rewrite put three of them back, in the one sentence that
  // stops a player launching vanilla. The fix is always an explicit {' '}.
  const runOn = text.match(/<\/[A-Za-z]+> [^<>{}\n]*&[a-z]+;/);
  ok(
    `no space dropped before an HTML entity in ${name}`,
    !runOn,
    runOn ? `${runOn[0]} : write {' '} instead of a bare space` : ''
  );
}

// The entry the whole of launch week routes through. scripts/launch-week-copy.test.mjs
// owns its wording; this only refuses to let the reorganisation drop it.
ok('the launch-week troubleshooting entry survived', src.includes('during launch week (Sept 9 to 12)'));

console.log(
  `\nOK — Get Started: ${checks} checks. One spine of ${TOTAL_STEPS} steps, joining at ` +
    `${JOIN_STEP}, every step with a success condition, every deep link still landing, and the ` +
    `Mac checklist read out of config/mods.ts.`
);

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Source with every comment removed, so assertions are about copy, not notes. */
function stripComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The slice of `text` between two markers. Throws rather than silently empty. */
function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0, `marker not found: ${start}`);
  assert.ok(b > a, `marker not found after ${start}: ${end}`);
  return text.slice(a, b);
}

/** The inside of every <ol> ... </ol> in the source, nesting ignored. */
function orderedListRegions(text) {
  const out = [];
  for (const m of text.matchAll(/<ol[\s>]/g)) {
    const close = text.indexOf('</ol>', m.index);
    out.push(text.slice(m.index, close === -1 ? text.length : close));
  }
  return out;
}

/** Run `fn` with a working localStorage in place, then put the world back. */
function withFakeStorage(fn) {
  const store = new Map();
  const had = 'window' in globalThis;
  const before = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
  };
  try {
    fn(store);
  } finally {
    if (had) globalThis.window = before;
    else delete globalThis.window;
  }
}

/** The private window with site data blocked: every access throws. */
function withThrowingStorage(fn) {
  const had = 'window' in globalThis;
  const before = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error('SecurityError: storage is blocked');
    },
  };
  try {
    fn();
  } finally {
    if (had) globalThis.window = before;
    else delete globalThis.window;
  }
}

/** Every .ts/.tsx file under the given directories. */
function walk(dirs) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const d of dirs) visit(repo(d));
  return out;
}
