// Daily recap: ONE cron job (evening, 23:00 America/Chicago by default) posts an
// activity summary embed to #valheim. It covers the TRAILING 24 HOURS — "what
// happened in the last day?". The 08:00 morning recap was retired 2026-08-28; a
// single evening post is the cadence now. buildStats/postRecap still accept a
// 'morning' period so scripts/preview.js and dry runs can render one, but nothing
// schedules it.
//
// On top of the base stats ride the per-name day boards (who was online, who
// fell) and an evening-only "🏆 Player of the Day" (POTY) crown.
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

// --- Player-of-the-Day fairness knobs (tweak freely) -----------------------
// Anti-monopoly: a viking may win at most this many evenings IN A ROW; the next
// would-be repeat is handed to the best alternative instead. EPIC wins (boss
// kill / new biome) are exempt — too rare and big to ever suppress.
const MAX_WIN_STREAK = 2; // => a 3rd straight crown for the same name is blocked

// "Unsung Hero" spotlight: roughly once a week, the evening crown goes to the
// quietest viking who still showed up — a deliberately gentle (yes, slightly
// artificial) award so light-playtime folks get their moment in the hall.
// Skipped on epic nights (a boss kill still headlines) and when nobody quiet
// enough was actually on. Excludes last night's winner.
const UNDERDOG = {
  key: 'underdog',
  label: '🌟 Unsung Hero',
  everyEvenings: 7,    // cadence — ≈ weekly (one evening recap per day)
  minHours: 0.3,       // must have truly played (~18 min), not a 2-minute blip
  minActivePlayers: 2, // only meaningful when other vikings were on too
};

/**
 * Pick the Player of the Day from per-player window metrics (all keyed by
 * character_name). Pure + deterministic; never throws on empty/tie/single.
 * Returns a render-ready { key, label, name, fields, seed } or null.
 *
 * ctx = { windowDeaths, lastCause, hours, bossesPresent, latestBoss,
 *         killsDelta, resourcesDelta, craftsDelta, newBiomes, lastCat,
 *         lastWinner, winStreak, forceUnderdog, seed }
 * Fairness: caps a person at MAX_WIN_STREAK in a row (epic-exempt) and, when
 * forceUnderdog is due, crowns the quietest active viking as 🌟 Unsung Hero.
 */
export function selectPlayerOfDay(ctx = {}) {
  const {
    windowDeaths = {}, lastCause = {}, hours = {},
    bossesPresent = {}, latestBoss = {},
    killsDelta = {}, resourcesDelta = {}, craftsDelta = {}, newBiomes = {},
    lastCat = null, lastWinner = null, winStreak = 0, forceUnderdog = false,
    seed = 0,
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

  // Tiebreak inputs: windowDeaths DESC (grit) -> hours DESC -> name ASC.
  const wd = windowDeaths || {};
  const hr = hours || {};

  // Unsung Hero: crown the quietest viking who still SHOWED UP (least hours),
  // never last night's winner. Returns a render-ready crown or null.
  const underdogPick = () => {
    const active = Object.keys(hr).filter((n) => (hr[n] || 0) > 0);
    if (active.length < UNDERDOG.minActivePlayers) return null;
    const pool = active
      .filter((n) => (hr[n] || 0) >= UNDERDOG.minHours && n !== lastWinner)
      .sort((a, b) =>
        (hr[a] || 0) - (hr[b] || 0) ||
        (wd[a] || 0) - (wd[b] || 0) ||
        a.toLowerCase().localeCompare(b.toLowerCase()));
    if (!pool.length) return null;
    const nm = pool[0];
    return {
      key: UNDERDOG.key, label: UNDERDOG.label, name: nm,
      fields: { hours: hr[nm] != null ? hr[nm] : undefined },
      seed: seed || 0,
    };
  };

  // Build EVERY crown-worthy candidate — each player clearing a category's
  // threshold, not just the per-category leader — so fairness rules have real
  // alternatives to fall back on when they skip the usual winner.
  const candidates = [];
  for (const cat of POTY_CATEGORIES) {
    const metric = metrics[cat.metric] || {};
    for (const nm of Object.keys(metric)) {
      const value = metric[nm] || 0;
      if (value >= cat.threshold) candidates.push({ ...cat, name: nm, value });
    }
  }

  // Rank: higher-priority award first; within a category (unique priorities, so
  // categories never tie) bigger metric then the uniform tiebreak chain.
  candidates.sort((a, b) =>
    b.priority - a.priority ||
    b.value - a.value ||
    (wd[b.name] || 0) - (wd[a.name] || 0) ||
    (hr[b.name] || 0) - (hr[a.name] || 0) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  // Weekly Unsung-Hero spotlight — but never bury an epic night under it
  // (a boss kill / new biome still headlines; the spotlight waits a day).
  if (forceUnderdog && !candidates.some((c) => EPIC_KEYS.has(c.key))) {
    const u = underdogPick();
    if (u) return u;
  }

  if (!candidates.length) return null;

  let winner = candidates[0];

  // Anti-monopoly: block a 3rd straight crown for the same person. Epic wins are
  // exempt — too rare/big to ever suppress.
  const blocked = winStreak >= MAX_WIN_STREAK && lastWinner ? lastWinner : null;
  if (blocked && winner.name === blocked && !EPIC_KEYS.has(winner.key)) {
    const alt = candidates.find((c) => c.name !== blocked);
    if (alt) {
      winner = alt;
    } else {
      // Only the streak-holder qualifies for anything tonight — spotlight a quiet
      // viking instead if we can; else let the streak stand (better than no crown).
      const u = underdogPick();
      if (u) return u;
    }
  }

  // Soft category anti-repeat: avoid the same award two evenings running when a
  // different-category alternative (by a non-blocked viking) exists.
  if (!EPIC_KEYS.has(winner.key) && winner.key === lastCat) {
    const alt = candidates.find((c) => c.key !== winner.key && c.name !== blocked);
    if (alt) winner = alt;
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

export function createRecap({ db, post, state, saveState, writeDb = null, tz = 'America/Chicago', startsAt = null, onPotyCrowned = null, channel = 'valheim' }) {
  async function buildStats(period) {
    const now = Date.now();
    // Fixed trailing-24h window — every recap answers "the last day", so the
    // morning and evening posts intentionally overlap.
    const windowStart = new Date(now - 24 * 3600 * 1000);
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
    const staleOpen = [];
    for (const s of sessions || []) {
      // Guard: an OPEN session that began before the 24h window is a missed
      // leave event (the server pauses when empty — nobody truly plays 24h+).
      // Counting it would put a phantom flat-24.0h on the day boards forever,
      // so skip it and warn so the row gets closed. (Seen 2026-07-07: six
      // pilot-night sessions with left_at NULL.)
      if (!s.left_at && new Date(s.joined_at).getTime() < startMs) {
        staleOpen.push(s.character_name || '?');
        continue;
      }
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
    if (staleOpen.length) {
      console.warn(
        `[recap] ignored ${staleOpen.length} stale open session(s) (left_at NULL, joined >24h ago) — close these rows: ${staleOpen.join(', ')}`
      );
    }

    // --- Deaths in the window: serves the day board, the recap death count,
    // and the reckless-cause flavor. .limit(10000) is a defensive ceiling —
    // a truncated read would undercount the board.
    const { data: deathRows } = await db
      .from('events')
      .select('character_name, created_at, metadata')
      .eq('type', 'death')
      .gte('created_at', startIso)
      .limit(10000);

    const windowDeaths = {};
    const lastCause = {};
    const lastCauseAt = {};
    for (const r of deathRows || []) {
      const nm = (r.character_name || '').trim();
      if (!nm) continue;
      const t = new Date(r.created_at).getTime();
      windowDeaths[nm] = (windowDeaths[nm] || 0) + 1;
      if (lastCauseAt[nm] === undefined || t >= lastCauseAt[nm]) {
        lastCauseAt[nm] = t;
        const c = r.metadata?.cause;
        lastCause[nm] = typeof c === 'string' && c.trim() ? c.trim() : undefined;
      }
    }
    const deaths = Object.values(windowDeaths).reduce((a, b) => a + b, 0);

    // Day boards (per-name, window-only): who played and who fell.
    // Online: hours DESC -> name ASC. Fallen: deaths DESC -> name ASC.
    const onlineToday = Object.keys(hours)
      .map((name) => ({ name, hours: hours[name] }))
      .sort(
        (a, b) => b.hours - a.hours || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );
    const fallenToday = Object.keys(windowDeaths)
      .map((name) => ({ name, count: windowDeaths[name] }))
      .sort(
        (a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );

    // --- Bosses felled in window (+ POTY candidates from the TRUE fighters).
    const { data: bossRows } = await db
      .from('bosses')
      .select('name, biome, killed_at, players_present, fight_stats')
      .eq('is_killed', true)
      .gte('killed_at', startIso);

    const bossKills = (bossRows || []).map((b) => b.name);
    const bossesPresent = {};
    const latestBoss = {};
    for (const b of bossRows || []) {
      // The boss-slayer crown must reward DEEDS, not mere presence: credit the
      // honest fighter set (those who actually dealt damage / drew first blood /
      // struck hardest), falling back to players_present only for legacy rows
      // recorded before fighters were captured (never the raw online roster now).
      const fighters =
        b.fight_stats && Array.isArray(b.fight_stats.fighters) && b.fight_stats.fighters.length > 0
          ? b.fight_stats.fighters
          : Array.isArray(b.players_present)
            ? b.players_present
            : [];
      const present = fighters;
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
      // Unsung-Hero spotlight comes due once the dry spell reaches the cadence.
      const underdogDue = (state.eveningsSinceUnderdog || 0) >= UNDERDOG.everyEvenings - 1;
      poty = selectPlayerOfDay({
        windowDeaths, lastCause, hours, bossesPresent, latestBoss,
        killsDelta, resourcesDelta, craftsDelta, newBiomes,
        lastCat,
        lastWinner: state.lastPotyWinner || null,
        winStreak: state.potyWinStreak || 0,
        forceUnderdog: underdogDue,
        seed: worldDay,
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
      onlineToday,
      fallenToday,
      poty,
      // transient: persisted by postRecap as next window's baseline; format ignores it.
      _statsSnapshotNext: statsSnapshotNext,
    };
  }

  async function postRecap(period) {
    const stats = await buildStats(period);
    await post(channel, formatRecap(stats));
    // State writes (here, not in buildStats which stays read-only):
    // refresh the player_stats baseline on EVERY recap...
    state.potyStatsSnapshot = stats._statsSnapshotNext || {};
    // ...and on the EVENING, track the crown for the fairness rules.
    if (period === 'evening') {
      const poty = stats.poty;
      if (poty) {
        state.lastPotyCategory = poty.key;
        // Per-person streak: extend if the same name repeats, else reset to 1.
        state.potyWinStreak = poty.name === state.lastPotyWinner ? (state.potyWinStreak || 0) + 1 : 1;
        state.lastPotyWinner = poty.name;
        // Underdog cadence: reset on a spotlight, otherwise tick toward the next.
        state.eveningsSinceUnderdog = poty.key === UNDERDOG.key ? 0 : (state.eveningsSinceUnderdog || 0) + 1;
      } else {
        // No crown tonight: a streak must be *consecutive* wins, so it breaks
        // here; the empty evening still counts toward the next spotlight.
        state.lastPotyWinner = null;
        state.potyWinStreak = 0;
        state.eveningsSinceUnderdog = (state.eveningsSinceUnderdog || 0) + 1;
      }
    }
    // Archive the evening's crown for the dashboard's Player-of-the-Day log
    // (best-effort; needs a service-role writeDb — null in dry-run/no key).
    if (period === 'evening' && stats.poty && writeDb) {
      try {
        await writeDb.from('poty_history').insert({
          character_name: stats.poty.name,
          award_category: stats.poty.key,
          award_label: stats.poty.label,
          world_day: stats.worldDay ?? null,
          awarded_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[recap] poty archive write failed:', e.message);
      }
    }
    // Thin hook: let the Voice of the Hall crown the winner in-game (best-effort).
    if (period === 'evening' && stats.poty && onPotyCrowned) {
      try {
        await onPotyCrowned(stats.poty, stats.worldDay ?? null);
      } catch (e) {
        console.error('[recap] poty voice hook failed:', e.message);
      }
    }
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
    // One evening recap. The hour stays env-tunable (RECAP_EVENING_HOUR) so it can
    // move without a code edit; default 23 = 11 PM Central. The 08:00 morning
    // recap was retired 2026-08-28 — one evening post is the cadence now.
    const eveningHour = parseInt(process.env.RECAP_EVENING_HOUR || '23', 10);
    const jobs = [
      cron.schedule(`0 ${eveningHour} * * *`, () => run('evening').catch((e) => console.error('[recap] evening:', e.message)), opts),
    ];
    console.log(
      `[recap] scheduled ${String(eveningHour).padStart(2, '0')}:00 ${tz}` +
        (startsAt ? ` (begins ${startsAt.toISOString().slice(0, 10)})` : '')
    );
    return jobs;
  }

  return { buildStats, postRecap, schedule, selectPlayerOfDay };
}
