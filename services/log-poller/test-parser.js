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
    // A plugin [EILIF_POS] line for a name that is not on the roster ALSO
    // emits a presence `join` ahead of the pos event (2026-09-10) — the
    // marker's own event is always the last one.
    const pass =
      expectType === null
        ? evs.length === 0
        : evs.at(-1)?.type === expectType &&
          evs.slice(0, -1).every((e) => e.type === 'join' && e.metadata?.source === 'pos');
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

// --- SteamID pairing carried on events (security-3) -----------------------
// Valheim allows duplicate character names, so every name-keyed write
// downstream needs the connecting SteamID to check against players.steam_id.
// The parser already correlates "Got connection SteamID" with the following
// ZDOID line; these cases pin down that it SHIPS that pairing on the events.
{
  const P = (p) => `[Info   : Unity Log] 09/05/2026 12:00:00: ${p}`;
  const STEAM_A = '76561198000000001';
  const STEAM_B = '76561198000000002';
  const idChecks = [];

  // (1) The whole sample fixture: joins, the death in between, and both leaves.
  {
    const p = new LogParser();
    const evs = [];
    for (const line of readFileSync(new URL('./fixtures/sample-session.log', import.meta.url), 'utf8').split('\n')) {
      evs.push(...p.processLine(line));
    }
    const first = (type, name) => evs.find((e) => e.type === type && e.characterName === name);
    idChecks.push(
      ['join carries the connecting SteamID', first('join', 'Bjorn Ironside')?.steamId === STEAM_A],
      ['a second join carries its own SteamID', first('join', 'Astrid Shieldmaiden')?.steamId === STEAM_B],
      ['death carries the pairing too', first('death', 'Bjorn Ironside')?.steamId === STEAM_A],
      ['leave carries the closing socket’s SteamID', first('leave', 'Astrid Shieldmaiden')?.steamId === STEAM_B],
      ['the last leave still carries its SteamID', first('leave', 'Bjorn Ironside')?.steamId === STEAM_A],
      ['steamIdFor() is empty once everyone has left', p.steamIdFor('Bjorn Ironside') === null]
    );
  }

  // (2) Relog to a different character on ONE connection: the synthesized
  //     leave and the new join must both name that one SteamID.
  {
    const p = new LogParser();
    const evs = [];
    for (const line of readFileSync(new URL('./fixtures/relog-session.log', import.meta.url), 'utf8').split('\n')) {
      evs.push(...p.processLine(line));
    }
    const relogLeave = evs.find((e) => e.type === 'leave' && e.characterName === 'Testman');
    const relogJoin = evs.find((e) => e.type === 'join' && e.characterName === 'Testmantwo');
    idChecks.push(
      ['relog: synthesized leave carries the SteamID', relogLeave?.steamId === '76561198099999999'],
      ['relog: the new character joins under the same SteamID', relogJoin?.steamId === '76561198099999999']
    );
  }

  // (3) Oath / pin / chat / pos for an online viking carry that viking's
  //     pairing — this is what lets the webhook refuse an impostor's write.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Astrid : 12345:1'));
    const oathEv = p.processLine('[Info   :Eilif Companion] [EILIF_OATH] Astrid | I hold the Hearth.')[0];
    const pinEv = p.processLine('[Info   :Eilif Companion] [EILIF_PIN] Astrid | poi | Dark Chapel | 1.0 | 2.0')[0];
    const chatEv = p.processLine('[Info   :Eilif Companion] [EILIF_CHAT] Astrid | hello there')[0];
    const posEv = p.processLine('[Info   :Eilif Companion] [EILIF_POS] Astrid | -184.9 | -2.1 | BlackForest')[0];
    const echoEv = p.processLine(
      '[Info   : Unity Log] Console: <color=orange>Astrid</color>: <color=#FFEB04FF>/OATH I SWEAR IT</color>'
    )[0];
    idChecks.push(
      ['oath carries the shouter’s pairing', oathEv?.steamId === STEAM_A],
      ['pin carries the pinner’s pairing', pinEv?.steamId === STEAM_A],
      ['chat carries the pairing', chatEv?.steamId === STEAM_A],
      ['pos carries the pairing', posEv?.steamId === STEAM_A],
      ['a console-echoed oath carries it as well', echoEv?.steamId === STEAM_A],
      ['steamIdFor() reports the live pairing', p.steamIdFor('Astrid') === STEAM_A]
    );

    // An IMPOSTOR: a second character called Astrid is impossible in one
    // session, but a shout from a name we have no connection for must simply
    // arrive WITHOUT a pairing — the webhook then allows it rather than
    // inventing a mismatch.
    const strangerOath = p.processLine('[Info   :Eilif Companion] [EILIF_OATH] Nobody | who am I')[0];
    idChecks.push(
      ['an unknown name carries no steamId', strangerOath?.steamId === undefined],
      ['steamIdFor() on an unknown name is null', p.steamIdFor('Nobody') === null]
    );
  }

  // (4) A join with no preceding connection line (poller started mid-session)
  //     must not borrow anyone else's SteamID.
  {
    const p = new LogParser();
    const joinEv = p.processLine(P('Got character ZDOID from Orphan : 999:1'))[0];
    idChecks.push(
      ['an uncorrelated join carries no steamId', joinEv?.type === 'join' && joinEv.steamId === undefined]
    );
  }

  // (5) The pairing survives a restart: it is in snapshot() and restored by the
  //     constructor, so post-restart oaths are still checkable.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_B}`));
    p.processLine(P('Got character ZDOID from Bjorn : 4242:1'));
    const resumed = new LogParser(p.snapshot());
    const oathEv = resumed.processLine('[Info   :Eilif Companion] [EILIF_OATH] Bjorn | still me')[0];
    idChecks.push(
      ['snapshot() persists the pairing', p.snapshot().connections.some(([s, n]) => s === STEAM_B && n === 'Bjorn')],
      ['a resumed parser still pairs the name', oathEv?.steamId === STEAM_B]
    );
  }

  let idOk = true;
  console.log('\nSteamID pairing:');
  for (const [label, pass] of idChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) idOk = false;
  }
  console.log(idOk ? 'STEAMID PAIRING OK' : 'STEAMID PAIRING FAILED');
  if (!idOk) ok = false;
}

// --- Presence: [EILIF_POS] is the truth (2026-09-10) ----------------------
// The vanilla lines pair "Got connection SteamID N" with the NEXT "Got
// character ZDOID from <name>" in FIFO order, and under 1.0's 10-25 player
// join bursts that pairing is frequently wrong. Two failures followed, both
// live on launch night: a player marked offline when SOMEBODY ELSE's socket
// closed (Fjällhnot, still in-world), and — after such a wrong leave — a
// respawn line re-adding the name with no pairing at all, so no "Closing
// socket" could ever remove it again (Rosir, Hel, Psifour, phantom forever).
// The companion plugin emits one position line per peer that is genuinely
// in-world every 60 s; these cases pin down that presence now follows THAT.
{
  const P = (p) => `[Info   : Unity Log] 09/10/2026 12:00:00: ${p}`;
  const POS = (name, biome = 'Meadows') =>
    `[Info   :Eilif Companion] [EILIF_POS] ${name} | -184.9 | -2.1 | ${biome}`;
  const STEAM_A = '76561198000000011';
  const STEAM_B = '76561198000000022';
  const STALE = 5 * 60 * 1000;
  const MIN = 60 * 1000;
  const presenceChecks = [];

  // (a) A position line for a name we do not have on the roster is a JOIN.
  //     This is the phantom's way back: no pairing exists, no pending
  //     handshake is stolen, the webhook simply opens a session.
  {
    const p = new LogParser();
    const evs = p.processLine(POS('Rosir', 'BlackForest'));
    presenceChecks.push(
      ['pos for an unknown name emits join then pos', evs.map((e) => e.type).join(',') === 'join,pos'],
      ['the join is tagged as coming from the position emitter', evs[0].metadata?.source === 'pos'],
      ['a pos-derived join invents no SteamID', evs[0].steamId === undefined],
      ['and the name is on the roster afterwards', p.roster().includes('Rosir')],
      ['the pos event itself is unchanged', evs[1].metadata?.biome === 'BlackForest'],
      ['the pending queue is untouched', p.snapshot().pending.length === 0]
    );
  }

  // (b) A position line for someone already online is just a position.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Astrid : 12345:1'));
    const evs = p.processLine(POS('Astrid'));
    presenceChecks.push(
      ['pos for an online name emits only pos', evs.length === 1 && evs[0].type === 'pos'],
      ['it still carries the pairing', evs[0].steamId === STEAM_A]
    );
  }

  // (c) The sweep: silent for longer than staleMs while SOMEBODY ELSE is
  //     still emitting -> leave, carrying the SteamID that name held, and the
  //     pairing torn down exactly as a real "Closing socket" would.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Astrid : 12345:1'));
    p.processLine(P(`Got connection SteamID ${STEAM_B}`));
    p.processLine(P('Got character ZDOID from Bjorn : 6789:1'));
    p.processLine(POS('Bjorn')); // Bjorn is demonstrably in-world; the emitter is alive
    const now = Date.now();
    p.posSeen.set('Astrid', now - 10 * MIN); // Astrid has not been seen for 10 min
    const swept = p.sweepStale(now, STALE);
    presenceChecks.push(
      ['the sweep leaves exactly the silent name', swept.length === 1 && swept[0].characterName === 'Astrid'],
      ['it is a leave tagged pos-stale', swept[0].type === 'leave' && swept[0].metadata.source === 'pos-stale'],
      ['it carries the SteamID that name held', swept[0].steamId === STEAM_A],
      ['the pairing is gone both ways', p.steamIdFor('Astrid') === null && !p.snapshot().connections.some(([s]) => s === STEAM_A)],
      ['the swept name is off the roster', !p.roster().includes('Astrid')],
      ['the name still emitting is untouched', p.roster().includes('Bjorn') && p.steamIdFor('Bjorn') === STEAM_B]
    );
  }

  // (d) Death then respawn inside staleMs is NOT a leave. The plugin skips a
  //     peer with no character, so a dead player emits nothing — the whole
  //     reason staleMs is five missed emits and not one.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Rosir : 12345:1'));
    p.processLine(POS('Rosir'));
    const deathEvs = p.processLine(P('Got character ZDOID from Rosir : 0:0'));
    const respawnEvs = p.processLine(P('Got character ZDOID from Rosir : -110561379:22006'));
    const swept = p.sweepStale(Date.now() + 30 * 1000, STALE);
    presenceChecks.push(
      ['the death is still a death', deathEvs.length === 1 && deathEvs[0].type === 'death'],
      ['a respawn of an online name is not a second join', respawnEvs.length === 0],
      ['nothing is swept across a death/respawn gap', swept.length === 0],
      ['and the viking is still online', p.roster().includes('Rosir')]
    );
  }

  // (e) THE GUARD. If the plugin is dead (or was never loaded) every name goes
  //     silent at once — and sweeping then would mark the whole server empty on
  //     the strength of our own missing input. Silence from EVERYONE means "no
  //     evidence", never "no players".
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Astrid : 12345:1'));
    const now = Date.now();
    p.posSeen.set('Astrid', now - 10 * MIN);
    const neverAnyPos = p.sweepStale(now, STALE);

    // Same roster, but the emitter WAS alive and then went quiet a while ago:
    // still no sweep, because the last position is older than staleMs / 2.
    p.lastAnyPosAt = now - 4 * MIN;
    const emitterWentQuiet = p.sweepStale(now, STALE);

    presenceChecks.push(
      ['no [EILIF_POS] has ever been seen -> sweep removes nobody', neverAnyPos.length === 0],
      ['the emitter falling silent -> sweep removes nobody', emitterWentQuiet.length === 0],
      ['the roster survives a dead position emitter', p.roster().includes('Astrid')]
    );
  }

  // (f) Restart: the stamps round-trip through snapshot(), and a restored
  //     roster gets a full staleMs of grace instead of being swept on sight.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Astrid : 12345:1'));
    p.processLine(POS('Astrid'));
    const now = Date.now();
    p.posSeen.set('Astrid', now - 10 * MIN); // would be swept, were it not a restart
    const snap = p.snapshot();
    const resumed = new LogParser(snap);
    const swept = resumed.sweepStale(now, STALE);
    presenceChecks.push(
      ['snapshot() carries posSeen as [name, ms] pairs',
        Array.isArray(snap.posSeen) &&
          snap.posSeen.length === 1 &&
          snap.posSeen[0][0] === 'Astrid' &&
          Number.isFinite(snap.posSeen[0][1])],
      ['snapshot() carries lastAnyPosAt', Number.isFinite(snap.lastAnyPosAt)],
      ['a resumed parser has a stamp for every restored name', resumed.posSeen.has('Astrid')],
      ['restored names are not swept immediately', swept.length === 0 && resumed.roster().includes('Astrid')]
    );
  }

  // (g) THE LAUNCH-NIGHT BUG, END TO END. Two handshakes in flight, the FIFO
  //     crosses them, the wrong viking is marked offline when the other one's
  //     socket closes — and then the position emitter puts them back and the
  //     sweep takes out the one who really left.
  {
    const p = new LogParser();
    p.processLine(P(`Got connection SteamID ${STEAM_B}`)); // B's handshake lands first…
    p.processLine(P(`Got connection SteamID ${STEAM_A}`));
    p.processLine(P('Got character ZDOID from Fjallhnot : 111:1')); // …but A spawns first
    p.processLine(P('Got character ZDOID from Psifour : 222:1'));
    const crossed = p.steamIdFor('Fjallhnot') === null; // paired with B's id, and known-doubtful

    // B leaves. The FIFO pairing says that socket belongs to Fjallhnot, so the
    // vanilla path marks the WRONG viking offline — reproduce it exactly.
    const wrongLeave = p.processLine(P(`Closing socket ${STEAM_B}`));
    const wronglyOffline = !p.roster().includes('Fjallhnot');

    // The next position line is the repair: Fjallhnot is plainly in-world.
    const backEvs = p.processLine(POS('Fjallhnot', 'Swamp'));
    const now = Date.now();
    p.posSeen.set('Psifour', now - 10 * MIN); // Psifour really is gone
    const swept = p.sweepStale(now, STALE);

    presenceChecks.push(
      ['the burst pairing is marked doubtful, not trusted', crossed],
      ['reproduced: the wrong viking is marked offline', wronglyOffline && wrongLeave[0]?.characterName === 'Fjallhnot'],
      ['the next position line brings them back with a join', backEvs[0]?.type === 'join' && backEvs[0].metadata.source === 'pos'],
      ['a name re-added by a position line CAN be swept later', p.posSeen.has('Fjallhnot')],
      ['the sweep then removes the one who actually left', swept.length === 1 && swept[0].characterName === 'Psifour'],
      ['final roster is exactly the viking who is really there', p.roster().join(',') === 'Fjallhnot']
    );
  }

  // (h) The call site: one tick with no new bytes must still sweep, dispatch
  //     the leave through the normal webhook path, and log it as presence.
  {
    const { Poller } = await import('./src/poller.js');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const posted = [];
    const logged = [];
    const logger = {
      info: (m) => logged.push(m),
      warn: (m) => logged.push(m),
      error: (m) => logged.push(m),
    };
    const poller = new Poller(
      {
        webhookUrl: 'stub',
        webhookSecret: 'stub',
        posStaleMs: STALE,
        syncEveryMs: 3_600_000,
        statePath: join(tmpdir(), `eilif-poller-test-${process.pid}.json`),
      },
      logger
    );
    poller.postEvent = async (payload) => (posted.push(payload), {});
    poller.parser.processLine(P(`Got connection SteamID ${STEAM_A}`));
    poller.parser.processLine(P('Got character ZDOID from Hel : 12345:1'));
    poller.parser.processLine(POS('Rosir')); // somebody is emitting, so the sweep is armed
    poller.parser.posSeen.set('Hel', Date.now() - 9 * MIN);
    await poller.tickAfterFetch({ text: '', size: 0, mtimeMs: Date.now() });

    const leave = posted.find((e) => e.type === 'leave');
    presenceChecks.push(
      ['a tick with no new lines still sweeps', !!leave && leave.characterName === 'Hel'],
      ['the swept leave reaches the webhook with its SteamID', leave?.steamId === STEAM_A],
      ['and is tagged pos-stale for the webhook', leave?.metadata?.source === 'pos-stale'],
      ['the sweep is logged as presence, in minutes',
        logged.some((m) => /^\[presence\] Hel silent for 9 min \(no \[EILIF_POS\]\) -> leave$/.test(m))],
      ['the leave also logs distinctly as an event', logged.some((m) => m === '[event] leave Hel (pos-stale)')],
      ['the phantom is gone from the roster', !poller.parser.roster().includes('Hel')]
    );

    // The heartbeat line can no longer print one number and the other's list.
    const before = logged.length;
    await poller.dispatch({ type: 'heartbeat', count: 6, metadata: { online: ['a', 'b', 'c'] } });
    const hb = logged.slice(before);
    presenceChecks.push(
      ['the heartbeat names both numbers', hb.some((m) => m === '[heartbeat] server reports 6 connected; roster 3: [a, b, c]')],
      ['and warns when they disagree by more than one', hb.some((m) => m === '[presence] roster/server mismatch (3 vs 6)')]
    );

    const before2 = logged.length;
    await poller.dispatch({ type: 'heartbeat', count: 4, metadata: { online: ['a', 'b', 'c'] } });
    presenceChecks.push([
      'a difference of one is normal (dead / at character select) and stays quiet',
      !logged.slice(before2).some((m) => /roster\/server mismatch/.test(m)),
    ]);
  }

  let presenceOk = true;
  console.log('\nPresence via [EILIF_POS]:');
  for (const [label, pass] of presenceChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) presenceOk = false;
  }
  console.log(presenceOk ? 'PRESENCE OK' : 'PRESENCE FAILED');
  if (!presenceOk) ok = false;
}

// --- Dispatch: what actually reaches the webhook (security-3) -------------
// The parser can carry the pairing perfectly and still be useless if dispatch
// drops it, so drive the real Poller.dispatch with a stubbed webhook + alert.
// (Lives here rather than in its own file so it stays inside `npm test`.)
{
  const { Poller } = await import('./src/poller.js');
  const posted = [];
  const alerts = [];
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const p = new Poller({ webhookUrl: 'stub', webhookSecret: 'stub' }, quiet);
  // The webhook answers `identityMismatch` for Alice's joins and nothing else.
  p.postEvent = async (payload) => {
    posted.push(payload);
    return payload.type === 'join' && payload.characterName === 'Alice'
      ? { ok: true, identityMismatch: true }
      : { ok: true };
  };
  p.postAlert = async (content) => alerts.push(content);

  const STEAM_A = '76561198000000001';
  await p.dispatch({ type: 'join', characterName: 'Alice', steamId: '76561198000000009', metadata: {} });
  await p.dispatch({ type: 'join', characterName: 'Alice', steamId: '76561198000000009', metadata: {} });
  await p.dispatch({ type: 'join', characterName: 'Alice', steamId: '76561198000000010', metadata: {} });
  await p.dispatch({ type: 'join', characterName: 'Bjorn', steamId: STEAM_A, metadata: {} });
  await p.dispatch({ type: 'leave', characterName: 'Bjorn', steamId: STEAM_A, metadata: {} });
  await p.dispatch({ type: 'oath', characterName: 'Bjorn', steamId: STEAM_A, metadata: { text: 'I swear' } });
  await p.dispatch({
    type: 'pin',
    characterName: 'Bjorn',
    steamId: STEAM_A,
    metadata: { name: 'Dark Chapel', kind: 'poi', worldX: 1, worldZ: 2 },
  });
  await p.dispatch({ type: 'raid', metadata: { event: 'The forest is moving…' } });
  await p.dispatch({ type: 'join', characterName: 'Ghost', metadata: {} });

  const wire = (e) => JSON.parse(JSON.stringify(e)); // what JSON.stringify actually sends
  const sent = (type) => posted.find((e) => e.type === type);
  const dispatchChecks = [
    ['join forwards the steamId', sent('join').steamId === '76561198000000009'],
    ['leave forwards the steamId', sent('leave').steamId === STEAM_A],
    ['oath forwards the steamId', sent('oath').steamId === STEAM_A],
    ['pin forwards the steamId', sent('pin').steamId === STEAM_A],
    ['a server-wide event sends no steamId key at all', !('steamId' in wire(sent('raid')))],
    ['a join with no pairing sends no steamId key', !('steamId' in wire(posted.at(-1)))],
    ['identityMismatch alerts once per (name, SteamID) pair', alerts.length === 2],
    [
      'the alert names the viking and the release',
      alerts[0].includes('Alice') && alerts[0].includes('players.steam_id'),
    ],
    ['a clean join raises no alert', !alerts.some((a) => a.includes('Bjorn'))],
  ];
  let dispatchOk = true;
  console.log('\nDispatch → webhook:');
  for (const [label, pass] of dispatchChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) dispatchOk = false;
  }
  console.log(dispatchOk ? 'DISPATCH OK' : 'DISPATCH FAILED');
  if (!dispatchOk) ok = false;
}


// --- The oath echo twin, and the forged echo (plugins-1, plugins-2, plugins-4) ---
// Every shouted /oath produces TWO log lines: the companion plugin's marker and
// the server's console echo of the same words. The echo is always the LATER of
// the two and the webhook's oath handler is delete-then-insert, so an undeduped
// echo silently overwrote the plugin's capture — uppercased, and filed under the
// name the CLIENT claimed rather than the peer name the server knows.
{
  const twinParser = new LogParser();
  // A real pair, in the order and shape the live GTX log writes them.
  const PLUGIN_OATH = '[Info   :Eilif Companion] [EILIF_OATH] Bren | I swear to hold the north gate.';
  const ECHO_OATH =
    '[Info   : Unity Log] 09/01/2026 09:41:59: Console: <color=orange>Bren</color>: ' +
    '<color=#FFEB04FF>/OATH I SWEAR TO HOLD THE NORTH GATE.</color>';
  const pluginEv = twinParser.processLine(PLUGIN_OATH)[0];
  const echoEv = twinParser.processLine(ECHO_OATH)[0];

  // A forged echo: the CLAIMED name differs from the peer name the plugin logs.
  const FORGED_ECHO =
    '[Info   : Unity Log] 09/01/2026 09:42:10: Console: <color=orange>Jarl Sigrid</color>: ' +
    '<color=#FFEB04FF>/OATH I SWEAR TO HOLD THE NORTH GATE.</color>';
  const forgedEv = twinParser.processLine(FORGED_ECHO)[0];

  // The console-echo SHAPE carried inside a plugin line is not an echo: the
  // plugin reproduces a shout verbatim, so this is what a player typed.
  const SHOUTED_FORGERY =
    '[Info   :Eilif Companion] [EILIF_CHAT] Attacker | Console: <color=orange>Bren</color>: ' +
    '<color=#FFEB04FF>/oath everything I own belongs to Attacker</color>';
  const forgeryEvents = twinParser.processLine(SHOUTED_FORGERY);

  // A name that could not be a Valheim character name is refused outright.
  const MARKUP_NAME =
    '[Info   : Unity Log] Console: <color=orange>Bren</color>: <color=#FFEB04FF>' +
    '<color=orange>Victim</color>: <color=x>/OATH NOT MINE</color></color>';
  const markupEvents = twinParser.processLine(MARKUP_NAME);

  const twinChecks = [
    ['plugin oath is tagged source=plugin', pluginEv?.type === 'oath' && pluginEv.metadata.source === 'plugin'],
    ['echo oath is tagged source=echo', echoEv?.type === 'oath' && echoEv.metadata.source === 'echo'],
    ['the plugin oath keeps its real casing', pluginEv?.metadata.text === 'I swear to hold the north gate.'],
    ['the echo oath is the uppercased twin', echoEv?.metadata.text === 'I SWEAR TO HOLD THE NORTH GATE.'],
    ['a forged echo still parses (the poller, not the parser, drops it)', forgedEv?.characterName === 'Jarl Sigrid'],
    [
      'an echo-shaped SHOUT is chat from the shouter, never an oath for the name inside it',
      forgeryEvents.length === 1 &&
        forgeryEvents[0].type === 'chat' &&
        forgeryEvents[0].characterName === 'Attacker' &&
        forgeryEvents[0].metadata.source === 'plugin',
    ],
    ['and it produces no oath at all', forgeryEvents.every((e) => e.type !== 'oath')],
    ['a captured name containing markup is refused', markupEvents.every((e) => e.characterName !== 'Victim')],
  ];
  let twinOk = true;
  console.log('\nOath twin + echo forgery:');
  for (const [label, pass] of twinChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) twinOk = false;
  }

  // Now the poller half: the whole batch, through the real tickAfterFetch.
  const { Poller } = await import('./src/poller.js');
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const runBatch = async (lines) => {
    const pl = new Poller(
      { webhookUrl: 'stub', webhookSecret: 'stub', syncEveryMs: 3600_000, chatWebhookUrl: 'stub' },
      quiet
    );
    const dispatched = [];
    pl.postEvent = async (payload) => (dispatched.push(payload), { ok: true });
    pl.postChat = async (ev) => dispatched.push({ type: 'chat', characterName: ev.characterName, metadata: ev.metadata });
    pl.saveState = async () => {};
    pl.updateLiveness = async () => {};
    pl.lastSyncAt = Date.now();
    await pl.tickAfterFetch({ text: lines.join('\n') + '\n', size: 1, mtimeMs: Date.now() });
    return dispatched;
  };

  const honest = await runBatch([PLUGIN_OATH, ECHO_OATH]);
  const forged = await runBatch([PLUGIN_OATH, FORGED_ECHO]);
  const echoOnly = await runBatch([ECHO_OATH]);
  const chatPair = await runBatch([
    '[Info   :Eilif Companion] [EILIF_CHAT] Bren | anyone seen my cart',
    '[Info   : Unity Log] Console: <color=orange>Jarl Sigrid</color>: <color=#FFEB04FF>ANYONE SEEN MY CART</color>',
  ]);
  const oaths = (evs) => evs.filter((e) => e.type === 'oath');
  const chats = (evs) => evs.filter((e) => e.type === 'chat');

  const batchChecks = [
    ['an honest oath pair posts ONCE', oaths(honest).length === 1],
    ['and it is the plugin line, in its real casing', oaths(honest)[0]?.text === 'I swear to hold the north gate.'],
    ['a FORGED echo is still recognised as the twin (keyed on text, not name)', oaths(forged).length === 1],
    ['and the surviving oath is the plugin line, under the peer name', oaths(forged)[0]?.characterName === 'Bren'],
    ['a mod-free oath with no plugin line still posts', oaths(echoOnly).length === 1 && oaths(echoOnly)[0]?.characterName === 'Bren'],
    ['an impersonated chat echo is not mirrored under the claimed name', chats(chatPair).length === 1],
    ['the mirrored line is the plugin capture', chats(chatPair)[0]?.characterName === 'Bren'],
  ];
  for (const [label, pass] of batchChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) twinOk = false;
  }
  console.log(twinOk ? 'OATH TWIN OK' : 'OATH TWIN FAILED');
  if (!twinOk) ok = false;
}

// --- postEvent honours a 429 instead of failing the whole tick (stress-1) ---
// The poller's delivery is all-or-nothing: any non-2xx rewinds the byte cursor
// and the WHOLE batch is replayed next tick. One rate-limited request therefore
// used to cost the entire batch — and a batch bigger than the budget could
// never drain. One retry after the advertised delay turns that into a pause.
{
  const { Poller, webhookRetryDelayMs } = await import('./src/poller.js');
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const mk = () => new Poller({ webhookUrl: 'stub', webhookSecret: 'stub' }, quiet);

  const rl = (headers = {}) =>
    new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers });
  const okRes = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  // (1) 429 then 200: one retry, and the caller never sees the refusal.
  const a = mk();
  let calls = 0;
  a.webhookFetch = async () => (++calls === 1 ? rl({ 'retry-after': '0.05' }) : okRes());
  const t0 = Date.now();
  const body = await a.postEvent({ type: 'sync' });
  const waited = Date.now() - t0;

  // (2) 429 twice: ONE retry only, then the tick honestly fails.
  const b = mk();
  let bCalls = 0;
  b.webhookFetch = async () => (bCalls++, rl({ 'retry-after': '0.05' }));
  let threw = null;
  await b.postEvent({ type: 'sync' }).catch((e) => (threw = e));

  // (3) A 500 is NOT retried — only 429 is a "come back in a moment".
  const c = mk();
  let cCalls = 0;
  c.webhookFetch = async () => (cCalls++, new Response('boom', { status: 500 }));
  let threw500 = null;
  await c.postEvent({ type: 'sync' }).catch((e) => (threw500 = e));

  const retryChecks = [
    ['429 then 200 resolves, and returns the second response body', calls === 2 && body?.ok === true],
    ['it waited for the advertised retry-after', waited >= 40],
    ['a second 429 is not retried again — exactly one retry', bCalls === 2],
    ['and the tick then fails honestly, so the batch is replayed', /429/.test(threw?.message ?? '')],
    ['a 500 is never retried', cCalls === 1 && /500/.test(threw500?.message ?? '')],
    ['retry-after seconds -> ms', webhookRetryDelayMs('2', '') === 2000],
    ['a body retry_after is the fallback', webhookRetryDelayMs(null, '{"retry_after":1.5}') === 1500],
    ['no advice at all defaults to 1 s', webhookRetryDelayMs(null, 'rate limited') === 1000],
    ['a global limit is capped at 10 s, never sat on', webhookRetryDelayMs('3600', '') === 10_000],
    ['a negative retry-after clamps to 0', webhookRetryDelayMs('-5', '') === 0],
  ];
  let retryOk = true;
  console.log('\nWebhook 429 retry:');
  for (const [label, pass] of retryChecks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) retryOk = false;
  }
  console.log(retryOk ? 'WEBHOOK RETRY OK' : 'WEBHOOK RETRY FAILED');
  if (!retryOk) ok = false;
}

console.log(ok ? '\nPARSER OK' : '\nPARSER FAILED');
process.exit(ok ? 0 : 1);
