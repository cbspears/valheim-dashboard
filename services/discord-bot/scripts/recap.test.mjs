// Unit tests for the daily recap's death accounting: the 10 s collapse that
// folds one death reported by BOTH producers into one fall, and the boards it
// feeds (the death total, the Fallen board, and the POTY 'The Bold' crown).
//
// The bug behind it: the 2026-09-01 recap reported 7 deaths for 4 real ones,
// because the gs mod report and the eilif death report both land in `events`.
// The line these tests defend is the 10 s width itself — a corpse run that ends
// in a second death a minute later is a REAL second death and must still count.
//
// Run:
//   node scripts/recap.test.mjs   (from services/discord-bot)
import assert from 'node:assert';
import { createRecap, collapseDeathRows, selectPlayerOfDay, appendDayDeltas } from '../src/recap.js';
import { POTY_TEMPLATES, formatRecap } from '../src/format.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); passed++; };

const T0 = Date.parse('2026-09-09T20:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const death = (name, offsetMs, cause) => ({
  character_name: name,
  created_at: at(offsetMs),
  metadata: cause ? { cause } : {},
});
const names = (rows) => rows.map((r) => r.character_name).sort();

// ── collapseDeathRows: the window itself ────────────────────────────────────
{
  eq(collapseDeathRows([]).length, 0, 'no deaths collapse to nothing');
  eq(collapseDeathRows(null).length, 0, 'a null read is tolerated (the query can fail soft)');
  eq(collapseDeathRows(undefined).length, 0, 'so is an undefined one');

  const twins = [death('Loa', 0, 'Greydwarf'), death('Loa', 400, 'Greydwarf')];
  eq(collapseDeathRows(twins).length, 1, 'two reports 0.4 s apart are ONE death');

  eq(collapseDeathRows([death('Loa', 0), death('Loa', 9_999)]).length, 1,
    'just inside 10 s still collapses');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 10_000)]).length, 1,
    'exactly 10 s is inside the window');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 10_001)]).length, 2,
    'one millisecond past 10 s is a second death');

  // The rule that must never be widened.
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 60_000)]).length, 2,
    'a corpse-run double 60 s apart stays TWO deaths');
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 30_000)]).length, 2,
    'and 30 s apart stays two');

  // Anchored on the kept row, exactly like relay.js: a burst cannot chain into
  // a window wider than 10 s.
  eq(collapseDeathRows([death('Loa', 0), death('Loa', 8_000), death('Loa', 16_000)]).length, 2,
    'a 0/8/16 s burst is two deaths, not one - the window never chains');

  eq(collapseDeathRows([death('Loa', 0), death('Bjorn', 400)]).length, 2,
    'two vikings dying together are two deaths, never collapsed into one');

  const unsorted = [death('Loa', 900), death('Loa', 0), death('Loa', 400)];
  eq(collapseDeathRows(unsorted).length, 1,
    'rows arrive in PostgREST order, so they are sorted before folding');
}

// ── collapseDeathRows: rows it must not touch ───────────────────────────────
{
  const unnamed = [{ character_name: '', created_at: at(0), metadata: {} }];
  eq(collapseDeathRows(unnamed).length, 1, 'an unnamed row is passed through untouched');
  const undated = [{ character_name: 'Loa', created_at: 'not a date', metadata: {} }];
  eq(collapseDeathRows(undated).length, 1, 'so is a row with an unparseable timestamp');
  const mixed = collapseDeathRows([
    { character_name: null, created_at: at(0), metadata: {} },
    death('Loa', 0),
    death('Loa', 500),
  ]);
  eq(mixed.length, 2, 'un-keyable rows survive alongside the collapsed ones');
  ok(names(mixed).includes('Loa'), 'and the kept death is still there');
}

// ── collapseDeathRows: the cause survives the fold ──────────────────────────
{
  // Only the gs report knows what killed you; the log-poller row has no cause.
  const pollerFirst = collapseDeathRows([death('Loa', 0), death('Loa', 300, 'Troll')]);
  eq(pollerFirst.length, 1, 'the pair is one death');
  eq(pollerFirst[0].metadata.cause, 'Troll',
    'a cause on the folded row is carried onto the kept one');

  const gsFirst = collapseDeathRows([death('Loa', 0, 'Troll'), death('Loa', 300)]);
  eq(gsFirst[0].metadata.cause, 'Troll', 'a cause already on the kept row is preserved');

  const both = collapseDeathRows([death('Loa', 0, 'Troll'), death('Loa', 300, 'Greydwarf')]);
  eq(both[0].metadata.cause, 'Troll', 'the kept row wins when both name a cause');

  const source = death('Loa', 0);
  collapseDeathRows([source, death('Loa', 300, 'Troll')]);
  eq(source.metadata.cause, undefined, 'the input rows are never mutated');
}

// ── buildStats: the boards the collapse feeds ───────────────────────────────
// A fake supabase client that serves one canned table set (same chainable shape
// as scripts/milestones.test.mjs).
function fakeDb(tables) {
  return {
    from(table) {
      const q = {};
      const chain = () => (...args) => { void args; return q; };
      for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'is', 'not', 'or', 'order', 'limit']) {
        q[m] = chain();
      }
      q.maybeSingle = () => Promise.resolve({ data: tables[table]?.[0] ?? null, error: null });
      q.single = q.maybeSingle;
      q.then = (onOk, onErr) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(onOk, onErr);
      return q;
    },
  };
}

function harness(deathRows) {
  const nowIso = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  return createRecap({
    db: fakeDb({
      // One closed session each so both vikings count as active (and so the
      // Unsung Hero cadence has a pool), inside the trailing 24 h window.
      sessions: [
        { character_name: 'Loa', joined_at: hourAgo, left_at: nowIso },
        { character_name: 'Bjorn', joined_at: hourAgo, left_at: nowIso },
      ],
      events: deathRows,
      bosses: [],
      players: [],
      player_stats: [],
      server_status: [{ player_count: 0, world_day: 12 }],
    }),
    post: async () => {},
    state: {},
    saveState: async () => {},
  });
}

{
  // Four real falls, each reported twice within 10 s: the exact 2026-09-01 shape.
  const doubled = [];
  for (const offset of [0, 120_000, 240_000, 360_000]) {
    doubled.push(death('Loa', offset, 'Greydwarf'), death('Loa', offset + 350, 'Greydwarf'));
  }
  const stats = await harness(doubled).buildStats('evening');
  eq(stats.deaths, 4, 'eight rows for four falls report FOUR deaths');
  eq(stats.fallenToday.length, 1, 'one viking on the Fallen board');
  eq(stats.fallenToday[0].count, 4, 'and the board shows her real count, not the doubled one');
}

{
  // 'The Bold' needs 3 deaths. Two real falls reported twice each used to look
  // like four and crown a viking who never earned it.
  const doubled = [
    death('Loa', 0, 'Troll'), death('Loa', 200, 'Troll'),
    death('Loa', 300_000, 'Troll'), death('Loa', 300_400, 'Troll'),
  ];
  const stats = await harness(doubled).buildStats('evening');
  eq(stats.deaths, 2, 'two real falls');
  eq(stats.poty, null, "'The Bold' is NOT crowned on a doubled tally of two");

  const real = [
    death('Loa', 0, 'Troll'),
    death('Loa', 300_000, 'Troll'),
    death('Loa', 600_000, 'Troll'),
  ];
  const earned = await harness(real).buildStats('evening');
  eq(earned.deaths, 3, 'three genuinely separate falls still count as three');
  eq(earned.poty?.key, 'bold', "and 'The Bold' is crowned when it is earned");
  eq(earned.poty?.fields.deaths, 3, 'the crown reports the collapsed count');
}

{
  // The collapse must not eat a corpse run: two deaths a minute apart are two.
  const corpseRun = [
    death('Loa', 0, 'Troll'),
    death('Loa', 60_000, 'Troll'),
    death('Loa', 120_000, 'Troll'),
  ];
  const stats = await harness(corpseRun).buildStats('evening');
  eq(stats.deaths, 3, 'a corpse run of three deaths a minute apart is still three');
}


// ═══════════════════════════════════════════════════════════════════════════
// PLAYER OF THE DAY — the notability draw (rewritten 2026-09-14)
//
// The old draw ranked a fixed priority list, so 💀 The Bold (3+ deaths) sat
// above every stat angle and the crown drifted to whoever died the most. The
// new draw scores every angle the same way — personal surprise × clan share,
// with a small activity nudge — and these are the properties that keeps.
// ═══════════════════════════════════════════════════════════════════════════

/** A ring buffer of `n` identical prior days, so `surprise` has a baseline. */
const priorDays = (n, byName) =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-09-0${i + 1}`, byName }));

// ── (a) deaths no longer win a routine night against a builds spike ─────────
{
  const crown = selectPlayerOfDay({
    hours: { Buildy: 2, Deadly: 2 },
    windowDeaths: { Deadly: 4 },
    buildsDelta: { Buildy: 400, Deadly: 20 },
    dayDeltas: priorDays(3, { Buildy: { builds: 80 }, Deadly: { deaths: 4 } }),
  });
  eq(crown?.key, 'builder', 'a 5x builds spike outranks a routine four-death night');
  eq(crown?.name, 'Buildy', 'and the crown goes to the builder');

  // The SAME deaths with nothing else happening still crown The Bold: the rule
  // is "not the default", not "never".
  const bold = selectPlayerOfDay({
    hours: { Deadly: 2 },
    windowDeaths: { Deadly: 4 },
    dayDeltas: priorDays(3, { Deadly: { deaths: 4 } }),
  });
  eq(bold?.key, 'bold', 'with no other story tonight, the death board is the story');

  // …and it never runs two nights in a row.
  const twiceRunning = selectPlayerOfDay({
    hours: { Deadly: 2 },
    windowDeaths: { Deadly: 4 },
    dayDeltas: priorDays(3, { Deadly: { deaths: 4 } }),
    history: [{ name: 'Deadly', key: 'bold' }],
  });
  eq(twiceRunning, null, 'The Bold never crowns two evenings running');

  // A tie on the death board is nobody's story.
  const tied = selectPlayerOfDay({
    hours: { Deadly: 2, Alsodead: 2 },
    windowDeaths: { Deadly: 4, Alsodead: 4 },
  });
  eq(tied, null, 'two vikings tied on deaths means neither owns the night');
}

// ── (b) personal surprise beats routine clan share ─────────────────────────
{
  const crown = selectPlayerOfDay({
    hours: { Spiker: 3, Routine: 3 },
    resourcesDelta: { Spiker: 450, Routine: 600 },
    dayDeltas: priorDays(4, {
      Spiker: { resources: 150 },   // 3x a normal day for them
      Routine: { resources: 600 },  // exactly a normal day
    }),
  });
  eq(crown?.name, 'Spiker', 'a 3x spike at 43% share beats a routine night at 57%');
  eq(crown?.key, 'woodcutter', 'on the angle that actually spiked');
  ok(crown.score > 0, 'the crown carries its score');
  ok(/surprise 3\.0x/.test(crown.why), `the why-line names the spike, got: ${crown.why}`);
  eq(crown.fields.surpriseX, 3, 'and the story fields carry it down to the blurb');
}

// ── (c) The Steadfast: a bottom-third regular, then a week of rest ──────────
{
  // Six ranked vikings; Yiz is dead last and has shown up 4 of 5 days. Rosir is
  // having a perfectly good building night, which The Steadfast outranks.
  const ctx = () => ({
    hours: { Yiz: 1, Rosir: 2 },
    buildsDelta: { Rosir: 400 },
    attendanceDays: { Yiz: 4, Rosir: 2 },
    progression: { Aki: 6, Bru: 5, Cadr: 4, Dagr: 3, Eir: 2, Yiz: 1 },
    dayDeltas: priorDays(3, { Rosir: { builds: 100 } }),
  });

  const crown = selectPlayerOfDay(ctx());
  eq(crown?.key, 'steadfast', 'perseverance outranks a routine stat win');
  eq(crown?.name, 'Yiz', 'and it finds the viking furthest behind who keeps showing up');
  eq(crown.fields.attendanceDays, 4, 'the blurb gets the attendance count');
  eq(crown.fields.progressRank, 6, 'and where they stand');
  eq(crown.fields.progressTotal, 6, 'out of how many');

  // It rests: same viking inside 7 nights, or ANY steadfast inside 3 nights.
  eq(selectPlayerOfDay({ ...ctx(), history: [{ name: 'Yiz', key: 'steadfast' }] })?.key, 'builder',
    'a steadfast crown last night blocks another one tonight');
  eq(selectPlayerOfDay({ ...ctx(), history: [{ name: 'Someone', key: 'steadfast' }] })?.key, 'builder',
    'and so does anyone else having won it inside three nights');
  const stale = Array.from({ length: 7 }, (_, i) => ({ name: 'X', key: i === 6 ? 'steadfast' : 'hunter' }));
  eq(selectPlayerOfDay({ ...ctx(), history: stale })?.key, 'steadfast',
    'once the rest is served it can fire again');

  // A viking who sat out this week is not steadfast, however far behind.
  eq(selectPlayerOfDay({ ...ctx(), attendanceDays: { Yiz: 2, Rosir: 2 } })?.key, 'builder',
    'showing up 2 of 5 days is not perseverance');
  // …nor is being at the TOP of the clan.
  eq(selectPlayerOfDay({ ...ctx(), progression: { Yiz: 9, Aki: 1, Bru: 1, Cadr: 1, Dagr: 1, Eir: 1 } })?.key,
    'builder', 'the clan leader is never The Steadfast');
}

// ── (d) rotation discounts read from poty_history ──────────────────────────
{
  const base = {
    hours: { Rosir: 2, Loa: 2 },
    buildsDelta: { Rosir: 400 },
    craftsDelta: { Loa: 40 },
    dayDeltas: priorDays(3, { Rosir: { builds: 100 }, Loa: { crafts: 20 } }),
  };
  eq(selectPlayerOfDay({ ...base })?.name, 'Rosir', 'on a clean slate the bigger spike wins');

  const rotated = selectPlayerOfDay({ ...base, history: [{ name: 'Rosir', key: 'builder' }] });
  eq(rotated?.name, 'Loa', 'last night\'s winner on last night\'s angle is discounted out of it');
  eq(rotated?.key, 'smith', 'and the crown moves to a different story');

  // The winner discount alone (0.5) is enough here; the angle discount is the
  // other half of the same rule, on a different viking.
  const sameAngle = selectPlayerOfDay({ ...base, history: [{ name: 'Someone', key: 'builder' }] });
  ok(sameAngle?.rot !== undefined || sameAngle?.name, 'a same-angle repeat still returns a crown');
  ok(/rot 0\.67/.test(selectPlayerOfDay({
    hours: { Rosir: 2 }, buildsDelta: { Rosir: 400 },
    dayDeltas: priorDays(3, { Rosir: { builds: 100 } }),
    history: [{ name: 'Someone', key: 'builder' }],
  }).why), 'the same angle two nights running is discounted 0.67');
}

// ── (e) an epic still headlines everything ─────────────────────────────────
{
  const crown = selectPlayerOfDay({
    hours: { Bosser: 2, Buildy: 2, Yiz: 1 },
    bossesPresent: { Bosser: 1 },
    latestBoss: { Bosser: { boss: 'Bonemass', biome: 'Swamp' } },
    buildsDelta: { Buildy: 4000 },
    attendanceDays: { Yiz: 5 },
    progression: { Aki: 6, Bru: 5, Cadr: 4, Dagr: 3, Eir: 2, Yiz: 1 },
    dayDeltas: priorDays(3, { Buildy: { builds: 60 } }),
    // Even a viking who won last night keeps an epic: epics skip rotation.
    history: [{ name: 'Bosser', key: 'boss_kill' }],
  });
  eq(crown?.key, 'boss_kill', 'a boss kill headlines over a spike AND over perseverance');
  eq(crown?.name, 'Bosser', 'and epics are exempt from the rotation discount');

  const biome = selectPlayerOfDay({
    hours: { Sailor: 2, Buildy: 2 },
    newBiomes: { Sailor: ['Mistlands'] },
    buildsDelta: { Buildy: 4000 },
    dayDeltas: priorDays(3, { Buildy: { builds: 60 } }),
  });
  eq(biome?.key, 'most_explored', 'so is a biome no clansman had walked');
  eq(biome?.fields.newBiome, 'Mistlands', 'and the blurb is told which one');

  // Fog peeled off the map is the SAME crown but NOT epic: it rotates.
  const fog = selectPlayerOfDay({
    hours: { Sailor: 2 },
    mapDelta: { Sailor: 0.9 },
    dayDeltas: priorDays(3, { Sailor: { map: 0.2 } }),
  });
  eq(fog?.key, 'most_explored', 'a big map delta is a Trailblazer night too');
  ok(fog.fields.mapDelta >= 0.4, 'and the blurb can say how much of the world');
  eq(selectPlayerOfDay({
    hours: { Sailor: 2 }, mapDelta: { Sailor: 0.3 },
    dayDeltas: priorDays(3, { Sailor: { map: 0.05 } }),
  }), null, 'below the 0.4 pct floor it is not a story at all');
}

// ── (f) the 20-minute activity gate ────────────────────────────────────────
{
  const tooQuick = selectPlayerOfDay({
    hours: { Blip: 0.2 },
    buildsDelta: { Blip: 5000 },
    dayDeltas: priorDays(3, { Blip: { builds: 10 } }),
  });
  eq(tooQuick, null, 'twelve minutes on the world earns no crown, whatever the counters say');

  const enough = selectPlayerOfDay({
    hours: { Blip: 0.4 },
    buildsDelta: { Blip: 5000 },
    dayDeltas: priorDays(3, { Blip: { builds: 10 } }),
  });
  eq(enough?.name, 'Blip', 'twenty-four minutes clears the gate');

  // The gate also keeps a no-show off the clan-share denominator.
  const shared = selectPlayerOfDay({
    hours: { Blip: 1, Ghost: 0.05 },
    buildsDelta: { Blip: 300, Ghost: 300 },
  });
  eq(shared?.name, 'Blip', 'and a viking who never logged in cannot dilute the share');
  eq(shared?.fields.clanShare, 1, 'the share is computed over the eligible only');
}

// ── (g) every new blurb renders, with and without the story fields ─────────
{
  const renderPoty = (key, fields, seed) =>
    formatRecap({
      period: 'evening', playersActive: 3, hoursPlayed: 9, deaths: 5, bossKills: [],
      onlineNow: 2, worldDay: 30, quiet: false, onlineToday: [], fallenToday: [],
      poty: { key, label: 'L', name: 'Steve', fields, seed },
    }).embeds[0].fields.find((f) => f.name.startsWith('🏆')).value;

  // [ full story fields, only the always-present number ] for each new angle.
  const CASES = {
    builder: [{ builds: 412, surpriseX: 5.1, clanShare: 0.34, hours: 3.2 }, { builds: 412 }],
    woodcutter: [{ resources: 900, surpriseX: 2.2, clanShare: 0.52 }, { resources: 900 }],
    smith: [{ items: 70, surpriseX: 3.4, clanShare: 0.61 }, { items: 70 }],
    wayfarer: [{ distance: 6300, sail: 2100, surpriseX: 1.9, clanShare: 0.29 }, { distance: 6300 }],
    angler: [{ fish: 4, surpriseX: 4, clanShare: 0.8 }, { fish: 4 }],
    hunter: [{ kills: 60, surpriseX: 2.7, clanShare: 0.41 }, { kills: 60 }],
    ironhide: [{ hours: 4.5, kills: 22, surpriseX: 2 }, { hours: 4.5 }],
    steadfast: [{ attendanceDays: 4, hours: 1.5, progressRank: 9, progressTotal: 11 }, { attendanceDays: 4 }],
    bold: [{ deaths: 5, cause: 'Tree', clanShare: 0.55 }, { deaths: 5 }],
  };

  for (const [key, variants] of Object.entries(CASES)) {
    const pool = POTY_TEMPLATES[key];
    ok(Array.isArray(pool) && pool.length >= 3, `${key}: has a blurb pool`);
    for (const fields of variants) {
      for (let seed = 0; seed < pool.length * 3; seed++) {
        const v = renderPoty(key, fields, seed);
        ok(!/[{}]/.test(v), `${key}: an unfilled token reached the recap, got: ${v}`);
        ok(!/undefined|NaN/.test(v), `${key}: no internals in a blurb, got: ${v}`);
        ok(!/\s{2}/.test(v) && !/\s[.,]/.test(v), `${key}: no hole where a value should be, got: ${v}`);
        ok(v.trim().endsWith('.'), `${key}: a blurb closes its sentence, got: ${v}`);
      }
    }
  }

  // The number is the point: every angle's blurb says it out loud.
  const says = (key, fields, needle) => {
    const hits = Array.from({ length: POTY_TEMPLATES[key].length * 3 }, (_, s) => renderPoty(key, fields, s));
    ok(hits.every((v) => v.includes(needle)), `${key}: every blurb names the number (${needle})`);
  };
  says('builder', { builds: 412 }, '412');
  says('wayfarer', { distance: 6300 }, '6.3 km');
  says('angler', { fish: 4 }, '4 fish');
  says('steadfast', { attendanceDays: 4 }, '4 of the last 5 days');

  // And the story tokens actually reach the page when they are notable. The
  // template index is (hash(name) + seed) % pool, so walk the seeds.
  const anyBlurb = (key, fields, re) =>
    Array.from({ length: POTY_TEMPLATES[key].length * 2 }, (_, s) => renderPoty(key, fields, s))
      .some((v) => re.test(v));
  const STORY = { builds: 412, surpriseX: 5.1, clanShare: 0.34 };
  ok(anyBlurb('builder', STORY, /5x a normal night/), 'the spike multiple reaches the blurb');
  ok(anyBlurb('builder', STORY, /a third of everything the clan built/), 'so does the clan share');
  ok(anyBlurb('steadfast', { attendanceDays: 4, hours: 1.5, progressRank: 9, progressTotal: 11 },
    /9th of 11 in the clan's reckoning/), 'and The Steadfast says where they stand');

  // …and NEVER when they are not notable: recap.js leaves the field undefined
  // below its story threshold, so no blurb can ever read "1.0x a normal night".
  ok(!anyBlurb('builder', { builds: 412 }, /x a normal night/),
    'a routine night never claims to be a spike');
}

// ── (h) the dayDeltas ring buffer: evening only, capped at 7 ───────────────
{
  let list = [];
  for (let i = 1; i <= 10; i++) {
    list = appendDayDeltas(list, { date: `2026-09-${String(i).padStart(2, '0')}`, byName: { Loa: { builds: i } } });
  }
  eq(list.length, 7, 'the ring buffer caps at seven days');
  eq(list[0].date, '2026-09-04', 'and drops the oldest first');
  eq(list[6].date, '2026-09-10', 'keeping tonight');

  // Re-running one evening replaces its entry instead of double-counting it.
  const twice = appendDayDeltas(list, { date: '2026-09-10', byName: { Loa: { builds: 99 } } });
  eq(twice.length, 7, 're-running an evening does not grow the buffer');
  eq(twice[6].byName.Loa.builds, 99, 'it replaces that day');
  eq(appendDayDeltas(null, null).length, 0, 'a missing buffer and a missing entry are tolerated');

  // …and only the EVENING recap appends at all.
  const state = {};
  const rec = () => createRecap({
    db: fakeDb({
      sessions: [{ character_name: 'Loa', joined_at: new Date(Date.now() - 3600_000).toISOString(), left_at: new Date().toISOString() }],
      events: [], bosses: [], players: [], player_stats: [],
      server_status: [{ player_count: 0, world_day: 12 }],
    }),
    post: async () => {}, state, saveState: async () => {},
  });
  await rec().postRecap('morning');
  eq(state.dayDeltas, undefined, 'a morning render never touches the personal baseline');
  await rec().postRecap('evening');
  eq(state.dayDeltas?.length, 1, 'the evening recap appends exactly one day');
  ok(state.dayDeltas[0].byName.Loa, 'with tonight\'s per-viking deltas in it');
  await rec().postRecap('evening');
  eq(state.dayDeltas?.length, 1, 'and a second run of the same evening replaces it');
}

// ── the operator line the crown carries (never posted) ─────────────────────
{
  const crown = selectPlayerOfDay({
    hours: { Rosir: 3 },
    buildsDelta: { Rosir: 400 },
    dayDeltas: priorDays(3, { Rosir: { builds: 100 } }),
  });
  ok(/^builder, surprise \d+\.\dx, share \d\.\d\d, rot \d\.\d\d$/.test(crown.why),
    `the why-line is one operator-readable line, got: ${crown.why}`);
}

console.log(`recap.test: ${passed} assertions passed`);
