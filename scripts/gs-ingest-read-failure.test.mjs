// A FAILED READ MUST NEVER LOOK LIKE AN EMPTY ONE — app/api/gs-ingest.
//
// THE INCIDENT THIS FILE EXISTS FOR (2026-09-13). Supabase REST 504s on roughly
// 0.3 % of requests all day (75 GETs on `players` and 37 on `player_stats` in
// one 24 h window). supabase-js reports every one of those as
// `{ data: null, error }` — which, at a `const { data } = await …` destructure,
// is byte-identical to "there is no such row". The route destructured only
// `data` at five reads, so a 504 on the `player_stats` read inside
// ingestPlayerStats produced `prev = null`, and from there:
//
//   applyBaseline saw no stored zero-point  → change === 'capture'
//     → the baseline was RE-TAKEN at the character's LIFETIME totals
//   mergeIntoRow(prev = null, …) had nothing to GREATEST against
//     → every column was overwritten with the (now tiny) effective values
//
// Three vikings lost their boards overnight. Yunter's zero-point ended up
// holding 132 kills while his column read 8.
//
// THE RULE NOW. Any read a WRITE depends on fails closed: it is logged, the
// request answers 503 `{ error: 'database read failed, retry' }`, and NOTHING is
// written. Nothing is lost by refusing — every producer here re-posts a
// CUMULATIVE snapshot on its next ~120 s cycle — whereas guessing costs a
// leaderboard. A genuine EMPTY result keeps its old meaning throughout: no
// players row for a reporter is still a quiet 200 skip, and a first-ever
// snapshot still captures its zero-point.
//
// HOW THIS RUNS. Same rig as scripts/client-map.test.mjs: the real POST handler
// driven with real Request objects, against a throwaway local HTTP server
// speaking just enough PostgREST — which can be told to answer any one query
// with a 504, exactly as production does.
//
// Run: npx tsx scripts/gs-ingest-read-failure.test.mjs
import assert from 'node:assert';
import http from 'node:http';

// ── A throwaway PostgREST that can be made to time out ───────────────────────
const requests = [];

/** Rows the stub hands back for the happy path. */
let playersRows = [{ id: 'yunter-1' }];
let statsRows = []; // no row yet — the legitimate "capture" case

/**
 * Which single query 504s. `{ table, match }` — `match` inspects the query
 * string, so the two DIFFERENT GETs this path makes on `player_stats` (the
 * log-only weapon-collision scan, `player_id=neq.…`, and the read that decides
 * the merge, `player_id=eq.…`) can be failed independently.
 */
let fail = null;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const table = url.pathname.replace('/rest/v1/', '');
    requests.push({ method: req.method, table, query: url.searchParams, body });

    if (fail && fail.table === table && (!fail.match || fail.match(url.searchParams, req.method))) {
      // What a Supabase gateway timeout actually looks like on the wire.
      res.writeHead(504, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'canceling statement due to statement timeout', code: '57014' }));
    }

    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && table === 'events') {
      return send([{ type: 'join', created_at: new Date().toISOString() }]);
    }
    if (req.method === 'GET' && table === 'players') return send(playersRows);
    if (req.method === 'GET' && table === 'player_stats') {
      // The collision monitor scans every OTHER row; it must never be mistaken
      // for the read that decides the merge.
      return send((url.searchParams.get('player_id') ?? '').startsWith('neq.') ? [] : statsRows);
    }
    return send([]);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// @supabase/realtime-js refuses to construct without a WebSocket implementation
// and Node 20 (this repo's pinned runtime) has no global one — same stub as
// scripts/client-map.test.mjs, loud if anything ever does open a channel.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class {
    constructor() {
      throw new Error('the ingest path must not open a realtime channel');
    }
  };
}

process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.PRESENCE_CHECK_ENABLED = 'true';
delete process.env.GS_EXPECTED_WORLD;

const { POST } = await import('../app/api/gs-ingest/route.ts');

/**
 * One GsValheimStatsClient-shaped snapshot for a veteran: real weapon combat,
 * real profile counters, kills that agree with the weapon breakdown. Exactly
 * the payload that re-baselined Yunter at his lifetime totals.
 */
function snapshot() {
  return {
    schemaVersion: 1,
    game: 'valheim',
    source: 'client',
    reporter: 'Yunter',
    world: 'Eilif',
    players: [
      {
        name: 'Yunter',
        kills: 132,
        deaths: 9,
        bossKills: 2,
        stats: { vh_Builds: 900, vh_Crafts: 400, vh_DistanceTraveled: 50000, vh_ItemsPickedUp: 3000 },
        weapons: [{ weapon: 'Axes', kills: 132, damageDealt: 40000, hardestHit: 300, biggestSwing: 300 }],
        creatureKills: [{ creature: 'Greyling', kills: 40 }],
        skills: [{ skill: 'Axes', level: 40 }],
      },
    ],
  };
}

let posts = 0;
/** POST one payload from a fresh IP (the route rate-limits per address). */
async function post(payload = snapshot()) {
  const n = ++posts;
  const before = requests.length;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  let res;
  try {
    res = await POST(
      new Request('http://localhost/api/gs-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${n}` },
        body: JSON.stringify(payload),
      }),
    );
  } finally {
    console.error = realError;
  }
  const calls = requests.slice(before);
  return {
    status: res.status,
    json: await res.json(),
    calls,
    errors,
    /** Every write attempted after the request began — the thing that must be zero. */
    writes: calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD'),
    upserts: calls.filter((c) => c.method === 'POST' && c.table === 'player_stats'),
  };
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

// ── 1. CONTROL: the very same payload, with every read answering ────────────
// Without this the 503 assertions below would pass just as happily against a
// fixture that never reached the merge at all.
{
  fail = null;
  const r = await post();
  check('a readable cycle still ingests and upserts player_stats', () => {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { status: 'inserted' });
    assert.equal(r.upserts.length, 1, 'expected exactly one player_stats upsert');
  });
  check('and it is the zero-point capture, which is what a null prev legitimately means', () => {
    const row = JSON.parse(r.upserts[0].body);
    assert.equal(row.player_id, 'yunter-1');
    assert.ok(row.gs_baseline, 'a first snapshot stores its baseline');
    assert.equal(row.kills, 0, 'a captured baseline credits nothing this cycle');
  });
}

// ── 2. THE BUG: a 504 on the player_stats read must not read as "no row" ─────
{
  fail = { table: 'player_stats', match: (q) => (q.get('player_id') ?? '').startsWith('eq.') };
  const r = await post();
  check('a failed player_stats read answers 503, not 200', () => {
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.deepEqual(r.json, { error: 'database read failed, retry' });
  });
  check('NOTHING is written — no upsert, no write of any kind', () => {
    assert.equal(r.upserts.length, 0, 'the row must not be touched');
    assert.equal(r.writes.length, 0, `expected no writes, got ${r.writes.map((w) => `${w.method} ${w.table}`).join(', ')}`);
  });
  check('and the failure is logged with the field it was reading', () => {
    assert.ok(
      r.errors.some((e) => e.includes('[gs-ingest] player_stats (baseline + GREATEST) read failed:')),
      `expected the read-failed line, got: ${r.errors.join(' | ')}`,
    );
  });
}

// ── 3. A 504 on the players lookup is not "this viking doesn't exist" ────────
{
  fail = { table: 'players' };
  const r = await post();
  check('a failed players lookup answers 503 instead of silently skipping the payload', () => {
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.deepEqual(r.json, { error: 'database read failed, retry' });
    assert.equal(r.writes.length, 0);
  });
}

// ── 4. A 504 on the presence probe must not switch the guard off ─────────────
// "Never block on absence of EVIDENCE" is the presence check's rule; absence of
// an ANSWER is a different thing, and used to buy an unconditional accept.
{
  fail = { table: 'events' };
  const r = await post();
  check('a failed presence read answers 503 rather than accepting the payload unchecked', () => {
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.writes.length, 0);
  });
}

// ── 5. A GENUINELY empty result keeps its old, correct meaning ───────────────
// The whole point of the fix is telling the two apart, so this is half of it:
// no players row for a reporter is still a quiet 200 skip, exactly as before.
{
  fail = null;
  playersRows = [];
  const r = await post();
  check('an empty players result is still a 200 skip, not a 503', () => {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { status: 'inserted' });
    assert.equal(r.upserts.length, 0, 'nothing to write for a viking with no row yet');
  });
  playersRows = [{ id: 'yunter-1' }];
}

// ── 6. The log-only weapon-collision scan must NOT fail the ingest ───────────
// It writes nothing and decides nothing; failing a real merge because a
// diagnostic could not run would be the fix overshooting.
{
  fail = { table: 'player_stats', match: (q) => (q.get('player_id') ?? '').startsWith('neq.') };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let r;
  try {
    r = await post();
  } finally {
    console.warn = realWarn;
  }
  check('a failed collision-monitor scan is warned about and the merge still lands', () => {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.upserts.length, 1);
    assert.ok(
      warnings.some((w) => w.includes('weapon-collision monitor read failed')),
      `expected the monitor warning, got: ${warnings.join(' | ')}`,
    );
  });
}

server.close();

if (failures > 0) {
  console.error(`\ngs-ingest read failure: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\ngs-ingest read failure: all checks passed');
