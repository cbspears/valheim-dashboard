// Death-phrasing tests for lib/episodes.ts (no network).
//
// Deaths reach the dashboard as a raw Valheim HitType or creature name in
// `events.metadata.cause`, cleaned only of token noise by /api/gs-ingest. Three
// separate places in lib/episodes.ts have to agree about what is an
// ENVIRONMENTAL cause and what is a creature name:
//   • ENV_DEATHS  → phraseDeath()   → the bare fragment (DeathLog, EpisodeList)
//   • ACTIVE_VOICE_CAUSES → describeDeath() → decides "X <phrase>" vs "X was <phrase>"
//   • ENV_DESC    → the episode's prose description, AND (via ENV_KEYS) the
//     classifier that decides whether a death is featurable as a "creature"
// A cause added to ENV_DEATHS but NOT to ENV_DESC still renders as a creature in
// the episode prose ("learned to fear the humble Enemyhit"), so these tests
// cover the whole path, not just phraseDeath.
//
// Run: npx tsx scripts/episodes-death.test.mjs
import { phraseDeath, describeDeath, buildEpisodes } from '../lib/episodes.ts';
import { HIT_TYPES } from '../lib/deaths.ts';
import assert from 'node:assert';

// ── enemyhit: Valheim's catch-all "killed by something the client can't name" ─
// Arrives Title-cased from the mod; the lookup is case-insensitive.
assert.equal(phraseDeath('EnemyHit'), 'struck down by an unseen foe');
assert.equal(phraseDeath('enemyhit'), 'struck down by an unseen foe');
assert.equal(phraseDeath('  EnemyHit  '), 'struck down by an unseen foe', 'whitespace tolerated');
// Passive participle → needs the "was" (it is NOT in ACTIVE_VOICE_CAUSES).
assert.equal(describeDeath('Testman', 'EnemyHit'), 'Testman was struck down by an unseen foe');

// Regression guard: it must never fall through to the creature branch.
assert.ok(!phraseDeath('EnemyHit').includes('taken by'), 'enemyhit is not phrased as a creature');
assert.ok(!describeDeath('Testman', 'EnemyHit').toLowerCase().includes('enemyhit'), 'the raw token never surfaces');

// ── the rest of the vocabulary still reads as before ─────────────────────────
assert.equal(describeDeath('Bjorn', 'Greydwarf'), 'Bjorn was taken by a Greydwarf', 'creature, consonant');
assert.equal(describeDeath('Bjorn', 'Abomination'), 'Bjorn was taken by an Abomination', 'creature, vowel');
assert.equal(describeDeath('Bjorn', 'The Elder'), 'Bjorn was felled by The Elder', 'named forsaken');
assert.equal(describeDeath('Bjorn', 'fall'), 'Bjorn fell to their death', 'active-voice env cause');
assert.equal(describeDeath('Bjorn', 'tree'), 'Bjorn was crushed by a falling tree', 'passive env cause');
assert.equal(describeDeath('Bjorn', ''), 'Bjorn has fallen', 'no cause at all');

// ── episode prose: enemyhit must be classified as environmental ──────────────
// ENV_KEYS (derived from ENV_DESC) is what stops featuredDeath() preferring this
// death as "a plain creature cause, most colorful" and rendering it through
// CREATURE_DESC as "{name} learned to fear the humble Enemyhit."
const day = '2026-08-22T20:00:00Z';
const episodes = buildEpisodes(
  [{ character_name: 'Testman', joined_at: day, left_at: '2026-08-22T22:00:00Z', duration_minutes: 120 }],
  [{ type: 'death', character_name: 'Testman', created_at: '2026-08-22T21:00:00Z', metadata: { cause: 'EnemyHit' } }],
);
assert.equal(episodes.length, 1, 'one session day → one episode');
const prose = `${episodes[0].title} ${episodes[0].description}`;
assert.ok(!/enemyhit/i.test(prose), `episode prose must not name the raw token — got: ${prose}`);
assert.ok(!/humble/i.test(prose), `episode prose must not use the creature template — got: ${prose}`);
assert.ok(/unseen foe|dark/i.test(prose), `episode prose should use the enemyhit flavor — got: ${prose}`);

// A real creature on the same shape still gets the creature treatment, so the
// assertions above are testing the classifier and not just "no deaths rendered".
const creatureEp = buildEpisodes(
  [{ character_name: 'Testman', joined_at: day, left_at: '2026-08-22T22:00:00Z', duration_minutes: 120 }],
  [{ type: 'death', character_name: 'Testman', created_at: '2026-08-22T21:00:00Z', metadata: { cause: 'Deathsquito' } }],
);
assert.ok(/deathsquito/i.test(creatureEp[0].description), 'a real creature is still named in the prose');

// ── every HitType reads plainly and blames the right thing ───────────────────
// scripts/eilif-death.test.mjs proves each of the 22 words RESOLVES (no raw
// token reaches the Saga). This is the other half: that what it resolves to is
// the right thing. A cause that reads well but names the wrong killer is worse
// than a token, because nobody notices it is wrong.
//
// [must say, must NOT say] per HitType. The must-nots are the misattributions:
// an unseen foe is not another viking, a cart is not a tree, a ballista bolt is
// not a monster, and "self" is nobody else's doing.
const READS = {
  Undefined: [/nameless|no name/i, /viking|foe|beast|creature/i],
  EnemyHit: [/unseen|never saw|did not show/i, /viking|cart|tree/i],
  PlayerHit: [/another viking|one of their own/i, /unseen|beast/i],
  Fall: [/fell|fall|fly|high rocks/i, /pushed|thrown/i],
  Drowning: [/water|deep|dragged under/i, /fire|flame/i],
  Burning: [/flame|fire|burn/i, /water|cold/i],
  Freezing: [/froze|frozen|cold/i, /flame|fire/i],
  Poisoned: [/poison/i, /flame|water/i],
  Water: [/water|deep|dragged under/i, /fire|flame/i],
  Smoke: [/smoke/i, /water/i],
  EdgeOfWorld: [/edge of the world/i, /beast|creature/i],
  Impact: [/broken|fall/i, /blade|claw/i],
  Cart: [/cart/i, /tree|ship|longship/i],
  Tree: [/tree/i, /cart|ship/i],
  Self: [/own hand/i, /foe|beast|viking/i],
  Structural: [/timber/i, /cart|ballista/i],
  Turret: [/ballista/i, /beast|creature/i],
  Boat: [/longship|ship/i, /cart|tree/i],
  Stalagtite: [/skewer|above/i, /beast|foe/i],
  Catapult: [/catapult/i, /ballista|cart/i],
  CinderFire: [/cinder/i, /water|cold/i],
  AshlandsOcean: [/boil/i, /cold|freez/i],
};

// The four HitTypes whose phrase is already active voice ("fell to their
// death"): they read straight after a name, and everything else is a participle
// that needs a "was". Mirrors ACTIVE_VOICE_CAUSES in lib/episodes.ts.
const ACTIVE_HITS = new Set(['Fall', 'Smoke', 'Poisoned', 'EdgeOfWorld']);

for (const hit of HIT_TYPES) {
  const [must, mustNot] = READS[hit] ?? [];
  assert.ok(must, `${hit}: add it to READS — a new HitType needs a reading, not just a phrase`);

  const bare = phraseDeath(hit);
  const full = describeDeath('Bjorn', hit);
  const token = new RegExp(`\\b${hit}\\b`); // case-sensitive: "tree" is English, "CinderFire" is a token

  assert.ok(!token.test(bare), `${hit}: the raw token reached phraseDeath: ${bare}`);
  assert.ok(!token.test(full), `${hit}: the raw token reached describeDeath: ${full}`);
  assert.ok(must.test(bare), `${hit}: phraseDeath should say what killed them, got: ${bare}`);
  assert.ok(!mustNot.test(bare), `${hit}: phraseDeath blames the wrong thing, got: ${bare}`);
  assert.ok(!/[—–]/.test(bare) && !/[—–]/.test(full), `${hit}: no dash in death copy`);

  // The "was" rule: a participle needs one, an active-voice phrase must not
  // have one ("Bjorn was fell to their death").
  const expected = ACTIVE_HITS.has(hit) ? `Bjorn ${bare}` : `Bjorn was ${bare}`;
  assert.equal(full, expected, `${hit}: describeDeath grammar`);
  assert.ok(/^[A-Z]/.test(full) && !/\s{2}/.test(full), `${hit}: reads as one clean sentence, got: ${full}`);

  // The episode prose has its own map (ENV_DESC) and its own classifier, so the
  // same word has to land as environmental there too.
  const eps = buildEpisodes(
    [{ character_name: 'Bjorn', joined_at: '2026-08-22T20:00:00Z', left_at: '2026-08-22T22:00:00Z', duration_minutes: 120 }],
    [{ type: 'death', character_name: 'Bjorn', created_at: '2026-08-22T21:00:00Z', metadata: { cause: hit } }],
  );
  const prose = `${eps[0].title} ${eps[0].description}`;
  assert.ok(!token.test(prose), `${hit}: the raw token reached the episode prose: ${prose}`);
  assert.ok(!/humble/i.test(prose), `${hit}: an environmental cause was featured as a creature: ${prose}`);
  assert.ok(!mustNot.test(prose.replace('Bjorn', '')), `${hit}: the episode prose blames the wrong thing: ${prose}`);
}

// ── the cases that are not HitTypes at all ───────────────────────────────────
// A PlayerHit WITH a named attacker arrives pre-phrased as "the hand of Bjorn"
// (lib/deaths.eilifCause), which must route through the boss branch rather than
// reading "taken by a the hand of Bjorn".
assert.equal(describeDeath('Sven', 'the hand of Bjorn'), 'Sven was felled by the hand of Bjorn');
assert.equal(describeDeath('Sven', 'Eikthyr'), 'Sven was felled by Eikthyr', 'a bare boss name');
assert.equal(describeDeath('Sven', 'The Queen'), 'Sven was felled by The Queen');
assert.equal(describeDeath('Sven', 'Deathsquito'), 'Sven was taken by a Deathsquito', 'creature casing is preserved');
assert.equal(describeDeath('Sven', '  '), 'Sven has fallen', 'whitespace counts as no cause');
assert.equal(describeDeath('', 'Neck'), 'A viking was taken by a Neck', 'a nameless report still reads');

// ── no dash anywhere a player reads episode prose ────────────────────────────
// Every branch of titleFor/describeEpisode, swept for em and en dashes: they are
// the loudest AI tell in the copy, and the world-day span used to render one.
{
  // All on one CT calendar day: 18:00-23:00Z on 08-22 is 13:00-18:00 CT.
  const day = (h) => `2026-08-22T${String(h).padStart(2, '0')}:00:00Z`;
  const session = (name) => ({
    character_name: name, joined_at: '2026-08-22T18:00:00Z',
    left_at: '2026-08-22T23:00:00Z', duration_minutes: 300,
  });
  const ev = (type, metadata, name = 'Bjorn') => ({
    type, character_name: name, created_at: day(20), metadata,
  });
  const oath = { character_name: 'Bjorn', oath_text: 'I will build the hall', sworn_at: day(21) };
  const pin = { name: 'Skull Rock', kind: 'landmark', by_character_name: 'Bjorn', created_at: day(21) };

  const shapes = [
    // [sessions, events, oaths, pins]
    [[session('Bjorn')], [], [], []],
    [[session('Bjorn')], [ev('death', { cause: 'Greydwarf' })], [], []],
    [[session('Bjorn')], [ev('death', { cause: 'Tree' })], [], []],
    [[session('Bjorn')], [ev('death', {}), ev('death', {}), ev('death', {})], [], []],
    [[session('Bjorn')], [ev('boss', { boss: 'Bonemass', world_day: 44 })], [], []],
    [[session('Bjorn')], [ev('raid', { event: 'The forest is moving...' })], [], []],
    [[session('Bjorn')], [ev('discovery', { detail: 'entered the Swamp' })], [], []],
    [[session('Bjorn')], [ev('death', { cause: 'Neck', world_day: 12 }), ev('raid', { event: 'You are being hunted', world_day: 13 })], [], []],
    [[session('Bjorn'), session('Ingrid')], [], [oath], [pin]],
    [[session('Bjorn'), session('Ingrid'), session('Sven'), session('Astrid'), session('Lóa'), session('Bren')], [], [oath, { ...oath, character_name: 'Ingrid' }], [pin, { ...pin, name: 'The Long Beach' }, { ...pin, name: 'Troll Cave' }, { ...pin, name: 'Far Rock' }]],
  ];

  for (const [sessions, events, oaths, pins] of shapes) {
    for (const e of buildEpisodes(sessions, events, oaths, pins)) {
      const text = `${e.title} ${e.description}`;
      assert.ok(!/[—–]/.test(text), `no dash in episode copy, got: ${text}`);
      assert.ok(!/\{|\}/.test(text), `every token is filled, got: ${text}`);
      assert.ok(!/\s{2}/.test(text) && !/\s[.,]/.test(text), `no stray spacing, got: ${text}`);
      assert.ok(/^[A-Z]/.test(e.description), `the description opens with a capital, got: ${e.description}`);
      assert.ok(e.description.trim().endsWith('.'), `and closes a sentence, got: ${e.description}`);
    }
  }

  // The world-day span specifically: it used to render "world-days 12–13".
  const spanned = buildEpisodes(
    [session('Bjorn')],
    [ev('death', { cause: 'Neck', world_day: 12 }), ev('death', { cause: 'Neck', world_day: 13 })],
  )[0];
  assert.ok(/world days 12 to 13/.test(spanned.description),
    `a multi-day episode spells the span out, got: ${spanned.description}`);
}

// ── a cause is a KEY, and the cause is attacker-supplied ─────────────────────
// ENV_DESC and ENV_DEATHS are plain object literals keyed by the lowercased
// cause, and a modded client picks the killer name it reports. A bare MAP[low]
// walked Object.prototype: "constructor" handed ENV_DESC the Object function
// and buildEpisodes THREW on it, which is a 500 on every page that renders the
// saga. "toString" was quieter and worse, because it rendered.
for (const cause of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype']) {
  const bare = phraseDeath(cause);
  assert.equal(typeof bare, 'string', `${cause}: phraseDeath must return a string, got ${typeof bare}`);
  const full = describeDeath('Bjorn', cause);
  assert.ok(!/\[native code\]|undefined/.test(full), `${cause}: no internals on the page, got: ${full}`);
  assert.ok(/^Bjorn was taken by an? /.test(full), `${cause}: it is read as a creature, got: ${full}`);

  const eps = buildEpisodes(
    [{ character_name: 'Bjorn', joined_at: '2026-08-22T20:00:00Z', left_at: '2026-08-22T22:00:00Z', duration_minutes: 120 }],
    [{ type: 'death', character_name: 'Bjorn', created_at: '2026-08-22T21:00:00Z', metadata: { cause } }],
  );
  const prose = `${eps[0].title} ${eps[0].description}`;
  assert.ok(!/\[native code\]|undefined/.test(prose), `${cause}: no internals in the prose, got: ${prose}`);
  assert.ok(!/\{|\}/.test(prose) && !/\s{2}/.test(prose), `${cause}: the prose is clean, got: ${prose}`);
}

console.log(`OK — all episode death-phrasing assertions passed (${HIT_TYPES.length} HitTypes, prose swept for dashes)`);
