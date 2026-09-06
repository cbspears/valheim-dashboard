// TRIPWIRE for the Hall's first-run band and its stat strip
// (UX review 2026-09-06, proposal 2).
//
// Two things this holds, both of which a well-meaning edit can undo without
// anything else failing:
//
//   1. THE HALL HAS A ROUTE IN. Before this band, app/page.tsx linked to
//      /events, /oath and /world and nowhere else: on a phone the only way to
//      Get Started from the Hall was the tenth item behind the hamburger. The
//      band must exist, must sit between the hero and the stat strip, must
//      carry a target big enough to hit (44px), and must default to VISIBLE.
//      A dismissal is a convenience for a returning viking, never a gate, so
//      every storage failure has to land on "show it".
//
//   2. THE STRIP CARRIES FACTS THE HERO DOES NOT. Three of the four tiles used
//      to restate the hero strip 200px above them (online now, world day,
//      bosses felled). The hero still says all three; the tiles must not.
//
// Copy doctrine (CLAUDE.md): no em dashes, no en dashes in anything a player
// reads. Comments are stripped before that sweep; this file's own prose is not
// player copy.
//
// Picked up automatically by `npm test`.
// Run alone: npx tsx scripts/hall-first-run.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRIC_INFO } from '../lib/milestones.ts';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');

const BAND = 'components/home/FirstRunBand.tsx';
const HALL = 'app/page.tsx';
const band = read(BAND);
const hall = read(HALL);

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ── 1. the band exists and says what it was written to say ─────────────────

ok(/^'use client';/m.test(band), 'the band is a client component (it remembers a dismissal)');
ok(band.includes('New to Eilif? Start here'), 'the band names the reader it is for');
ok(
  band.includes('Install the modpack and log on. About 15 minutes, no experience needed.'),
  'and says what the next fifteen minutes hold',
);
ok(band.includes('href="/get-started"'), 'the primary button opens Get Started');
ok(band.includes('href="/resources#mods"'), 'the quiet second door opens the mod list');
ok(band.includes('What mods do I need?'), 'and is labelled as the question it answers');

// SC 2.5.8 target size, and the plan's own floor: the gold button is the one
// control a first-timer on a phone has to hit.
const cta = band.match(/href="\/get-started"\s*\n\s*className="([^"]+)"/);
ok(cta, 'the button carries a className to check');
ok(/\bmin-h-11\b/.test(cta[1]), 'the gold button is at least 44px tall (min-h-11)');
const dismissBtn = band.match(/<button[\s\S]*?className="([^"]+)"/);
ok(dismissBtn && /\bh-11\b/.test(dismissBtn[1]), 'the dismiss control is 44px on a phone');
ok(/aria-label="[^"]+"/.test(band), 'and the dismiss control says what it does to a screen reader');
ok(
  /aria-labelledby="first-run-heading"/.test(band) && /id="first-run-heading"/.test(band),
  'the band is a landmark named by its own heading',
);

// ── 2. dismissal is a convenience, never a gate ────────────────────────────
//
// RUN, do not pattern-match. The first version of this section asserted
// `!/catch[\s\S]{0,120}setDismissed\(true\)/`, which was anchored on a call
// 500 characters away from the catch that mattered: changing readDismissed's
// catch to `return true` (a private window now HIDES the band from someone who
// has never dismissed it, the one failure this component exists to prevent)
// passed all 126 assertions. So the storage reader and the server snapshot are
// both exercised for real below.

const { FirstRunBand, readDismissed, DISMISS_KEY } = await import(
  '../components/home/FirstRunBand.tsx'
);
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

/** Swap in a fake browser store for one call. */
const withStore = (localStorage, fn) => {
  const had = 'window' in globalThis;
  const previous = globalThis.window;
  globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {} };
  try {
    return fn();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
};

const THROWS = {
  getItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  setItem() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
};

ok(DISMISS_KEY.startsWith('eilif:'), 'the dismissal key is namespaced to this site');
ok(readDismissed() === false, 'no window at all reads as "not dismissed"');
ok(
  withStore(THROWS, readDismissed) === false,
  'a storage that throws reads as "not dismissed" (private window, blocked site data)',
);
ok(
  withStore({ getItem: () => null }, readDismissed) === false,
  'a browser that has never dismissed it reads as "not dismissed"',
);
ok(
  withStore({ getItem: (k) => (k === DISMISS_KEY ? '1' : null) }, readDismissed) === true,
  'and the one browser that DID dismiss it reads as dismissed',
);

// The server snapshot ignores storage entirely: the HTML this page ships is
// the same for everyone, so one viewer's dismissal can never be baked into it.
const ssr = withStore(
  { getItem: () => '1' },
  () => renderToStaticMarkup(createElement(FirstRunBand)),
);
ok(ssr.includes('New to Eilif? Start here'), 'the rendered band carries its heading');
ok(ssr.includes('href="/get-started"'), 'and its route in, even when the store says dismissed');
ok(
  withStore(THROWS, () => renderToStaticMarkup(createElement(FirstRunBand))).length > 0,
  'a throwing store cannot take the render down',
);

// Every single touch of localStorage sits inside a try block. A throw from
// window.localStorage (a private window, blocked site data) must not take the
// Hall down with it.
// Comments strip first: this component's own documentation says the word
// "localStorage" three times, and prose is not an access.
const bandCode = stripComments(band);
const tryBlocks = [...bandCode.matchAll(/try\s*\{[\s\S]*?\}\s*catch/g)].map((m) => [
  m.index,
  m.index + m[0].length,
]);
const touches = [...bandCode.matchAll(/localStorage/g)].map((m) => m.index);
ok(touches.length >= 2, 'the band both reads and writes the dismissal');
for (const at of touches) {
  ok(
    tryBlocks.some(([from, to]) => at > from && at < to),
    `every localStorage access is inside a try/catch (offset ${at})`,
  );
}

// Nothing a catch does may end in the dismissed state. Every catch body in the
// file is read whole (brace-matched, not a fixed lookahead) and none of them
// may so much as mention `true`, which is the value that hides the band.
const catchBodies = [];
for (const m of bandCode.matchAll(/catch\s*(?:\([^)]*\)\s*)?\{/g)) {
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < bandCode.length && depth > 0; i++) {
    if (bandCode[i] === '{') depth++;
    else if (bandCode[i] === '}') depth--;
  }
  catchBodies.push(bandCode.slice(m.index + m[0].length, i - 1));
}
ok(catchBodies.length >= 2, `both storage failures are caught (${catchBodies.length} catch blocks)`);
for (const body of catchBodies) {
  ok(!/\btrue\b/.test(body), `a storage failure never lands on "dismissed": ${JSON.stringify(body.trim().slice(0, 60))}`);
  ok(!/\bthrow\b/.test(body), 'and never rethrows');
}

// ── 3. the Hall renders it, in the right place ─────────────────────────────

ok(
  hall.includes("import { FirstRunBand } from '@/components/home/FirstRunBand'"),
  'the Hall imports the band',
);
const iHero = hall.indexOf('<HomeHero');
const iBand = hall.indexOf('<FirstRunBand />');
const iStrip = hall.indexOf('<StatTile');
ok(iHero > 0 && iBand > iHero, 'the band sits below the hero');
ok(iStrip > iBand, 'and above the stat strip, where the plan put it');

// ── 4. the strip carries only facts the hero does not ──────────────────────

const tileLabels = [...hall.matchAll(/<StatTile\b[\s\S]*?\/>/g)]
  .map((m) => m[0].match(/label=(?:"([^"]+)"|\{metricInfo\('([^']+)'\)\.label\})/))
  .map((m) => (m ? (m[1] ?? METRIC_INFO[m[2]].label) : null));
ok(tileLabels.length === 4, `the strip is four tiles (got ${tileLabels.length})`);
ok(!tileLabels.some((l) => l === null), 'every tile label is a literal or comes from METRIC_INFO');

// The hero still says all three of these, twenty lines above the strip.
for (const [fact, inHero] of [
  ['Online Now', '/ {MAX_PLAYERS} sailing'],
  ['World Day', 'of this world'],
  ['Bosses Felled', 'Forsaken\n          felled'],
]) {
  ok(!tileLabels.includes(fact), `the strip no longer restates "${fact}"`);
  ok(hall.includes(inHero), `and the hero still carries it (${JSON.stringify(inHero)})`);
}

// "Pins" is the plan's own sketch label and its section 4 canonical word for
// the thing (it retires "place"); it is also what a player types to make one.
for (const label of ['Total vikings', METRIC_INFO.playtime_total_hours.label, METRIC_INFO.deaths_total.label, 'Pins']) {
  ok(tileLabels.includes(label), `the strip carries "${label}"`);
}
// One register for metric names (lib/milestones METRIC_INFO), so the Hall
// cannot drift from the /world ledger and the /players boards.
ok(hall.includes("metricInfo('playtime_total_hours').label"), 'hours are labelled from the register');
ok(hall.includes("metricInfo('deaths_total').label"), 'deaths are labelled from the register');

// ── 5. the reading order the plan asked for ────────────────────────────────

// Matched on what the source actually renders, not on the banner comments:
// the objective the warband is chasing, who is on, what it has earned, what is
// next, then the record and the oath. Boss progress used to be dead last.
const order = [
  ['the current objective', 'title="Boss progress"'],
  ['who is on now', '<Hearth '],
  ['great deeds', '<GreatDeedsCard'],
  ['coming up', 'title="Coming Up"'],
  ['recent story', 'title="Recent story"'],
  ['the oath teaser', 'href="/players#oaths"'],
];
let at = -1;
for (const [name, marker] of order) {
  const next = hall.indexOf(marker, at + 1);
  ok(next > at, `${name} comes after what precedes it in the reading order`);
  at = next;
}

// /oath folded into /players#oaths on 2026-09-06 and app/oath/page.tsx is
// gone, so a Hall that still linked to /oath would spend a 308 on every click.
ok(!hall.includes('href="/oath"'), 'the oath teaser does not link through the redirect');

// Five rows, per the sketch. The feed's most common event is one viking
// arriving and leaving, and eight rows of it spent a whole card on one name.
ok(/getRecentEvents\(5\)/.test(hall), 'the story feed is five rows deep, not eight');

// The launch-night way in, kept from the minor set: an empty feed still hands
// the reader a next step.
ok(
  /EmptyState[\s\S]{0,600}href="\/get-started"/.test(hall),
  'the empty story feed still links to Get Started',
);

// ── 6. copy doctrine over both files ───────────────────────────────────────

let strings = 0;
for (const [f, raw] of [[BAND, band], [HALL, hall]]) {
  const src = stripComments(raw);
  const nodes = [...src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]);
  const props = [...src.matchAll(/(?:title|label|hint|message|aria-label)=["']([^"']+)["']/g)]
    .map((m) => m[1]);
  for (const s of [...nodes, ...props]) {
    ok(!s.includes('—'), `no em dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
    ok(!s.includes('–'), `no en dash in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
    strings++;
  }
  for (const s of props) {
    ok(!s.includes('!'), `no exclamation mark in ${f}: ${JSON.stringify(s.slice(0, 60))}`);
  }
}
ok(strings > 20, `the Hall's own copy was really scanned (${strings} strings)`);

console.log(`hall-first-run.test: ${passed} assertions passed`);
