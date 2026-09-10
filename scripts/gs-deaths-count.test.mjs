// VALHEIM 1.0 STOPGAP — the deaths-from-events fallback (lib/deaths.ts
// countDeathEvents), which /api/gs-ingest uses to fill player_stats.deaths while
// GsValheimStatsClient 0.2.12 cannot read the 1.0 profile counters.
//
// Run: npx tsx scripts/gs-deaths-count.test.mjs
import assert from 'node:assert';
import { countDeathEvents } from '../lib/deaths.ts';

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/** Minimal supabase stub: only the shape countDeathEvents actually uses. */
function makeDb(rows, { error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const preds = [];
      const b = {
        select(_cols, opts) {
          calls.push({ table, opts });
          return b;
        },
        eq(col, val) {
          preds.push((r) => r[col] === val);
          return b;
        },
        ilike(col, val) {
          const folded = String(val).toLowerCase();
          preds.push((r) => String(r[col] ?? '').toLowerCase() === folded);
          return b;
        },
        then(resolve, reject) {
          if (error) return Promise.resolve({ count: null, error }).then(resolve, reject);
          const matched = rows.filter((r) => preds.every((p) => p(r)));
          return Promise.resolve({ count: matched.length, data: null, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

const EVENTS = [
  { type: 'death', character_name: 'Rosir' },
  { type: 'death', character_name: 'Rosir' },
  { type: 'death', character_name: 'rosir' }, // case skew from another producer
  { type: 'death', character_name: 'Kaetiloy' },
  { type: 'join', character_name: 'Rosir' }, // not a death
];

{
  const db = makeDb(EVENTS);
  const n = await countDeathEvents(db, 'Rosir');
  ok(n === 3, `counts every death row for the viking, case-insensitively (got ${n})`);
  const head = db.calls[0]?.opts;
  ok(head?.count === 'exact' && head?.head === true, 'asks Postgres for a HEAD count, never for the rows');
}

{
  const n = await countDeathEvents(makeDb(EVENTS), 'Kaetiloy');
  ok(n === 1, `one death is one death (got ${n})`);
}

{
  const n = await countDeathEvents(makeDb(EVENTS), 'Bjorn');
  ok(n === 0, 'a viking with no death rows counts 0, not null — GREATEST leaves the column alone');
}

{
  // A failed read must NEVER read as "zero deaths": the caller leaves the column
  // untouched on null, and a 0 would be indistinguishable from a real count.
  const n = await countDeathEvents(makeDb(EVENTS, { error: { message: 'statement timeout' } }), 'Rosir');
  ok(n === null, 'a failed count is null, not 0');
}

{
  const n = await countDeathEvents(makeDb(EVENTS), '   ');
  ok(n === null, 'a blank name never counts anybody');
}

console.log(`OK — deaths-from-events fallback: ${checks} checks passed`);
