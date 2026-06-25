// Daily recaps: two cron jobs (08:00 and 22:00 America/Chicago) post an
// activity summary embed to #valheim. Stats cover the window since the last
// recap (default 12h).
//
// Two leaderboard extras ride on top of the base stats:
//   • a cumulative "Hall of the Fallen" deaths board (BOTH recaps), and
//   • an evening-only "🏆 Player of the Day" (POTY) crown.
// All scoring lives here; rendering (incl. the Norse blurb templates) lives in
// format.js, which stays pure — buildStats hands it a fully-resolved stats obj.
import cron from 'node-cron';
import { formatRecap } from './format.js';

// Epic categories headline even on back-to-back nights (exempt from anti-repeat).
const EPIC_KEYS = new Set(['boss_kill', 'most_explored']);

// POTY categories, highest priority first. `epic` => anti-repeat exempt.
// REAL-DATA today: boss_kill / most_deaths / most_hours. The rest are
// forward-compatible: they read player_stats deltas that are ~0 until a stats
// mod starts moving the counters, so they fail their thresholds and are skipped
// — then slot in by priority with ZERO code changes once the data flows.
const POTY_CATEGORIES = [
  { key: 'boss_kill',      label: '👑 Bane of Beasts (Boss-Slayer)', priority: 100, threshold: 1,   epic: true,  metric: 'bossesPresent' },
  { key: 'most_explored',  label: '🧭 Trailblazer',                  priority: 70,  threshold: 1,   epic: true,  metric: 'newBiomeCount' },
  { key: 'most_deaths',    label: '💀 The Bold',                     priority: 55,  threshold: 3,   epic: false, metric: 'windowDeaths' },
  { key: 'most_kills',     label: '⚔️ Monster-Hunter',               priority: 50,  threshold: 50,  epic: false, metric: 'killsDelta' },
  { key: 'most_resources', label: '🪓 The Industrious',              priority: 40,  threshold: 500, epic: false, metric: 'resourcesDelta' },
  { key: 'most_crafted',   label: '🔨 Master of the Forge',          priority: 35,  threshold: 50,  epic: false, metric: 'craftsDelta' },
  { key: 'most_hours',     label: '🔥 The Devoted',                  priority: 20,  threshold: 3,   epic: false, metric: 'hours' },
];

/**
 * Pick the Player of the Day from per-player window metrics (all keyed by
 * character_name). Pure + deterministic; never throws on empty/tie/single.
 * Returns a render-ready { key, label, name, fields, seed } or null.
 *
 * ctx = { windowDeaths, lastCause, hours, bossesPresent, latestBoss,
 *         killsDelta, resourcesDelta, craftsDelta, newBiomes, lastCat, seed }
 */
export function selectPlayerOfDay(ctx = {}) {
  const {
    windowDeaths = {}, lastCause = {}, hours = {},
    bossesPresent = {}, latestBoss = {},
    killsDelta = {}, resourcesDelta = {}, craftsDelta = {}, newBiomes = {},
    lastCat = null, seed = 0,
  } = ctx;

  // most_explored metric = count of newly-discovered biomes per player.
  const newBiomeCount = {};
  for (const [nm, arr] of Object.entries(newBiomes)) {
    if (Array.isArray(arr) && arr.length) newBiomeCount[nm] = arr.length;
  }

  const metrics = {
    bossesPresent, newBiomeCount, windowDeaths,
    killsDelta, resourcesDelta, craftsDelta, hours,
  };

  // STEP 2 tiebreak chain (uniform across categories): metric DESC ->
  // windowDeaths DESC (grit) -> hours DESC -> character_name ASC (case-insens).
  const wd = windowDeaths || {};
  const hr = hours || {};
  const compare = (metric) => (a, b) =>
    ((metric || {})[b] || 0) - ((metric || {})[a] || 0) ||
    (wd[b] || 0) - (wd[a] || 0) ||
    (hr[b] || 0) - (hr[a] || 0) ||
    a.toLowerCase().localeCompare(b.toLowerCase());

  // Per category, crown a single winner; keep it if it clears the threshold.
  const qualifiers = [];
  for (const cat of POTY_CATEGORIES) {
    const metric = metrics[cat.metric] || {};
    const names = Object.keys(metric).filter((n) => (metric[n] || 0) > 0);
    if (!names.length) continue;
    names.sort(compare(metric));
    const name = names[0];
    const value = metric[name] || 0;
    if (value >= cat.threshold) qualifiers.push({ ...cat, name, value });
  }
  if (!qualifiers.length) return null;

  // STEP 3: pure priority tiering (priorities are unique -> a total order).
  qualifiers.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));

  // Soft anti-repeat: skip ONE step if the top is a non-epic repeat of last
  // night's crown AND an alternative exists.
  let winner = qualifiers[0];
  if (!EPIC_KEYS.has(winner.key) && winner.key === lastCat && qualifiers.length >= 2) {
    winner = qualifiers[1];
  }

  const name = winner.name;
  const lb = latestBoss[name] || {};
  return {
    key: winner.key,
    label: winner.label,
    name,
    fields: {
      boss: lb.boss,
      biome: lb.biome,
      deaths: windowDeaths[name] || 0,
      cause: lastCause[name],
      hours: hours[name] != null ? hours[name] : undefined,
      kills: killsDelta[name],
      resources: resourcesDelta[name],
      items: craftsDelta[name],
      newBiome: Array.isArray(newBiomes[name]) ? newBiomes[name][0] : undefined,
    },
    seed: seed || 0,
  };
}

export function createRecap({ db, post, state, saveState, tz = 'America/Chicago', startsAt = null }) {
  async function buildStats(period) {
    const now = Date.now();
    const windowStart = new Date(
      state.lastRecapAt ? new Date(state.lastRecapAt).getTime() : now - 12 * 3600 * 1000
    );
    const startMs = windowStart.getTime();
    const startIso = windowStart.toISOString();

    // Lazy-init POTY state so dry-run (state = {}) / first boot never throw.
    const snap = state.potyStatsSnapshot || {};
    const lastCat = state.lastPotyCategory || null;

    // --- Sessions overlapping [windowStart, now] -> active set + per-name hours.
    const { data: sessions } = await db
      .from('sessions')
      .select('character_name, joined_at, left_at')
      .or(`left_at.is.null,left_at.gte.${startIso}`);

    const activeNames = new Set();
    const hoursMs = {};
    let totalMs = 0;
    for (const s of sessions || []) {
      const start = Math.max(new Date(s.joined_at).getTime(), startMs);
      const end = Math.min(s.left_at ? new Date(s.left_at).getTime() : now, now);
      if (end > start) {
        totalMs += end - start;
        const nm = (s.character_name || '').trim();
        if (nm) {
          activeNames.add(nm);
          hoursMs[nm] = (hoursMs[nm] || 0) + (end - start);
        }
      }
    }
    const hours = {};
    for (const [nm, ms] of Object.entries(hoursMs)) hours[nm] = ms / 3600000;

    // --- Deaths: ONE cumulative fetch serves the board totals, the window
    // deltas, the recap death count, and the reckless-cause flavor. .limit(10000)
    // is mandatory — death rows can exceed the 1000-row default and a truncated
    // read would undercount the board.
    const { data: deathRows } = await db
      .from('events')
      .select('character_name, created_at, metadata')
      .eq('type', 'death')
      .limit(10000);

    const deathTotal = {};
    const windowDeaths = {};
    const lastCause = {};
    const lastCauseAt = {};
    for (const r of deathRows || []) {
      const nm = (r.character_name || '').trim();
      if (!nm) continue;
      deathTotal[nm] = (deathTotal[nm] || 0) + 1;
      const t = new Date(r.created_at).getTime();
      if (t >= startMs) {
        windowDeaths[nm] = (windowDeaths[nm] || 0) + 1;
        if (lastCauseAt[nm] === undefined || t >= lastCauseAt[nm]) {
          lastCauseAt[nm] = t;
          const c = r.metadata?.cause;
          lastCause[nm] = typeof c === 'string' && c.trim() ? c.trim() : undefined;
        }
      }
    }
    const deaths = Object.values(windowDeaths).reduce((a, b) => a + b, 0);

    // Deaths board: total DESC -> delta DESC (fresh blood floats up) -> name ASC.
    const deathsBoard = Object.keys(deathTotal)
      .map((name) => ({ name, total: deathTotal[name], delta: windowDeaths[name] || 0 }))
      .sort(
        (a, b) =>
          b.total - a.total ||
          b.delta - a.delta ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );

    // --- Bosses felled in window (+ POTY candidates from players_present).
    const { data: bossRows } = await db
      .from('bosses')
      .select('name, biome, killed_at, players_present')
      .eq('is_killed', true)
      .gte('killed_at', startIso);

    const bossKills = (bossRows || []).map((b) => b.name);
    const bossesPresent = {};
    const latestBoss = {};
    for (const b of bossRows || []) {
      const present = Array.isArray(b.players_present) ? b.players_present : [];
      const t = b.killed_at ? new Date(b.killed_at).getTime() : 0;
      for (const raw of present) {
        const nm = (raw || '').trim();
        if (!nm) continue;
        bossesPresent[nm] = (bossesPresent[nm] || 0) + 1;
        if (!latestBoss[nm] || t >= latestBoss[nm].t) {
          latestBoss[nm] = { boss: b.name, biome: b.biome, t };
        }
      }
    }

    // --- player_stats snapshot + deltas (forward-compatible; ~0 today).
    // Snapshot the CURRENT counters keyed by character_name for the next window's
    // baseline; diff against the prior snapshot for kills/resources/crafts/biomes.
    const statsSnapshotNext = {};
    const killsDelta = {};
    const resourcesDelta = {};
    const craftsDelta = {};
    const newBiomes = {};
    try {
      const { data: players } = await db.from('players').select('id, character_name');
      const idToName = new Map();
      for (const p of players || []) {
        const nm = (p.character_name || '').trim();
        if (nm) idToName.set(p.id, nm);
      }
      const { data: pstats } = await db
        .from('player_stats')
        .select('player_id, kills, resources_harvested, items_crafted, distance_traveled, biomes_discovered');
      for (const ps of pstats || []) {
        const nm = idToName.get(ps.player_id);
        if (!nm) continue;
        const cur = {
          kills: Number(ps.kills) || 0,
          resources_harvested: Number(ps.resources_harvested) || 0,
          items_crafted: Number(ps.items_crafted) || 0,
          distance_traveled: Number(ps.distance_traveled) || 0,
          biomes_discovered: Array.isArray(ps.biomes_discovered) ? ps.biomes_discovered : [],
        };
        statsSnapshotNext[nm] = cur;
        const prev = snap[nm];
        if (prev) {
          // clamp at 0 so a counter reset / world wipe never yields negatives.
          killsDelta[nm] = Math.max(cur.kills - (Number(prev.kills) || 0), 0);
          resourcesDelta[nm] = Math.max(cur.resources_harvested - (Number(prev.resources_harvested) || 0), 0);
          craftsDelta[nm] = Math.max(cur.items_crafted - (Number(prev.items_crafted) || 0), 0);
          const prevBiomes = new Set(Array.isArray(prev.biomes_discovered) ? prev.biomes_discovered : []);
          const fresh = cur.biomes_discovered.filter((x) => x && !prevBiomes.has(x));
          if (fresh.length) newBiomes[nm] = fresh;
        }
      }
    } catch {
      // players/player_stats unreadable -> forward-compat only; ignore.
    }

    const { data: status } = await db
      .from('server_status')
      .select('player_count, world_day')
      .eq('id', 1)
      .maybeSingle();

    const playersActive = activeNames.size;
    const worldDay = status?.world_day ?? 0;
    const quiet = playersActive === 0 && deaths === 0 && bossKills.length === 0;

    // POTY: EVENING ONLY. Morning never computes or shows a crown.
    let poty = null;
    if (period === 'evening') {
      poty = selectPlayerOfDay({
        windowDeaths, lastCause, hours, bossesPresent, latestBoss,
        killsDelta, resourcesDelta, craftsDelta, newBiomes,
        lastCat, seed: worldDay,
      });
    }

    return {
      period,
      playersActive,
      hoursPlayed: totalMs / 3600000,
      deaths,
      bossKills,
      onlineNow: status?.player_count ?? 0,
      worldDay,
      quiet,
      deathsBoard,
      poty,
      // transient: persisted by postRecap as next window's baseline; format ignores it.
      _statsSnapshotNext: statsSnapshotNext,
    };
  }

  async function postRecap(period) {
    const stats = await buildStats(period);
    await post('valheim', formatRecap(stats));
    // STEP 6 state writes (here, not in buildStats which stays read-only):
    // refresh the player_stats baseline on EVERY recap...
    state.potyStatsSnapshot = stats._statsSnapshotNext || {};
    // ...but only remember the crowned category on an evening that crowned one
    // (a skip leaves it unchanged, so anti-repeat measures days not half-days).
    if (period === 'evening' && stats.poty) state.lastPotyCategory = stats.poty.key;
    state.lastRecapAt = new Date().toISOString();
    await saveState();
    return stats;
  }

  function schedule() {
    const opts = { timezone: tz };
    // Gate: stay silent until the world launches (startsAt). Relay + boss
    // announcements are event-driven, so they're naturally quiet before then.
    const run = (period) => {
      if (startsAt && Date.now() < startsAt.getTime()) {
        console.log(`[recap] ${period} gated — recaps begin ${startsAt.toISOString().slice(0, 10)}`);
        return Promise.resolve();
      }
      return postRecap(period);
    };
    const jobs = [
      cron.schedule('0 8 * * *', () => run('morning').catch((e) => console.error('[recap] morning:', e.message)), opts),
      cron.schedule('0 22 * * *', () => run('evening').catch((e) => console.error('[recap] evening:', e.message)), opts),
    ];
    console.log(
      `[recap] scheduled 08:00 & 22:00 ${tz}` +
        (startsAt ? ` (begins ${startsAt.toISOString().slice(0, 10)})` : '')
    );
    return jobs;
  }

  return { buildStats, postRecap, schedule, selectPlayerOfDay };
}
