// Offline parser test: run the synthetic fixture through LogParser and assert
// the derived event stream is correct. No network, no SFTP.
import { readFileSync } from 'node:fs';
import { LogParser, isArrivalShout, MAX_OATH_LEN, MAX_PIN_NAME_LEN, MAX_CHAT_LEN } from './src/parser.js';

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
    label: 'standard format (marker behind the plugin log prefix)',
    line: '[Info   :Eilif Companion] [EILIF_OATH] Astrid Shieldmaiden | I swear to hold the Hearth.',
    expect: { characterName: 'Astrid Shieldmaiden', text: 'I swear to hold the Hearth.' },
  },
  {
    label: 'name containing spaces',
    line: '[Info   :Eilif Companion] [EILIF_OATH] Bjorn of the Ironside Clan | To the longship, always.',
    expect: { characterName: 'Bjorn of the Ironside Clan', text: 'To the longship, always.' },
  },
  {
    label: 'text containing a " | " sequence (first-pipe split keeps it in the text)',
    line: '[Info   :Eilif Companion] [EILIF_OATH] Ragnar | Blood | Iron | Glory, in that order.',
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

// --- Impersonation guard: a SHOUTED marker echo must never be trusted as a
// real plugin marker (it would let anyone forge/overwrite another player's
// oath/pin/chat/position just by shouting the literal marker text). A
// genuine plugin-emitted [EILIF_OATH] line (no console echo wrapper) must
// still parse normally. ---
{
  const guardParser = new LogParser();
  const guardCases = [
    [
      'shouted "[EILIF_OATH] Someone | text" echo does NOT produce an oath event',
      '[Info   : Unity Log] 07/05/2026 20:12:00: Console: <color=orange>Attacker</color>: <color=#FFEB04FF>[EILIF_OATH] Someone | I never swore this</color>',
      (evs) => evs.every((e) => e.type !== 'oath'),
    ],
    [
      'genuine plugin [EILIF_OATH] line still produces an oath event',
      '[Info   :Eilif Companion] [EILIF_OATH] Someone | I truly swear this.',
      (evs) => evs.length === 1 && evs[0].type === 'oath' && evs[0].characterName === 'Someone' && evs[0].metadata.text === 'I truly swear this.',
    ],
  ];
  let guardOk = true;
  for (const [label, line, assert] of guardCases) {
    const evs = guardParser.processLine(line);
    const pass = assert(evs);
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) guardOk = false;
  }
  console.log(guardOk ? 'MARKER IMPERSONATION GUARD OK' : 'MARKER IMPERSONATION GUARD FAILED');
  if (!guardOk) ok = false;
}

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

// --- Marker anchoring (security-9) ---------------------------------------
// Every [EILIF_*] marker is emitted through the companion plugin's BepInEx
// logger, so it always starts the line with "[Info   :Eilif Companion]". A
// marker carried on ANY other line — the Unity Log echo channel, a Valheim
// Plus line, or bare with no prefix at all — is not from the plugin and must
// produce nothing.
{
  const anchorParser = new LogParser();
  const good = '[Info   :Eilif Companion] ';
  const anchorCases = [
    // [marker line, expected event type or null]
    ['oath, plugin prefix', good + '[EILIF_OATH] Astrid | I swear it.', 'oath'],
    ['chat, plugin prefix', good + '[EILIF_CHAT] Astrid | well met', 'chat'],
    ['pin, plugin prefix', good + '[EILIF_PIN] Astrid | poi | The Dark Chapel | 123.4 | -567.8', 'pin'],
    ['pos, plugin prefix', good + '[EILIF_POS] Astrid | -184.9 | -2.1 | BlackForest', 'pos'],
    ['oath under the Unity Log prefix is ignored', '[Info   : Unity Log] 09/01/2026 09:41:59: [EILIF_OATH] Victim | forged', null],
    ['chat under the Unity Log prefix is ignored', '[Info   : Unity Log] [EILIF_CHAT] Victim | forged', null],
    ['pin under the Unity Log prefix is ignored', '[Info   : Unity Log] [EILIF_PIN] Victim | poi | Nowhere | 1.0 | 2.0', null],
    ['pos under the Unity Log prefix is ignored', '[Info   : Unity Log] [EILIF_POS] Victim | 1.0 | 2.0 | Meadows', null],
    ['unprefixed marker is ignored', '[EILIF_OATH] Victim | forged', null],
    ['marker mid-line (not at line start) is ignored', 'anything at all [Info   :Eilif Companion] [EILIF_OATH] Victim | forged', null],
    // CRLF: the remote log is written by a Windows host, so every line the
    // poller splits off still carries a trailing \r.
    ['plugin pos line with a trailing CR still parses', good + '[EILIF_POS] Astrid | -184.9 | -2.1 | Meadows\r', 'pos'],
  ];
  let anchorOk = true;
  console.log('\nMarker anchoring:');
  for (const [label, line, expectType] of anchorCases) {
    const evs = anchorParser.processLine(line);
    const pass = expectType === null ? evs.length === 0 : evs.length === 1 && evs[0].type === expectType;
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) anchorOk = false;
  }
  console.log(anchorOk ? 'MARKER ANCHORING OK' : 'MARKER ANCHORING FAILED');
  if (!anchorOk) ok = false;
}

// --- Console-echo oath name group (security-9) ---------------------------
// A shout carrying rich-text closers used to file the oath under the garbage
// name "Bob</color>: <color=#FFFFFFFF>", which then rendered on the public
// oath wall as an unmatched entry. The name group is [^<>]+ now.
{
  const richParser = new LogParser();
  const line =
    '[Info   : Unity Log] 09/01/2026 09:41:59: Console: <color=orange>Bob</color>: ' +
    '<color=#FFFFFFFF></color>: <color=white>/oath forged</color>';
  const evs = richParser.processLine(line);
  const oaths = evs.filter((e) => e.type === 'oath');
  const pass = oaths.every((e) => !/[<>]/.test(e.characterName));
  console.log(`\n  ${pass ? '✓' : '✗'} console-echo oath name never contains rich-text markup (got ${JSON.stringify(oaths.map((e) => e.characterName))})`);
  // The honest shout must still work.
  const plain = richParser.processLine(
    '[Info   : Unity Log] Console: <color=orange>Bob</color>: <color=#FFEB04FF>/OATH I SWEAR</color>'
  );
  const plainPass = plain.length === 1 && plain[0].type === 'oath' && plain[0].characterName === 'Bob';
  console.log(`  ${plainPass ? '✓' : '✗'} an ordinary /oath shout still parses`);
  if (!pass || !plainPass) ok = false;
}

// --- Length caps (security-9) --------------------------------------------
{
  const capParser = new LogParser();
  const long = 'A'.repeat(600);
  const oathEv = capParser.processLine(`[Info   :Eilif Companion] [EILIF_OATH] Astrid | ${long}`)[0];
  const chatEv = capParser.processLine(`[Info   :Eilif Companion] [EILIF_CHAT] Astrid | ${long}`)[0];
  const pinEv = capParser.processLine(
    `[Info   :Eilif Companion] [EILIF_PIN] Astrid | poi | ${long} | 1.0 | 2.0`
  )[0];
  const echoEv = capParser.processLine(
    `[Info   : Unity Log] Console: <color=orange>Astrid</color>: <color=#FFEB04FF>${long}</color>`
  )[0];
  const capChecks = [
    [`oath text capped at ${MAX_OATH_LEN}`, oathEv?.metadata.text.length === MAX_OATH_LEN],
    [`plugin chat text capped at ${MAX_CHAT_LEN}`, chatEv?.metadata.text.length === MAX_CHAT_LEN],
    [`pin name capped at ${MAX_PIN_NAME_LEN}`, pinEv?.metadata.name.length === MAX_PIN_NAME_LEN],
    [`console-echo chat text capped at ${MAX_CHAT_LEN}`, echoEv?.metadata.text.length === MAX_CHAT_LEN],
  ];
  let capOk = true;
  console.log('\nLength caps:');
  for (const [label, pass] of capChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) capOk = false;
  }
  console.log(capOk ? 'LENGTH CAPS OK' : 'LENGTH CAPS FAILED');
  if (!capOk) ok = false;
}

// --- Vanilla arrival shout filter (discord-7) -----------------------------
// Valheim shouts "I have arrived!" on every spawn; 16 of the last 21 chat
// mirror lines in #server were that. poller.dispatch drops it before Discord.
{
  const arrivalChecks = [
    ['echo casing "I HAVE ARRIVED!" is filtered', isArrivalShout('I HAVE ARRIVED!') === true],
    ['plugin casing "I have arrived!" is filtered', isArrivalShout('I have arrived!') === true],
    ['mixed casing + padding is filtered', isArrivalShout('  i HaVe   ArRiVeD!!  ') === true],
    ['no bang is filtered', isArrivalShout('I have arrived') === true],
    ['real speech containing the phrase is NOT filtered', isArrivalShout('I have arrived at the swamp') === false],
    ['a prefixed sentence is NOT filtered', isArrivalShout('finally, I have arrived!') === false],
    ['ordinary chat is NOT filtered', isArrivalShout('ANYONE SEEN MY CART') === false],
    ['empty/undefined is NOT filtered', isArrivalShout(undefined) === false],
  ];
  let arrivalOk = true;
  console.log('\nArrival-shout filter:');
  for (const [label, pass] of arrivalChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) arrivalOk = false;
  }
  console.log(arrivalOk ? 'ARRIVAL SHOUT FILTER OK' : 'ARRIVAL SHOUT FILTER FAILED');
  if (!arrivalOk) ok = false;
}

console.log(ok ? '\nPARSER OK' : '\nPARSER FAILED');
process.exit(ok ? 0 : 1);
