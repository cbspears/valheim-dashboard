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


// --- console-echo oath capture (mod-free path) ---
{
  const p2 = new LogParser();
  const ev = p2.processLine('[Info   : Unity Log] 07/04/2026 01:02:49: Console: <color=orange>Testman</color>: <color=#FFEB04FF>/OATH I SWEAR TO HAVE A GOOD TIME</color>');
  if (!(ev.length === 1 && ev[0].type === 'oath' && ev[0].characterName === 'Testman' && ev[0].metadata.text === 'I SWEAR TO HAVE A GOOD TIME')) { console.log('console-echo oath FAILED'); ok = false; }
  else {
    // A plain shout is no longer silent — it's mirrorable chat (echo source).
    const shout = p2.processLine('[Info   : Unity Log] Console: <color=orange>T</color>: <color=#FFEB04FF>JUST A SHOUT</color>');
    if (!(shout.length === 1 && shout[0].type === 'chat' && shout[0].characterName === 'T' && shout[0].metadata.text === 'JUST A SHOUT' && shout[0].metadata.source === 'echo')) { console.log('plain shout -> chat FAILED'); ok = false; }
    else console.log('CONSOLE OATH OK');
  }
}

// --- shout-chat mirroring (plugin line + console echo) ---
{
  const p3 = new LogParser();
  const checks = [
    // Plugin capture: raw casing, text may contain " | ".
    ['plugin chat', '[Info   :Eilif Companion] [EILIF_CHAT] Testman | hello there | all', { characterName: 'Testman', text: 'hello there | all', source: 'plugin' }],
    // Console echo: uppercased by the game.
    ['echo chat', '[Info   : Unity Log] 07/05/2026 20:11:03: Console: <color=orange>Ivar Hollowleg</color>: <color=#FFEB04FF>ANYONE SEEN MY CART</color>', { characterName: 'Ivar Hollowleg', text: 'ANYONE SEEN MY CART', source: 'echo' }],
    // Slash-commands are never chat (neither path).
    ['plugin /pin not chat', '[Info   :Eilif Companion] [EILIF_CHAT] Testman | /pin base Odinshold', null],
    ['echo /pin not chat', '[Info   : Unity Log] Console: <color=orange>Testman</color>: <color=#FFEB04FF>/PIN BASE ODINSHOLD</color>', null],
  ];
  let chatOk = true;
  for (const [label, line, expect] of checks) {
    const evs = p3.processLine(line).filter((e) => e.type === 'chat');
    let pass;
    if (expect === null) pass = evs.length === 0;
    else pass = evs.length === 1 && evs[0].characterName === expect.characterName && evs[0].metadata.text === expect.text && evs[0].metadata.source === expect.source;
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) chatOk = false;
  }
  // Oath shouts must still resolve to oath (not chat) via the earlier check.
  const oathEv = p3.processLine('[Info   : Unity Log] Console: <color=orange>Testman</color>: <color=#FFEB04FF>/OATH I SWEAR</color>');
  if (!(oathEv.length === 1 && oathEv[0].type === 'oath')) { console.log('  ✗ oath shout stays oath'); chatOk = false; }
  else console.log('  ✓ oath shout stays oath');
  console.log(chatOk ? 'CHAT PARSING OK' : 'CHAT PARSING FAILED');
  if (!chatOk) ok = false;
}

// --- Relog fixture: same Steam connection, different character (real
// incident 2026-07-04 — Testman -> Testmantwo). Neither the emitter nor the
// vanilla log emits an explicit "left" event for the old character on an
// in-session character swap, so the parser must synthesize a leave for the
// old name when the reconnect resolves to a new one. ---
{
  const relogLines = readFileSync(new URL('./fixtures/relog-session.log', import.meta.url), 'utf8').split('\n');
  const relogParser = new LogParser();
  const relogEvents = [];
  let rosterAfterRelog = null;
  for (const line of relogLines) {
    for (const ev of relogParser.processLine(line)) relogEvents.push(ev);
    if (relogEvents.some((e) => e.type === 'join' && e.characterName === 'Testmantwo') && rosterAfterRelog === null) {
      rosterAfterRelog = relogParser.roster();
    }
  }
  const types = relogEvents.map((e) => `${e.type}:${e.characterName ?? ''}`);
  console.log('\nRelog fixture events:', types.join(', '));

  const joinNames = relogEvents.filter((e) => e.type === 'join').map((e) => e.characterName);
  const leaveNames = relogEvents.filter((e) => e.type === 'leave').map((e) => e.characterName);

  const relogChecks = [
    ['Testman joins once (initial connect), never a 2nd time', joinNames.filter((n) => n === 'Testman').length === 1],
    ['Testmantwo joins once (the relog)', joinNames.filter((n) => n === 'Testmantwo').length === 1],
    ['leave sequence is [Testman, Testmantwo] — old character leaves BEFORE the new one joins, socket close leaves the CURRENT owner', leaveNames.length === 2 && leaveNames[0] === 'Testman' && leaveNames[1] === 'Testmantwo'],
    ['leave Testman is emitted strictly before join Testmantwo', (() => {
      const leaveIdx = relogEvents.findIndex((e) => e.type === 'leave' && e.characterName === 'Testman');
      const joinTwoIdx = relogEvents.findIndex((e) => e.type === 'join' && e.characterName === 'Testmantwo');
      return leaveIdx !== -1 && joinTwoIdx !== -1 && leaveIdx < joinTwoIdx;
    })()],
    ['roster right after the relog is Testmantwo only (Testman gone, not double-counted)', rosterAfterRelog !== null && rosterAfterRelog.includes('Testmantwo') && !rosterAfterRelog.includes('Testman') && rosterAfterRelog.length === 1],
    ['final roster empty after the closing-socket line', relogParser.roster().length === 0],
  ];
  let relogOk = true;
  for (const [label, pass] of relogChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) relogOk = false;
  }
  console.log(relogOk ? 'RELOG FIXTURE OK' : 'RELOG FIXTURE FAILED');
  if (!relogOk) ok = false;
}

// --- Restart recovery: a process restart persists `online` but (on older
// state.json files predating this fix) may not carry `connections`/`pending`.
// A reconnect for an already-online name must still (re)correlate its
// SteamID instead of leaving a stale entry at the front of
// pendingConnections — that stale entry is what corrupted FIFO matching for
// every subsequent, unrelated join in the real incident. ---
{
  const recoveryParser = new LogParser({ online: ['Testman'] });
  recoveryParser.processLine('[Info   : Unity Log] 07/04/2026 21:00:00: Got connection SteamID 76561198012340000');
  recoveryParser.processLine('[Info   : Unity Log] 07/04/2026 21:00:05: Got character ZDOID from Testman : -1393331323:3');
  // A second, unrelated player connects+joins right after. If the prior line
  // hadn't drained pendingConnections, this join would incorrectly steal
  // Testman's steamId correlation.
  recoveryParser.processLine('[Info   : Unity Log] 07/04/2026 21:00:10: Got connection SteamID 76561198012340001');
  const secondJoin = recoveryParser.processLine('[Info   : Unity Log] 07/04/2026 21:00:15: Got character ZDOID from Ivar Hollowleg : 912938345:1');
  const pass =
    recoveryParser.pendingConnections.length === 0 &&
    recoveryParser.steamToName.get('76561198012340000') === 'Testman' &&
    recoveryParser.steamToName.get('76561198012340001') === 'Ivar Hollowleg' &&
    secondJoin.some((e) => e.type === 'join' && e.characterName === 'Ivar Hollowleg');
  console.log(`\n  ${pass ? '✓' : '✗'} restart recovery: reconnect for already-online name re-correlates without corrupting the next join's FIFO match`);
  console.log(pass ? 'RESTART RECOVERY OK' : 'RESTART RECOVERY FAILED');
  if (!pass) ok = false;
}

console.log(ok ? '\nPARSER OK' : '\nPARSER FAILED');
process.exit(ok ? 0 : 1);
