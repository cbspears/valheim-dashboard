/**
 * MARKER-LINE INJECTION — the poller half of the EilifCompanion 0.3.2 identity work.
 *
 * The plugin writes its captures as lines in LogOutput.log, and the SFTP poller parses that file
 * line by line. Two of the fields on those lines are attacker-written:
 *
 *   • the shout TEXT (a player types it), and
 *   • the peer NAME (ZNet.RPC_PeerInfo assigns m_playerName straight from the handshake packet,
 *     with no length or character check — so it is free text on a modified client).
 *
 * Two shapes turned either field into somebody else's identity. BOTH ARE CLOSED — this file is a
 * regression test now, not a report of a live defect:
 *
 *   1. THE CONSOLE-ECHO IMITATION. services/log-poller/src/parser.js used to test RE.consoleShout
 *      as an UNANCHORED substring, before every marker regex, so ANY line merely CONTAINING
 *      `Console: <color=orange>NAME</color>: <color=..>TEXT</color>` was read as a mod-free echo
 *      from NAME. A player only had to SHOUT that literal string: the plugin's raw-case
 *      [EILIF_CHAT] line reproduced it verbatim. Fixed 2026-09-05 at the consumer, in two places:
 *      echo detection is now anchored to the line's OWN prefix (`ECHO_LINE`, a fixed-shape
 *      `[… : Unity Log] <date> <time>: Console: ` with no `.*` in it, so the engine cannot
 *      backtrack past the real prefix to a second, player-supplied "Console:" further along the
 *      line), and every captured name goes through `isPlausibleCharacterName()`, which rejects
 *      `<`, `>`, `|` and control characters outright.
 *   2. THE FIELD-SEPARATOR SHIFT. Marker lines are " | "-delimited and the oath/chat parsers split
 *      on the FIRST separator, so a peer named "Bren | hello" emitted
 *      `[EILIF_CHAT] Bren | hello | (their words)` and the poller read Bren speaking. Closed at the
 *      producer by SafeName(), and now also by the name check above.
 *
 * plugins/eilif-companion/src/SpeakerIdentity.cs closes both at the producer: Safe() defangs
 * rich-text tag openers in text, SafeName() also flattens '|' in names. This test drives the REAL
 * parser with the exact lines the hardened plugin emits and asserts they are attributed to the
 * speaker, never to the named victim — so it keeps holding whichever end regresses.
 *
 * SCOPE, honestly: this covers the CONSUMER contract. The producer is C# and this repo has no C#
 * test harness, so the sanitized strings below are written out as literals rather than generated —
 * if SpeakerIdentity.Safe/SafeName ever change, update them here in the same commit.
 *
 * The benign block at the end is not decoration: poller.js suppresses a shout's console-echo twin
 * by comparing name + UPPERCASED text, so a sanitizer that rewrote ordinary punctuation would
 * double-post every "<3" and "5 > 3" to Discord. That is why only tag openers are flattened.
 */
import assert from 'node:assert/strict';
import { LogParser } from '../services/log-poller/src/parser.js';

const PREFIX = '[Info   :Eilif Companion] ';
const WARN = '[Warning:Eilif Companion] ';

/** Parse one line through a fresh parser (state is irrelevant to these paths). */
function parse(line) {
  return new LogParser({ online: ['Bren', 'Troll'] }).parseLine(line);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('marker-line injection (EilifCompanion 0.3.2 log safety)');

// ── 1. The console-echo imitation, as the hardened plugin now writes it ──────
// Safe() turned every "<color" / "</color" opener into "(color" / "(/color", so the line no
// longer matches RE.consoleShout and falls through to the marker regexes, where it belongs.
{
  const shout =
    'Console: (color=orange)Bren(/color): (color=x)/oath i am a coward(/color)';

  check('a shouted echo imitation is chat from the shouter, not an oath from the victim', () => {
    const ev = parse(`${PREFIX}[EILIF_CHAT] Troll | ${shout}`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'chat');
    assert.equal(ev[0].characterName, 'Troll');
    assert.equal(ev[0].metadata.source, 'plugin');
  });

  check('the same shape in a pin place name stays a pin by the shouter', () => {
    const ev = parse(`${PREFIX}[EILIF_PIN] Troll | poi | ${shout} | 1.0 | 2.0`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'pin');
    assert.equal(ev[0].characterName, 'Troll');
  });

  check('the same shape in a peer name stays that peer, not the victim', () => {
    const ev = parse(`${PREFIX}[EILIF_POS] ${shout} | 1.0 | 2.0 | Meadows`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'pos');
    assert.notEqual(ev[0].characterName, 'Bren');
  });

  check('the [EILIF_IDENT] warning line is inert to the parser', () => {
    // The claimed name is printed as evidence on this line, so it is attacker-written too.
    const ev = parse(`${WARN}[EILIF_IDENT] mismatch peer=Troll claimed=${shout} uid=42`);
    assert.deepEqual(ev, []);
  });
}

// ── 2. The field-separator shift, as SafeName() now writes it ────────────────
// A peer name of "Bren | hello" reaches the log as "Bren / hello": one field, one speaker.
{
  check('a piped peer name cannot borrow a shorter name on a chat line', () => {
    const ev = parse(`${PREFIX}[EILIF_CHAT] Bren / hello | words the real Bren never said`);
    assert.equal(ev[0].characterName, 'Bren / hello');
  });

  check('a piped peer name cannot borrow a shorter name on an oath line', () => {
    const ev = parse(`${PREFIX}[EILIF_OATH] Bren / hello | I am a coward`);
    assert.equal(ev[0].characterName, 'Bren / hello');
  });

  check('a piped peer name cannot plant a pin on someone else', () => {
    const ev = parse(`${PREFIX}[EILIF_PIN] Bren / poi / X / 1.0 / 2.0 | poi | place | 3.0 | 4.0`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'pin');
    assert.equal(ev[0].characterName, 'Bren / poi / X / 1.0 / 2.0');
  });

  check('a piped peer name cannot shift the position fields', () => {
    const ev = parse(`${PREFIX}[EILIF_POS] Bren / 1.0 / 2.0 / Meadows | -184.9 | -2.1 | BlackForest`);
    assert.equal(ev[0].characterName, 'Bren / 1.0 / 2.0 / Meadows');
    assert.equal(ev[0].metadata.x, -184.9);
  });
}

// ── 3. Ordinary punctuation survives, so the echo-twin dedupe still matches ──
// poller.js drops the console echo of a shout only when name + UPPERCASED text are identical to
// the plugin's line. Anything the sanitizer rewrites here would double-post to #server.
{
  // Accepted cost, stated plainly: text that really is tag-shaped ("<b>bold</b>", or a shout
  // containing "<color=…>") IS rewritten, so those rare shouts can mirror twice. That is the whole
  // trade — a blanket flatten of every '<' and '>' would do it to "<3" and "5 > 3" as well.
  for (const text of ['i have <3 arrows', '5 > 3', '>_<', '-> north', 'x <= y']) {
    check(`"${text}" reaches the mirror unchanged`, () => {
      const ev = parse(`${PREFIX}[EILIF_CHAT] Troll | ${text}`);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].type, 'chat');
      assert.equal(ev[0].metadata.text, text);
    });
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall marker-line injection checks passed');
