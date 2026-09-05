#!/usr/bin/env node
// Local-stack stress test: 20 vikings, 6 simulated hours, compressed into ~12
// real minutes.
//
// WHAT THIS IS FOR. The Eilif pipeline has never seen more than 3 concurrent
// players. Launch is 15-20 friends at once. Everything downstream of the game
// server — the log poller's webhook batch, the GsValheimStats client posts, our
// own death reports, the Emitter's roster, the milestone evaluator, the Discord
// bot's relay/titles/deeds loops — is written for a handful of players and has
// never been measured at the real roster size. This harness replays a whole
// evening at that size against a LOCAL Supabase + a LOCAL `next start`, then
// asserts the invariants that decide whether launch night's record is honest:
// one events row per real death, every session closed, stats equal to what was
// actually posted, one war party on the boss, one announcement per deed.
//
// IT NEVER TOUCHES PRODUCTION. Every endpoint it posts to comes from BASE_URL
// (default http://localhost:3400) and every row it reads comes from SUPABASE_URL
// (default http://127.0.0.1:54321). Run it against anything else and you are on
// your own. See docs/STRESS-TEST.md for the exact reproduce commands.
//
// WHAT IT SIMULATES, and which producer each part stands in for:
//   • /api/webhook          — the SFTP log poller: join / leave / pos / chat /
//                             oath / pin / sync, with the SteamID pairing it
//                             forwards. In production all of it comes from ONE
//                             machine, which matters — see POLLER_SHARDS below.
//   • /api/gs-ingest client — GsValheimStatsClient's ~120 s cumulative snapshot,
//                             one per player, each from its OWN ip.
//   • /api/gs-ingest eilif-death — our EilifCompanionClient death report, fired
//                             CONCURRENTLY with the gs one for the same death so
//                             the ingest_death() race is exercised on every death.
//   • /api/gs-ingest client-map — the cartography post (map_explored_pct).
//   • /api/gs-ingest server — the Emitter's roster + worldDay + milestones,
//                             Bearer-authenticated.
//
// RATE LIMITS. lib/rate-limit.ts is 60 requests / 60 s per IP, keyed on the first
// x-forwarded-for hop, so this harness sends a per-role x-forwarded-for: one ip
// per player for their own client posts, one for the game server, and a small
// pool for the poller (POLLER_SHARDS — read the note at that constant before
// drawing any conclusion from the 429 column). scripts/stress/ratelimit-probe.mjs
// measures the real single-IP budget at real-time cadence.
//
// Node 20, no dependencies beyond the standard library.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ── configuration ────────────────────────────────────────────────────────────

const cfg = {
  base: process.env.BASE_URL || 'http://localhost:3400',
  supabaseUrl: process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || 'stress-secret',
  emitterToken: process.env.GS_EMITTER_TOKEN || 'stress-emitter',
  world: process.env.GS_EXPECTED_WORLD || 'StressWorld',
  simMinutes: intEnv('SIM_MINUTES', 360),
  tickMs: intEnv('TICK_MS', 2000),
  players: intEnv('PLAYERS', 20),
  out: process.env.OUT || '/tmp/stress-results.json',
  verifyOnly: process.argv.includes('--verify-only'),
  seed: intEnv('SEED', 20260909),
};

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
}

if (!cfg.serviceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required (the LOCAL one — see docs/STRESS-TEST.md).');
  process.exit(2);
}
// ── refusing to run anywhere but the local stack ─────────────────────────────
//
// TWO CHECKS, because one is not enough and the gap between them is the exact
// accident this harness can cause.
//
// (a) SHAPE. Both URLs must resolve to a loopback HOSTNAME — not merely contain
//     the substring "localhost", which `http://localhost.example.com` and
//     `https://eilif.example/?x=localhost` both do.
//
// (b) COHERENCE, in preflight() below. `NEXT_PUBLIC_SUPABASE_URL` is inlined at
//     BUILD time, so a production `.next` served by `next start` on a localhost
//     port reads and writes PRODUCTION while every string in this config still
//     says "localhost" (docs/STRESS-TEST.md §2). Shape alone cannot see that;
//     preflight stamps a sentinel into the local database and requires the site
//     to read it back.
function isLoopback(u) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}
if (!isLoopback(cfg.base) || !isLoopback(cfg.supabaseUrl)) {
  console.error(
    `Refusing to run: BASE_URL (${cfg.base}) and SUPABASE_URL (${cfg.supabaseUrl}) must both be loopback. ` +
      'This harness writes thousands of rows.',
  );
  process.exit(2);
}

// ── deterministic RNG (so a failing run is reproducible) ─────────────────────

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(cfg.seed);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);

// ── the roster ───────────────────────────────────────────────────────────────
//
// Nineteen ASCII names plus one deliberately non-ASCII ("Þóra"): the identity
// paths fold case with toLowerCase() and match names through PostgREST `ilike`
// with escaped wildcards, and a name outside ASCII is the cheapest way to find
// out whether any of that mangles a real player. (Valheim allows it.)

const NAMES = [
  'Astrid', 'Bjorn', 'Cnut', 'Dagny', 'Eirik',
  'Freydis', 'Gunnar', 'Halla', 'Ivar', 'Jorunn',
  'Ketil', 'Leif', 'Magnus', 'Njal', 'Orm',
  'Ragna', 'Sigrid', 'Torvald', 'Ulf', 'Þóra',
].slice(0, cfg.players);

const BIOMES = ['Meadows', 'BlackForest', 'Swamp', 'Mountain', 'Plains', 'Ocean'];
const CREATURES = ['$enemy_greydwarf', 'Greydwarf(Clone)', 'Neck', '$enemy_boar', 'Deathsquito', '$enemy_draugr'];
const HIT_TYPES = ['EnemyHit', 'Fall', 'Drowning', 'Burning', 'Freezing', 'Poisoned', 'Impact', 'Tree', 'Structural'];
const SHOUTS = [
  'anyone got spare nails',
  'come to the longhouse',
  'i found a crypt',
  'need a boat crew',
  'trolls at the south camp',
  'who took my hammer',
];

// Simulated clock: the run ENDS at roughly real "now", so every timestamp we
// write is in the recent past. The presence cross-check in /api/gs-ingest
// compares a `leave` against Date.now(), so a simulated clock that ran into the
// future would make every client post look like it came from a player who has
// not joined yet.
const SIM_START = Date.now() - cfg.simMinutes * 60_000;
const simAt = (minute, extraSec = 0) => new Date(SIM_START + minute * 60_000 + extraSec * 1000);
const simIso = (minute, extraSec = 0) => simAt(minute, extraSec).toISOString();

// ── per-role client identities ───────────────────────────────────────────────
//
// See the rate-limit note in the header. Each viking's client posts come from
// their own address; the Emitter posts from the game server; everything the log
// poller would send comes from the poller's machine.
//
// ⚠️ POLLER_SHARDS EXISTS BECAUSE TIME IS COMPRESSED, AND IT HIDES A REAL RISK.
// lib/rate-limit.ts counts against the WALL CLOCK (60 requests per 60 real
// seconds per IP), but this harness replays a simulated minute every TICK_MS
// (2 s by default) — a 30x speed-up. The poller's ~21 posts per simulated
// minute therefore arrive as ~630 per real minute from one address and the
// bucket empties within seconds, which drowns every other measurement in 429s
// (measured: 2,232 of 2,305 position posts refused in a 10x smoke run). Sharding
// the poller's traffic across N addresses restores the per-real-minute rate the
// real poller would produce, so what the run measures is the PIPELINE rather
// than the limiter.
//
// The real deployment has exactly ONE poller address. Set POLLER_SHARDS=1 and
// TICK_MS=60000 to measure the limiter honestly instead — or run
// scripts/stress/ratelimit-probe.mjs, which measures that budget directly at
// real-time cadence in one minute.
const POLLER_SHARDS = intEnv('POLLER_SHARDS', 16);
let pollerSeq = 0;
const pollerIp = () => `203.0.113.${10 + (pollerSeq++ % POLLER_SHARDS)}`;
const SERVER_IP = '198.51.100.7';
const clientIp = (i) => `192.0.2.${20 + i}`;

// ── the vikings ──────────────────────────────────────────────────────────────

function makeViking(name, i) {
  // A LIFETIME import: the first snapshot a character posts becomes its
  // zero-point (lib/gs-baseline), so these numbers must credit exactly nothing.
  // Half the roster arrives with a real career behind them, which is what
  // launch night will actually look like.
  const veteran = i % 2 === 0;
  const b = veteran ? Math.floor(between(400, 4000)) : 0;
  return {
    i,
    name,
    steamId: `7656119${String(100000000 + i * 7919).slice(0, 10)}`,
    ip: clientIp(i),
    online: false,
    // raw LIFETIME cumulative counters, as the .fch profile carries them
    raw: {
      kills: b,
      deaths: Math.floor(b / 40),
      bossKills: veteran ? 1 : 0,
      builds: b * 2,
      crafts: b,
      damage: b * 12,
      walk: b * 30,
      run: b * 12,
      sail: b * 5,
      air: 0,
      pickups: b * 6,
      fish: veteran ? 3 : 0,
      longestLifeSec: b * 2,
      bestKillsBeforeDeath: Math.min(40, Math.floor(b / 60)),
    },
    // what the FIRST posted snapshot was (the zero-point we expect the server to
    // have captured); filled in on the first emit
    baseline: null,
    posted: null,          // the newest snapshot the server accepted
    bossDamage: {},        // bossName(gameObject) -> cumulative damage BY THIS CLIENT for itself
    observedOf: {},        // other player name -> cumulative damage this client watched them deal
    exploredPct: 11 + (i % 5) * 0.75,
    deaths: [],            // { tsUtc, hitType, attacker, biome }
    sessions: [],          // { joinMin, leaveMin }
  };
}

const vikings = NAMES.map(makeViking);
const byName = new Map(vikings.map((v) => [v.name, v]));

// ── HTTP with measurement ────────────────────────────────────────────────────

const samples = new Map(); // label -> { ms: number[], codes: Map<status,count>, retries }

function record(label, ms, status) {
  let s = samples.get(label);
  if (!s) {
    s = { ms: [], codes: new Map(), retries: 0 };
    samples.set(label, s);
  }
  s.ms.push(ms);
  s.codes.set(status, (s.codes.get(status) ?? 0) + 1);
}

const MAX_RETRY = 4;

/**
 * POST one payload and measure it.
 *
 * Retries on 429 and 5xx with backoff, exactly as the real producers do (the log
 * poller rewinds its byte cursor and replays the whole batch; the mods re-post
 * their cumulative snapshot on the next cycle). Every attempt is measured and
 * counted, so a retried request shows up in both the latency table and the
 * non-2xx counts rather than being hidden by the retry.
 */
async function post(label, url, body, headers, { retry = true } = {}) {
  let attempt = 0;
  for (;;) {
    const t0 = performance.now();
    let status = 0;
    let text = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      status = 0;
      text = String(e?.message ?? e);
    }
    record(label, performance.now() - t0, status);
    const retryable = status === 429 || status === 0 || (status >= 500 && status < 600);
    if (!retry || !retryable || attempt >= MAX_RETRY) {
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status, text, json };
    }
    const s = samples.get(label);
    if (s) s.retries += 1;
    attempt += 1;
    await sleep(120 * attempt + Math.floor(rnd() * 80));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── producers ────────────────────────────────────────────────────────────────

const webhook = (label, body) =>
  post(label, `${cfg.base}/api/webhook`, body, {
    'x-webhook-secret': cfg.webhookSecret,
    'x-forwarded-for': pollerIp(),
  });

function gsBody(v, extra) {
  return {
    schemaVersion: 1,
    game: 'valheim',
    world: cfg.world,
    ...extra,
  };
}

/** The reporter's own players[] entry — the only authoritative cumulative source. */
function selfEntry(v) {
  const r = v.raw;
  const bossEntries = Object.entries(v.bossDamage).map(([boss, damageDealt]) => ({
    boss,
    damageDealt: Math.round(damageDealt),
    kills: 0,
    fightSec: 40,
  }));
  return {
    name: v.name,
    kills: r.kills,
    deaths: r.deaths,
    bossKills: r.bossKills,
    longestLifeSec: r.longestLifeSec,
    bestKillsBeforeDeath: r.bestKillsBeforeDeath,
    currentLifeStartedUtc: simIso(0),
    platformId: v.steamId,
    stats: {
      vh_Builds: r.builds,
      vh_Crafts: r.crafts,
      vh_DistanceTraveled: r.walk + r.run + r.sail + r.air,
      vh_DistanceWalk: r.walk,
      vh_DistanceRun: r.run,
      vh_DistanceSail: r.sail,
      vh_DistanceAir: r.air,
    },
    // One weapon carries the whole damage total so damageDealt is exactly
    // predictable for the invariant check (the parse SUMS weapons[].damageDealt).
    weapons: [
      {
        weapon: 'Swords',
        damageDealt: r.damage,
        kills: r.kills,
        hardestHit: 120 + v.i,
        biggestSwing: 140 + v.i,
      },
    ],
    creatureKills: [{ creature: 'Greydwarf', kills: r.kills }],
    // resourcesHarvested is the SUM of pickups[].count, fish included.
    pickups: [
      { item: 'Wood', count: r.pickups },
      { item: 'Fish1', count: r.fish },
    ],
    materials: [{ material: 'Wood', amount: r.pickups }],
    skills: [{ skill: 'Swords', level: 20 }, { skill: 'Fishing', level: 12 }],
    boss: bossEntries,
    crafts: [{ item: 'ArrowWood', count: r.crafts }],
  };
}

/** Everything this client has watched OTHER vikings do (the ZDO-owner case). */
function bystanderEntries(v) {
  return Object.entries(v.observedOf).map(([name, byBoss]) => ({
    name,
    // A bystander entry carries partial combat only — no stats, no cumulative
    // counters. This is exactly the shape parseObservedBossDamage reads.
    boss: Object.entries(byBoss).map(([boss, damageDealt]) => ({
      boss,
      damageDealt: Math.round(damageDealt),
      kills: 0,
    })),
  }));
}

function deathEventsOf(v) {
  return v.deaths.map((d) => ({
    playerName: v.name,
    tsUtc: d.tsUtc,
    killer: d.attacker ?? '',
    biome: d.biome,
    lifeSec: 600,
    killsThisLife: 4,
  }));
}

async function gsClientPost(v, extra = {}) {
  const body = gsBody(v, {
    source: 'client',
    reporter: v.name,
    emittedAtUtc: new Date().toISOString(),
    players: [selfEntry(v), ...bystanderEntries(v)],
    deathEvents: deathEventsOf(v),
    ...extra,
  });
  const snapshot = JSON.parse(JSON.stringify(v.raw));
  const res = await post('gs-ingest client', `${cfg.base}/api/gs-ingest`, body, { 'x-forwarded-for': v.ip });
  // What the SERVER has actually been told. The zero-point is the first snapshot
  // it accepted; `posted` is the newest one, and the two are what the
  // player_stats invariant is checked against — not v.raw, which keeps growing
  // between the ~120 s posts and after the last one.
  if (res.status >= 200 && res.status < 300) {
    if (!v.baseline) v.baseline = snapshot;
    v.posted = snapshot;
  }
  return res;
}

async function gsMapPost(v) {
  return post(
    'gs-ingest client-map',
    `${cfg.base}/api/gs-ingest`,
    gsBody(v, { source: 'client-map', playerName: v.name, exploredPct: v.exploredPct }),
    { 'x-forwarded-for': v.ip },
  );
}

async function eilifDeathPost(v, d) {
  return post(
    'gs-ingest eilif-death',
    `${cfg.base}/api/gs-ingest`,
    gsBody(v, {
      source: 'eilif-death',
      player: v.name,
      reporter: v.name, // EilifCompanionClient >= 0.3.1
      tsUtc: d.tsUtc,
      hitType: d.hitType,
      attacker: d.attacker,
      biome: d.biome,
      pos: { x: Math.round(between(-4000, 4000)), z: Math.round(between(-4000, 4000)) },
    }),
    { 'x-forwarded-for': v.ip },
  );
}

async function emitterPost(minute, { milestones = [], bossKillEvents = [] } = {}) {
  const roster = vikings.filter((v) => v.online).map((v) => v.name);
  return post(
    'gs-ingest server',
    `${cfg.base}/api/gs-ingest`,
    {
      schemaVersion: 1,
      game: 'valheim',
      source: 'server',
      world: cfg.world,
      emittedAtUtc: simIso(minute),
      onlinePlayers: roster,
      worldDay: 1 + Math.floor(minute / 20),
      milestones,
      bossKillEvents,
    },
    { authorization: `Bearer ${cfg.emitterToken}`, 'x-forwarded-for': SERVER_IP },
  );
}

// ── the run ──────────────────────────────────────────────────────────────────

const expected = {
  realDeaths: 0,          // every death that genuinely happened
  deathKeys: new Set(),   // `${name}|${tsUtc}` — the key lib/deaths.ts:222 derives
  corpseRunPairs: [],     // [{ name, first, second }]
  bossFighters: [],
  bossDamageTotals: {},   // name -> damage on Eikthyr
  elderFighters: [],      // the second boss — see ELDER_* below
  elderDamage: {},        // name -> damage on The Elder
  impostor: null,
};

// Six invariants can only be judged against what the RUN meant to happen — how
// many deaths were real, who fought the boss, which viking the impostor
// impersonated. `--verify-only` skips the simulation, so it has to read those
// back from the results file the run wrote, or admit it cannot check them.
// Reporting PASS on an empty expectation set is exactly the vacuity this
// harness exists to catch, and reporting FAIL accuses production code of a
// defect the harness invented.
let expectationsAvailable = !cfg.verifyOnly;

function rehydrateExpectations() {
  const from = process.env.EXPECTED_IN || cfg.out;
  let saved;
  try {
    saved = JSON.parse(readFileSync(resolve(from), 'utf8'));
  } catch (e) {
    console.warn(
      `[stress] --verify-only: could not read expectations from ${from} (${e?.message ?? e}).\n` +
        '          The invariants that need them will be SKIPPED, not passed. Point EXPECTED_IN at a results.json\n' +
        '          written by a full run to check them.',
    );
    return;
  }
  const e = saved?.expected;
  if (!e || typeof e !== 'object') {
    console.warn(`[stress] --verify-only: ${from} carries no "expected" block. Those invariants will be SKIPPED.`);
    return;
  }
  expected.realDeaths = e.realDeaths ?? 0;
  expected.deathKeys = new Set(Array.isArray(e.deathKeys) ? e.deathKeys : []);
  expected.corpseRunPairs = e.corpseRunPairs ?? [];
  expected.bossFighters = e.bossFighters ?? [];
  expected.bossDamageTotals = e.bossDamageTotals ?? {};
  expected.elderFighters = e.elderFighters ?? [];
  expected.elderDamage = e.elderDamage ?? {};
  expected.impostor = e.impostor ?? null;
  if (e.sessionsExpected != null) expected.sessionsExpected = e.sessionsExpected;
  for (const [name, snap] of Object.entries(e.vikingStats ?? {})) {
    const v = byName.get(name);
    if (!v) continue;
    v.baseline = snap?.baseline ?? null;
    v.posted = snap?.posted ?? null;
  }
  expectationsAvailable = true;
  console.log(`[stress] --verify-only: expectations rehydrated from ${from} (${expected.realDeaths} deaths, ${expected.bossFighters.length} boss fighters).`);
}

// Everything scheduled below is a FRACTION of the run, so a short smoke run
// (SIM_MINUTES=40) still exercises the boss, the corpse runs, the relogs and the
// impostor rather than silently skipping them.
const at = (frac) => Math.max(2, Math.round(frac * cfg.simMinutes));
const BOSS_MINUTE = at(0.55);
const BOSS_OBJECT = 'Eikthyr';
const BOSS_ROW = 'Eikthyr';

// ── the second boss: a replay of the 2026-08-28 Eikthyr incident ─────────────
//
// The FIRST boss is felled with a full Emitter MVP summary, and
// planBossKillUpdate writes that summary's topDamagePlayer/topDamage VERBATIM
// (lib/boss-damage.ts:530) — deliberately, because a fight record knows things a
// cumulative career total never can. Which means asserting the stored verdict
// equals the verdict we sent asserts nothing at all about the client-damage
// fold: it is an echo.
//
// So there is a second boss, and NOTHING reports a fight record for it. Five
// vikings hit `gd_king`, one client owns the ZDO and reports the other four as
// bystanders, and the only thing that ever fells it is the Emitter's
// `defeated_gdking` milestone key — which carries no fighters, no firstBlood and
// no topDamage. That is precisely the night lib/boss-damage.ts was written for
// (its header: "NOT ONE producer emitted a bossKillEvents entry"), and it is the
// only shape in which the fold's own war party and top-damage verdict are the
// sole source of the answer.
const ELDER_OBJECT = 'gd_king';
const ELDER_ROW = 'The Elder';
const ELDER_MINUTE = at(0.72);
// The kill lands TWO minutes after the last blow, so every fold has settled
// before the milestone flip reads the row. That is not papering over a race —
// the flip's read-modify-write and a concurrent fold genuinely can interleave —
// it keeps THIS test measuring the fold rather than that coin flip.
const ELDER_KILL_TICK = (ELDER_MINUTE + 2) % 2 === 0 ? ELDER_MINUTE + 2 : ELDER_MINUTE + 3;
// Deliberately none of the relog (3, 7, 11, 15), corpse-run (0, 5, 10, 15) or
// impostor (Ulf, 18) vikings: this scenario is about the damage fold, and it
// should not be able to fail for a presence reason.
const ELDER_PARTY = [12, 13, 14, 16, 17].filter((i) => i < vikings.length);

async function joinViking(v, minute, sec = 0, steamId = null) {
  const res = await webhook('webhook join', {
    type: 'join',
    characterName: v.name,
    steamId: steamId ?? v.steamId,
    occurredAt: simIso(minute, sec),
    worldDay: 1 + Math.floor(minute / 20),
  });
  if (!steamId) {
    v.online = true;
    v.sessions.push({ joinMin: minute, joinSec: sec, leaveMin: null });
  }
  return res;
}

async function leaveViking(v, minute, sec = 0) {
  const res = await webhook('webhook leave', {
    type: 'leave',
    characterName: v.name,
    steamId: v.steamId,
    occurredAt: simIso(minute, sec),
  });
  v.online = false;
  const open = [...v.sessions].reverse().find((s) => s.leaveMin === null);
  if (open) {
    open.leaveMin = minute;
    open.leaveSec = sec;
  }
  return res;
}

/** One death: the gs report and our own report fired CONCURRENTLY, 0-10 ms apart. */
async function die(v, minute, sec) {
  const tsUtc = simAt(minute, sec).toISOString();
  const hitType = pick(HIT_TYPES);
  const attacker = hitType === 'EnemyHit' ? pick(CREATURES) : null;
  const d = { tsUtc, hitType, attacker, biome: pick(BIOMES) };
  v.deaths.push(d);
  v.raw.deaths += 1;
  expected.realDeaths += 1;
  expected.deathKeys.add(`${v.name}|${tsUtc}`);

  // The whole point of this pair: both producers Harmony-patch Player.OnDeath and
  // POST immediately, so in the real world they land within a few hundred ms of
  // each other. 0-10 ms is the tightest observed gap (db/2026-09-04_ingest_death.sql).
  const jitter = Math.floor(rnd() * 10);
  await Promise.all([
    (async () => {
      await sleep(jitter);
      return eilifDeathPost(v, d);
    })(),
    (async () => {
      await sleep(10 - jitter);
      // The gs producer's report of the same death rides its cumulative snapshot.
      return gsClientPost(v);
    })(),
  ]);
  return d;
}

/** Grow one viking's cumulative counters by roughly one minute of play. */
function tickStats(v) {
  v.raw.kills += Math.round(between(2, 5));
  v.raw.builds += Math.round(between(4, 12));
  v.raw.crafts += Math.round(between(2, 6));
  v.raw.damage += Math.round(between(250, 500));
  v.raw.walk += Math.round(between(90, 160));
  v.raw.run += Math.round(between(30, 90));
  v.raw.sail += Math.round(between(0, 60));
  v.raw.pickups += Math.round(between(60, 110));
  if (rnd() < 0.03) v.raw.fish += 1;
  v.raw.longestLifeSec = Math.max(v.raw.longestLifeSec, Math.round(between(300, 2400)));
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

async function runSimulation() {
  const t0 = Date.now();
  console.log(
    `[stress] ${vikings.length} vikings, ${cfg.simMinutes} simulated minutes at ${cfg.tickMs}ms/minute ` +
      `(~${Math.round((cfg.simMinutes * cfg.tickMs) / 60000)} real minutes), world "${cfg.world}", seed ${cfg.seed}.`,
  );

  // Deaths: pick minutes up front so the schedule is deterministic and printable.
  //
  // TWO CONSTRAINTS THE SCHEDULE HAS TO RESPECT, both learned the hard way.
  //
  // 1. THE WINDOW MUST SCALE. `cfg.simMinutes - 40` is exactly zero at
  //    SIM_MINUTES=40 — the size this file's own header recommends for a smoke
  //    run — which put all thirty deaths on minute 8, and NEGATIVE below it,
  //    which scheduled them before the run started where they silently never
  //    fire at all.
  //
  // 2. NO TWO DEATHS MAY SHARE (viking, second). lib/deaths.ts:222 derives
  //    `eilifDeathId = ${player}|${tsUtc}` and db/2026-09-04_ingest_death.sql
  //    returns 'duplicate' on an exact key match — CORRECTLY, because that is
  //    the same report arriving twice. Two harness deaths on one key are
  //    therefore one row, and counting them as two blames production for a
  //    collision we manufactured: a guaranteed false "gs/eilif twins survived".
  //
  // 3. AND NO TWO MAY LAND WITHIN 2 SECONDS OF EACH OTHER, for the same viking.
  //    Two death rows for one viking under two seconds apart is the SIGNATURE of
  //    the gs/eilif twin, and the invariant that hunts it cannot tell that
  //    signature from two real deaths a second apart. On a compressed smoke run
  //    (every death in one simulated minute) merely distinct seconds produced
  //    exactly that false alarm. A three-second floor makes the twin detector a
  //    statement about production again.
  //
  // So the schedule claims a real instant per death and nudges it forward until
  // it is both unique and far enough from that viking's other deaths.
  const deathWindow = Math.max(1, cfg.simMinutes - 40);
  const MIN_DEATH_GAP_S = 3;
  const claimedByViking = new Map(); // name -> Set of epoch seconds
  const claimSecond = (whoIdx, minute, sec) => {
    const name = vikings[whoIdx].name;
    let taken = claimedByViking.get(name);
    if (!taken) claimedByViking.set(name, (taken = new Set()));
    const base = Math.floor(simAt(minute, 0).getTime() / 1000);
    for (let bump = 0; bump < 60; bump++) {
      const s = (sec + bump) % 60;
      const t = base + s;
      let clash = false;
      for (let d = -(MIN_DEATH_GAP_S - 1); d <= MIN_DEATH_GAP_S - 1 && !clash; d++) clash = taken.has(t + d);
      if (clash) continue;
      taken.add(t);
      return s;
    }
    return null; // that entire minute already belongs to this viking
  };

  const deathSchedule = [];
  for (let n = 0; n < 30; n++) {
    const minute = 8 + Math.floor(rnd() * deathWindow);
    const who = Math.floor(rnd() * vikings.length);
    const sec = claimSecond(who, minute, Math.floor(rnd() * 50));
    if (sec === null) continue;
    deathSchedule.push({ minute, who, sec });
  }
  // Four corpse-run doubles: a second death exactly 60 s after the first, well
  // inside the +/-3 min collapse window. BOTH must survive as separate rows.
  const corpseRuns = [];
  for (const [k, f] of [0.11, 0.33, 0.58, 0.83].entries()) {
    const minute = at(f);
    const who = (k * 5) % vikings.length;
    const sec = claimSecond(who, minute, 5);
    const sec2 = sec === null ? null : claimSecond(who, minute + 1, sec);
    if (sec === null || sec2 === null) continue;
    corpseRuns.push({ minute, who, sec, sec2 });
  }

  const relogs = [0, 1, 2, 3].map((k) => ({
    who: (3 + k * 4) % vikings.length,
    leave: at(0.66) + k,
    join: at(0.66) + k + 3,
  }));

  const OATH_MINUTES = [at(0.012), at(0.026), at(0.062)];
  const PIN_MINUTES = [at(0.042), at(0.17), at(0.5)];
  const IMPOSTOR_MINUTE = at(0.83);

  for (let minute = 0; minute <= cfg.simMinutes; minute++) {
    const tickStart = Date.now();
    const jobs = [];

    // ── minute 0: the launch-night burst — all 20 join at once ──────────────
    if (minute === 0) {
      console.log('[stress] minute 0: all vikings join at once (the launch-night burst)');
      await Promise.all(vikings.map((v) => joinViking(v, 0, v.i)));
      await emitterPost(0);
      continue;
    }

    // ── presence: positions for everyone online (a 20-wide burst per minute) ─
    for (const v of vikings) {
      if (!v.online) continue;
      jobs.push(
        webhook('webhook pos', {
          type: 'pos',
          characterName: v.name,
          x: Math.round(between(-6000, 6000)),
          z: Math.round(between(-6000, 6000)),
          biome: pick(BIOMES),
          occurredAt: simIso(minute, 5),
        }),
      );
    }

    // ── chat: a handful of shouts a minute ──────────────────────────────────
    for (const v of vikings) {
      if (!v.online) continue;
      if (rnd() > 0.05) continue;
      jobs.push(
        webhook('webhook chat', {
          type: 'chat',
          characterName: v.name,
          message: pick(SHOUTS),
          occurredAt: simIso(minute, 12),
        }),
      );
    }

    // ── oaths: sworn in the first hour ──────────────────────────────────────
    if (OATH_MINUTES.includes(minute)) {
      const swearers = vikings.filter((v) => v.online && v.i % 3 === OATH_MINUTES.indexOf(minute)).slice(0, 7);
      for (const v of swearers) {
        jobs.push(
          webhook('webhook oath', {
            type: 'oath',
            characterName: v.name,
            text: `I swear to hold the line at ${pick(BIOMES)}`,
            steamId: v.steamId,
            occurredAt: simIso(minute, 20),
          }),
        );
      }
    }

    // ── pins ────────────────────────────────────────────────────────────────
    if (PIN_MINUTES.includes(minute)) {
      const v = vikings[minute % vikings.length];
      if (v.online) {
        jobs.push(
          webhook('webhook pin', {
            type: 'pin',
            characterName: v.name,
            steamId: v.steamId,
            metadata: {
              name: `Camp ${minute}`,
              kind: minute === 15 ? 'base' : 'poi',
              worldX: Math.round(between(-5000, 5000)),
              worldZ: Math.round(between(-5000, 5000)),
            },
            occurredAt: simIso(minute, 25),
          }),
        );
      }
    }

    // ── the roster sync the poller sends on its heartbeat ────────────────────
    if (minute % 10 === 0) {
      jobs.push(
        webhook('webhook sync', {
          type: 'sync',
          metadata: { online: vikings.filter((v) => v.online).map((v) => v.name), serverOnline: true },
          worldDay: 1 + Math.floor(minute / 20),
          occurredAt: simIso(minute, 30),
        }),
      );
    }

    // ── stats: every viking grows, and posts its cumulative every 2 minutes ──
    for (const v of vikings) if (v.online) tickStats(v);

    // ── the boss fight: eight vikings hit Eikthyr over five minutes ─────────
    if (minute >= BOSS_MINUTE - 4 && minute <= BOSS_MINUTE) {
      const fighters = vikings.filter((v) => v.online).slice(0, 8);
      if (expected.bossFighters.length === 0) {
        expected.bossFighters = fighters.map((v) => v.name);
      }
      const owner = fighters[0]; // whichever client owns the ZDO records EVERYONE's damage
      for (const f of fighters) {
        const blow = Math.round(between(40, 90)) + f.i * 3;
        expected.bossDamageTotals[f.name] = (expected.bossDamageTotals[f.name] ?? 0) + blow;
        if (f === owner) {
          // The owner's own entry carries its own damage (the reporter-own path).
          owner.bossDamage[BOSS_OBJECT] = (owner.bossDamage[BOSS_OBJECT] ?? 0) + blow;
        } else {
          // Everyone else's blows are recorded on the OWNER's client only, as
          // bystander entries — Character.RPC_Damage runs on the ZDO owner. Their
          // own snapshots carry no boss damage at all, which is exactly the shape
          // of the 2026-08-28 Eikthyr incident.
          const bucket = (owner.observedOf[f.name] ??= {});
          bucket[BOSS_OBJECT] = (bucket[BOSS_OBJECT] ?? 0) + blow;
        }
      }
    }

    // ── the second boss: nobody files a fight record for this one ───────────
    // Same ZDO-owner shape as Eikthyr — the owner's own blows ride its own
    // entry, everyone else's ride the owner's bystander entries — but no
    // bossKillEvents ever, from any producer. See the ELDER_* block above.
    if (ELDER_PARTY.length >= 2 && minute > ELDER_MINUTE - 4 && minute <= ELDER_MINUTE) {
      const party = ELDER_PARTY.map((i) => vikings[i]);
      if (expected.elderFighters.length === 0) expected.elderFighters = party.map((v) => v.name);
      const owner = party[0];
      for (const f of party) {
        const blow = Math.round(between(30, 70)) + f.i * 2;
        expected.elderDamage[f.name] = (expected.elderDamage[f.name] ?? 0) + blow;
        if (f === owner) {
          owner.bossDamage[ELDER_OBJECT] = (owner.bossDamage[ELDER_OBJECT] ?? 0) + blow;
        } else {
          const bucket = (owner.observedOf[f.name] ??= {});
          bucket[ELDER_OBJECT] = (bucket[ELDER_OBJECT] ?? 0) + blow;
        }
      }
    }

    if (minute % 2 === 0) {
      for (const v of vikings) {
        if (!v.online) continue;
        jobs.push(gsClientPost(v));
      }
      const isKillTick = minute === BOSS_MINUTE;
      // The Elder's kill key rides the SAME milestones array and nothing else:
      // no bossKillEvents entry accompanies it, ever.
      const isElderKillTick = ELDER_PARTY.length >= 2 && minute === ELDER_KILL_TICK;
      const top = Object.entries(expected.bossDamageTotals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      jobs.push(
        emitterPost(minute, {
          milestones: [
            ...(isKillTick
              ? [{ key: 'defeated_eikthyr', label: 'Eikthyr defeated', kind: 'boss', tsUtc: simIso(minute, 40) }]
              : []),
            ...(isElderKillTick
              ? [{ key: 'defeated_gdking', label: 'The Elder defeated', kind: 'boss', tsUtc: simIso(minute, 40) }]
              : []),
          ],
          bossKillEvents: isKillTick
            ? [
                {
                  boss: BOSS_OBJECT,
                  fightSec: 240,
                  firstBlood: expected.bossFighters[0],
                  topDamagePlayer: top?.[0] ?? null,
                  topDamage: Math.round(top?.[1] ?? 0),
                  participants: expected.bossFighters.length,
                  tsUtc: simIso(minute, 40),
                },
              ]
            : [],
        }),
      );
    }

    // ── cartography every 5 minutes ─────────────────────────────────────────
    if (minute % 5 === 0) {
      for (const v of vikings) {
        if (!v.online) continue;
        v.exploredPct = Math.min(100, v.exploredPct + 0.2);
        jobs.push(gsMapPost(v));
      }
    }

    // ── deaths ──────────────────────────────────────────────────────────────
    for (const d of deathSchedule) {
      if (d.minute !== minute) continue;
      const v = vikings[d.who];
      if (!v.online) continue;
      jobs.push(die(v, minute, d.sec));
    }
    for (const c of corpseRuns) {
      if (c.minute !== minute) continue;
      const v = vikings[c.who];
      if (!v.online) continue;
      // A corpse run: die, sprint back, die again 60 s later. Both are real.
      jobs.push(
        (async () => {
          const first = await die(v, minute, c.sec);
          const second = await die(v, minute + 1, c.sec2);
          expected.corpseRunPairs.push({ name: v.name, first: first.tsUtc, second: second.tsUtc });
        })(),
      );
    }

    // ── relogs ──────────────────────────────────────────────────────────────
    for (const r of relogs) {
      const v = vikings[r.who];
      if (r.leave === minute) jobs.push(leaveViking(v, minute, 15));
      if (r.join === minute) jobs.push(joinViking(v, minute, 15));
    }

    // ── the impostor: a second join of an existing name, different SteamID ───
    if (minute === IMPOSTOR_MINUTE) {
      const victim = byName.get('Ulf') ?? vikings[0];
      expected.impostor = { name: victim.name, bound: victim.steamId, seen: '76561199999999999' };
      jobs.push(
        (async () => {
          const res = await webhook('webhook join (impostor)', {
            type: 'join',
            characterName: victim.name,
            steamId: '76561199999999999',
            occurredAt: simIso(minute, 33),
          });
          expected.impostor.response = res.json;
        })(),
      );
    }

    // ── the end of the evening: everybody logs off at once ──────────────────
    if (minute === cfg.simMinutes - 5) {
      console.log('[stress] closing time: every viking leaves at once');
      await Promise.all(jobs);
      await Promise.all(vikings.filter((v) => v.online).map((v) => leaveViking(v, minute, v.i)));
      await webhook('webhook sync', {
        type: 'sync',
        metadata: { online: [], serverOnline: true },
        occurredAt: simIso(minute, 55),
      });
      await emitterPost(minute);
      continue;
    }

    await Promise.all(jobs);

    if (minute % 30 === 0) {
      const el = Math.round((Date.now() - t0) / 1000);
      const reqs = [...samples.values()].reduce((a, s) => a + s.ms.length, 0);
      console.log(`[stress] sim minute ${minute}/${cfg.simMinutes} — ${fmt(reqs)} requests, ${el}s real`);
    }

    const spent = Date.now() - tickStart;
    if (spent < cfg.tickMs) await sleep(cfg.tickMs - spent);
  }

  // Final reconciliation, the way the poller and Emitter both settle down.
  await webhook('webhook sync', {
    type: 'sync',
    metadata: { online: [], serverOnline: true },
    occurredAt: simIso(cfg.simMinutes, 0),
  });
  await emitterPost(cfg.simMinutes);

  console.log(`[stress] simulation complete in ${Math.round((Date.now() - t0) / 1000)}s real.`);
}

// ── latency table ────────────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function latencyTable() {
  const rows = [];
  for (const [label, s] of [...samples.entries()].sort()) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const non2xx = [...s.codes.entries()].filter(([c]) => c < 200 || c >= 300);
    rows.push({
      endpoint: label,
      n: s.ms.length,
      p50: Math.round(quantile(sorted, 0.5)),
      p95: Math.round(quantile(sorted, 0.95)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
      non2xx: non2xx.reduce((a, [, n]) => a + n, 0),
      codes: Object.fromEntries([...s.codes.entries()].sort()),
      retries: s.retries,
    });
  }
  return rows;
}

function printTable(rows, cols) {
  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((s, i) => String(s).padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.header)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

// ── invariant checks (through the local REST API) ─────────────────────────────

async function rest(path) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** PostgREST caps a page at 1000 rows; walk it. */
async function restAll(path) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 1000) {
    const page = await rest(`${path}${sep}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function restPatch(path, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function abort(message) {
  console.error(`\n[stress] REFUSING TO RUN\n${message}\n`);
  process.exit(2);
}

/**
 * Prove, before writing anything, that the site at BASE_URL is backed by the
 * database at SUPABASE_URL.
 *
 * The check that matters: stamp a sentinel world day straight into the local
 * `server_status` row through PostgREST, then ask the SITE for it. A `next start`
 * whose `NEXT_PUBLIC_SUPABASE_URL` was inlined at build time answers from
 * whatever project it was BUILT against — production — and cannot echo a number
 * that only exists here. That is the one failure the URL shape check cannot see,
 * and it is not hypothetical: it is what happened on the first attempt at this
 * test (docs/STRESS-TEST.md §2).
 *
 * The sentinel is deliberately NOT drawn from the seeded RNG, so preflight can
 * never shift the death schedule.
 */
async function preflight() {
  let before;
  try {
    [before] = await rest('server_status?select=*&id=eq.1');
  } catch (e) {
    abort(`SUPABASE_URL ${cfg.supabaseUrl} did not answer: ${e.message}\nIs the local stack up? See docs/STRESS-TEST.md §1.`);
  }
  if (!before) {
    abort(`${cfg.supabaseUrl} has no server_status row 1 — this is not a database built from db/*.sql. See docs/STRESS-TEST.md §1.`);
  }

  const sentinel = 900 + Math.floor(Math.random() * 90);
  await restPatch('server_status?id=eq.1', { world_day: sentinel });

  let seen = null;
  let siteError = null;
  try {
    const res = await fetch(`${cfg.base}/api/status`, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    seen = (await res.json()).worldDay;
  } catch (e) {
    siteError = e?.message ?? String(e);
  }

  // Put it back before deciding anything, so a refusal leaves no trace.
  await restPatch('server_status?id=eq.1', { world_day: before.world_day ?? 0 });

  if (siteError) {
    abort(`BASE_URL ${cfg.base}/api/status did not answer: ${siteError}\nIs the local site up? See docs/STRESS-TEST.md §2.`);
  }
  if (seen !== sentinel) {
    abort(
      `THE SITE AT ${cfg.base} IS NOT READING ${cfg.supabaseUrl}.\n` +
        `  wrote world_day=${sentinel} into the local server_status row; /api/status answered worldDay=${seen}.\n` +
        '  Almost certainly a production .next: NEXT_PUBLIC_SUPABASE_URL is inlined at BUILD time, so exporting\n' +
        '  it before `next start` changes nothing and every write this harness makes would land in PRODUCTION.\n' +
        '  Fix it before re-running — docs/STRESS-TEST.md §2 has both workarounds.',
    );
  }
  console.log(`[stress] preflight: ${cfg.base} reads ${cfg.supabaseUrl} (sentinel world day ${sentinel} echoed back).`);
}

const checks = [];
function check(name, ok, evidence, recommendation = '') {
  checks.push({ name, ok: ok ? 'PASS' : 'FAIL', evidence, recommendation });
  return ok;
}

/**
 * A check that could not be run at all.
 *
 * SKIP is not PASS. `--verify-only` without a saved expectation file cannot know
 * how many deaths were meant to happen or who fought the boss, and a check that
 * silently reports success on nothing it actually compared is worse than no
 * check — the whole point of finding those two vacuous passes was that they read
 * as evidence. Skips are printed in the table, counted separately in the summary
 * and recorded in results.json.
 */
function skipCheck(name, reason) {
  checks.push({ name, ok: 'SKIP', evidence: reason, recommendation: '' });
  return false;
}

async function verify() {
  console.log('\n=== invariants ===');

  const [events, sessions, players, stats, bosses, milestones, voice, chat, positions, oaths] = await Promise.all([
    restAll('events?select=id,type,character_name,player_id,metadata,created_at&order=created_at.asc'),
    restAll('sessions?select=id,character_name,player_id,joined_at,left_at,duration_minutes&order=joined_at.asc'),
    restAll('players?select=id,character_name,steam_id,is_online,current_title,last_seen_at'),
    restAll('player_stats?select=*'),
    restAll('bosses?select=id,name,is_killed,killed_at,players_present,fight_stats'),
    restAll('milestones?select=id,metric,threshold,title,achieved_at,achieved_value,announced_at'),
    restAll('voice_lines?select=id,text,kind,status,meta,queued_at'),
    restAll('chat_lines?select=id,character_name,message'),
    restAll('player_positions?select=character_name,x,z,biome,updated_at'),
    restAll('oaths?select=character_name,oath_text,match_status'),
  ]);

  const deaths = events.filter((e) => e.type === 'death');
  const statsByPid = new Map(stats.map((s) => [s.player_id, s]));
  const pidByName = new Map(players.map((p) => [p.character_name, p.id]));

  // 1. exactly one events row per real death
  //
  // The comparison is against the number of DISTINCT `${name}|${tsUtc}` keys,
  // because that is the key lib/deaths.ts:222 derives and the one
  // db/2026-09-04_ingest_death.sql dedupes on. The self-check below makes the
  // difference visible instead of letting a harness collision be read as a
  // production defect.
  if (!expectationsAvailable) {
    skipCheck('one events row per real death', `no expectations loaded; the database holds ${deaths.length} death rows`);
    skipCheck('harness death schedule collided with nothing', 'no expectations loaded');
  } else {
    check(
      'harness death schedule collided with nothing',
      expected.deathKeys.size === expected.realDeaths,
      `${expected.realDeaths} deaths fired, ${expected.deathKeys.size} distinct (name|tsUtc) keys`,
      'THIS HARNESS, not production: two deaths shared a key, so the server correctly stored one row. See claimSecond() in runSimulation.',
    );
    check(
      'one events row per real death',
      deaths.length === expected.deathKeys.size,
      `expected ${expected.deathKeys.size} deaths, found ${deaths.length} rows`,
      deaths.length > expected.deathKeys.size
        ? 'gs/eilif twins survived — check db/2026-09-04_ingest_death.sql is applied and lib/deaths.ts:406 is reaching the rpc'
        : 'deaths were lost — check /api/gs-ingest presence gate (app/api/gs-ingest/route.ts confirmOnThisServer) and lib/deaths.ts:569',
    );
  }

  // 1b. no gs/eilif twins: no two death rows for the same viking within 2 s
  const twins = [];
  const byViking = new Map();
  for (const d of deaths) {
    const list = byViking.get(d.character_name) ?? [];
    list.push(d);
    byViking.set(d.character_name, list);
  }
  for (const [name, list] of byViking) {
    const times = list.map((d) => Date.parse(d.created_at)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < 2000) twins.push(`${name} ${new Date(times[i - 1]).toISOString()}`);
    }
  }
  check('no gs/eilif twin death rows (<2s apart)', twins.length === 0, twins.length ? twins.join(', ') : 'none', 'lib/deaths.ts:406 / db/2026-09-04_ingest_death.sql');

  // 1c. every death row carries the authoritative eilif cause
  const withEilifCause = deaths.filter((d) => d.metadata?.causeSource === 'eilif');
  check(
    'every death row carries the eilif cause',
    withEilifCause.length === deaths.length,
    `${withEilifCause.length}/${deaths.length} rows have metadata.causeSource='eilif'`,
    'a row without it means the eilif report lost its race or was dropped — lib/deaths.ts ingestEilifDeath',
  );

  // 1d. corpse-run doubles both survived
  const corpseOk = expected.corpseRunPairs.every((p) => {
    const list = byViking.get(p.name) ?? [];
    return list.some((d) => d.created_at.startsWith(p.first.slice(0, 19))) &&
      list.some((d) => d.created_at.startsWith(p.second.slice(0, 19)));
  });
  if (!expectationsAvailable) {
    skipCheck('corpse-run doubles (60s apart) both kept', 'no expectations loaded — the pairs are only known to the run that fired them');
  } else {
    check(
      'corpse-run doubles (60s apart) both kept',
      expected.corpseRunPairs.length > 0 && corpseOk,
      `${expected.corpseRunPairs.length} pairs: ${expected.corpseRunPairs.map((p) => p.name).join(', ')}`,
      'a lost second death means the +/-3-min window collapsed two real deaths — db/2026-09-04_ingest_death.sql',
    );
  }

  // 2. every session closed with a plausible duration
  const open = sessions.filter((s) => !s.left_at);
  const implausible = sessions.filter(
    (s) => s.left_at && (s.duration_minutes === null || s.duration_minutes < 0 || s.duration_minutes > cfg.simMinutes + 5),
  );
  // The join count is a property of the RUN, so `--verify-only` reads it back
  // with the rest of the expectations rather than comparing against zero.
  if (expected.sessionsExpected == null) expected.sessionsExpected = vikings.reduce((a, v) => a + v.sessions.length, 0);
  const expectedSessions = expected.sessionsExpected;
  check('every session closed', open.length === 0, `${open.length} sessions still open of ${sessions.length}`, 'app/api/webhook/route.ts §5 leave branch');
  if (!expectationsAvailable) {
    skipCheck('session count matches joins', `no expectations loaded; the database holds ${sessions.length} sessions`);
  } else {
    check('session count matches joins', sessions.length === expectedSessions, `expected ${expectedSessions}, found ${sessions.length}`, 'app/api/webhook/route.ts §5 join replay guard');
  }
  check('session durations plausible', implausible.length === 0, implausible.length ? JSON.stringify(implausible.slice(0, 3)) : 'all within 0..' + (cfg.simMinutes + 5) + ' min', 'app/api/webhook/route.ts §5');

  // 3. players.steam_id bound for everyone
  const unbound = players.filter((p) => !p.steam_id).map((p) => p.character_name);
  check('players.steam_id bound for every viking', unbound.length === 0, unbound.length ? unbound.join(', ') : `${players.length}/${players.length} bound`, 'app/api/webhook/route.ts §3b');
  const misbound = vikings.filter((v) => {
    const row = players.find((p) => p.character_name === v.name);
    return row && row.steam_id !== v.steamId;
  });
  check('steam_id equals the FIRST account seen', misbound.length === 0, misbound.length ? misbound.map((v) => v.name).join(', ') : 'first-sight binding held for all', 'app/api/webhook/route.ts §3b decideIdentity');

  // 3b. the impostor was flagged, not bound
  const imp = expected.impostor;
  const impRow = imp ? players.find((p) => p.character_name === imp.name) : null;
  const impEvents = imp
    ? events.filter((e) => e.type === 'join' && e.character_name === imp.name && e.metadata?.identity === 'steam_mismatch')
    : [];
  if (!expectationsAvailable) {
    skipCheck('impostor join flagged and NOT bound', 'no expectations loaded — the harness cannot know which viking was impersonated');
  } else {
    check(
      'impostor join flagged and NOT bound',
      Boolean(imp && impRow?.steam_id === imp.bound && impEvents.length === 1 && imp.response?.identityMismatch === true),
      imp
        ? `bound=${impRow?.steam_id} (expected ${imp.bound}); flagged join rows=${impEvents.length}; response.identityMismatch=${imp.response?.identityMismatch}`
        : 'no impostor scenario ran',
      'app/api/webhook/route.ts §3b',
    );
  }

  // 4. player_stats equal the final cumulative values (raw - baseline)
  //
  // COUNT WHAT WAS ACTUALLY COMPARED. A viking whose snapshots were all refused
  // — a 429 storm, a world-guard mismatch, the presence gate — has no baseline
  // to difference against, and skipping it silently while still printing
  // "20 vikings matched on 6 columns each" is a fabricated pass on the invariant
  // that guards lib/gs-baseline.ts. A viking this check could not verify must
  // never read as a viking it verified.
  const statMismatch = [];
  const statSkipped = [];
  let statCompared = 0;
  for (const v of vikings) {
    const pid = pidByName.get(v.name);
    const row = pid ? statsByPid.get(pid) : null;
    if (!row) {
      statMismatch.push(`${v.name}: no player_stats row`);
      continue;
    }
    if (!v.baseline || !v.posted) {
      statSkipped.push(v.name);
      continue;
    }
    statCompared += 1;
    const want = {
      kills: v.posted.kills - v.baseline.kills,
      deaths: v.posted.deaths - v.baseline.deaths,
      structures_built: v.posted.builds - v.baseline.builds,
      items_crafted: v.posted.crafts - v.baseline.crafts,
      damage_dealt: v.posted.damage - v.baseline.damage,
      resources_harvested: (v.posted.pickups + v.posted.fish) - (v.baseline.pickups + v.baseline.fish),
    };
    for (const [col, w] of Object.entries(want)) {
      const got = Number(row[col] ?? 0);
      if (Math.abs(got - w) > 0.5) statMismatch.push(`${v.name}.${col}: expected ${w}, got ${got}`);
    }
  }
  if (!expectationsAvailable && statCompared === 0) {
    skipCheck(
      'player_stats equal the posted cumulative minus the zero-point',
      `no expectations loaded — nothing to difference against for ${vikings.length} vikings`,
    );
  } else {
    check(
      'player_stats equal the posted cumulative minus the zero-point',
      statMismatch.length === 0 && statSkipped.length === 0,
      `${statCompared} of ${vikings.length} vikings compared on 6 columns each` +
        (statSkipped.length ? `; NOT COMPARED (no accepted snapshot): ${statSkipped.join(', ')}` : '') +
        (statMismatch.length ? ` | ${statMismatch.slice(0, 6).join(' | ')}` : ''),
      statSkipped.length
        ? 'those vikings never had a snapshot accepted — look at the non-2xx column for gs-ingest client before blaming the baseline'
        : 'lib/gs-baseline.ts applyBaseline / mergeIntoRow',
    );
  }

  // 5. the boss
  const boss = bosses.find((b) => b.name === BOSS_ROW);
  const fs = boss?.fight_stats ?? null;
  const fighters = Array.isArray(fs?.fighters) ? [...fs.fighters].sort() : [];
  const wantFighters = [...expected.bossFighters].sort();
  check('Eikthyr is_killed', boss?.is_killed === true, `is_killed=${boss?.is_killed} killed_at=${boss?.killed_at}`, 'app/api/gs-ingest/route.ts ingestBossMilestones');

  /** Compare a stored per-fighter damage map against what the harness dealt. */
  const damageMismatch = (stored, want, tol = 2) => {
    const got = stored && typeof stored === 'object' ? stored : {};
    const out = [];
    for (const [nm, w] of Object.entries(want)) {
      const g = Number(got[nm] ?? 0);
      if (Math.abs(g - Math.round(w)) > tol) out.push(`${nm}: expected ${Math.round(w)}, got ${got[nm] ?? 'absent'}`);
    }
    for (const nm of Object.keys(got)) if (!(nm in want)) out.push(`${nm}: credited ${got[nm]} but never swung`);
    return out;
  };

  if (!expectationsAvailable) {
    for (const n of [
      'Eikthyr fighters == the 8 attackers',
      'Eikthyr per-fighter damage attributed correctly',
      'Eikthyr MVP summary written verbatim (an echo — see The Elder for the fold)',
      'Eikthyr damage total not double-counted',
    ]) skipCheck(n, 'no expectations loaded — the war party and the damage are only known to the run that dealt them');
  } else {
    check(
      'Eikthyr fighters == the 8 attackers',
      JSON.stringify(fighters) === JSON.stringify(wantFighters),
      `expected [${wantFighters.join(', ')}] got [${fighters.join(', ')}]`,
      'lib/boss-damage.ts foldClientDamage / foldObservedDamage',
    );
    // Per FIGHTER, not just the sum: a sum can be right while every blow is
    // credited to the wrong viking, which is the precise error the 2026-08-28
    // incident produced (one client's own damage standing in for the war party).
    const perFighter = damageMismatch(fs?.damage, expected.bossDamageTotals);
    check(
      'Eikthyr per-fighter damage attributed correctly',
      perFighter.length === 0,
      perFighter.length ? perFighter.slice(0, 4).join(' | ') : `${Object.keys(expected.bossDamageTotals).length} fighters, each credited exactly their own blows`,
      'lib/boss-damage.ts foldClientDamage (own entry) / foldObservedDamage (the ZDO owner’s bystander readings)',
    );
    const wantTop = Object.entries(expected.bossDamageTotals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    // BE HONEST ABOUT WHAT THIS ONE PROVES. Eikthyr is felled WITH an Emitter MVP
    // summary, and planBossKillUpdate writes that summary's verdict verbatim
    // (lib/boss-damage.ts:530) — by design, because a fight record knows what a
    // career total cannot. So this asserts the summary survived the merge; it is
    // an echo of what the harness sent and proves nothing about the fold. The
    // fold's own verdict is tested on The Elder, where no summary exists at all.
    check(
      'Eikthyr MVP summary written verbatim (an echo — see The Elder for the fold)',
      fs?.topDamagePlayer === wantTop?.[0] && Math.abs((fs?.topDamage ?? 0) - Math.round(wantTop?.[1] ?? 0)) <= 2,
      `sent ${wantTop?.[0]} ${Math.round(wantTop?.[1] ?? 0)}, stored ${fs?.topDamagePlayer} ${fs?.topDamage}`,
      'lib/boss-damage.ts planBossKillUpdate — a server report owns the fight record',
    );
    const damageSum = Object.values(fs?.damage ?? {}).reduce((a, b) => a + b, 0);
    const wantSum = Object.values(expected.bossDamageTotals).reduce((a, b) => a + b, 0);
    check(
      'Eikthyr damage total not double-counted',
      Math.abs(damageSum - wantSum) <= 8,
      `expected ~${Math.round(wantSum)}, got ${Math.round(damageSum)}`,
      'lib/boss-damage.ts — own-entry and observed damage must stay disjoint',
    );
  }
  const bossEvents = events.filter((e) => e.type === 'boss' && e.metadata?.boss === BOSS_ROW);
  check('exactly one boss event row', bossEvents.length === 1, `${bossEvents.length} rows`, 'app/api/gs-ingest/route.ts ingestBossMilestones guarded flip');

  // 5b. THE SECOND BOSS — the 2026-08-28 incident, replayed.
  //
  // The Elder is felled by the `defeated_gdking` milestone key alone: no
  // bossKillEvents entry from anyone, so nothing echoes anything. Every name and
  // every number below can only have come from the client-damage fold, which is
  // the whole reason lib/boss-damage.ts exists.
  const elder = bosses.find((b) => b.name === ELDER_ROW);
  const efs = elder?.fight_stats ?? null;
  if (!expectationsAvailable || expected.elderFighters.length < 2) {
    for (const n of [
      'The Elder felled by the milestone alone',
      'The Elder war party derived from the damage fold',
      'The Elder top damage COMPUTED by the fold (not echoed)',
      'The Elder per-fighter damage attributed correctly',
    ]) skipCheck(n, expectationsAvailable ? 'the roster was too small for a second war party' : 'no expectations loaded');
  } else {
    const eFighters = Array.isArray(efs?.fighters) ? [...efs.fighters].sort() : [];
    const wantEFighters = [...expected.elderFighters].sort();
    const wantETop = Object.entries(expected.elderDamage).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    check(
      'The Elder felled by the milestone alone',
      elder?.is_killed === true,
      `is_killed=${elder?.is_killed} killed_at=${elder?.killed_at} source=${efs?.source}`,
      'app/api/gs-ingest/route.ts ingestBossMilestones — the guarded flip',
    );
    check(
      'The Elder war party derived from the damage fold',
      JSON.stringify(eFighters) === JSON.stringify(wantEFighters),
      `expected [${wantEFighters.join(', ')}] got [${eFighters.join(', ')}]`,
      'nothing reported fighters for this boss — an empty list is the 2026-08-28 failure. lib/boss-damage.ts foldClientDamage / foldObservedDamage, and the flip must UNION rather than replace (ingestBossMilestones).',
    );
    check(
      'The Elder top damage COMPUTED by the fold (not echoed)',
      efs?.topDamagePlayer === wantETop?.[0] &&
        Math.abs((efs?.topDamage ?? 0) - Math.round(wantETop?.[1] ?? 0)) <= 2 &&
        efs?.topDamageFrom === 'gs-client-damage',
      `expected ${wantETop?.[0]} ${Math.round(wantETop?.[1] ?? 0)} from gs-client-damage, got ${efs?.topDamagePlayer} ${efs?.topDamage} from ${efs?.topDamageFrom ?? 'nothing'}`,
      'lib/boss-damage.ts foldClientDamage verdict + verdictIsOurs; the milestone flip must preserve topDamageFrom (ingestBossMilestones spreads `prior` first)',
    );
    const ePerFighter = damageMismatch(efs?.damage, expected.elderDamage);
    check(
      'The Elder per-fighter damage attributed correctly',
      ePerFighter.length === 0,
      ePerFighter.length ? ePerFighter.slice(0, 4).join(' | ') : `${wantEFighters.length} fighters, each credited exactly their own blows`,
      'lib/boss-damage.ts — the ZDO owner’s observed readings must land on the observed viking, not the observer',
    );
  }

  // 6. milestones: achieved_at set once per crossed threshold
  const achieved = milestones.filter((m) => m.achieved_at);
  const sagaDeeds = events.filter((e) => e.type === 'milestone' || e.metadata?.milestone);
  check(
    'at least one Great Deed crossed',
    achieved.length > 0,
    `${achieved.length} of ${milestones.length}: ${achieved.map((m) => m.id).join(', ')}`,
    'lib/milestones.ts evaluateAndRecord',
  );
  check(
    'one saga event per achieved deed',
    sagaDeeds.length === achieved.length,
    `${achieved.length} achieved, ${sagaDeeds.length} saga rows`,
    'lib/milestones.ts evaluateAndRecord',
  );

  // 7. titles unique per roster
  const titled = players.filter((p) => p.current_title);
  const titleCounts = new Map();
  for (const p of titled) titleCounts.set(p.current_title, (titleCounts.get(p.current_title) ?? 0) + 1);
  const dupTitles = [...titleCounts.entries()].filter(([, n]) => n > 1);
  // Uniqueness AND coverage. Uniqueness alone passes when nobody has a title at
  // all (a dead announcer, an unreachable /api/titles, a throwing epithet
  // engine) — zero titles have zero duplicates. epithetsFor's pass B gives every
  // roster member a de-duplicated placeholder, so full coverage is the honest
  // bar: anything less means the announcer never saw part of the roster.
  const untitled = players.filter((p) => !p.current_title).map((p) => p.character_name);
  check(
    'titles unique per roster, and everyone has one',
    dupTitles.length === 0 && titled.length === players.length && players.length > 0,
    `${titled.length}/${players.length} titled` +
      (dupTitles.length ? `; DUPLICATES ${dupTitles.map(([t, n]) => `${t} x${n}`).join(', ')}` : ', all distinct') +
      (untitled.length ? `; UNTITLED ${untitled.slice(0, 6).join(', ')}` : ''),
    untitled.length
      ? 'services/discord-bot/src/titles.js seeds players.current_title from /api/titles — check the titles loop ran and the API answered'
      : 'lib/epithets.ts epithetsFor',
  );

  // 8. server_status
  const [status] = await rest('server_status?select=*&id=eq.1');
  check(
    'server_status.player_count matches the roster',
    status?.player_count === 0 && Array.isArray(status?.current_players) && status.current_players.length === 0,
    `player_count=${status?.player_count} current_players=${JSON.stringify(status?.current_players)} world_day=${status?.world_day}`,
    'app/api/webhook/route.ts §2b sync + §6',
  );
  const stillOnline = players.filter((p) => p.is_online).map((p) => p.character_name);
  check('no viking left marked online', stillOnline.length === 0, stillOnline.length ? stillOnline.join(', ') : 'all offline', 'app/api/webhook/route.ts §2b');

  // 9. voice lines
  check('voice_lines queued', voice.length > 0, `${voice.length} lines (${[...new Set(voice.map((v) => v.kind))].join(', ')})`, 'services/discord-bot/src/voice.js');

  // 10. no 5xx anywhere
  const fivexx = [...samples.entries()].flatMap(([label, s]) =>
    [...s.codes.entries()].filter(([c]) => c >= 500).map(([c, n]) => `${label} ${c}x${n}`),
  );
  check('no 5xx responses', fivexx.length === 0, fivexx.length ? fivexx.join(', ') : 'none', '');

  // 11. supporting surfaces did not silently drop data
  check('chat mirrored', chat.length > 0, `${chat.length} chat_lines`, 'app/api/webhook/route.ts §2g');
  check('positions upserted one row per viking', positions.length === vikings.length, `${positions.length} rows for ${vikings.length} vikings`, 'app/api/webhook/route.ts §2h');
  check('oaths recorded and matched', oaths.length > 0 && oaths.every((o) => o.match_status === 'exact'), `${oaths.length} oaths, ${oaths.filter((o) => o.match_status === 'exact').length} matched`, 'app/api/webhook/route.ts §2e');

  return { events, sessions, players, stats, bosses, milestones, voice, status };
}

// ── main ─────────────────────────────────────────────────────────────────────

const started = new Date().toISOString();
await preflight();
if (cfg.verifyOnly) rehydrateExpectations();
else await runSimulation();

const table = latencyTable();
console.log('\n=== latency (ms) + response codes ===');
printTable(table, [
  { header: 'endpoint', get: (r) => r.endpoint },
  { header: 'n', get: (r) => r.n },
  { header: 'p50', get: (r) => r.p50 },
  { header: 'p95', get: (r) => r.p95 },
  { header: 'max', get: (r) => r.max },
  { header: 'non-2xx', get: (r) => r.non2xx },
  { header: 'retries', get: (r) => r.retries },
  { header: 'codes', get: (r) => JSON.stringify(r.codes) },
]);

// Give the Discord bot's loops (milestones, titles, voice) a moment to see the
// final state before the invariants read it — they run on their own timers.
if (!cfg.verifyOnly) {
  const settle = intEnv('SETTLE_MS', 45000);
  console.log(`\n[stress] settling ${settle}ms so the bot's milestone/title/voice loops can run...`);
  await sleep(settle);
}

const results = await verify();

console.log('\n=== invariant table ===');
printTable(checks, [
  { header: 'result', get: (r) => r.ok },
  { header: 'invariant', get: (r) => r.name },
  { header: 'evidence', get: (r) => r.evidence },
]);

const failed = checks.filter((c) => c.ok === 'FAIL');
const skipped = checks.filter((c) => c.ok === 'SKIP');
const passed = checks.filter((c) => c.ok === 'PASS');
console.log(
  `\n${passed.length}/${checks.length} invariants passed` +
    (skipped.length ? `, ${skipped.length} SKIPPED (checked nothing — not a pass)` : '') +
    `, ${failed.length} failed.`,
);
for (const f of failed) console.log(`  FAIL  ${f.name}\n        ${f.evidence}\n        -> ${f.recommendation}`);
for (const s of skipped) console.log(`  SKIP  ${s.name}\n        ${s.evidence}`);

const outPath = resolve(cfg.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      startedAt: started,
      finishedAt: new Date().toISOString(),
      // Every secret, not just the loud one: an operator who exports the real
      // WEBHOOK_SECRET and GS_EMITTER_TOKEN before a run must be able to share
      // this file without shipping them.
      config: { ...cfg, serviceKey: '<redacted>', webhookSecret: '<redacted>', emitterToken: '<redacted>' },
      latency: table,
      checks,
      // Everything `--verify-only` needs to re-check the same invariants later
      // rather than skipping them. See rehydrateExpectations().
      expected: {
        realDeaths: expected.realDeaths,
        deathKeys: [...expected.deathKeys],
        corpseRunPairs: expected.corpseRunPairs,
        bossFighters: expected.bossFighters,
        bossDamageTotals: expected.bossDamageTotals,
        elderFighters: expected.elderFighters,
        elderDamage: expected.elderDamage,
        impostor: expected.impostor,
        sessionsExpected: expected.sessionsExpected,
        vikingStats: Object.fromEntries(vikings.map((v) => [v.name, { baseline: v.baseline, posted: v.posted }])),
      },
      counts: {
        events: results.events.length,
        sessions: results.sessions.length,
        players: results.players.length,
        playerStats: results.stats.length,
        milestonesAchieved: results.milestones.filter((m) => m.achieved_at).length,
        voiceLines: results.voice.length,
        invariantsPassed: passed.length,
        invariantsFailed: failed.length,
        invariantsSkipped: skipped.length,
      },
    },
    null,
    2,
  ),
);
console.log(`\nresults -> ${outPath}`);
process.exit(failed.length > 0 ? 1 : 0);
