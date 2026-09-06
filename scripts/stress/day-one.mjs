#!/usr/bin/env node
// Day one on the launch world: the first evening, stage by stage.
//
// WHAT THIS IS FOR, and why it is not scripts/stress/run.mjs. run.mjs replays a
// mature six-hour evening at full roster to measure throughput and the death /
// boss / deed invariants. It starts at world day 1 but sprints to day 19 in
// twelve real minutes, every viking is online from minute zero, and it never
// stops to look at a page. None of that is launch night.
//
// Launch night is the states NOBODY has ever seen rendered, because until the
// wipe there has never been an empty database in front of a running site:
//
//   • the server up with world day 1 and NOBODY on it yet
//   • exactly ONE viking online, ONE oath sworn, ONE death — the counts where
//     English plural agreement is the only thing between us and "1 vikings"
//   • the first deed crossing, once
//   • titles seeding for a roster that has never had one
//   • Eikthyr felled on day 3 with the whole ledger still nearly empty
//
// So this runs in STAGES, one process per stage, with the cumulative state kept
// in a JSON file between them. That is the point: the rehearsal script curls the
// pages BETWEEN stages, so every step is looked at in the state it actually
// passes through rather than only at the end.
//
//   node scripts/stress/day-one.mjs --stage boot
//   node scripts/stress/day-one.mjs --stage first-join
//   node scripts/stress/day-one.mjs --stage day1
//   node scripts/stress/day-one.mjs --stage day2
//   node scripts/stress/day-one.mjs --stage day3
//   node scripts/stress/day-one.mjs --stage close
//   node scripts/stress/day-one.mjs --stage verify
//
// IT NEVER TOUCHES PRODUCTION: same loopback refusal as run.mjs, on both URLs.
// Node 20, standard library only.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ── configuration ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, dflt = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return dflt;
}

const cfg = {
  base: process.env.BASE_URL || 'http://localhost:3401',
  supabaseUrl: process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || 'stress-secret',
  emitterToken: process.env.GS_EMITTER_TOKEN || 'stress-emitter',
  // The launch world. GS_EXPECTED_WORLD on the serving site must match, or
  // /api/gs-ingest refuses every post with 409 — which is itself worth
  // rehearsing, since getting it wrong in Vercel is a documented launch step.
  world: flag('world', process.env.GS_EXPECTED_WORLD || 'Eilif'),
  state: flag('state', process.env.DAY_ONE_STATE || '/tmp/eilif-day-one-state.json'),
  stage: flag('stage', 'boot'),
  // The dry-run announcer's captured output. `verify` compares what the relay
  // actually POSTED against the rows the database HOLDS — see checkRelayCoverage
  // below for the night this was missing.
  botLog: flag('bot-log', process.env.BOT_LOG || null),
};

if (!cfg.serviceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required (the LOCAL one — see docs/STRESS-TEST.md).');
  process.exit(2);
}
function isLoopback(u) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}
if (!isLoopback(cfg.base) || !isLoopback(cfg.supabaseUrl)) {
  console.error(
    `Refusing to run: BASE_URL (${cfg.base}) and SUPABASE_URL (${cfg.supabaseUrl}) must both be loopback.`,
  );
  process.exit(2);
}

// ── the launch roster ────────────────────────────────────────────────────────
//
// Deliberately NOT run.mjs's roster. A page still showing Astrid or Þóra after
// the wipe is stale rehearsal data, and the rehearsal can only see that if the
// two rosters are disjoint. One non-ASCII name here too, for the same reason
// run.mjs has one: the identity path folds case and matches through ilike.
const NAMES = [
  'Alvis', 'Brynja', 'Dagfinn', 'Eyvind', 'Frida',
  'Geirmund', 'Hildr', 'Ingimar', 'Jorund', 'Kolbein',
  'Liv', 'Munin', 'Nanna', 'Oddvar', 'Rurik',
  'Solveig', 'Tyra', 'Vigdis', 'Ylva', 'Ævar',
];

const BIOMES = ['Meadows', 'BlackForest', 'Swamp', 'Mountain', 'Ocean'];
const CREATURES = ['$enemy_greydwarf', 'Neck', '$enemy_boar', 'Greyling(Clone)'];
const HIT_TYPES = ['EnemyHit', 'Fall', 'Drowning', 'Impact'];
const SHOUTS = [
  'first light on a new shore',
  'anyone seen my raft',
  'boar down',
  'meet at the big rock',
  'this is the spot',
];

// Deterministic RNG so a failure reproduces.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260909);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stage state, carried between processes ───────────────────────────────────
//
// Each stage is its own node process (so the rehearsal can look at the pages in
// between), which means the cumulative career every gs-ingest post carries has
// to survive on disk. `sim` is the wall-clock anchor: every stage's timestamps
// are offsets from it, so an evening rendered on the pages is contiguous even
// though the stages ran minutes apart in real time.
function freshState() {
  const startedAt = Date.now() - 3 * 60 * 60 * 1000; // the evening began 3h ago
  return {
    startedAt,
    world: cfg.world,
    stagesRun: [],
    online: [],
    deaths: [],           // { name, tsUtc }
    oaths: [],            // names
    bossFighters: [],
    bossDamage: {},       // name -> damage on Eikthyr
    career: {},           // name -> cumulative counters
    joins: 0,
    leaves: 0,
  };
}
function loadState() {
  if (!existsSync(cfg.state)) return freshState();
  try {
    return JSON.parse(readFileSync(cfg.state, 'utf8'));
  } catch {
    return freshState();
  }
}
function saveState(st) {
  mkdirSync(dirname(resolve(cfg.state)), { recursive: true });
  writeFileSync(resolve(cfg.state), JSON.stringify(st, null, 2));
}

const st = loadState();
// Minute 0 is the panel Start. Days are 20 simulated minutes wide, the same
// ratio run.mjs uses, so day 1 covers minutes 0-19 and Eikthyr falls on day 3.
const simIso = (minute, sec = 0) => new Date(st.startedAt + minute * 60_000 + sec * 1000).toISOString();
const dayOf = (minute) => 1 + Math.floor(minute / 20);

function steamIdOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `7656119${String(7000000000 + (h % 999999999)).slice(0, 10)}`;
}
function ipOf(name) {
  return `192.0.2.${20 + (NAMES.indexOf(name) % 200)}`;
}
function career(name) {
  return (st.career[name] ??= {
    kills: 0, deaths: 0, builds: 0, crafts: 0, damage: 0,
    walk: 0, run: 0, sail: 0, pickups: 0, fish: 0, longestLifeSec: 0, exploredPct: 0,
  });
}

// ── producers ────────────────────────────────────────────────────────────────

const stats = { n: 0, codes: new Map(), ms: [] };
async function post(label, url, body, headers) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  stats.n += 1;
  stats.ms.push(ms);
  stats.codes.set(res.status, (stats.codes.get(res.status) ?? 0) + 1);
  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    console.log(`  ! ${label} -> HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  return res;
}

const POLLER_IP = '203.0.113.10';
const SERVER_IP = '198.51.100.7';

const webhook = (label, body) =>
  post(label, `${cfg.base}/api/webhook`, body, {
    'x-webhook-secret': cfg.webhookSecret,
    'x-forwarded-for': POLLER_IP,
  });

async function emitter(minute, { milestones = [], bossKillEvents = [], online = null } = {}) {
  return post('gs-ingest server', `${cfg.base}/api/gs-ingest`, {
    schemaVersion: 1,
    game: 'valheim',
    source: 'server',
    world: cfg.world,
    emittedAtUtc: simIso(minute),
    onlinePlayers: online ?? st.online,
    worldDay: dayOf(minute),
    milestones,
    bossKillEvents,
  }, { authorization: `Bearer ${cfg.emitterToken}`, 'x-forwarded-for': SERVER_IP });
}

function selfEntry(name) {
  const c = career(name);
  const bossEntries = Object.entries(st.bossDamage[name] ?? {}).map(([boss, damageDealt]) => ({
    boss, damageDealt: Math.round(damageDealt), kills: 0, fightSec: 40,
  }));
  return {
    name,
    kills: c.kills,
    deaths: c.deaths,
    bossKills: 0,
    longestLifeSec: c.longestLifeSec,
    bestKillsBeforeDeath: 3,
    currentLifeStartedUtc: simIso(0),
    platformId: steamIdOf(name),
    stats: {
      vh_Builds: c.builds,
      vh_Crafts: c.crafts,
      vh_DistanceTraveled: c.walk + c.run + c.sail,
      vh_DistanceWalk: c.walk,
      vh_DistanceRun: c.run,
      vh_DistanceSail: c.sail,
      vh_DistanceAir: 0,
    },
    weapons: [{ weapon: 'Clubs', damageDealt: c.damage, kills: c.kills, hardestHit: 42, biggestSwing: 55 }],
    creatureKills: [{ creature: 'Greyling', kills: c.kills }],
    pickups: [{ item: 'Wood', count: c.pickups }, { item: 'Fish1', count: c.fish }],
    materials: [{ material: 'Wood', amount: c.pickups }],
    skills: [{ skill: 'Clubs', level: 8 }, { skill: 'Fishing', level: 2 }],
    boss: bossEntries,
    crafts: [{ item: 'ArrowWood', count: c.crafts }],
  };
}

/** Blows the ZDO owner watched everyone else land — the bystander shape. */
function bystanderEntries(reporter) {
  const observed = st.observedOf?.[reporter] ?? {};
  return Object.entries(observed).map(([name, byBoss]) => ({
    name,
    boss: Object.entries(byBoss).map(([boss, damageDealt]) => ({ boss, damageDealt: Math.round(damageDealt), kills: 0 })),
  }));
}

async function gsClient(name, deathEvents = []) {
  return post('gs-ingest client', `${cfg.base}/api/gs-ingest`, {
    schemaVersion: 1,
    game: 'valheim',
    world: cfg.world,
    source: 'client',
    reporter: name,
    emittedAtUtc: new Date().toISOString(),
    players: [selfEntry(name), ...bystanderEntries(name)],
    deathEvents,
  }, { 'x-forwarded-for': ipOf(name) });
}

async function gsMap(name) {
  const c = career(name);
  return post('gs-ingest client-map', `${cfg.base}/api/gs-ingest`, {
    schemaVersion: 1, game: 'valheim', world: cfg.world,
    source: 'client-map', playerName: name, exploredPct: c.exploredPct,
  }, { 'x-forwarded-for': ipOf(name) });
}

async function eilifDeath(name, d) {
  return post('gs-ingest eilif-death', `${cfg.base}/api/gs-ingest`, {
    schemaVersion: 1, game: 'valheim', world: cfg.world,
    source: 'eilif-death', player: name, reporter: name,
    tsUtc: d.tsUtc, hitType: d.hitType, attacker: d.attacker, biome: d.biome,
    pos: { x: Math.round(between(-2000, 2000)), z: Math.round(between(-2000, 2000)) },
  }, { 'x-forwarded-for': ipOf(name) });
}

async function join(name, minute, sec = 0) {
  const res = await webhook('join', {
    type: 'join', characterName: name, steamId: steamIdOf(name),
    occurredAt: simIso(minute, sec), worldDay: dayOf(minute),
  });
  if (!st.online.includes(name)) st.online.push(name);
  st.joins += 1;
  return res;
}

async function leave(name, minute, sec = 0) {
  const res = await webhook('leave', {
    type: 'leave', characterName: name, steamId: steamIdOf(name), occurredAt: simIso(minute, sec),
  });
  st.online = st.online.filter((n) => n !== name);
  st.leaves += 1;
  return res;
}

async function sync(minute, sec = 30) {
  return webhook('sync', {
    type: 'sync',
    metadata: { online: st.online, serverOnline: true },
    worldDay: dayOf(minute),
    occurredAt: simIso(minute, sec),
  });
}

async function positions(minute) {
  await Promise.all(st.online.map((name) => webhook('pos', {
    type: 'pos', characterName: name,
    x: Math.round(between(-1200, 1200)), z: Math.round(between(-1200, 1200)),
    biome: pick(BIOMES), occurredAt: simIso(minute, 5),
  })));
}

async function oath(name, minute, text) {
  st.oaths.push(name);
  return webhook('oath', {
    type: 'oath', characterName: name, text, steamId: steamIdOf(name), occurredAt: simIso(minute, 20),
  });
}

/** One death, both producers racing, exactly as the two plugins do it. */
async function die(name, minute, sec) {
  const tsUtc = simIso(minute, sec);
  const hitType = pick(HIT_TYPES);
  const d = { tsUtc, hitType, attacker: hitType === 'EnemyHit' ? pick(CREATURES) : null, biome: pick(BIOMES) };
  career(name).deaths += 1;
  st.deaths.push({ name, tsUtc });
  const jitter = Math.floor(rnd() * 10);
  await Promise.all([
    (async () => { await sleep(jitter); return eilifDeath(name, d); })(),
    (async () => {
      await sleep(10 - jitter);
      return gsClient(name, [{ playerName: name, tsUtc, killer: d.attacker ?? '', biome: d.biome, lifeSec: 420, killsThisLife: 2 }]);
    })(),
  ]);
  return d;
}

/** Roughly one evening-hour of play for one viking. Day one is modest by design. */
function grow(name, hours = 1) {
  const c = career(name);
  c.kills += Math.round(between(6, 18) * hours);
  c.builds += Math.round(between(20, 70) * hours);
  c.crafts += Math.round(between(8, 25) * hours);
  c.damage += Math.round(between(700, 2200) * hours);
  c.walk += Math.round(between(1800, 3200) * hours);
  c.run += Math.round(between(500, 1400) * hours);
  c.sail += Math.round(between(0, 400) * hours);
  c.pickups += Math.round(between(200, 600) * hours);
  if (rnd() < 0.3) c.fish += 1;
  c.longestLifeSec = Math.max(c.longestLifeSec, Math.round(between(600, 2400)));
  c.exploredPct = Math.min(100, c.exploredPct + between(0.1, 0.5) * hours);
}

// ── the stages ───────────────────────────────────────────────────────────────

const STAGES = {
  // The panel Start has happened and the Emitter's first post lands. Nobody has
  // joined. This is the state the GO post links people to.
  async boot() {
    await emitter(0, { online: [] });
    await sync(0);
    console.log(`  world '${cfg.world}' reported at day ${dayOf(0)}, roster empty`);
  },

  // ONE viking. Every "N vikings / N have sworn / N deaths" string on the site
  // renders at exactly one for the first time in this project's life.
  async ['first-join']() {
    await join(NAMES[0], 1);
    await sync(1);
    grow(NAMES[0], 0.2);
    await gsClient(NAMES[0]);
    await emitter(2);
    await oath(NAMES[0], 3, 'I will raise the first roof before I sleep');
    await positions(3);
    console.log(`  ${NAMES[0]} is online, one oath sworn`);
  },

  // The rest of the warband arrives across day 1 and settles in. Two more oaths
  // (so the count leaves 1 and the "N sworn" line has to agree at 3 as well).
  async day1() {
    for (const name of NAMES.slice(1)) {
      await join(name, 4 + Math.floor(rnd() * 6));
    }
    await sync(10);
    for (const name of st.online) grow(name, 0.6);
    await Promise.all(st.online.map((n) => gsClient(n)));
    await emitter(10);
    await positions(11);
    await oath(NAMES[3], 12, 'My axe answers when the horn sounds');
    await oath(NAMES[7], 13, 'No viking of this hall sails alone');
    // A few shouts, mirrored to Discord by the poller in production.
    await Promise.all(st.online.slice(0, 5).map((n, i) => webhook('chat', {
      type: 'chat', characterName: n, message: SHOUTS[i % SHOUTS.length], occurredAt: simIso(14, i),
    })));
    await webhook('pin', {
      type: 'pin', characterName: NAMES[0], steamId: steamIdOf(NAMES[0]),
      metadata: { name: 'Landfall', kind: 'base', worldX: 120, worldZ: -340 },
      occurredAt: simIso(15, 25),
    });
    await Promise.all(st.online.map((n) => gsMap(n)));
    await emitter(18);
    console.log(`  ${st.online.length} online, ${st.oaths.length} oaths, day ${dayOf(18)}`);
  },

  // Day 2 and the first blood of the season: ONE death, then two more, so the
  // How We Die board and the death counters are exercised at 1 and at 3.
  async day2() {
    await emitter(20);
    await die(NAMES[5], 22, 14);
    await sync(23);
    await emitter(24);
    for (const name of st.online) grow(name, 0.8);
    await Promise.all(st.online.map((n) => gsClient(n)));
    await die(NAMES[11], 30, 5);
    await die(NAMES[2], 33, 41);
    await positions(34);
    await emitter(36);
    console.log(`  day ${dayOf(36)}, ${st.deaths.length} deaths so far`);
  },

  // Day 3: eight vikings fell Eikthyr. The ZDO owner reports everyone else's
  // blows as bystanders, then the Emitter's defeated_eikthyr key and the fight
  // record land together — the shape a real first boss night has.
  async day3() {
    await emitter(40);
    for (const name of st.online) grow(name, 1);
    const fighters = st.online.slice(0, 8);
    st.bossFighters = fighters;
    const owner = fighters[0];
    st.observedOf = { [owner]: {} };
    for (const f of fighters) {
      const blow = Math.round(between(120, 260));
      st.bossDamage[f] = { ...(st.bossDamage[f] ?? {}), Eikthyr: blow };
      if (f === owner) continue;
      st.observedOf[owner][f] = { Eikthyr: blow };
    }
    await Promise.all(st.online.map((n) => gsClient(n)));
    await sleep(400); // let the damage fold settle before the milestone flip reads it
    const top = fighters
      .map((f) => [f, st.bossDamage[f].Eikthyr])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    await emitter(44, {
      milestones: [{ key: 'defeated_eikthyr', label: 'Eikthyr defeated', kind: 'boss', tsUtc: simIso(44, 40) }],
      bossKillEvents: [{
        boss: 'Eikthyr', fightSec: 260, firstBlood: fighters[0],
        topDamagePlayer: top[0], topDamage: Math.round(top[1]),
        participants: fighters.length, tsUtc: simIso(44, 40),
      }],
    });
    await positions(45);
    await emitter(46);
    console.log(`  Eikthyr felled on day ${dayOf(44)} by ${fighters.length}; top damage ${top[0]} ${Math.round(top[1])}`);
  },

  // Closing time. Everyone logs off and the poller sends its last roster sync.
  async close() {
    const leaving = [...st.online];
    for (const name of leaving) await leave(name, 50 + Math.floor(rnd() * 4));
    await sync(55);
    await emitter(56, { online: [] });
    console.log(`  ${leaving.length} left, roster empty`);
  },

  async verify() {
    await verify();
  },
};

// ── verification ─────────────────────────────────────────────────────────────

async function rest(path) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

const checks = [];
function check(name, ok, evidence) {
  checks.push({ name, ok: ok ? 'PASS' : 'FAIL', evidence });
}
// A check that could not be made is NOT a check that passed. It gets its own
// verdict so it can never be counted in the "N/N passed" line, which is the
// whole reason two rehearsals looked clean while the feed was missing 43% of
// the evening.
function skip(name, why) {
  checks.push({ name, ok: 'SKIP', evidence: why });
}

// The six stages that must have run, and what they must have left behind, for
// any of the checks below to mean anything.
const REQUIRED_STAGES = ['boot', 'first-join', 'day1', 'day2', 'day3', 'close'];
const EXPECTED = { joins: NAMES.length, deaths: 3, bossFighters: 8 };

// WHY THIS GATE EXISTS. Most checks below compare a filtered database count
// against a counter carried in the state file, so when the state file is empty
// BOTH sides are zero and the check passes vacuously: run verify against a
// wiped database with a fresh state file and it reports "0 sessions for 0
// joins  PASS", "0 death rows for 0 deaths  PASS", "0 of 0 oaths  PASS" — a
// majority-green report for an evening that never happened. A crashed stage, a
// `--stage boot` re-run in the middle of the sequence, or a wrong
// DAY_ONE_STATE all produce exactly that. So the evening's own shape is
// checked FIRST and, when it does not hold, verify stops: an inconclusive run
// must not be able to look like a clean one.
function preconditionsHold() {
  const ran = new Set((st.stagesRun ?? []).map((s) => s.stage));
  const missing = REQUIRED_STAGES.filter((s) => !ran.has(s));
  const counts = [];
  if ((st.joins ?? 0) !== EXPECTED.joins) counts.push(`joins=${st.joins ?? 0} (want ${EXPECTED.joins})`);
  if ((st.deaths ?? []).length !== EXPECTED.deaths) counts.push(`deaths=${(st.deaths ?? []).length} (want ${EXPECTED.deaths})`);
  if ((st.bossFighters ?? []).length !== EXPECTED.bossFighters) {
    counts.push(`bossFighters=${(st.bossFighters ?? []).length} (want ${EXPECTED.bossFighters})`);
  }
  const ok = missing.length === 0 && counts.length === 0;
  check(
    'the evening actually ran (state file, not the DB)',
    ok,
    ok
      ? `${REQUIRED_STAGES.length} stages, ${st.joins} joins, ${st.deaths.length} deaths, ${st.bossFighters.length} at Eikthyr — ${cfg.state}`
      : [
          missing.length ? `stages never run: ${missing.join(', ')}` : '',
          counts.join('; '),
          `state file ${cfg.state}`,
        ].filter(Boolean).join(' · '),
  );
  return ok;
}

async function verify() {
  if (!preconditionsHold()) {
    report();
    console.log('\n  Every check below this one compares the database against that state file,');
    console.log('  so with the evening incomplete they would pass on two matching zeroes.');
    console.log(`  Re-run the stages in order: ${REQUIRED_STAGES.join(' → ')}, then verify.`);
    return;
  }
  const mine = new Set(NAMES);

  // Column names are the production ones: players.character_name (not `name`),
  // sessions.joined_at/left_at, events.created_at. db/0000_initial_schema.sql.
  const players = await rest('players?select=character_name,steam_id,current_title,is_online');
  const ours = players.filter((p) => mine.has(p.character_name));
  const foreign = players.filter((p) => !mine.has(p.character_name));
  check('all 20 vikings on the roster', ours.length === NAMES.length,
    `${ours.length} of ${NAMES.length}${foreign.length ? ` (+${foreign.length} rows from another writer on this stack: ${foreign.map((f) => f.character_name).join(', ')})` : ''}`);
  check('every viking bound to a SteamID', ours.every((p) => p.steam_id), `${ours.filter((p) => p.steam_id).length}/${ours.length} bound`);

  const sessions = await rest('sessions?select=character_name,joined_at,left_at');
  const oursS = sessions.filter((s) => mine.has(s.character_name));
  check('one session per join, all closed', oursS.length === st.joins && oursS.every((s) => s.left_at),
    `${oursS.length} sessions for ${st.joins} joins, ${oursS.filter((s) => !s.left_at).length} left open`);

  const events = await rest('events?select=type,character_name,created_at,metadata&order=created_at.asc');
  const deathRows = events.filter((e) => e.type === 'death' && mine.has(e.character_name));
  check('one events row per real death', deathRows.length === st.deaths.length,
    `${deathRows.length} death rows for ${st.deaths.length} deaths`);
  check('every death carries the eilif cause', deathRows.every((e) => e.metadata?.causeSource === 'eilif'),
    `${deathRows.filter((e) => e.metadata?.causeSource === 'eilif').length}/${deathRows.length} causeSource=eilif`);

  const milestones = await rest('milestones?select=id,title,metric,threshold,achieved_at,announced_at');
  const bosses = await rest('bosses?select=name,is_killed,killed_at,players_present,fight_stats');
  const eik = bosses.find((b) => b.name === 'Eikthyr');
  check('Eikthyr is_killed', eik?.is_killed === true, `is_killed=${eik?.is_killed}`);
  const party = eik?.players_present ?? [];
  check('war party is the eight who swung', party.length === st.bossFighters.length && st.bossFighters.every((f) => party.includes(f)),
    `${party.length} present: ${party.join(', ')}`);
  const others = bosses.filter((b) => b.name !== 'Eikthyr');
  check('no other boss felled on day one', others.every((b) => !b.is_killed),
    `${others.filter((b) => b.is_killed).map((b) => b.name).join(', ') || 'none'}`);

  // The saga row for a boss is type 'boss' with metadata.boss naming it — there
  // is no 'boss_kill' type (scripts/stress/run.mjs asserts the same shape).
  const bossRows = events.filter((e) => e.type === 'boss' && e.metadata?.boss === 'Eikthyr');
  check('exactly one boss event row', bossRows.length === 1, `${bossRows.length} rows of type 'boss' for Eikthyr`);

  // THE ONE DEED DAY ONE IS ABOUT. `First of the Forsaken` is boss_kills_total >= 1,
  // and Eikthyr is down — but evaluateAndRecord() has exactly one call site in
  // the repo, inside the `source: 'client'` branch of app/api/gs-ingest/route.ts;
  // ingestBossMilestones(), the server branch that flips the boss, never
  // re-evaluates the collective deeds. (Cited by symbol on purpose: route.ts is
  // being edited by other work this week and any line number goes stale in
  // hours. `grep -n evaluateAndRecord app/api/gs-ingest/route.ts` finds both.)
  // So if the warband logs off inside the ~120 s before the next client
  // snapshot, the marquee day-one deed never fires.
  const bossDeed = milestones.find((m) => m.metric === 'boss_kills_total' && m.threshold === 1);
  check('the first-boss deed fired with the kill', Boolean(bossDeed?.achieved_at),
    bossDeed
      ? `"${bossDeed.title}" achieved_at=${bossDeed.achieved_at ?? 'null'} while bosses.is_killed=${eik?.is_killed}`
      : 'no boss_kills_total>=1 milestone row found');

  const achieved = milestones.filter((m) => m.achieved_at);
  check('at least one Great Deed crossed', achieved.length >= 1,
    achieved.map((m) => m.title).join(', ') || 'none');
  check('no deed achieved twice', new Set(achieved.map((m) => m.id)).size === achieved.length,
    `${achieved.length} achieved, ${new Set(achieved.map((m) => m.id)).size} distinct`);
  // A day-one ledger should be nearly empty. If most of the 38 deeds have fired
  // the world baseline did not neutralise the lifetime careers.
  check('the day-one ledger is still nearly empty', achieved.length <= 4,
    `${achieved.length} of ${milestones.length} deeds achieved`);

  const status = await rest('server_status?select=*');
  const s = status[0] ?? {};
  check('server_status carries the launch world day', (s.world_day ?? 0) >= 1 && (s.world_day ?? 0) <= 3,
    `world_day=${s.world_day}`);
  check('nobody left marked online', (s.player_count ?? 0) === 0 && (s.current_players ?? []).length === 0,
    `player_count=${s.player_count}, current_players=${JSON.stringify(s.current_players)}`);

  const oaths = await rest('oaths?select=character_name,oath_text');
  const oursO = oaths.filter((o) => mine.has(o.character_name));
  check('every oath landed', oursO.length === st.oaths.length, `${oursO.length} of ${st.oaths.length}`);

  const positionsRows = await rest('player_positions?select=character_name');
  const oursP = positionsRows.filter((p) => mine.has(p.character_name));
  check('one position row per viking, no duplicates', oursP.length === NAMES.length,
    `${oursP.length} rows for ${NAMES.length} vikings`);

  // The titles announcer runs on its own interval (TITLES_MS / BOT_COMPRESSION,
  // 20 s at the default 30x). Reading once right after the last stage is a coin
  // flip on that timer, and a coin flip is not evidence — so wait for it.
  let titled = [];
  const titleDeadlineMs = Date.now() + 45_000;
  for (;;) {
    const titles = await rest('players?select=character_name,current_title');
    titled = titles.filter((p) => mine.has(p.character_name) && p.current_title);
    if (titled.length === NAMES.length || Date.now() > titleDeadlineMs) break;
    await sleep(2000);
  }
  check('titles seeded for the whole roster', titled.length === NAMES.length,
    `${titled.length} of ${NAMES.length} titled within 45s`);
  check('every seeded title is distinct', new Set(titled.map((p) => p.current_title)).size === titled.length,
    `${new Set(titled.map((p) => p.current_title)).size} distinct of ${titled.length}`);
  // SEED-SILENT (services/discord-bot/src/titles.js): the first pass over a
  // roster with no current_title records the title WITHOUT announcing it and
  // WITHOUT a Crowning Log row. On a wiped database that is every viking, so a
  // non-empty title_history here means launch night opened with 20 proclamations.
  const history = await rest('title_history?select=id,title,awarded_at');
  check('seeding wrote no Crowning Log rows', history.length === 0,
    `${history.length} title_history rows after seeding ${titled.length} titles`);

  checkRelayCoverage(events, mine);

  report();
}

// ── DID THE ANNOUNCER ACTUALLY SAY IT? ───────────────────────────────────────
//
// Added 2026-09-06, and it is the check whose absence let two full rehearsals
// grade clean while TWENTY of the evening's forty-six event rows never reached
// #server. Every other check in verify() is a database assertion: it reads the
// rows and says they are right. None of them asks whether the bot posted them,
// so a relay that consumed rows and rendered nothing looked exactly like a
// relay that had nothing to do.
//
// THE MECHANISM, because it is not a harness quirk. The relay's cursor IS
// `events.created_at` (services/discord-bot/src/relay.js:192-247) and it is
// advanced onto EVERY consumed row, including rows formatFeedEvent renders
// nothing for. This rehearsal anchors the evening three hours in the past while
// the bot's own milestone rows land at real `now`, so one milestone row parked
// the cursor two hours past the close stage and every `left the realm` after it
// stopped matching `.gt(created_at, cursor)` — permanently, with no error line
// anywhere, while the same process's boss, title and voice loops kept running.
//
// On launch night the same shape arrives from a different direction:
// `events.created_at` is producer-supplied and clamped only at now+5min
// (lib/event-time.ts:42), deliberately, because "a clock a few minutes ahead is
// an ordinary skewed PC". So one player PC three minutes fast posts a death
// through the unauthenticated gs-ingest path, the cursor jumps three minutes,
// and every join, leave and death written in that window is deleted from the
// feed while the loop reports success. The product fix belongs to the bot
// (relay.js must not cursor on a producer-supplied column); this check is how a
// rehearsal SEES it.
//
// Markers are exactly what services/discord-bot/src/format.js:486-505 renders.
// Only join/leave/death/raid reach the feed at all; chat, boss and sync return
// null there and are excluded here for the same reason.
//
// Death is matched by its EMOJI plus the bolded name anywhere on the line, not
// by a name-first prefix: buildDeathMessage() fills a template, and several of
// them put the name in the middle or at the end ("Gravity finally caught up with
// {name}.", "The deep claimed {name}."). A `💀 **${name}**` marker would have
// missed those and invented a failure, which in a gate is worse than no gate.
//
// Caveat worth knowing if the roster ever changes: names go through nameMd(), so
// a character name containing markdown would be escaped here and not there. The
// twenty in NAMES are all plain.
const FEED_MARKERS = {
  join: (line, n) => line.includes(`**${n}** entered the realm`),
  leave: (line, n) => line.includes(`**${n}** left the realm`),
  death: (line, n) => line.includes('💀') && line.includes(`**${n}**`),
};

function checkRelayCoverage(events, mine) {
  const name = 'the relay posted the whole evening';
  if (!cfg.botLog) {
    skip(name, 'no --bot-log: pass the dry-run announcer\'s captured log to grade the feed');
    return;
  }
  let log;
  try {
    log = readFileSync(resolve(cfg.botLog), 'utf8');
  } catch (e) {
    check(name, false, `cannot read --bot-log ${cfg.botLog}: ${e?.message ?? e}`);
    return;
  }

  // Per type, over OUR roster only, so another writer on this stack cannot move
  // either number. A death the relay deliberately collapsed as a duplicate, and
  // a row Discord permanently rejected, are both accounted for rather than
  // counted as losses — the relay logs each one.
  const collapsed = (log.match(/\[relay\] collapsed a duplicate death/g) || []).length;
  const rejected = (log.match(/\[relay\] Discord rejected event/g) || []).length;
  const lines = log.split('\n');
  const detail = [];
  let missing = 0;
  let expected = 0;
  for (const [type, matches] of Object.entries(FEED_MARKERS)) {
    const rows = events.filter((e) => e.type === type && mine.has(e.character_name)).length;
    let posted = 0;
    for (const line of lines) {
      for (const n of mine) {
        if (matches(line, n)) { posted++; break; }
      }
    }
    expected += rows;
    if (rows > posted) missing += rows - posted;
    detail.push(`${type} ${posted}/${rows}`);
  }
  const accounted = Math.max(0, missing - collapsed - rejected);
  check(name, accounted === 0,
    `${detail.join(' · ')}${collapsed ? ` (${collapsed} collapsed)` : ''}${rejected ? ` (${rejected} rejected)` : ''}` +
      `${accounted ? ` — ${accounted} of ${expected} feed rows NEVER POSTED, silently` : ''}`);
}

function report() {
  console.log(`\n── day-one invariants ${'─'.repeat(46)}`);
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.ok === 'FAIL') failed++;
    else if (c.ok === 'SKIP') skipped++;
    console.log(`  ${c.ok.padEnd(4)}  ${c.name.padEnd(44)} ${c.evidence}`);
  }
  console.log(`  ${checks.length - failed - skipped}/${checks.length} passed`);
  // A skipped check is reported apart from the passes on purpose. "21/21" over a
  // check that never ran is the false green this whole file exists to refuse.
  if (skipped) console.log(`  ${skipped} check(s) SKIPPED — not graded, and NOT evidence.`);
  if (failed) process.exitCode = 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

const stage = STAGES[cfg.stage];
if (!stage) {
  console.error(`Unknown --stage "${cfg.stage}". One of: ${Object.keys(STAGES).join(', ')}`);
  process.exit(2);
}
if (cfg.stage === 'boot') {
  // A fresh evening every time boot runs, so a re-run never inherits half a
  // previous rehearsal's roster.
  const fresh = freshState();
  Object.assign(st, fresh);
  for (const k of Object.keys(st)) if (!(k in fresh)) delete st[k];
}

console.log(`\n── day-one stage: ${cfg.stage} (world '${cfg.world}', ${cfg.base}) ${'─'.repeat(20)}`);
await stage();
st.stagesRun.push({ stage: cfg.stage, at: new Date().toISOString() });
saveState(st);

if (stats.n) {
  const sorted = [...stats.ms].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const codes = [...stats.codes.entries()].map(([c, n]) => `${c}×${n}`).join(' ');
  console.log(`  ${stats.n} requests  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${sorted[sorted.length - 1]}ms  [${codes}]`);
  const bad = [...stats.codes.entries()].filter(([c]) => c >= 300);
  if (bad.length) {
    console.log(`  NON-2xx present: ${bad.map(([c, n]) => `${c}×${n}`).join(' ')}`);
    process.exitCode = 1;
  }
}
