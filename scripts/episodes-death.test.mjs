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

console.log('OK — all episode death-phrasing assertions passed');
