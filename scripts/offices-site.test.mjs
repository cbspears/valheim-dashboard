// Unit tests for the site's half of the Storyteller: the office badge
// (components/viking/office.ts) and the war-room's apocryphal and untold
// branches (components/boss/tellings.ts). No React, no Supabase.
//
// Covers, in order:
//   1. reading the open term out of the roll
//   2. the label beside a viking's epithet, now and in an earlier act
//   3. the apocryphal telling, and that it is never listed twice
//   4. the untold clock, that it matches the bot's nudge clock exactly, and that
//      it stays silent on a hall with no office roll (the ships-off gate)
//   5. that the office is NOT an epithet dimension
//
// Run: npx tsx scripts/offices-site.test.mjs   (npm test picks it up)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { currentHolder, currentOffice, officeLabelFor } from '../components/viking/office.ts';
import {
  DRAFT_STANDS_AFTER_MS,
  apocryphalTelling,
  nudgeDueAt,
  otherTellings,
  pickTelling,
  wantsStoryteller,
} from '../components/boss/tellings.ts';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const DAY = 86_400_000;

const OFFICES = [
  {
    id: 'o2',
    office: 'storyteller',
    holder_character: 'Astrid',
    since: '2026-09-05T00:00:00Z',
    until: null,
    elected_by: 'vote',
    act: null,
    created_at: '2026-09-05T00:00:00Z',
  },
  {
    id: 'o1',
    office: 'storyteller',
    holder_character: 'Bren Bjornsson',
    since: '2026-08-01T00:00:00Z',
    until: '2026-09-05T00:00:00Z',
    elected_by: 'named',
    act: 'Eikthyr',
    created_at: '2026-08-01T00:00:00Z',
  },
];

// ── 1. The open term ──────────────────────────────────────────────────────
{
  eq(currentOffice(OFFICES)?.id, 'o2', 'the open term is the one with no end');
  eq(currentHolder(OFFICES), 'Astrid', 'and its holder is the Storyteller');
  eq(currentHolder([]), null, 'an empty roll has no holder');
  eq(currentHolder(OFFICES.filter((o) => o.until)), null, 'and a roll of closed terms has none either');
  eq(currentHolder([{ ...OFFICES[0], holder_character: '   ' }]), null, 'a blank name is no name');
  eq(currentOffice(OFFICES, 'jarl'), null, 'and another office is a different question');
}

// ── 2. The label beside the epithet ───────────────────────────────────────
{
  eq(officeLabelFor(OFFICES, 'Astrid'), 'Storyteller of Eilif', 'the current holder is named plainly');
  eq(
    officeLabelFor(OFFICES, 'Bren Bjornsson'),
    'Storyteller for the Eikthyr act',
    'a former holder is placed in the act they served',
  );
  eq(officeLabelFor(OFFICES, 'bren bjornsson'), 'Storyteller for the Eikthyr act', 'the name match ignores case');
  eq(officeLabelFor(OFFICES, 'Loa'), null, 'a viking who never held it gets nothing');
  eq(officeLabelFor([], 'Astrid'), null, 'and neither does anyone on an empty roll');
  eq(officeLabelFor(OFFICES, ''), null, 'a nameless viking is nobody');

  eq(
    officeLabelFor([{ ...OFFICES[1], act: null }], 'Bren Bjornsson'),
    'Storyteller of Eilif, in an earlier act',
    'a term with no act recorded still reads as a past term',
  );

  // Held twice: the more recent term describes them.
  const twice = [
    { ...OFFICES[1], id: 'o3', since: '2026-09-10T00:00:00Z', until: '2026-09-20T00:00:00Z', act: 'Bonemass' },
    OFFICES[1],
  ];
  eq(
    officeLabelFor(twice, 'Bren Bjornsson'),
    'Storyteller for the Bonemass act',
    'a viking who held it twice is described by the term the hall remembers most recently',
  );
  // And an open term always wins over any closed one, whatever order they arrive in.
  eq(
    officeLabelFor([OFFICES[1], { ...OFFICES[1], id: 'o4', since: '2026-09-25T00:00:00Z', until: null }], 'Bren Bjornsson'),
    'Storyteller of Eilif',
    'an open term wins over every closed one',
  );
}

// ── 3. The apocryphal telling ─────────────────────────────────────────────
{
  const rows = [
    { id: 't1', boss_id: 'b3', text: 'Kept.', source: 'player', chosen: true, standing: 'canon', created_at: '2026-09-06T00:00:00Z', author_character: 'Astrid' },
    { id: 't2', boss_id: 'b3', text: 'Not kept.', source: 'player', chosen: false, standing: 'apocryphal', created_at: '2026-09-05T00:00:00Z', author_character: 'Bren' },
    { id: 't3', boss_id: 'b3', text: 'The Skald wrote this.', source: 'skald', chosen: false, standing: null, created_at: '2026-09-04T00:00:00Z', author_character: 'The Skald' },
  ];
  const shown = pickTelling(rows);
  eq(shown.id, 't1', 'the chosen telling is the one on show');

  const apoc = apocryphalTelling(rows, shown);
  eq(apoc.id, 't2', 'the telling the hall voted against gets its own heading');

  const others = otherTellings(rows, shown, apoc);
  eq(others.length, 1, 'and is not also folded into the collapsed list');
  eq(others[0].id, 't3', 'which holds everything else');

  // A hand-written row could carry both flags; the page must not print the same
  // paragraphs twice under two headings.
  const both = [{ ...rows[0], standing: 'apocryphal' }, rows[2]];
  eq(apocryphalTelling(both, pickTelling(both)), null, 'the telling on show is never also the apocryphal one');

  // Before db/2026-09-06_telling_votes.sql, `standing` is simply absent.
  const dropStanding = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'standing'));
  const preMigration = rows.map(dropStanding);
  eq(apocryphalTelling(preMigration, pickTelling(preMigration)), null, 'with no standing column there is no apocryphal telling');
  eq(otherTellings(preMigration, pickTelling(preMigration)).length, 2, 'and the collapsed list reads exactly as it did before');
}

// ── 4. The untold clock ───────────────────────────────────────────────────
{
  const killedAt = '2026-09-01T00:00:00Z';
  const killedMs = Date.parse(killedAt);
  const skaldOnly = [{ id: 't1', boss_id: 'b3', text: 'It fell.', source: 'skald', chosen: true, created_at: killedAt, author_character: 'The Skald' }];

  // THE SHIPS-OFF GATE, FIRST, because it is the one that matters on the war
  // room as it stands today. With the office feature off, db/2026-09-06_offices
  // .sql is unapplied, getOffices returns [] and the page passes officeKnown
  // false: no untold line ever appears, however old the fall is. This assertion
  // is the whole reason wantsStoryteller takes the flag.
  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, nowMs: killedMs + 9 * DAY }),
    false,
    'with no office roll at all the page never asks for a storyteller it does not have',
  );
  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, officeKnown: false, nowMs: killedMs + 900 * DAY }),
    false,
    'and no amount of time changes that: the gate is the office, not the clock',
  );

  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, officeKnown: true, nowMs: killedMs + 2 * DAY }),
    false,
    'two days after a kill the draft is simply new',
  );
  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, officeKnown: true, nowMs: killedMs + 9 * DAY }),
    true,
    'a day for the nudge and a week after it, the page says the draft still stands',
  );
  eq(
    wantsStoryteller({
      tellings: [...skaldOnly, { id: 't2', boss_id: 'b3', text: 'I was there.', source: 'player', chosen: false, created_at: killedAt, author_character: 'Bren' }],
      killedAt,
      officeKnown: true,
      nowMs: killedMs + 90 * DAY,
    }),
    false,
    'a viking telling clears it forever, chosen or not',
  );
  eq(
    wantsStoryteller({ tellings: [], killedAt: null, officeKnown: true, nowMs: Date.now() }),
    false,
    'a boss with no kill date has no clock to run out',
  );

  // An inherited fall: the clock runs from the TERM, not from the kill, so a
  // new Storyteller is never greeted by a page complaining about their first day.
  const officeSince = '2026-09-05T00:00:00Z';
  const sinceMs = Date.parse(officeSince);
  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, officeKnown: true, officeSince, nowMs: killedMs + 9 * DAY }),
    false,
    'a fall from before the term is not overdue nine days after the KILL',
  );
  eq(
    wantsStoryteller({ tellings: skaldOnly, killedAt, officeKnown: true, officeSince, nowMs: sinceMs + 15 * DAY }),
    true,
    'it is overdue a week after the nudge, which is a week after the term opened',
  );

  // THE TWO CLOCKS ARE ONE CLOCK. The bot schedules the nudge and the page
  // describes the aftermath, in two runtimes, from two copies of the same
  // numbers. Read the bot's own constants and require them to agree.
  const botSrc = readFileSync(new URL('../services/discord-bot/src/storyteller.js', import.meta.url), 'utf8');
  ok(
    /export const NUDGE_AFTER_KILL_MS = 24 \* 3600 \* 1000;/.test(botSrc),
    'the bot nudges a day after a kill, which is what nudgeDueAt here assumes',
  );
  ok(
    /export const NUDGE_GRACE_MS = 7 \* 24 \* 3600 \* 1000;/.test(botSrc),
    'and a week after a term opens for an inherited fall',
  );
  eq(
    nudgeDueAt('2026-09-06T00:00:00Z', null),
    Date.parse('2026-09-06T00:00:00Z') + 24 * 3600 * 1000,
    "and the page's own copy of that clock reads the same",
  );
  eq(DRAFT_STANDS_AFTER_MS, 7 * DAY, 'the page then waits a further week before saying anything');
}

// ── 4b. The ships-off wiring, on the page that renders it ─────────────────
//
// wantsStoryteller defaults officeKnown to false, so the gate only works if the
// war room actually passes it, and passes it from the office roll rather than
// from a constant somebody typed. Both halves are pinned: a page that stopped
// passing it would be silent (the default is safe) and a page that passed
// `true` would put the untold line back on a hall with no office at all.
{
  const page = readFileSync(new URL('../app/boss/[slug]/page.tsx', import.meta.url), 'utf8');
  ok(/officeKnown=\{offices\.length > 0\}/.test(page),
    'the war room derives officeKnown from the office roll it read');
  ok(!/officeKnown=\{true\}/.test(page), 'and never hard-codes it on');
  ok(/getOffices\(\)/.test(page), 'having actually read the roll');

  const component = readFileSync(new URL('../components/boss/BossTellings.tsx', import.meta.url), 'utf8');
  ok(/officeKnown = false/.test(component),
    'and the component defaults it to false, so an un-wired caller is silent rather than wrong');
  ok(/wantsStoryteller\(\{ tellings, killedAt, officeKnown, officeSince \}\)/.test(component),
    'the untold line is computed from it');

  const helper = readFileSync(new URL('../components/boss/tellings.ts', import.meta.url), 'utf8');
  ok(/if \(!officeKnown\) return false;/.test(helper),
    'and the helper refuses outright without an office roll, before it ever looks at a clock');
}

// ── 5. The office is not an epithet ───────────────────────────────────────
{
  const epithets = readFileSync(new URL('../lib/epithets.ts', import.meta.url), 'utf8');
  ok(
    !/office|storyteller/i.test(epithets),
    'lib/epithets.ts knows nothing about offices: a seat in the hall must never displace a title a viking earned',
  );

  const page = readFileSync(new URL('../app/viking/[slug]/page.tsx', import.meta.url), 'utf8');
  ok(page.includes('<OfficeBadge label={officeLabel} />'), 'the viking page shows the office');
  ok(page.includes('{epithet.title}'), 'and still shows the epithet');
  ok(
    page.indexOf('{epithet.title}') < page.indexOf('<OfficeBadge'),
    'with the office BESIDE the epithet rather than in place of it',
  );

  const card = readFileSync(new URL('../components/boss/BossTellings.tsx', import.meta.url), 'utf8');
  ok(card.includes('Storyteller:'), "the war-room's tellings card names the Storyteller when there is one");
  ok(card.includes('The apocryphal version'), 'and gives the version the hall voted against its own heading');
  ok(
    card.includes('The Skald&apos;s draft stands, for want of a storyteller.'),
    'and carries the untold line exactly as it was specified',
  );
  ok(!/[—–]/.test(card), 'with no em or en dash anywhere in it');
}

// ── 6. The office read, and the column it must never ask for ─────────────
{
  const data = readFileSync(new URL('../lib/data.ts', import.meta.url), 'utf8');
  const cols = /const OFFICES_PUBLIC_COLS =\s*'([^']*)'/.exec(data);
  ok(cols, 'getOffices reads a named column list this test can read');
  ok(
    !/holder_discord_id/.test(cols[1]),
    'which never asks for holder_discord_id, because anon has no grant on it and the read would fail outright',
  );

  // Derive the required columns from the interface rather than a hand-copied
  // list, the rule scripts/narrow-selects.test.mjs follows: a list typed twice
  // only proves somebody typed it twice.
  const types = readFileSync(new URL('../lib/types.ts', import.meta.url), 'utf8');
  const iface = types.slice(types.indexOf('export interface Office {'));
  const fields = new Set(
    [...iface.slice(0, iface.indexOf('\n}')).matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1]),
  );
  ok(fields.size >= 7, `Office declares ${fields.size} fields (${[...fields].sort().join(', ')})`);
  for (const f of fields) ok(cols[1].includes(f), `the select carries "${f}"`);
  ok(!/holder_discord_id/.test([...fields].join(',')), 'and the public type does not declare the private column at all');

  // Both site reads must survive their migrations being late.
  ok(
    /export const getOffices = cache\([\s\S]{0,900}?if \(error\) return \[\];/.test(data),
    'getOffices answers a missing offices table with an empty roll rather than failing the page',
  );
}

console.log(`offices-site.test: ${passed} assertions passed`);
