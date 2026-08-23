// Tests for the eilif-death path — our own client plugin's authoritative death
// cause (lib/deaths.ts) and the cross-producer collapse it has to survive.
//
// THE BUG THIS GUARDS AGAINST, in two halves:
//
//   1. A RAW TOKEN REACHING THE SAGA. The plugin sends the HitData.HitType enum
//      NAME verbatim (22 values, decompiled from assembly_valheim 0.221.12). If a
//      value has no phrase in lib/episodes.ts, a death renders as "taken by a
//      Cinderfire". The enum walk below asserts EVERY value lands on a real
//      phrase in phraseDeath(), describeDeath() AND the episode prose (three
//      separate maps that have to agree — see scripts/episodes-death.test.mjs).
//
//   2. A DOUBLE-COUNTED DEATH. Three producers report the same death (poller /
//      GsValheimStatsClient / our plugin) in ANY order, and "How We Die", the
//      Saga and the per-viking death log all count rows. The dedupe tests below
//      drive both arrival orders against a Supabase stub and assert exactly one
//      surviving row, carrying the EILIF cause either way.
//
// Run: npx tsx scripts/eilif-death.test.mjs
import assert from 'node:assert';
import {
  HIT_TYPES,
  DEDUPE_WINDOW_MS,
  EILIF_CAUSE_SOURCE,
  normalizeHitType,
  humanizeKiller,
  eilifCause,
  parseEilifDeath,
  ingestEilifDeath,
  ingestDeathEvents,
} from '../lib/deaths.ts';
import { phraseDeath, describeDeath, buildEpisodes } from '../lib/episodes.ts';
import { CREATURES } from '../config/creatures.ts';

// ── 0. the decompiled enum itself ────────────────────────────────────────────
// 22 values, in HitData.HitType declaration order (ilspycmd on the plugin's own
// libs/assembly_valheim.dll, game 0.221.12). A game update that adds a value has
// to be reflected here, and that edit is what forces the phrase below.
assert.deepEqual(HIT_TYPES, [
  'Undefined', 'EnemyHit', 'PlayerHit', 'Fall', 'Drowning', 'Burning', 'Freezing',
  'Poisoned', 'Water', 'Smoke', 'EdgeOfWorld', 'Impact', 'Cart', 'Tree', 'Self',
  'Structural', 'Turret', 'Boat', 'Stalagtite', 'Catapult', 'CinderFire', 'AshlandsOcean',
]);

assert.equal(normalizeHitType('burning'), 'Burning', 'case-insensitive');
assert.equal(normalizeHitType('  CINDERFIRE '), 'CinderFire', 'whitespace + case');
assert.equal(normalizeHitType('Sharknado'), null, 'an unknown word is not a HitType');
assert.equal(normalizeHitType(null), null);
assert.equal(normalizeHitType(42), null);

// ── 1. EVERY HitType renders as a real phrase, never a raw token ─────────────
const day = '2026-08-22T20:00:00Z';
const session = [{ character_name: 'Testman', joined_at: day, left_at: '2026-08-22T22:00:00Z', duration_minutes: 120 }];

for (const hit of HIT_TYPES) {
  const cause = eilifCause(hit, null);
  assert.equal(cause, hit.toLowerCase(), `${hit}: no attacker → the lowercased HitType word`);

  // THE failure mode: with no ENV_DEATHS entry, phraseDeath falls through to its
  // creature branch and emits "taken by a <token>" / "felled by <token>".
  const phrase = phraseDeath(cause);
  assert.ok(
    !/^taken by /.test(phrase) && !/^felled by /.test(phrase),
    `${hit} → phraseDeath("${cause}") = "${phrase}" — fell through to the CREATURE branch; ` +
      `add "${cause}" to ENV_DEATHS in lib/episodes.ts`,
  );
  assert.ok(phrase && phrase !== cause, `${hit} has a real phrase, not the bare token`);

  // describeDeath must read as a sentence, not as the bare token. (Checking the
  // token is absent ENTIRELY would be wrong: "claimed by dark water" is the
  // correct rendering of Water and legitimately contains the word.)
  const sentence = describeDeath('Testman', cause);
  assert.ok(sentence.startsWith('Testman '), `${hit}: "${sentence}"`);
  assert.ok(
    sentence !== `Testman was ${cause}` && sentence !== `Testman ${cause}`,
    `${hit}: the sentence is just the bare token — got "${sentence}"`,
  );

  // Episode prose: ENV_KEYS (derived from ENV_DESC, a SEPARATE map) is what stops
  // featuredDeath() classing this as "a plain creature cause".
  const eps = buildEpisodes(session, [
    { type: 'death', character_name: 'Testman', created_at: '2026-08-22T21:00:00Z', metadata: { cause } },
  ]);
  const prose = `${eps[0].title} ${eps[0].description}`;
  assert.ok(
    !/humble/i.test(prose),
    `${hit} → episode prose used the CREATURE template ("learned to fear the humble …"); ` +
      `add "${cause}" to ENV_DESC in lib/episodes.ts. Got: ${prose}`,
  );
}

// Spot-check the phrasings Charlie asked for by name — the whole point of the
// plugin is that these stop arriving as the generic "enemyhit".
assert.equal(phraseDeath('burning'), 'lost to the flames', 'campfire/fire');
assert.equal(phraseDeath('drowning'), 'claimed by dark water');
assert.equal(phraseDeath('freezing'), 'frozen in the cold');
assert.equal(phraseDeath('fall'), 'fell to their death');
assert.equal(describeDeath('Bjorn', 'burning'), 'Bjorn was lost to the flames');
assert.equal(describeDeath('Bjorn', 'catapult'), 'Bjorn was smashed flat by a catapult stone');
assert.equal(describeDeath('Bjorn', 'cinderfire'), 'Bjorn was burned by falling cinders');
assert.equal(describeDeath('Bjorn', 'cart'), 'Bjorn was run down by their own cart');
assert.equal(describeDeath('Bjorn', 'undefined'), 'Bjorn was struck down by something nameless');
assert.equal(describeDeath('Bjorn', 'playerhit'), 'Bjorn was cut down by another viking');

// ── 2. humanizeKiller: three spellings of a creature, one display name ───────
// Character.m_name is a LOCALIZATION TOKEN (verified: GetHoverName() localizes
// it), so a serpent literally arrives as "$enemy_serpent".
assert.equal(humanizeKiller('$enemy_serpent'), 'Serpent', 'the token Charlie asked about');
assert.equal(humanizeKiller('Serpent(Clone)'), 'Serpent', 'prefab clone name');
assert.equal(humanizeKiller('serpent'), 'Serpent', 'already-readable name');
assert.equal(humanizeKiller('$enemy_greydwarfbrute'), 'Greydwarf Brute');
assert.equal(humanizeKiller('$enemy_gdking'), 'The Elder', 'boss token → the name in lib/episodes BOSSES');
assert.equal(humanizeKiller('$enemy_dragon'), 'Moder');
assert.equal(humanizeKiller('$enemy_goblin'), 'Fuling');
// Unmapped creature: never dropped, never raw — capitalized, and visibly odd
// enough that someone adds a config/creatures.ts entry.
assert.equal(humanizeKiller('$enemy_notarealcreature'), 'Notarealcreature');
// A readable name from GsValheimStatsClient keeps its producer's casing.
assert.equal(humanizeKiller('Deathsquito'), 'Deathsquito');
assert.equal(humanizeKiller('SomeModdedThing'), 'SomeModdedThing', 'unknown readable name passes through');
// Fail-safe inputs.
assert.equal(humanizeKiller(''), null);
assert.equal(humanizeKiller('   '), null);
assert.equal(humanizeKiller(null), null);
assert.equal(humanizeKiller(undefined), null);
assert.equal(humanizeKiller(7), null);
assert.equal(humanizeKiller('$enemy_'), null, 'a token with nothing after the prefix');
// Prototype pollution: a token spelling an Object.prototype member must read as
// unmapped, not return an inherited function.
assert.equal(humanizeKiller('$enemy_constructor'), 'Constructor');
assert.equal(humanizeKiller('$enemy_toString'), 'ToString');

// Every value in config/creatures.ts must be a non-empty display string (a typo
// leaving one blank would silently produce a causeless death row).
for (const [token, name] of Object.entries(CREATURES)) {
  assert.equal(token, token.toLowerCase(), `creature key "${token}" must be lowercase`);
  assert.ok(typeof name === 'string' && name.trim(), `creature "${token}" has a display name`);
}

// ── 3. eilifCause: attacker wins, and a player killer reads as a person ──────
assert.equal(eilifCause('EnemyHit', 'Serpent'), 'Serpent');
assert.equal(phraseDeath(eilifCause('EnemyHit', 'Serpent')), 'taken by a Serpent');
assert.equal(eilifCause('EnemyHit', null), 'enemyhit', 'no attacker → the honest unnamed-foe cause');
// PlayerHit: a bare name would render "taken by a Bjorn". "the hand of …" routes
// through phraseDeath's `felled by` branch instead.
assert.equal(eilifCause('PlayerHit', 'Bjorn'), 'the hand of Bjorn');
assert.equal(describeDeath('Sven', 'the hand of Bjorn'), 'Sven was felled by the hand of Bjorn');
assert.equal(eilifCause('PlayerHit', null), 'playerhit', 'unnamed player killer still reads sensibly');

// ── 4. parseEilifDeath: normalization + fail-safe on junk ────────────────────
const goodBody = {
  schemaVersion: 1, game: 'valheim', source: 'eilif-death',
  world: 'Eilif', player: 'Testman', tsUtc: '2026-08-22T21:00:00.000Z',
  hitType: 'Burning', attacker: null, biome: 'Meadows', pos: { x: 12.4, z: -7.8 },
};
const parsed = parseEilifDeath(goodBody);
assert.ok(parsed, 'a well-formed report parses');
assert.equal(parsed.cause, 'burning');
assert.equal(parsed.hitType, 'Burning');
assert.equal(parsed.attacker, null);
assert.equal(parsed.biome, 'Meadows');
assert.equal(parsed.metadata.source, EILIF_CAUSE_SOURCE);
assert.equal(parsed.metadata.causeSource, EILIF_CAUSE_SOURCE);
assert.equal(parsed.metadata.eilifDeathId, 'Testman|2026-08-22T21:00:00.000Z');
assert.deepEqual(parsed.metadata.pos, { x: 12, z: -8 });
assert.ok(!('attacker' in parsed.metadata), 'no attacker key when there was no attacker');

const serpentParsed = parseEilifDeath({ ...goodBody, hitType: 'EnemyHit', attacker: '$enemy_serpent', biome: 'Ocean' });
assert.equal(serpentParsed.cause, 'Sea Serpent');
assert.equal(serpentParsed.metadata.attacker, 'Sea Serpent');
assert.equal(serpentParsed.metadata.hitType, 'EnemyHit', 'the raw HitType is kept for diagnosis');

// Junk in → null out (and, crucially, NO eilif precedence claimed, so the gs
// report for that death still lands normally).
assert.equal(parseEilifDeath({ ...goodBody, player: '' }), null, 'no player');
assert.equal(parseEilifDeath({ ...goodBody, player: '   ' }), null, 'blank player');
assert.equal(parseEilifDeath({ ...goodBody, player: undefined }), null, 'missing player');
assert.equal(parseEilifDeath({ ...goodBody, tsUtc: 'not-a-date' }), null, 'unparseable timestamp');
assert.equal(parseEilifDeath({ ...goodBody, tsUtc: undefined }), null, 'missing timestamp');
assert.equal(parseEilifDeath({ ...goodBody, hitType: 'Sharknado' }), null, 'HitType from the future fails safe');
assert.equal(parseEilifDeath({ ...goodBody, hitType: undefined }), null, 'missing hitType');
assert.equal(parseEilifDeath({}), null, 'empty body');
// Optional fields degrade rather than reject.
const noBiome = parseEilifDeath({ ...goodBody, biome: undefined, pos: undefined });
assert.ok(noBiome, 'biome + pos are optional');
assert.equal(noBiome.biome, null);
assert.ok(!('pos' in noBiome.metadata) && !('biome' in noBiome.metadata));
assert.ok(parseEilifDeath({ ...goodBody, pos: { x: 'nope', z: 3 } }), 'a malformed pos never rejects the death');
assert.ok(!('pos' in parseEilifDeath({ ...goodBody, pos: { x: 'nope', z: 3 } }).metadata));

// ── the Supabase stub ────────────────────────────────────────────────────────
//
// Covers exactly the chains lib/deaths.ts uses against `events` and `players`:
//   select().eq()/.in()/.gte()/.lte()/.order()  → filtered rows
//   insert(row|row[])                            → appended
//   update({metadata}).eq('id', …)               → patched in place
//   delete().eq…is()                             → removed
// Filters accumulate into a predicate list, so a query with a filter the real
// code stops applying would show up as extra rows rather than pass silently.
function makeDb(state) {
  let nextId = 1000;

  /** PostgREST's `metadata->>key` addressing, plus plain columns. */
  const cell = (row, col) =>
    col.startsWith('metadata->>')
      ? ((row.metadata ?? {})[col.slice('metadata->>'.length)] ?? null)
      : (row[col] ?? null);

  /** Chainable filter builder shared by select / update / delete. */
  function filters(onResolve) {
    const preds = [];
    let orderCol = null;
    const matching = () => {
      let out = state.__table.filter((r) => preds.every((p) => p(r)));
      if (orderCol) out = [...out].sort((a, b) => String(a[orderCol]).localeCompare(String(b[orderCol])));
      return out;
    };
    const b = {
      eq(col, val) { preds.push((r) => cell(r, col) === val); return b; },
      in(col, vals) { preds.push((r) => vals.includes(cell(r, col))); return b; },
      gte(col, val) { preds.push((r) => String(r[col]) >= String(val)); return b; },
      lte(col, val) { preds.push((r) => String(r[col]) <= String(val)); return b; },
      is(col, val) { preds.push((r) => cell(r, col) === val); return b; },
      order(col) { orderCol = col; return b; },
      limit() { return b; },
      select() { return b; },
      then(resolve, reject) { return Promise.resolve(onResolve(matching())).then(resolve, reject); },
    };
    return b;
  }

  return {
    state,
    from(table) {
      state[table] ??= [];
      state.__table = state[table];
      return {
        select: () => filters((rows) => ({ data: rows.map((r) => ({ ...r })), error: null })),
        insert(row) {
          for (const r of Array.isArray(row) ? row : [row]) state[table].push({ id: `id-${nextId++}`, ...r });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          return filters((rows) => {
            for (const r of rows) Object.assign(r, patch);
            return { data: rows.map((r) => ({ ...r })), error: null };
          });
        },
        delete() {
          return filters((rows) => {
            const doomed = new Set(rows);
            state[table] = state[table].filter((r) => !doomed.has(r));
            state.__table = state[table];
            return { data: null, error: null };
          });
        },
      };
    },
  };
}

const T = '2026-08-22T21:00:00.000Z';
const eilifBody = {
  schemaVersion: 1, game: 'valheim', source: 'eilif-death', world: 'Eilif',
  player: 'Testman', tsUtc: T, hitType: 'Burning', attacker: null, biome: 'Meadows',
};
/** A gs deathEvents payload for the SAME death, 40 s later — inside the ±3 min window. */
const gsTs = '2026-08-22T21:00:40.000Z';
const gsDeathEvents = [{ playerName: 'Testman', killer: 'enemyhit', biome: 'Meadows', tsUtc: gsTs, lifeSec: 900 }];
const freshState = () => ({ events: [], players: [{ id: 'p1', character_name: 'Testman' }] });
const deaths = (db) => db.state.events.filter((e) => e.type === 'death');

// ── 5. plain insert (nothing else has reported this death) ──────────────────
{
  const db = makeDb(freshState());
  const r = await ingestEilifDeath(db, eilifBody);
  assert.equal(r.status, 'inserted');
  assert.equal(r.cause, 'burning');
  assert.equal(deaths(db).length, 1, 'exactly one death row');
  const row = deaths(db)[0];
  assert.equal(row.player_id, 'p1');
  assert.equal(row.character_name, 'Testman');
  assert.equal(row.metadata.cause, 'burning');
  assert.equal(row.metadata.hitType, 'Burning');
  assert.equal(row.metadata.causeSource, EILIF_CAUSE_SOURCE);
  assert.equal(row.created_at, T);
}

// ── 6. idempotent: the same report twice is one row ─────────────────────────
{
  const db = makeDb(freshState());
  await ingestEilifDeath(db, eilifBody);
  const again = await ingestEilifDeath(db, eilifBody);
  assert.equal(again.status, 'duplicate');
  assert.equal(deaths(db).length, 1, 'a retried report never adds a second row');
}

// ── 7. ORDER A — gs first, eilif second: the gs row is UPGRADED in place ────
// This is the headline case: gs already wrote "enemyhit" (its flat catch-all for
// a campfire), then our plugin's real cause arrives and must replace it WITHOUT
// creating a second death.
{
  const db = makeDb(freshState());
  await ingestDeathEvents(db, gsDeathEvents, 'Testman');
  assert.equal(deaths(db).length, 1, 'gs wrote its row');
  assert.equal(deaths(db)[0].metadata.cause, 'enemyhit', 'and it is the useless generic cause');

  const r = await ingestEilifDeath(db, eilifBody);
  assert.equal(r.status, 'upgraded', 'the eilif report upgrades rather than inserts');
  assert.equal(deaths(db).length, 1, 'STILL exactly one death — never double-counted');
  const row = deaths(db)[0];
  assert.equal(row.metadata.cause, 'burning', 'the cause now comes from the eilif report');
  assert.equal(row.metadata.hitType, 'Burning');
  assert.equal(row.metadata.causeSource, EILIF_CAUSE_SOURCE);
  assert.equal(row.metadata.source, 'gs', 'who CREATED the row is preserved');
  assert.equal(row.metadata.gsDeathId, `Testman|${gsTs}`, 'gs dedupe key preserved');
  assert.equal(row.metadata.lifeSec, 900, 'gs-only detail preserved');
  assert.equal(describeDeath(row.character_name, row.metadata.cause), 'Testman was lost to the flames');
}

// ── 8. ORDER B — eilif first, gs second: the later gs death is DROPPED ──────
{
  const db = makeDb(freshState());
  await ingestEilifDeath(db, eilifBody);
  assert.equal(deaths(db).length, 1);

  await ingestDeathEvents(db, gsDeathEvents, 'Testman');
  assert.equal(deaths(db).length, 1, 'the gs report did NOT add a second death');
  assert.equal(deaths(db)[0].metadata.cause, 'burning', 'the eilif cause still stands');
  assert.equal(deaths(db)[0].metadata.causeSource, EILIF_CAUSE_SOURCE);

  // And re-POSTing the cumulative gs snapshot (every ~120 s) stays a no-op.
  await ingestDeathEvents(db, gsDeathEvents, 'Testman');
  assert.equal(deaths(db).length, 1, 'the cumulative gs re-POST is still a no-op');
}

// ── 9. a causeless POLLER row is upgraded, not duplicated ───────────────────
{
  const db = makeDb(freshState());
  db.state.events.push({
    id: 'poller-1', type: 'death', player_id: 'p1', character_name: 'Testman',
    metadata: {}, created_at: '2026-08-22T21:01:10.000Z',
  });
  const r = await ingestEilifDeath(db, eilifBody);
  assert.equal(r.status, 'upgraded');
  assert.equal(deaths(db).length, 1, 'the poller row was upgraded, not joined by a second');
  const row = deaths(db)[0];
  assert.equal(row.id, 'poller-1');
  assert.equal(row.metadata.cause, 'burning');
  assert.equal(row.metadata.causeSource, EILIF_CAUSE_SOURCE);
  assert.ok(!('source' in row.metadata), 'a poller row gains no creator it never had');
}

// ── 10. a genuinely SEPARATE death (outside the window) is its own row ──────
// The dedupe must not be so eager that a second death minutes later vanishes.
{
  const db = makeDb(freshState());
  await ingestEilifDeath(db, eilifBody);
  const later = new Date(Date.parse(T) + DEDUPE_WINDOW_MS + 60_000).toISOString();
  const r = await ingestEilifDeath(db, { ...eilifBody, tsUtc: later, hitType: 'Drowning' });
  assert.equal(r.status, 'inserted');
  assert.equal(deaths(db).length, 2, 'two real deaths, two rows');
  assert.deepEqual(deaths(db).map((e) => e.metadata.cause).sort(), ['burning', 'drowning']);
}

// ── 11. a gs death for ANOTHER viking is untouched by our eilif row ─────────
{
  const db = makeDb(freshState());
  db.state.players.push({ id: 'p2', character_name: 'Bjorn' });
  await ingestEilifDeath(db, eilifBody);
  await ingestDeathEvents(db, [{ playerName: 'Bjorn', killer: '$enemy_serpent', tsUtc: gsTs }], 'Bjorn');
  assert.equal(deaths(db).length, 2, 'different vikings never collapse into each other');
  const bjorn = deaths(db).find((e) => e.character_name === 'Bjorn');
  assert.equal(bjorn.metadata.cause, 'Sea Serpent', 'and gs killers still humanize');
}

// ── 12. no players row yet → nothing is written (self-heals next cycle) ─────
{
  const db = makeDb({ events: [], players: [] });
  const r = await ingestEilifDeath(db, eilifBody);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ignored');
  assert.match(r.reason, /players row/);
  assert.equal(deaths(db).length, 0, 'never auto-create a player from a client payload');
}

// ── 13. a junk payload writes nothing and claims no precedence ──────────────
{
  const db = makeDb(freshState());
  const r = await ingestEilifDeath(db, { ...eilifBody, hitType: 'Sharknado' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ignored');
  assert.equal(deaths(db).length, 0);

  // Crucially: the gs report for that same death still lands, so an unknown
  // HitType degrades to today's behaviour instead of losing the death entirely.
  await ingestDeathEvents(db, gsDeathEvents, 'Testman');
  assert.equal(deaths(db).length, 1, 'the gs death is NOT suppressed by a rejected eilif report');
  assert.equal(deaths(db)[0].metadata.cause, 'enemyhit');
}

// ── 14. gs path regressions (it moved file, it must still behave) ──────────
{
  const db = makeDb(freshState());
  // A client may only report its OWN deaths.
  await ingestDeathEvents(db, [{ playerName: 'SomeoneElse', killer: 'Troll', tsUtc: gsTs }], 'Testman');
  assert.equal(deaths(db).length, 0, 'a reporter cannot author another viking\'s death');

  // Duplicates within one payload collapse.
  await ingestDeathEvents(db, [gsDeathEvents[0], gsDeathEvents[0]], 'Testman');
  assert.equal(deaths(db).length, 1, 'same gsDeathId twice in one payload → one row');

  // Non-array / empty input is a silent no-op.
  await ingestDeathEvents(db, null, 'Testman');
  await ingestDeathEvents(db, [], 'Testman');
  assert.equal(deaths(db).length, 1);
}

console.log(`OK — eilif-death: all ${HIT_TYPES.length} HitTypes phrase cleanly, both dedupe orders collapse to one row`);
