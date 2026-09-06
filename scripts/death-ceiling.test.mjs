// The per-character death ceiling, and the word it comes back as.
//
// WHAT THIS IS ABOUT. db/2026-09-06_death_ceiling.sql refuses a death report when
// a character already has 5 deaths inside a two-minute span. It used to signal
// that refusal with 'ignored' — the same word ingest_death already used for "no
// players row yet", which is a completely different situation: that one SELF-HEALS
// the moment the poller's join path creates the row, while a ceiling refusal means
// the death is gone for good. So lib/deaths.ts logged every ceiling refusal as
// "no players row yet" on the eilif path, and on the gs batch path logged nothing
// at all. On launch night that is the difference between "a viking is dying oddly
// fast" and "someone is forging reports at the unauthenticated client URL", and
// neither was visible in the log an operator actually watches (T-3 audit site-3).
//
// The ceiling now returns 'capped'. These checks pin all three halves of that:
// the word travels through callIngestDeath, 'ignored' keeps its old meaning, and
// BOTH paths write a warning naming the character and how many reports were
// refused.
//
// The stub below models ingest_death the way the SQL is written, ceiling included,
// so a change to the migration that this file does not follow shows up as a red
// line rather than as silence.
//
//   npx tsx scripts/death-ceiling.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ingestEilifDeath, ingestDeathEvents } from '../lib/deaths.ts';

let checks = 0;
const ok = (label, cond, detail = '') => {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok   ${label}`);
};

// ── 0. the migration really does return 'capped' ─────────────────────────────
// The stub below is only worth trusting if it matches the SQL, and the SQL is the
// half this repo cannot execute. Read it.
const sql = readFileSync(new URL('../db/2026-09-06_death_ceiling.sql', import.meta.url), 'utf8');
ok('the ceiling returns \'capped\' on both modes', (sql.match(/return 'capped';/g) ?? []).length === 2,
  `${(sql.match(/return 'capped';/g) ?? []).length} occurrences`);
ok('no ceiling branch still returns \'ignored\'',
  !/report ignored'[\s\S]{0,80}return 'ignored';/.test(sql));
ok('the header records the re-apply (needed, or done with a date)', /(NEEDS RE-APPLYING|RE-APPLIED to production)/.test(sql));
ok('the function comment advertises capped', /inserted\|upgraded\|dropped\|duplicate\|capped\|ignored/.test(sql));

// ── the stub ─────────────────────────────────────────────────────────────────

const CEILING = 5;
const CEILING_WINDOW_MS = 60_000;

/** Mirrors db/2026-09-06_death_ceiling.sql closely enough for the outcome words. */
function makeDb({ players = [], events = [] } = {}) {
  const state = { players: [...players], events: [...events] };
  const near = (name, atMs) =>
    state.events.filter(
      (e) =>
        e.type === 'death' &&
        e.character_name === name &&
        Math.abs(Date.parse(e.created_at) - atMs) <= CEILING_WINDOW_MS,
    ).length;

  return {
    state,
    async rpc(fn, args) {
      assert.equal(fn, 'ingest_death');
      const { p_name, p_player_id, p_at, p_metadata } = args;
      const at = Date.parse(p_at);
      // Replay idempotency, then the two gates the app-side branches care about.
      const key = p_metadata?.eilifDeathId ?? p_metadata?.gsDeathId ?? null;
      if (key && state.events.some((e) => (e.metadata?.eilifDeathId ?? e.metadata?.gsDeathId) === key)) {
        return { data: 'duplicate', error: null };
      }
      if (!p_player_id) return { data: 'ignored', error: null };
      if (near(p_name, at) >= CEILING) return { data: 'capped', error: null };
      state.events.push({
        id: `e${state.events.length}`,
        type: 'death',
        player_id: p_player_id,
        character_name: p_name,
        metadata: p_metadata ?? {},
        created_at: p_at,
      });
      return { data: 'inserted', error: null };
    },
    from(table) {
      state[table] ??= [];
      const b = {
        _rows: () => state[table],
        _preds: [],
        select() { return b; },
        eq(col, val) { b._preds.push((r) => r[col] === val); return b; },
        in(col, vals) { b._preds.push((r) => vals.includes(r[col])); return b; },
        gte() { return b; },
        lte() { return b; },
        is() { return b; },
        order() { return b; },
        limit() { return b; },
        then(resolve, reject) {
          const rows = b._rows().filter((r) => b._preds.every((p) => p(r)));
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
        insert() { return Promise.resolve({ data: null, error: null }); },
        update() { return b; },
        delete() { return b; },
      };
      return b;
    },
  };
}

/** Capture console.warn for one awaited call. */
async function capturingWarns(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = real;
  }
}

// Deliberately a moment in the RECENT PAST, not a launch-night literal: lib/
// event-time.ts clamps any future-dated report to now, which would move the
// reported time out of the window these fixtures build around and quietly turn
// every capped case into an insert.
const NOW = new Date(Date.now() - 30_000).toISOString();
const PLAYER = { id: 'p1', character_name: 'Sigrún' };

/** Five deaths already inside the window, so the sixth is the one that is capped. */
function fullWindow(name = PLAYER.character_name) {
  return Array.from({ length: CEILING }, (_, i) => ({
    id: `pre${i}`,
    type: 'death',
    player_id: PLAYER.id,
    character_name: name,
    metadata: {},
    created_at: new Date(Date.parse(NOW) - i * 1000).toISOString(),
  }));
}

// ── 1. the eilif path ────────────────────────────────────────────────────────

{
  const db = makeDb({ players: [PLAYER], events: fullWindow() });
  const { result, lines } = await capturingWarns(() =>
    ingestEilifDeath(db, {
      source: 'eilif-death',
      player: PLAYER.character_name,
      reporter: PLAYER.character_name,
      tsUtc: NOW,
      hitType: 'EnemyHit',
      eilifDeathId: 'cap-1',
    }),
  );
  ok('eilif: a ceiling refusal comes back as \'capped\'', result.status === 'capped', `status=${result.status}`);
  ok('eilif: it is not reported as ok', result.ok === false);
  ok('eilif: the reason names the ceiling, not a missing players row',
    /ceiling/i.test(result.reason ?? '') && !/players row/i.test(result.reason ?? ''), result.reason);
  const warn = lines.find((l) => /CAPPED/.test(l));
  ok('eilif: a warning is logged', Boolean(warn), lines.join(' | ') || 'no console.warn at all');
  ok('eilif: the warning names the character', warn.includes(PLAYER.character_name), warn);
  ok('eilif: the warning carries the count', /\b1 report\b/.test(warn), warn);
  ok('eilif: the warning says the death was not stored', /NOT stored/.test(warn), warn);
  ok('eilif: nothing was written', db.state.events.length === CEILING, `${db.state.events.length} rows`);
}

// ── 2. 'ignored' keeps its old meaning ───────────────────────────────────────

{
  // No players row at all: the rpc returns 'ignored', which self-heals once the
  // poller's join path creates one. This must NOT warn and must NOT say capped.
  const db = makeDb({ players: [], events: [] });
  const { result, lines } = await capturingWarns(() =>
    ingestEilifDeath(db, {
      source: 'eilif-death',
      player: 'Haki',
      reporter: 'Haki',
      tsUtc: NOW,
      hitType: 'Fall',
      eilifDeathId: 'ign-1',
    }),
  );
  ok('ignored still means \'no players row yet\'',
    result.status === 'ignored' && result.reason === 'no players row yet', `${result.status}/${result.reason}`);
  ok('ignored does not log the ceiling warning', !lines.some((l) => /CAPPED/.test(l)), lines.join(' | '));
}

// ── 3. the gs batch path ─────────────────────────────────────────────────────
//
// The regression this half is about: before the fix the batch loop had branches
// for 'inserted' and 'dropped' only, so a capped report produced NO log line
// anywhere. Three refusals for one character must produce exactly one warning
// carrying the count 3.

{
  const db = makeDb({ players: [PLAYER], events: fullWindow() });
  const deaths = [0, 1, 2].map((i) => ({
    playerName: PLAYER.character_name,
    tsUtc: new Date(Date.parse(NOW) + (i + 1) * 1000).toISOString(),
    hitType: 'EnemyHit',
  }));
  const { lines } = await capturingWarns(() => ingestDeathEvents(db, deaths, PLAYER.character_name));
  const warns = lines.filter((l) => /CAPPED/.test(l));
  ok('gs: the batch path logs the refusal at all', warns.length >= 1, lines.join(' | ') || 'silent');
  ok('gs: one line per character, not one per death', warns.length === 1, `${warns.length} lines`);
  ok('gs: the line names the character', warns[0].includes(PLAYER.character_name), warns[0]);
  ok('gs: the line carries the count', /\b3 reports\b/.test(warns[0]), warns[0]);
  ok('gs: it says which producer', /^\[deaths\] gs /.test(warns[0]), warns[0]);
  ok('gs: nothing was written', db.state.events.length === CEILING, `${db.state.events.length} rows`);
}

// ── 4. a normal death is untouched by any of this ────────────────────────────

{
  const db = makeDb({ players: [PLAYER], events: [] });
  const { result, lines } = await capturingWarns(() =>
    ingestEilifDeath(db, {
      source: 'eilif-death',
      player: PLAYER.character_name,
      reporter: PLAYER.character_name,
      tsUtc: NOW,
      hitType: 'Drowning',
      eilifDeathId: 'fine-1',
    }),
  );
  ok('an honest death still inserts', result.ok === true && result.status === 'inserted', result.status);
  ok('an honest death logs no ceiling warning', !lines.some((l) => /CAPPED/.test(l)), lines.join(' | '));
  ok('an honest death is stored', db.state.events.length === 1);
}

console.log(`\nOK — death ceiling: ${checks} checks. 'capped' is its own outcome on both producer paths, ` +
  `each refusal is warned once per character with the count, and 'ignored' still means "no players row yet".`);
