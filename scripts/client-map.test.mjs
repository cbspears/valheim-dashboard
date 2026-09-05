// Tests for the client-map (automatic cartography) ingest path — app/api/gs-ingest.
//
// THE HOLE THIS GUARDS AGAINST (audit security-4). `source:'client-map'` is one of
// the two unauthenticated writes /api/gs-ingest accepts: the plugin runs on players'
// PCs, so it cannot hold a secret, and the POST URL ships inside the public
// Thunderstore pack. The payload names the character whose explored-% it raises, and
// until EilifCompanionClient 0.3.2 that was the ONLY name in it — so the server's
// presence cross-check could only prove that the person being written about was
// online, never that the caller was them. One curl naming any online viking pinned
// them at 100 % explored for good (the write keeps the GREATEST reading), handing out
// the "Far-Seer" title, the in-game explored board and a collective Great Deed.
//
// 0.3.2 adds `reporter` = the local player's own name (EilifMapTrackerPlugin.Post).
// The route then enforces two things, both asserted below:
//
//   1. reporter, when present, must BE the named player (identityKey equality, so
//      case and surrounding whitespace don't matter) — otherwise 'reporter mismatch'.
//   2. the presence check runs on the REPORTER, not on the named player;
//   3. a reporter that is not a string at all is refused rather than normalised to ''
//      (which would have bought the pre-0.3.2 compatibility branch by type juggling).
//
// …plus the compatibility rule: a payload with no reporter at all (every client up to
// and including 0.3.1, which is what pack v11 pins) keeps its old behaviour and is
// merely logged, once per instance.
//
// HOW THIS RUNS. The route handler is imported and driven with real Request objects.
// Supabase is pointed at a throwaway local HTTP server that speaks just enough
// PostgREST for this path (the events presence probe, the players lookup, the
// player_stats read and the upsert), which also lets the assertions read back exactly
// which name the presence probe filtered on and what was finally written.
//
// Run: npx tsx scripts/client-map.test.mjs
import assert from 'node:assert';
import http from 'node:http';

// ── A throwaway PostgREST ────────────────────────────────────────────────────
// Records every request so the tests can assert on the queries themselves, not
// only on the response.
const requests = [];
let presenceRow = { type: 'join', created_at: new Date().toISOString() };
let statsRow = { map_explored_pct: 10, gs_stats: null };
const upserts = [];

// Which players row the stub resolves the named character to. The route's jump-cap
// clock (lastMapRaiseAt) is module-level and keyed by player id, so blocks that are
// not about the cap hand out a FRESH id and start from a full allowance — otherwise
// every post after the first would be clamped simply because the suite is fast.
let playerId = 'player-1';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const table = url.pathname.replace('/rest/v1/', '');
    requests.push({ method: req.method, table, query: url.searchParams, url: req.url });

    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && table === 'events') return send(presenceRow ? [presenceRow] : []);
    if (req.method === 'GET' && table === 'players') return send([{ id: playerId }]);
    if (req.method === 'GET' && table === 'player_stats') return send([statsRow]);
    if (req.method === 'POST' && table === 'player_stats') {
      upserts.push(JSON.parse(body || '{}'));
      return send([]);
    }
    return send([]);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// @supabase/realtime-js refuses to construct without a WebSocket implementation, and
// Node 20 (this repo's pinned runtime) has no global one. createClient builds a
// realtime client eagerly even though nothing here ever opens a channel — a stub is
// enough, and it fails loudly if anything ever does try to use it.
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
delete process.env.GS_EXPECTED_WORLD; // the world gate has its own coverage; not under test here

const { POST } = await import('../app/api/gs-ingest/route.ts');

let posts = 0;
/**
 * POST one client-map payload from a fresh IP (the route rate-limits per IP).
 * `as` picks which players row the stub resolves to — see `playerId`.
 */
async function post(payload, as = `player-${posts + 1}`) {
  const n = ++posts;
  playerId = as;
  const before = requests.length;
  const res = await POST(
    new Request('http://localhost/api/gs-ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${n}` },
      body: JSON.stringify({ schemaVersion: 1, game: 'valheim', source: 'client-map', ...payload }),
    }),
  );
  return { status: res.status, json: await res.json(), calls: requests.slice(before) };
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

// ── 1. A reporter naming someone else is refused, before any database work ───
// This is the attack: an unauthenticated POST that raises another viking's map.
{
  const r = await post({ playerName: 'Bren', reporter: 'Troll', world: 'W', exploredPct: 100 });
  check('a client-map post whose reporter is not the named player is ignored', () => {
    assert.equal(r.status, 200, 'still a 200 so an honest mod never retry-storms');
    assert.deepEqual(r.json, { status: 'ignored', reason: 'reporter mismatch' });
  });
  check('the refusal costs zero database round trips', () => {
    assert.deepEqual(r.calls, [], `expected no queries, got ${r.calls.map((c) => c.table).join(', ')}`);
  });
  check('nothing was written', () => assert.equal(upserts.length, 0));
}

// ── 2. A self-report is accepted, and a presence probe runs before the write ─
// This is the shape the plugin actually sends: both names read from the same
// Player.m_localPlayer, so they arrive byte-identical. Which of the two the presence
// probe uses cannot be told apart here — block 3 is what pins that down.
{
  const r = await post({ playerName: 'Bren', reporter: 'Bren', world: 'W', exploredPct: 12 }, 'bren-self');
  check('a self-reported client-map post is ingested', () => {
    assert.equal(r.json.status, 'inserted', JSON.stringify(r.json));
    assert.equal(r.json.player, 'Bren');
  });
  check('a presence probe ran before the reading was written', () => {
    const presence = r.calls.find((c) => c.table === 'events');
    assert.ok(presence, 'expected a presence query against events');
    assert.match(presence.query.get('character_name') ?? '', /Bren$/);
    assert.ok(
      r.calls.indexOf(presence) < r.calls.findIndex((c) => c.method === 'POST'),
      'presence must be probed before anything is written',
    );
  });
  check('the reading was written', () => {
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].player_id, 'bren-self');
    assert.equal(upserts[0].map_explored_pct, 12);
  });
}

// ── 3. Equality is identityKey equality, not string equality ─────────────────
// The plugin reads both names from Player.m_localPlayer, so they arrive identical;
// this only makes sure a stray space or a case difference can never lock an honest
// player out of their own cartography.
{
  upserts.length = 0;
  const r = await post({ playerName: 'Bren', reporter: '  bren ', world: 'W', exploredPct: 13 });
  check('reporter matching modulo case and whitespace is accepted', () => {
    assert.equal(r.json.status, 'inserted', JSON.stringify(r.json));
    assert.equal(upserts.length, 1);
  });
  // The discriminating case: only the trimmed REPORTER matches /bren$/ case-sensitively,
  // so this fails if the route ever probes playerName ('Bren') again instead.
  check('presence probes the REPORTER, not the named player', () => {
    const presence = r.calls.find((c) => c.table === 'events');
    assert.match(presence.query.get('character_name') ?? '', /bren$/);
  });
}

// ── 4. A reporter-less post (client ≤0.3.1, what pack v11 pins) still works ──
// Refusing these would blank every player's exploration until the pack is re-minted,
// so they keep the old behaviour: presence falls back to the named player.
{
  upserts.length = 0;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const first = await post({ playerName: 'Bren', world: 'W', exploredPct: 14 });
    const second = await post({ playerName: 'Bren', world: 'W', exploredPct: 15 });

    check('a payload with no reporter is still ingested', () => {
      assert.equal(first.json.status, 'inserted', JSON.stringify(first.json));
      assert.equal(second.json.status, 'inserted', JSON.stringify(second.json));
      assert.equal(upserts.length, 2);
    });
    check('presence falls back to the named player when there is no reporter', () => {
      const presence = first.calls.find((c) => c.table === 'events');
      assert.match(presence.query.get('character_name') ?? '', /Bren$/);
    });
    check('the compatibility gap is logged ONCE per instance, not once per post', () => {
      const hits = warnings.filter((w) => w.includes('client-map accepted WITHOUT a reporter'));
      assert.equal(hits.length, 1, `expected exactly one warning, got ${hits.length}`);
    });
  } finally {
    console.warn = realWarn;
  }
}

// ── 5. A reporter with no player named is a mismatch, not a free pass ────────
{
  upserts.length = 0;
  const r = await post({ reporter: 'Troll', world: 'W', exploredPct: 100 });
  check('reporter present but playerName missing is refused', () => {
    assert.deepEqual(r.json, { status: 'ignored', reason: 'reporter mismatch' });
    assert.equal(upserts.length, 0);
  });
}

// ── 6. A reporter that is not a name at all is refused ──────────────────────
// `reporter: 42` normalises to '' everywhere else in the route, which would have bought
// the permissive ≤0.3.1 branch by type juggling. An explicit null still reads as absent:
// serialisers emit it for a missing value and refusing those would blank real exploration.
{
  upserts.length = 0;
  const bad = await post({ playerName: 'Bren', reporter: 42, world: 'W', exploredPct: 100 });
  check('a non-string reporter is refused, not treated as an old client', () => {
    assert.deepEqual(bad.json, { status: 'ignored', reason: 'bad reporter' });
    assert.deepEqual(bad.calls, [], 'and costs no database round trips');
    assert.equal(upserts.length, 0);
  });

  const nulled = await post({ playerName: 'Bren', reporter: null, world: 'W', exploredPct: 16 });
  check('an explicit null reporter is treated as absent and still ingested', () => {
    assert.equal(nulled.json.status, 'inserted', JSON.stringify(nulled.json));
    assert.equal(upserts.length, 1);
  });
}

// ── 7. The identity check does not replace the presence check ───────────────
// A perfectly self-consistent payload from someone who left the server long ago is
// still dropped — the two guards answer different questions ("is this really you?"
// and "are you actually here?") and both have to hold.
{
  upserts.length = 0;
  presenceRow = { type: 'leave', created_at: new Date(Date.now() - 60 * 60_000).toISOString() };
  const r = await post({ playerName: 'Bren', reporter: 'Bren', world: 'W', exploredPct: 99 });
  check('a self-reported post from an offline character is still rejected', () => {
    assert.deepEqual(r.json, { status: 'ignored', reason: 'not connected to this server' });
    assert.equal(upserts.length, 0);
  });
  presenceRow = { type: 'join', created_at: new Date().toISOString() };
}

// ── 8. The jump cap survives the identity check ─────────────────────────────
// Defence in depth: binding a report to its sender does not make its NUMBER true,
// so a bound 0 → 100 leap is still clamped and flagged.
{
  upserts.length = 0;
  statsRow = { map_explored_pct: 4, gs_stats: null };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let r;
  try {
    r = await post({ playerName: 'Bren', reporter: 'Bren', world: 'W', exploredPct: 100 }, 'bren-jump');
  } finally {
    console.warn = realWarn;
  }
  check('a bound but implausible leap is clamped to the +15%/5min cap', () => {
    assert.equal(r.json.status, 'inserted', JSON.stringify(r.json));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].map_explored_pct, 19, 'clamped to prev(4) + 15');
  });
  check('and flagged for review in gs_stats._flags', () => {
    const flags = upserts[0].gs_stats?._flags ?? [];
    assert.equal(flags.length, 1);
    assert.equal(flags[0].kind, 'mapJump');
    assert.ok(warnings.some((w) => w.includes('MAP JUMP')));
  });
  statsRow = { map_explored_pct: 10, gs_stats: null };
}

server.close();

if (failures > 0) {
  console.error(`\nclient-map: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nclient-map: all checks passed');
