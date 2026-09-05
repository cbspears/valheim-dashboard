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
assert.equal(serpentParsed.cause, 'Serpent');
assert.equal(serpentParsed.metadata.attacker, 'Serpent');
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
//   rpc('ingest_death', …)                       → see makeIngestDeathRpc
// Filters accumulate into a predicate list, so a query with a filter the real
// code stops applying would show up as extra rows rather than pass silently.
//
// TWO MODES, and every dedupe case below runs in BOTH (see runDedupeSuite):
//   'rpc'     — db/2026-09-04_ingest_death.sql IS applied: the atomic function
//               answers, and lib/deaths.ts takes the rpc path.
//   'missing' — the migration is NOT applied yet: every rpc comes back 42883
//               (undefined_function) and lib/deaths.ts must fall back to the old
//               select-then-insert path and behave EXACTLY as it does today.
// That pairing is the deploy-safety contract: the code can ship before or after
// the migration and neither order loses a death.
/**
 * An in-memory stand-in for the Postgres function db/2026-09-04_ingest_death.sql
 * defines, mirroring its logic statement for statement (the ±3-min window, the
 * causeSource=\'eilif\' exclusion, the nearest-in-time pick, the metadata patch
 * that never touches `source`, and the gs 1:1 pairing that stamps gsDeathId onto
 * the eilif row it consumed).
 *
 * It runs to completion without awaiting anything, which is exactly the property
 * pg_advisory_xact_lock buys in the real thing: two reports of one death can
 * never interleave their check and their write. The concurrency case below leans
 * on that.
 */
function makeIngestDeathRpc(state) {
  const WINDOW_MS = 3 * 60_000;
  const deathRows = () => state.events.filter((e) => e.type === 'death');
  const meta = (r) => r.metadata ?? {};
  const nearest = (rows, at) =>
    [...rows].sort((a, b) => Math.abs(Date.parse(a.created_at) - at) - Math.abs(Date.parse(b.created_at) - at))[0];

  return ({ p_name, p_player_id, p_at, p_metadata, p_mode }) => {
    const m = p_metadata ?? {};
    const at = Date.parse(p_at);
    if (!p_name || !p_name.trim() || Number.isNaN(at)) return { data: 'ignored', error: null };

    const inWindow = deathRows().filter(
      (r) => r.character_name === p_name && Math.abs(Date.parse(r.created_at) - at) <= WINDOW_MS,
    );

    if (p_mode === 'eilif') {
      if (m.eilifDeathId && deathRows().some((r) => meta(r).eilifDeathId === m.eilifDeathId)) {
        return { data: 'duplicate', error: null };
      }
      const candidate = nearest(inWindow.filter((r) => meta(r).causeSource !== 'eilif'), at);
      if (candidate) {
        candidate.metadata ??= {};
        for (const k of ['eilifDeathId', 'causeSource', 'cause', 'hitType', 'attacker', 'biome']) {
          if (m[k] != null) candidate.metadata[k] = m[k];
        }
        return { data: 'upgraded', error: null };
      }
      if (!p_player_id) return { data: 'ignored', error: null };
      state.events.push({
        id: `rpc-${state.events.length}`,
        type: 'death',
        player_id: p_player_id,
        character_name: p_name,
        metadata: { ...m },
        created_at: p_at,
      });
      return { data: 'inserted', error: null };
    }

    if (p_mode !== 'gs') return { data: 'ignored', error: null };
    if (m.gsDeathId && deathRows().some((r) => meta(r).gsDeathId === m.gsDeathId)) {
      return { data: 'duplicate', error: null };
    }
    // An UNPAIRED eilif row in the window is this same death.
    const twin = nearest(
      inWindow.filter((r) => meta(r).causeSource === 'eilif' && meta(r).gsDeathId == null),
      at,
    );
    if (twin) {
      if (m.gsDeathId) (twin.metadata ??= {}).gsDeathId = m.gsDeathId;
      return { data: 'dropped', error: null };
    }
    if (!p_player_id) return { data: 'ignored', error: null };
    state.events.push({
      id: `rpc-${state.events.length}`,
      type: 'death',
      player_id: p_player_id,
      character_name: p_name,
      metadata: { ...m },
      created_at: p_at,
    });
    return { data: 'inserted', error: null };
  };
}

function makeDb(state, mode = 'rpc') {
  let nextId = 1000;

  /** PostgREST's `metadata->>key` addressing, plus plain columns. */
  const cell = (row, col) =>
    col.startsWith('metadata->>')
      ? ((row.metadata ?? {})[col.slice('metadata->>'.length)] ?? null)
      : (row[col] ?? null);

  // Chainable filter builder shared by select / update / delete. The TABLE is
  // captured per query (not read off a shared "current table" slot at resolve
  // time) — the concurrency cases below run two ingests through this stub at
  // once, and a shared slot would silently answer one query from the other
  // query's table.
  function filters(table, onResolve) {
    const preds = [];
    let orderCol = null;
    const matching = () => {
      let out = state[table].filter((r) => preds.every((p) => p(r)));
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

  const ingestDeath = makeIngestDeathRpc(state);

  return {
    state,
    mode,
    async rpc(fn, args) {
      if (mode === 'missing') {
        // Exactly what Postgres/PostgREST answer when the function isn't there.
        return { data: null, error: { code: '42883', message: `function public.${fn}(...) does not exist` } };
      }
      if (fn !== 'ingest_death') throw new Error(`unexpected rpc ${fn}`);
      state.rpcCalls = (state.rpcCalls ?? 0) + 1;
      return ingestDeath(args);
    },
    from(table) {
      state[table] ??= [];
      return {
        select: () => filters(table, (rows) => ({ data: rows.map((r) => ({ ...r })), error: null })),
        insert(row) {
          for (const r of Array.isArray(row) ? row : [row]) state[table].push({ id: `id-${nextId++}`, ...r });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          return filters(table, (rows) => {
            for (const r of rows) Object.assign(r, patch);
            return { data: rows.map((r) => ({ ...r })), error: null };
          });
        },
        delete() {
          return filters(table, (rows) => {
            const doomed = new Set(rows);
            state[table] = state[table].filter((r) => !doomed.has(r));
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

// ── 5-14. cross-producer dedupe, run TWICE ──────────────────────────────────
//
// Once with the atomic function in place ('rpc') and once with it missing
// ('missing', every call answering 42883). Identical assertions both times: that
// is the whole deploy-safety claim — lib/deaths.ts may ship before or after
// db/2026-09-04_ingest_death.sql and neither order changes what lands in
// `events`. The rpc mode additionally CANNOT race; the fallback mode can, which
// is exactly why the migration exists (see the concurrency case afterwards).
async function runDedupeSuite(mode) {
  // ── 5. plain insert (nothing else has reported this death) ──────────────────
  {
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
    await ingestEilifDeath(db, eilifBody);
    const later = new Date(Date.parse(T) + DEDUPE_WINDOW_MS + 60_000).toISOString();
    const r = await ingestEilifDeath(db, { ...eilifBody, tsUtc: later, hitType: 'Drowning' });
    assert.equal(r.status, 'inserted');
    assert.equal(deaths(db).length, 2, 'two real deaths, two rows');
    assert.deepEqual(deaths(db).map((e) => e.metadata.cause).sort(), ['burning', 'drowning']);
  }

  // ── 11. a gs death for ANOTHER viking is untouched by our eilif row ─────────
  {
    const db = makeDb(freshState(), mode);
    db.state.players.push({ id: 'p2', character_name: 'Bjorn' });
    await ingestEilifDeath(db, eilifBody);
    await ingestDeathEvents(db, [{ playerName: 'Bjorn', killer: '$enemy_serpent', tsUtc: gsTs }], 'Bjorn');
    assert.equal(deaths(db).length, 2, 'different vikings never collapse into each other');
    const bjorn = deaths(db).find((e) => e.character_name === 'Bjorn');
    assert.equal(bjorn.metadata.cause, 'Serpent', 'and gs killers still humanize');
  }

  // ── 12. no players row yet → nothing is written (self-heals next cycle) ─────
  {
    const db = makeDb({ events: [], players: [] }, mode);
    const r = await ingestEilifDeath(db, eilifBody);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'ignored');
    assert.match(r.reason, /players row/);
    assert.equal(deaths(db).length, 0, 'never auto-create a player from a client payload');
  }

  // ── 13. a junk payload writes nothing and claims no precedence ──────────────
  {
    const db = makeDb(freshState(), mode);
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
    const db = makeDb(freshState(), mode);
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
}

for (const mode of ['rpc', 'missing']) {
  await runDedupeSuite(mode);
}

// ── 15. THE RACE, and the lock that closes it ───────────────────────────────
//
// Both client mods Harmony-patch Player.OnDeath and POST immediately, so the two
// reports of ONE death land within milliseconds — the interleaving that put four
// duplicate ChÆrleif rows in prod (2026-08-28 02:44:21.895/.899, 09-01
// 01:32:41.104/.114, 01:44:00.475/.476, 01:52:45.438/.441).
//
// With the function applied, each report's check-and-write is one indivisible
// call (pg_advisory_xact_lock in the real thing; a synchronous body here), so
// whichever wins the race, the loser SEES its row. Both orders are driven
// concurrently below and both must collapse to a single death.
{
  const db = makeDb(freshState(), 'rpc');
  await Promise.all([
    ingestEilifDeath(db, eilifBody),
    ingestDeathEvents(db, gsDeathEvents, 'Testman'),
  ]);
  assert.equal(deaths(db).length, 1, 'simultaneous eilif + gs reports of one death → ONE row');
  assert.equal(deaths(db)[0].metadata.cause, 'burning', 'and the eilif cause is the one that survives');
  assert.ok(db.state.rpcCalls > 0, 'the atomic path was actually exercised');
}
{
  // Same, gs first in the microtask queue.
  const db = makeDb(freshState(), 'rpc');
  await Promise.all([
    ingestDeathEvents(db, gsDeathEvents, 'Testman'),
    ingestEilifDeath(db, eilifBody),
  ]);
  assert.equal(deaths(db).length, 1, 'reversed order — still ONE row');
  assert.equal(deaths(db)[0].metadata.causeSource, EILIF_CAUSE_SOURCE, 'eilif precedence holds either way');
}

// ── 16. the dropped gs twin is PAIRED, not merely discarded ─────────────────
// Dropping the gs report stamps its gsDeathId onto the eilif row it matched.
// Two consequences, both load-bearing: the next ~120 s cumulative re-POST sees
// the key already recorded and does nothing at all, and the eilif row can never
// be used to swallow a SECOND gs death (the corpse-run double death).
{
  const db = makeDb(freshState(), 'rpc');
  await ingestEilifDeath(db, eilifBody);
  await ingestDeathEvents(db, gsDeathEvents, 'Testman');
  assert.equal(deaths(db).length, 1);
  assert.equal(deaths(db)[0].metadata.gsDeathId, `Testman|${gsTs}`, 'the consumed gs id is recorded on the eilif row');

  // A genuinely separate death 20 s later, reported only by gs: the already-paired
  // eilif row must NOT cover it.
  const secondTs = new Date(Date.parse(gsTs) + 20_000).toISOString();
  await ingestDeathEvents(db, [{ playerName: 'Testman', killer: '$enemy_troll', tsUtc: secondTs }], 'Testman');
  assert.equal(deaths(db).length, 2, 'one eilif report covers at most ONE gs death');
  assert.ok(deaths(db).some((e) => e.metadata.cause === 'Troll'), 'the uncovered gs twin still lands');
}

// ── 17. an rpc that fails for a REAL reason still writes the death ──────────
// 42883 means "migration not applied" and is silent; anything else is a genuine
// failure that gets logged — but either way the fallback runs, because losing a
// death is worse than writing it the old way.
{
  const db = makeDb(freshState(), 'rpc');
  db.rpc = async () => ({ data: null, error: { code: '57014', message: 'statement timeout' } });
  const r = await ingestEilifDeath(db, eilifBody);
  assert.equal(r.status, 'inserted', 'a failing rpc falls through to the select-then-insert path');
  assert.equal(deaths(db).length, 1);
}

// ── 18. client text is capped, de-tagged and control-char free ──────────────
//
// Client payloads carry NO token (they run on players' PCs), so `attacker`,
// `biome` and the derived `cause` are attacker-chosen strings that end up in a
// Discord message, an in-game voice line, the Saga and the boards signs. An
// oversized cause is not cosmetic: >~1,900 chars makes Discord answer 400 to the
// relay's post, and the relay advances its cursor only after a successful send,
// so ONE poison row stalls the whole #server feed until somebody deletes it.
{
  const long = 'A'.repeat(500);
  const p = parseEilifDeath({ ...eilifBody, hitType: 'EnemyHit', attacker: long, biome: long });
  assert.equal(p.attacker.length, 48, 'attacker capped at 48');
  assert.equal(p.biome.length, 48, 'biome capped at 48');
  assert.ok(p.cause.length <= 48, `cause capped at 48 (got ${p.cause.length})`);

  // "the hand of <name>" must not smuggle the cause past the cap.
  const pvp = parseEilifDeath({ ...eilifBody, hitType: 'PlayerHit', attacker: 'B'.repeat(60) });
  assert.ok(pvp.cause.length <= 48, `PlayerHit cause capped too (got ${pvp.cause.length})`);
  assert.ok(pvp.cause.startsWith('the hand of '), 'and still reads as a PvP death');

  // Rich text is stripped, the words it wrapped are kept.
  assert.equal(humanizeKiller('<color=red>Serpent</color>'), 'Serpent', 'Unity/Discord tags stripped');
  assert.equal(humanizeKiller('<size=99><b>$enemy_troll</b>'), 'Troll', 'tags stripped before the token lookup');
  // Control characters (a newline that would break a Discord line, a NUL, an
  // ANSI escape that would colour the ops logs) go too.
  assert.equal(humanizeKiller('Sea\nSerpent'), 'Sea Serpent', 'newline folded to a space');
  assert.equal(humanizeKiller('Neck\u0000'), 'Neck', 'a trailing NUL is dropped');
  assert.equal(humanizeKiller('Sea\u0007Serpent'), 'Sea Serpent', 'a bell byte folds to a space');
  assert.equal(humanizeKiller('<b></b>'), null, 'nothing legible left → treated as a missing field');
  assert.equal(humanizeKiller('   '), null);

  // The gs deathEvents path gets the same treatment (same producer risk).
  const db = makeDb(freshState(), 'rpc');
  await ingestDeathEvents(
    db,
    [{ playerName: 'Testman', killer: `<color=red>${'C'.repeat(200)}</color>`, biome: 'Meadows'.padEnd(300, 'x'), tsUtc: gsTs }],
    'Testman',
  );
  const row = deaths(db)[0];
  assert.ok(row.metadata.cause.length <= 48, 'gs cause capped');
  assert.ok(row.metadata.killer.length <= 48, 'the raw gs killer is capped too');
  assert.ok(row.metadata.biome.length <= 48, 'gs biome capped');
  assert.ok(!/[<>]/.test(row.metadata.cause), 'no rich-text markup survives');
}

// ── 16. `reporter`: a death report may only be filed by the character it is about
//
// THE HOLE THIS CLOSES (audit security-2). Client payloads carry no secret — they
// run on players' PCs — so before EilifCompanionClient 0.3.1 the only thing tying
// a death report to its sender was a presence check on the VICTIM's name. Anyone
// who could reach /api/gs-ingest could therefore post a death, with
// attacker-written cause text, for any viking who happened to be online: it lands
// in #server via the relay, in How We Die, in the Saga and in that viking's death
// log, and Eilif speaks the cause aloud in game.
//
// 0.3.1 sends `reporter` = the local player's own character name. Three cases,
// and all three have to keep holding: present-and-matching (the honest client),
// present-and-mismatched (refused outright, nothing written), and absent (a
// ≤0.3.0 client — pack v11 still pins 0.2.0, so refusing these would silently
// drop every real death until the pack is re-minted).
{
  // (a) PRESENT AND MATCHING — the only shape an honest 0.3.1 client sends.
  const withReporter = { ...eilifBody, reporter: 'Testman' };
  assert.equal(parseEilifDeath(withReporter).reporter, 'Testman', 'reporter parsed');

  const db = makeDb(freshState(), 'rpc');
  const ok = await ingestEilifDeath(db, withReporter);
  assert.equal(ok.status, 'inserted', 'a self-reported death is ingested exactly as before');
  assert.equal(ok.cause, 'burning');
  assert.equal(deaths(db).length, 1, 'one death row');

  // Same viking, different spelling: identityKey folds case and whitespace, the
  // same rule the rest of the ingest uses for "are these two strings one viking".
  // A skew of case here must never cost somebody a real death.
  const folded = makeDb(freshState(), 'rpc');
  const okFolded = await ingestEilifDeath(folded, { ...eilifBody, reporter: '  testman ' });
  assert.equal(okFolded.status, 'inserted', 'case/whitespace skew is still the same viking');
  assert.equal(deaths(folded).length, 1);

  // (b) PRESENT AND MISMATCHED — refused, and nothing at all is written.
  const forge = makeDb(freshState(), 'rpc');
  const bad = await ingestEilifDeath(forge, { ...eilifBody, reporter: 'Griefer' });
  assert.equal(bad.ok, false, 'a death filed for somebody else is refused');
  assert.equal(bad.status, 'ignored');
  assert.equal(bad.reason, 'reporter mismatch');
  assert.equal(deaths(forge).length, 0, 'and NOTHING is written — not even an upgrade');

  // The refusal must not be dodgeable by dressing the name up: sanitizeClientText
  // strips the markup first, so this is still plainly not "Testman".
  const dressed = makeDb(freshState(), 'rpc');
  const bad2 = await ingestEilifDeath(dressed, { ...eilifBody, reporter: '<color=red>Griefer</color>' });
  assert.equal(bad2.reason, 'reporter mismatch', 'rich text does not smuggle a mismatch past the check');
  assert.equal(deaths(dressed).length, 0);

  // Nor by making the victim the odd one out: the pair has to agree either way.
  const swapped = makeDb(freshState(), 'rpc');
  const bad3 = await ingestEilifDeath(swapped, { ...eilifBody, player: 'Someone Else', reporter: 'Testman' });
  assert.equal(bad3.reason, 'reporter mismatch', 'the rule is symmetric — the two names must agree');
  assert.equal(deaths(swapped).length, 0);

  // (c) ABSENT (client <=0.3.0) — parsed as null and ingested exactly as today.
  assert.equal(parseEilifDeath(eilifBody).reporter, null, 'no reporter -> null, not a mismatch');
  const legacy = makeDb(freshState(), 'rpc');
  const okLegacy = await ingestEilifDeath(legacy, eilifBody);
  assert.equal(okLegacy.status, 'inserted', 'an older client is not broken by the new field');
  assert.equal(deaths(legacy).length, 1);

  // Junk that sanitizes away to nothing is treated as ABSENT, not as a mismatch:
  // it is no claim of identity at all, and the presence cross-check upstream still
  // has to pass, so this is no weaker than the pre-0.3.1 path it falls back to.
  assert.equal(parseEilifDeath({ ...eilifBody, reporter: '<b></b>' }).reporter, null);
  assert.equal(parseEilifDeath({ ...eilifBody, reporter: 42 }).reporter, null, 'a non-string is not a reporter');

  // Same capping as every other client-supplied name (32, not the 48 used for
  // free text) — a reporter name also reaches the ops logs.
  const long = parseEilifDeath({ ...eilifBody, reporter: 'R'.repeat(200) });
  assert.equal(long.reporter.length, 32, 'reporter capped at CLIENT_NAME_MAX');
  assert.equal(long.player, 'Testman', 'and the victim is untouched by it');

  // …and that cap must not, by itself, invent a mismatch. Only `reporter` goes
  // through it at parse time, so a name long enough to be truncated would
  // otherwise stop matching the untruncated `player` and cost a real viking a
  // real death. Valheim's own name limit is far below 32, so this is a guard
  // rail — but a launch-night false rejection is exactly the thing worth one.
  const bigName = 'V'.repeat(40);
  const big = makeDb(freshState(), 'rpc');
  const okBig = await ingestEilifDeath(big, { ...eilifBody, player: bigName, reporter: bigName });
  assert.notEqual(okBig.reason, 'reporter mismatch', 'a truncating-length name is still self-reported');
}

console.log(`OK — eilif-death: all ${HIT_TYPES.length} HitTypes phrase cleanly, both dedupe orders collapse to one row (atomic rpc AND fallback), simultaneous reports collapse too, and a death can only be reported by the viking it happened to`);
