// "The altar is marked on the atlas" — the line, and whether it is true.
//
// The war-room used to render that link from a hardcoded set of two boss slugs,
// left over from a demo atlas /map no longer draws. So Eikthyr and The Elder
// linked to a map with no altar on it, every boss that DOES get a real altar pin
// got no link, and the set would have survived the launch wipe and carried both
// claims onto a world where nothing had been charted (T-3 audit site-4).
//
// It is now driven by the pin /api/gs-ingest actually writes. These checks pin
// the matching rule, and one of them reads the page source to make sure the
// hardcoded set has not come back.
//
//   npx tsx scripts/boss-altar-link.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { findAltarPin } from '../components/boss/altar.ts';
import { altarPinName, ALTAR_PIN_KIND } from '../lib/altar.ts';

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

const pin = (name, pinKind = ALTAR_PIN_KIND) => ({ name, pinKind, id: name });

// ── the altar is charted ────────────────────────────────────────────────────
const withAltar = [
  pin('the hamlet', 'base'),
  pin('Eikthyr altar'),
  pin('Rando Tree', 'poi'),
];
ok('a real altar pin lights the link', findAltarPin(withAltar, 'Eikthyr')?.name === 'Eikthyr altar');
ok('the name is built the way the route builds it', altarPinName('Eikthyr') === 'Eikthyr altar');

// ── it is not charted ───────────────────────────────────────────────────────
// The six pins production actually holds today, none of them an altar. Under the
// old hardcoded set BOTH Eikthyr and The Elder claimed one.
const productionToday = [
  pin('the hamlet', 'base'),
  pin('Chaerleif', 'base'),
  pin('loaddddd', 'poi'),
  pin('BEECH', 'poi'),
  pin('Mushroom Kingdom', 'poi'),
  pin('Rando Tree', 'poi'),
];
ok('no altar pin, no link (Eikthyr)', findAltarPin(productionToday, 'Eikthyr') === null);
ok('no altar pin, no link (The Elder)', findAltarPin(productionToday, 'The Elder') === null);
ok('an empty atlas is not an altar', findAltarPin([], 'Bonemass') === null);
ok('a missing atlas is not an altar', findAltarPin(null, 'Bonemass') === null);
ok('a nameless boss is not an altar', findAltarPin(withAltar, '') === null);
ok('an undefined boss is not an altar', findAltarPin(withAltar, undefined) === null);

// ── every boss is treated alike ─────────────────────────────────────────────
// The point of the change: the five bosses the hardcoded set could never light.
for (const name of ['Bonemass', 'Moder', 'Yagluth', 'The Queen', 'Fader', 'Forsaken VIII']) {
  ok(`${name} lights the link when its altar is charted`,
    findAltarPin([...productionToday, pin(altarPinName(name))], name)?.name === `${name} altar`);
}

// ── only the hall's own pin counts ──────────────────────────────────────────
// A viking can shout `/pin Eikthyr altar` and get a row with the same NAME. Only
// /api/gs-ingest writes kind 'boss', so the kind is what tells them apart — a
// player's pin must not make the page claim the hall charted the fall.
ok('a player pin with the altar name does not count',
  findAltarPin([pin('Eikthyr altar', 'poi')], 'Eikthyr') === null);
ok('a base pin with the altar name does not count',
  findAltarPin([pin('Eikthyr altar', 'base')], 'Eikthyr') === null);
ok('a pin with no kind at all does not count',
  findAltarPin([{ name: 'Eikthyr altar' }], 'Eikthyr') === null);

// ── the match survives ordinary noise ───────────────────────────────────────
ok('case does not matter', findAltarPin([pin('eikthyr ALTAR')], 'Eikthyr') !== null);
ok('doubled spaces do not matter', findAltarPin([pin('Eikthyr  altar')], 'Eikthyr') !== null);
ok('surrounding space does not matter', findAltarPin([pin('  Eikthyr altar ')], 'Eikthyr') !== null);
// ...but a different boss's altar is a different altar.
ok('one boss does not borrow another\'s altar',
  findAltarPin([pin('The Elder altar')], 'Eikthyr') === null);
ok('a bare boss name is not an altar', findAltarPin([pin('Eikthyr')], 'Eikthyr') === null);
ok('a null pin name is skipped', findAltarPin([{ name: null, pinKind: 'boss' }, pin('Eikthyr altar')], 'Eikthyr') !== null);

// ── the hardcoded set is gone and stays gone ────────────────────────────────
const page = readFileSync(new URL('../app/boss/[slug]/page.tsx', import.meta.url), 'utf8');
ok('the demo set is gone from the war-room', !/BOSSES_ON_MAP/.test(page));
ok('the link is rendered from a pin', /\{altarPin &&/.test(page));
ok('the war-room reads the atlas', /getPins\(\)/.test(page) && /findAltarPin/.test(page));
ok('the altar line itself is unchanged', /The altar is marked on the atlas\. View the map/.test(page));

console.log(`\nOK — boss altar link: ${checks} checks. The line renders only for a boss with a real ` +
  `kind='${ALTAR_PIN_KIND}' "<Boss> altar" pin, and a player-made pin of the same name never counts.`);
