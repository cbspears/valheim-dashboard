// Offline parser test: run the synthetic fixture through LogParser and assert
// the derived event stream is correct. No network, no SFTP.
import { readFileSync } from 'node:fs';
import { LogParser } from './src/parser.js';

const lines = readFileSync(new URL('./fixtures/sample-session.log', import.meta.url), 'utf8').split('\n');
const parser = new LogParser();
const events = [];
for (const line of lines) {
  for (const ev of parser.processLine(line)) {
    const tag =
      ev.type === 'heartbeat'
        ? `heartbeat count=${ev.count} online=[${ev.metadata.online.join(', ')}]`
        : `${ev.type}${ev.characterName ? ` ${ev.characterName}` : ''}${ev.metadata?.event ? ` "${ev.metadata.event}"` : ''}`;
    events.push({ type: ev.type, tag, name: ev.characterName ?? null });
    console.log('  ' + tag);
  }
}

// --- Assertions ---
const summary = events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
const joins = events.filter((e) => e.type === 'join').map((e) => e.name);
const leaves = events.filter((e) => e.type === 'leave').map((e) => e.name);
const deaths = events.filter((e) => e.type === 'death').map((e) => e.name);

const checks = [
  ['2 joins', summary.join === 2],
  ['joins are Bjorn + Astrid', joins.includes('Bjorn Ironside') && joins.includes('Astrid Shieldmaiden')],
  ['respawn did NOT create a 3rd join', summary.join === 2],
  ['1 death (Bjorn)', summary.death === 1 && deaths[0] === 'Bjorn Ironside'],
  ['2 leaves (Astrid then Bjorn)', summary.leave === 2 && leaves[0] === 'Astrid Shieldmaiden' && leaves[1] === 'Bjorn Ironside'],
  ['1 raid', summary.raid === 1],
  ['final roster empty', parser.roster().length === 0],
];

console.log('\nSummary:', JSON.stringify(summary));
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}
// --- [EILIF_OATH] marker cases (separate parser instance; not fixture-driven) ---
const oathParser = new LogParser();
const oathCases = [
  {
    label: 'standard format (marker embedded in BepInEx prefix)',
    line: '[Info   : Unity Log] 06/24/2026 18:30:00: [EILIF_OATH] Astrid Shieldmaiden | I swear to hold the Hearth.',
    expect: { characterName: 'Astrid Shieldmaiden', text: 'I swear to hold the Hearth.' },
  },
  {
    label: 'name containing spaces',
    line: '[Info   : Unity Log] [EILIF_OATH] Bjorn of the Ironside Clan | To the longship, always.',
    expect: { characterName: 'Bjorn of the Ironside Clan', text: 'To the longship, always.' },
  },
  {
    label: 'text containing a " | " sequence (first-pipe split keeps it in the text)',
    line: '[Info   : Unity Log] [EILIF_OATH] Ragnar | Blood | Iron | Glory, in that order.',
    expect: { characterName: 'Ragnar', text: 'Blood | Iron | Glory, in that order.' },
  },
  {
    label: 'non-oath line must NOT match',
    line: '[Info   : Unity Log] 06/24/2026 18:30:00: Got character ZDOID from Ragnar : 12:3',
    expect: null,
  },
];

let oathOk = true;
console.log('\nOath marker cases:');
for (const { label, line, expect } of oathCases) {
  const events = oathParser.processLine(line);
  const oathEvents = events.filter((e) => e.type === 'oath');
  let pass;
  if (expect === null) {
    pass = oathEvents.length === 0;
  } else {
    pass =
      oathEvents.length === 1 &&
      oathEvents[0].characterName === expect.characterName &&
      oathEvents[0].metadata.text === expect.text;
  }
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) oathOk = false;
}
console.log(oathOk ? 'OATH PARSING OK' : 'OATH PARSING FAILED');
if (!oathOk) ok = false;

console.log(ok ? '\nPARSER OK' : '\nPARSER FAILED');
process.exit(ok ? 0 : 1);
