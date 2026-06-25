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
console.log(ok ? '\nPARSER OK' : '\nPARSER FAILED');
process.exit(ok ? 0 : 1);
