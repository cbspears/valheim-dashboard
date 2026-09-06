// Two lines of launch-week copy that were true of one branch and wrong on the
// other, held to the facts of record.
//
// 1. /commands, the gallery entry. It said "Works in any channel of the hall,
//    because no gallery channel is set" — a claim about the Discord bot's .env
//    that the site never sees and Vercel has no variable for. The fact is fine
//    (that IS the intended setting); the reason was not the site's to give.
//    scripts/commands-page.test.mjs already holds "any channel" to the deployed
//    bot's env; this file holds the sentence to what the site can know.
//
// 2. /get-started, the launch-week "Incompatible version" entry. It said "Let
//    Steam finish updating Valheim, then import the new pack code posted in
//    Discord" — right on the 1.0 night, and exactly backwards on the other one.
//    Charlie's cutoff (docs/LAUNCH-DAY.md) is that no 1.0 by noon CT means a
//    vanilla night: the box stays on the older build and the pack is NOT
//    re-minted, so a player who took that advice cannot join, and the pack code
//    it promises does not exist. This is the page every confused player is
//    pointed at during launch week (T-3 audit site-5, site-6).
//
//   npx tsx scripts/launch-week-copy.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DISCORD_COMMANDS } from '../config/commands.ts';

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

// ── 1. the gallery entry says only what the site can know ───────────────────
const gallery = DISCORD_COMMANDS.find((e) => e.id === 'gallery');
ok('the gallery entry is still on the page', Boolean(gallery));
const note = gallery.note ?? '';
ok('it still tells the hall any channel works', /any channel of the hall/i.test(note), note);
// The specific claim that made it a lie waiting to happen: a statement about a
// variable in a file the site cannot read.
ok('it no longer explains itself with the bot\'s env',
  !/no gallery channel is set/i.test(note) && !/CHANNEL_GALLERY/.test(note), note);
ok('it keeps the two limits a poster needs', /12 MB/.test(note) && /bin/.test(note), note);

// Nothing on the page may reach for process.env: it renders on Vercel, and the
// bot's environment lives on a different machine entirely.
const commandsSrc = readFileSync(new URL('../config/commands.ts', import.meta.url), 'utf8');
ok('the register reads no environment at all', !/process\.env/.test(commandsSrc));

// ── 2. the launch-week entry holds on both branches ─────────────────────────
const page = readFileSync(new URL('../app/get-started/page.tsx', import.meta.url), 'utf8');
const entry = sliceTrouble(page, 'Incompatible version” during launch week');
ok('the launch-week entry is still on the page', entry.length > 0);

// The launch announcement is the one thing a player must read either way, and
// it must be named: without it the copy is just two branches the player cannot
// choose between.
//
// AND IT MUST BE NAMED IN A WORD THE PLAYER CAN FIND. This first shipped as "the
// GO post in Discord", which is the runbook's word for docs/LAUNCH-DAY.md step 22
// and appears nowhere a player can read: the bot posts nothing labelled that, and
// no page on this site defines it. The rest of get-started already says a mod
// update is "announced in Discord", so the entry uses the same register.
// JSX prose is hard-wrapped by the formatter, so every assertion about a
// SENTENCE reads the whitespace-collapsed text. Asserting against the raw slice
// makes the test fail when a word moves across a line break, which is a
// formatting change, not a copy change.
const flat = entry.replace(/\s+/g, ' ');
ok('it points at the launch announcement in Discord',
  /launch announcement in Discord/.test(flat), flat);
ok('it does not send the player after a runbook word',
  !/\bGO post\b/.test(entry.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')), entry);

// Branch A, 1.0 night: update, then take the new pack code.
ok('the 1.0 branch says update and re-import',
  /let Steam finish updating/.test(flat) && /new pack code/.test(flat), flat);
// Branch B, vanilla night: do NOT update, keep the pack you have.
ok('the vanilla branch says do not update yet', /do not let Steam update yet/.test(flat), flat);
ok('the vanilla branch says keep the pack you have', /keep the pack code you already have/.test(flat), flat);
ok('the vanilla branch says HOW to hold the update',
  /Only update this game when I launch it/.test(flat), flat);

// The failure mode this is guarding: unconditional advice. If the entry ever
// tells the player to update without naming a condition, it is wrong on the
// branch Charlie decided at noon.
ok('the update advice is conditional, not a flat instruction',
  /if it says 1\.0/i.test(flat), flat);
ok('the holding advice is conditional too',
  /if it says the hall is holding/i.test(flat), flat);

// House style for player-facing copy: no em or en dashes (the same rule
// scripts/stress/page-check.mjs enforces against the rendered page).
const prose = entry.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
ok('no em or en dash in the entry', !/[—–]/.test(prose), prose.match(/.{0,40}[—–].{0,40}/)?.[0] ?? '');

console.log(`\nOK — launch-week copy: ${checks} checks. /commands claims nothing about the bot's ` +
  `environment, and /get-started's launch-week entry is true on the 1.0 night and on a vanilla night.`);

/** The JSX of one <Trouble> block, by a distinctive fragment of its symptom. */
function sliceTrouble(src, symptomFragment) {
  const at = src.indexOf(symptomFragment);
  if (at === -1) return '';
  const open = src.lastIndexOf('<Trouble', at);
  const close = src.indexOf('</Trouble>', at);
  if (open === -1 || close === -1) return '';
  return src.slice(open, close + '</Trouble>'.length);
}
