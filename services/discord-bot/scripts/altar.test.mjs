// Unit tests for altar tellings (src/altar.js). No network, no Discord.
//
// Covers, in order:
//   1. the altar pin's name, and that it matches the file that writes it
//   2. distance, and the first sentence of a telling
//   3. the spoken line, its 150-character composed cap searched across every tail
//   4. the 24 h memory, and that it stays bounded
//   5. who is standing at an altar: proximity, freshness, online, a chosen telling
//   6. the loop end to end, and the VOICE_TARGETING gate that must silence it
//   7. the copy doctrine
//
// Run: node scripts/altar.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  ALTAR_MEMORY_MAX,
  ALTAR_PIN_KIND,
  ALTAR_PIN_SUFFIX,
  ALTAR_LINE_MAX,
  ALTAR_QUIET_MS,
  ALTAR_RADIUS_M,
  FIRST_SENTENCE_MAX,
  POSITION_FRESH_MS,
  altarCandidates,
  altarIsDue,
  altarKey,
  altarLine,
  altarPinName,
  bossNameFromAltarPin,
  createAltarTellings,
  firstSentence,
  metresBetween,
  rememberAltar,
} from '../src/altar.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const silentLog = { info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-09-06T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── 1. The altar pin's name ───────────────────────────────────────────────
{
  eq(altarPinName('Bonemass'), 'Bonemass altar', 'an altar is named for its forsaken');
  eq(bossNameFromAltarPin('Bonemass altar'), 'Bonemass', 'and reads back to the boss');
  eq(bossNameFromAltarPin('Bonemass'), null, 'a bare boss name is not an altar pin');
  eq(bossNameFromAltarPin('Bren’s longhouse'), null, "and neither is a viking's own pin");
  eq(altarPinName('  '), '', 'an empty name makes no pin');

  // THE SUFFIX IS A CONTRACT ACROSS TWO RUNTIMES. lib/altar.ts writes the pin
  // and this module reads it; a rename on one side alone would leave every
  // altar unreadable, silently, with no error anywhere.
  const libSrc = readFileSync(new URL('../../../lib/altar.ts', import.meta.url), 'utf8');
  ok(
    libSrc.includes(`export const ALTAR_PIN_SUFFIX = '${ALTAR_PIN_SUFFIX}';`),
    'lib/altar.ts names the altar exactly the way this module reads it',
  );
  ok(
    libSrc.includes(`export const ALTAR_PIN_KIND = '${ALTAR_PIN_KIND}';`),
    'and writes the same pin kind this module queries',
  );
  ok(
    /return clean \? `\$\{clean\}\$\{ALTAR_PIN_SUFFIX\}` : '';/.test(libSrc),
    'and builds the name the same way',
  );
}

// ── 2. Distance and the first sentence ────────────────────────────────────
{
  eq(metresBetween({ x: 0, z: 0 }, { x: 3, z: 4 }), 5, 'a 3-4-5 triangle is five metres');
  eq(metresBetween({ x: 10, z: 10 }, { x: 10, z: 10 }), 0, 'and standing on it is none');
  eq(metresBetween({ x: 'x', z: 0 }, { x: 0, z: 0 }), Infinity, 'an unreadable coordinate is infinitely far away');
  eq(metresBetween(null, { x: 0, z: 0 }), Infinity, 'and so is nothing at all');

  eq(
    firstSentence('The mist came in fast. Then it broke. We ran.'),
    'The mist came in fast.',
    'the first sentence is the first sentence',
  );
  eq(firstSentence('It fell? We were not sure. '), 'It fell?', 'a question ends a sentence too');
  eq(firstSentence('No end to this one'), 'No end to this one', 'a short run-on is spoken whole');
  const long = firstSentence('x'.repeat(400));
  ok(long.length <= FIRST_SENTENCE_MAX, `a long run-on is cut to ${FIRST_SENTENCE_MAX} (${long.length})`);
  ok(long.endsWith('…'), 'and says so with an ellipsis');
  eq(firstSentence('Line one.\n\nLine two.'), 'Line one.', 'paragraphs collapse before the cut');
  eq(firstSentence(''), '', 'an empty telling has no sentence');
  eq(firstSentence(null), '', 'and neither does nothing');
  // A cut must never strand half of a surrogate pair.
  const emoji = firstSentence('🗿'.repeat(200));
  ok(!/[\uD800-\uDBFF]$/.test(emoji.replace(/…$/, '')), 'a cut never leaves half a character behind');
}

// ── 3. The spoken line ────────────────────────────────────────────────────
{
  const line = altarLine('The mist came in fast. Then it broke.', 'Bren Bjornsson', 'seed-1');
  ok(line.startsWith('The mist came in fast.'), 'the line opens with the telling');
  ok(line.includes('Bren'), 'and names who told it');
  ok(!line.includes('Bjornsson'), 'by their first name, like every other spoken line');
  eq(line, altarLine('The mist came in fast. Then it broke.', 'Bren Bjornsson', 'seed-1'), 'and is stable for a seed');

  const skald = altarLine('It fell.', 'The Skald', 'seed-2');
  ok(skald.includes('The Skald'), 'the Skald keeps its whole name');

  eq(altarLine('', 'Bren'), '', 'an empty telling produces no line at all');

  // THE COMPOSED CAP, SEARCHED RATHER THAN SAMPLED.
  //
  // The opening and the tail are capped separately (120 and a filled pool line)
  // and their sum is not: 120 characters of run-on telling plus "That is
  // <thirty-two characters of name> speaking. The rest is on the page." was 196
  // characters of centre-screen text, 46 over the ceiling every other in-game
  // line keeps. One seeded sample cannot catch that, because the seed decides
  // which tail is drawn, so this drives EVERY tail against the longest name and
  // the longest telling this function will ever be handed.
  const longestName = 'Ragnhildr'.repeat(6); // longer than the 32 tellerName keeps
  const runOn = 'x'.repeat(400);
  const realistic = 'The swamp took two of us before the mist lifted and we found the thing waiting under the roots of a tree the size of a longship keel';
  let longest = '';
  for (let seed = 0; seed < 60; seed++) {
    for (const text of [runOn, realistic, `${realistic}. And then it fell.`]) {
      for (const author of [longestName, 'Ragnhildr', 'Bo', 'The Skald']) {
        const line = altarLine(text, author, `seed-${seed}`);
        if (line.length > longest.length) longest = line;
      }
    }
  }
  ok(longest.length > 0, 'the search actually produced lines, so this check is armed');
  ok(
    longest.length <= ALTAR_LINE_MAX,
    `the whole spoken line stays inside the ${ALTAR_LINE_MAX} character ceiling (worst was ${longest.length}: ${JSON.stringify(longest)})`,
  );

  // The tail is never the half that gets cut: it names the teller, which is the
  // reason the line ends with it at all.
  const squeezed = altarLine(runOn, longestName, 'seed-3');
  ok(/\.$|page\.$/.test(squeezed), `the tail survives whole (${JSON.stringify(squeezed)})`);
  ok(squeezed.includes('Ragnhildr'), 'and still names the teller');
  ok(squeezed.length <= ALTAR_LINE_MAX, 'while the opening yields the room');
  ok(!/[—–]/.test(longest), 'and no composed line carries an em or en dash');
  ok(!longest.includes('!'), 'nor an exclamation mark');

  // A short telling is not padded or trimmed by any of that.
  eq(
    altarLine('It fell.', 'Bo', 'seed-9').startsWith('It fell.'),
    true,
    'a line with room to spare is left exactly as it was',
  );
}

// ── 4. The memory ─────────────────────────────────────────────────────────
{
  eq(altarKey('Bren', 'p1'), 'bren|p1', 'the key is the viking and the altar');
  eq(altarKey('BREN ', 'p1'), 'bren|p1', 'and is case and space insensitive');

  const mem = {};
  ok(altarIsDue(mem, 'bren|p1', NOW), 'a viking who has never heard this altar is due');
  rememberAltar(mem, 'bren|p1', NOW);
  ok(!altarIsDue(mem, 'bren|p1', NOW + 3600_000), 'an hour later they are not');
  ok(altarIsDue(mem, 'bren|p1', NOW + ALTAR_QUIET_MS), 'a day later they are again');
  ok(altarIsDue(mem, 'astrid|p1', NOW), 'and somebody else always is');
  ok(altarIsDue({ 'bren|p1': 'not a date' }, 'bren|p1', NOW), 'an unreadable stamp is treated as never told');

  // Bounded, oldest first.
  const big = {};
  for (let i = 0; i < ALTAR_MEMORY_MAX + 50; i++) rememberAltar(big, `v${i}|p1`, NOW + i);
  eq(Object.keys(big).length, ALTAR_MEMORY_MAX, 'the memory stays bounded');
  eq(big['v0|p1'], undefined, 'the oldest entry is the one dropped');
  ok(big[`v${ALTAR_MEMORY_MAX + 49}|p1`], 'and the newest is kept');

  // Re-telling the same viking moves them to the back rather than adding a row.
  const reused = {};
  rememberAltar(reused, 'bren|p1', NOW);
  rememberAltar(reused, 'astrid|p1', NOW + 1);
  rememberAltar(reused, 'bren|p1', NOW + 2);
  eq(Object.keys(reused).join(','), 'astrid|p1,bren|p1', 'a repeat moves the entry to the back of the queue');
}

// ── 5. Who is standing at an altar ────────────────────────────────────────
{
  const altars = [
    { id: 'p1', name: 'Bonemass altar', bossId: 'b3', x: 100, z: 100 },
    { id: 'p2', name: 'Eikthyr altar', bossId: 'b1', x: 5000, z: 5000 },
  ];
  const tellings = {
    b3: { text: 'The bog took two of us. Then it took the beast.', author: 'Bren' },
    // b1 has no chosen telling: its altar is a place with nothing to say.
  };
  const base = { altars, tellings, nowMs: NOW, memory: {} };

  const at = (name, x, z, ageMs = 10_000) => ({ character_name: name, x, z, updated_at: iso(ageMs) });

  eq(
    altarCandidates({ ...base, positions: [at('Bren', 110, 100)], online: ['Bren'] }).length,
    1,
    'a viking ten metres from an altar with a telling is owed one',
  );
  eq(
    altarCandidates({ ...base, positions: [at('Bren', 100 + ALTAR_RADIUS_M + 5, 100)], online: ['Bren'] }).length,
    0,
    'and one just outside the radius is not',
  );
  eq(
    altarCandidates({ ...base, positions: [at('Bren', 110, 100, POSITION_FRESH_MS + 5000)], online: ['Bren'] }).length,
    0,
    'a stale position says where they were, not where they are',
  );
  eq(
    altarCandidates({ ...base, positions: [at('Bren', 110, 100)], online: [] }).length,
    0,
    'a viking who is not in the realm hears nothing',
  );
  eq(
    altarCandidates({ ...base, positions: [at('Bren', 5010, 5000)], online: ['Bren'] }).length,
    0,
    'an altar whose boss has no chosen telling has nothing to say',
  );
  eq(
    altarCandidates({
      ...base,
      memory: { [altarKey('Bren', 'p1')]: iso(3600_000) },
      positions: [at('Bren', 110, 100)],
      online: ['Bren'],
    }).length,
    0,
    'and a viking told at this altar an hour ago is not told again',
  );
  eq(
    altarCandidates({
      ...base,
      memory: { [altarKey('Bren', 'p1')]: iso(ALTAR_QUIET_MS + 1000) },
      positions: [at('Bren', 110, 100)],
      online: ['Bren'],
    }).length,
    1,
    'a day later they are',
  );

  // A position stamped in the future is a producer clock problem, not a viking.
  eq(
    altarCandidates({
      ...base,
      positions: [{ character_name: 'Bren', x: 110, z: 100, updated_at: new Date(NOW + 3600_000).toISOString() }],
      online: ['Bren'],
    }).length,
    0,
    'a position stamped in the future is unusable',
  );

  // Two altars in reach: the nearer one speaks, and only one line is owed.
  const close = [
    { id: 'p1', name: 'Bonemass altar', bossId: 'b3', x: 100, z: 100 },
    { id: 'p3', name: 'Moder altar', bossId: 'b4', x: 120, z: 100 },
  ];
  const both = altarCandidates({
    altars: close,
    tellings: { b3: { text: 'One.', author: 'Bren' }, b4: { text: 'Two.', author: 'Astrid' } },
    positions: [at('Loa', 118, 100)],
    online: ['Loa'],
    memory: {},
    nowMs: NOW,
  });
  eq(both.length, 1, 'a viking between two altars hears one saga, not two');
  eq(both[0].altar.id, 'p3', 'and it is the nearer one');

  // Several vikings at once, in a stable order.
  const crowd = altarCandidates({
    ...base,
    positions: [at('Loa', 101, 100), at('Astrid', 102, 100), at('Bren', 103, 100)],
    online: ['Loa', 'Astrid', 'Bren'],
  });
  eq(crowd.map((c) => c.character).join(','), 'Astrid,Bren,Loa', 'a crowd is answered in a deterministic order');
}

// ── 6. The loop, and the targeting gate ───────────────────────────────────
function fakeDb({ pins = [], bosses = [], tellings = [], positions = [], online = [] } = {}) {
  const state = { voice: [] };
  const table = (rows) => {
    const preds = [];
    const api = {
      eq(col, val) { preds.push((r) => r[col] === val); return api; },
      gte(col, val) { preds.push((r) => String(r[col]) >= String(val)); return api; },
      limit() { return Promise.resolve({ data: rows.filter((r) => preds.every((p) => p(r))), error: null }); },
      then(res, rej) {
        return Promise.resolve({ data: rows.filter((r) => preds.every((p) => p(r))), error: null }).then(res, rej);
      },
    };
    return api;
  };
  return {
    state,
    from(name) {
      return {
        select() {
          if (name === 'pins') return table(pins);
          if (name === 'bosses') return table(bosses);
          if (name === 'boss_tellings') return table(tellings);
          if (name === 'player_positions') return table(positions);
          return table(online);
        },
        insert(row) {
          state.voice.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

{
  const db = () =>
    fakeDb({
      pins: [{ id: 'p1', name: 'Bonemass altar', kind: 'boss', world_x: 100, world_z: 100 }],
      bosses: [{ id: 'b3', name: 'Bonemass' }],
      tellings: [{ boss_id: 'b3', text: 'The bog took two of us. Then it took the beast.', author_character: 'Bren', source: 'player', chosen: true }],
      positions: [{ character_name: 'Loa', x: 105, z: 100, updated_at: iso(10_000) }],
      online: [{ character_name: 'Loa', is_online: true }],
    });

  // THE HARD GATE. Without targeting, one viking walking past an altar would
  // have the whole server read a telling at them, so the loop does nothing.
  delete process.env.VOICE_TARGETING;
  const silent = db();
  const state = {};
  const off = createAltarTellings({ db: silent, state, saveState: async () => {}, log: silentLog });
  eq(await off.tick(NOW), 0, 'with VOICE_TARGETING unset the loop speaks nothing');
  eq(silent.state.voice.length, 0, 'and queues nothing at all, rather than broadcasting');

  process.env.VOICE_TARGETING = '0';
  eq(await createAltarTellings({ db: db(), state: {}, saveState: async () => {}, log: silentLog }).tick(NOW), 0,
    'and "0" is not "1"');

  process.env.VOICE_TARGETING = '1';
  const live = db();
  const memState = {};
  const altar = createAltarTellings({ db: live, state: memState, saveState: async () => {}, log: silentLog });
  eq(await altar.tick(NOW), 1, 'with targeting on, the viking at the altar hears it');
  eq(live.state.voice.length, 1, 'as one queued line');
  const queued = live.state.voice[0];
  eq(queued.kind, 'event', 'queued as an event line, exempt from the ambient gap');
  eq(queued.meta.target, 'Loa', 'AIMED at the one viking standing there');
  eq(queued.meta.source, 'altar_telling', 'and marked for what it is');
  ok(queued.text.startsWith('The bog took two of us.'), 'the line opens with the telling');
  ok(queued.text.includes('Bren'), 'and names who told it');

  // The same viking on the next tick, sixty seconds later, hears nothing.
  eq(await altar.tick(NOW + 60_000), 0, 'the same altar does not repeat itself a minute later');
  eq(live.state.voice.length, 1, 'and nothing more is queued');
  ok(memState.altar.told[altarKey('Loa', 'p1')], 'the memory is in state.json, so a restart remembers');

  // A day later it may speak again, given a position that is fresh THEN. (The
  // fixture above is stamped near NOW, so at NOW+24h it is correctly stale:
  // the quiet window and the freshness window are separate gates and both have
  // to pass.)
  const laterNow = NOW + ALTAR_QUIET_MS + 1000;
  const later = fakeDb({
    pins: [{ id: 'p1', name: 'Bonemass altar', kind: 'boss', world_x: 100, world_z: 100 }],
    bosses: [{ id: 'b3', name: 'Bonemass' }],
    tellings: [{ boss_id: 'b3', text: 'The bog took two of us.', author_character: 'Bren', source: 'player', chosen: true }],
    positions: [{ character_name: 'Loa', x: 105, z: 100, updated_at: new Date(laterNow - 10_000).toISOString() }],
    online: [{ character_name: 'Loa', is_online: true }],
  });
  const returning = createAltarTellings({ db: later, state: memState, saveState: async () => {}, log: silentLog });
  eq(await returning.tick(laterNow), 1, 'a day later the same viking at the same altar hears it again');

  // A pin that is not an altar, and an altar for a boss nobody has told.
  const stranger = fakeDb({
    pins: [{ id: 'p9', name: 'Bren’s longhouse', kind: 'boss', world_x: 100, world_z: 100 }],
    bosses: [{ id: 'b3', name: 'Bonemass' }],
    tellings: [{ boss_id: 'b3', text: 'It fell.', author_character: 'Bren', source: 'player', chosen: true }],
    positions: [{ character_name: 'Loa', x: 100, z: 100, updated_at: iso(1000) }],
    online: [{ character_name: 'Loa', is_online: true }],
  });
  eq(
    await createAltarTellings({ db: stranger, state: {}, saveState: async () => {}, log: silentLog }).tick(NOW),
    0,
    'a pin that does not name an altar is never spoken at',
  );
  eq(stranger.state.voice.length, 0, 'and nothing is queued for it');

  delete process.env.VOICE_TARGETING;
}

// ── 7. The copy doctrine ──────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../src/altar.js', import.meta.url), 'utf8');
  const isNotPlayerCopy = (line) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ||
    /log\.(info|warn|error)\?\./.test(line) ||
    /console\.(log|warn|error)/.test(line) ||
    /\.match\(|\.replace\(|RegExp|new Error\(/.test(line);
  const offenders = [];
  src.split('\n').forEach((raw, i) => {
    if (isNotPlayerCopy(raw)) return;
    const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    if (/[—–]/.test(code)) offenders.push(`altar.js:${i + 1}: ${code.trim()}`);
  });
  ok(offenders.length === 0, `no em/en dash in the spoken copy, found: ${JSON.stringify(offenders.slice(0, 3))}`);

  ok(/if \(!targeting\(\)\) return 0;/.test(src), 'the targeting gate is the first thing the tick does');
  ok(/target: c\.character/.test(src), 'and every line it queues carries a target');
  ok(!/kind: 'ambient'/.test(src), 'an altar telling is never an ambient line');
}

console.log(`altar.test: ${passed} assertions passed`);
