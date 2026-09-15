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
//
// ═══════════════════════════════════════════════════════════════════════════
// PLAYER OF THE DAY — the rules of record (rewritten 2026-09-14)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY IT CHANGED. The first cut ranked a fixed priority list against fixed
// thresholds, so "💀 The Bold" (3+ deaths) outranked every stat angle below it
// and the crown drifted to whoever died the most — three of the first five
// crowns were The Bold or a repeat winner. Charlie's brief: "fun unique angles:
// not just raw hours or raw stats, something interesting or unique that
// happened… a player comparatively furthest behind in progression who keeps
// showing up could be player of the day for being perseverant. A player who cut
// down a ton of trees that day is a notable event."
//
// THE MODEL. Every angle scores the SAME way, and the biggest score wins. What
// is scored is NOTABILITY, not size: how far out of the ordinary tonight was for
// THAT viking, tempered by how much of the clan's day they accounted for.
//
//   surprise = todayDelta / max(mean of that viking's last ≤7 daily deltas, floor)
//   share    = todayDelta / (sum of every eligible viking's delta tonight)   0..1
//   score    = surprise^A × share^B × activityNudge
//   activityNudge = 1 + NUDGE × min(hours, NUDGE_HOURS) / NUDGE_HOURS
//
// KNOBS (tune freely, they are all here):
//   A = SURPRISE_EXP  0.6   how much a personal spike counts
//   B = SHARE_EXP     0.4   how much "most of the clan's day" counts
//   SURPRISE_CAP      10    a first-ever day cannot score infinitely
//   NUDGE / NUDGE_HOURS  0.1 / 4  the activity nudge is never decisive (≤ +10%)
//   MIN_ELIGIBLE_HOURS   20 min   the activity gate: below it, no crown
//   DAY_DELTA_DAYS       7        length of the state.json ring buffer
//
// Tuned so that a 3× personal spike holding 30% of the clan's day BEATS a
// routine 1× night holding 45%:  3^0.6 × 0.30^0.4 = 1.19  vs  1 × 0.45^0.4 = 0.72.
// With fewer than 2 days of history, surprise = 1 and clan share carries it.
//
// FLOORS. Each angle has a minimum absolute delta so trivia never wins, and the
// same floor is the surprise denominator's floor (so a viking who normally does
// nothing cannot turn 1 plank into a 50× spike):
//   kills 15 · builds 60 · crafts 15 · resources 150 · distance 3 km ·
//   sail 2 km · fish 3 · damage 2000 · map +0.4 pct
//
// TIERS. Score only ever ranks WITHIN a tier:
//   3  boss_kill                       (epic)
//   2  most_explored via a NEW BIOME   (epic)
//   1  steadfast                       (beats routine stat wins, never an epic)
//   0  every stat angle, ironhide, the map-delta Trailblazer, and bold
//
// ROTATION (read from poty_history at recap time; falls back to state.json when
// that read fails): same viking in the last 3 nights → ×0.5; same angle in the
// last 2 nights → ×0.67. Epics are exempt from both. MAX_WIN_STREAK stays as a
// final backstop, and the weekly 🌟 Unsung Hero spotlight is unchanged.
//
// THE DAY-DELTA RING BUFFER lives in state.json as
//   dayDeltas: [{ date, byName: { name: {kills,builds,crafts,resources,distance,
//                                       sail,fish,map,damage,hours,deaths} } }]
// capped at DAY_DELTA_DAYS and appended ONLY by the evening recap (a morning
// render must never poison the personal baseline). See appendDayDeltas.
import cron from 'node-cron';
import { formatRecap } from './format.js';
import { isExcluded, isExcludedName, withoutExcluded } from './excluded.js';

// Two ingest paths (the `gs` mod report and the `eilif` death report) can write
// the SAME death milliseconds apart, so the recap used to count one death twice:
// the 2026-09-01 recap said 7 deaths for 4 real ones, and 'The Bold' crowned a
// viking on a doubled tally. Collapse a repeat for the same viking inside this
// window ONLY — a corpse run that ends in a second death a minute later is a
// REAL second death and must still count, so never widen this. Mirrors
// relay.js's DEATH_COLLAPSE_MS; both must move together if either ever does.
const DEATH_COLLAPSE_MS = 10_000;

/**
 * Fold duplicate death reports for one viking into a single row.
 *
 * Pure and total: rows arrive in whatever order PostgREST returns them, so they
 * are sorted by time here first. A row we cannot key on (no character name, or
 * an unparseable created_at) is passed through untouched — collapsing needs a
 * name and a clock, and a row without them is left exactly as the caller found
 * it rather than guessed at.
 *
 * The window is anchored on the row that was KEPT, not on the previous row, so a
 * burst of reports can never chain into a window wider than DEATH_COLLAPSE_MS.
 * That is the same rule relay.js applies when deciding whether to post.
 *
 * Only one of the two producers knows what killed you (the log-poller path has
 * no cause — the server log carries none), so when a folded row names a cause
 * and the kept one does not, the cause is carried over.
 */
export function collapseDeathRows(rows, collapseMs = DEATH_COLLAPSE_MS) {
  const causeOf = (r) => {
    const c = r?.metadata?.cause;
    return typeof c === 'string' && c.trim() ? c.trim() : undefined;
  };

  const passthrough = [];
  const keyed = [];
  for (const r of rows || []) {
    const nm = (r?.character_name || '').trim();
    const t = Date.parse(r?.created_at);
    if (!nm || !Number.isFinite(t)) {
      passthrough.push(r);
      continue;
    }
    keyed.push({ row: r, name: nm, t });
  }
  keyed.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));

  const kept = [];
  const anchor = new Map(); // name -> the kept entry that owns the open window
  for (const entry of keyed) {
    const open = anchor.get(entry.name);
    if (open && entry.t - open.t <= collapseMs) {
      if (!causeOf(open.row)) {
        const cause = causeOf(entry.row);
        if (cause) {
          open.row = { ...open.row, metadata: { ...(open.row.metadata || {}), cause } };
        }
      }
      continue;
    }
    anchor.set(entry.name, entry);
    kept.push(entry);
  }

  return [...passthrough, ...kept.map((e) => e.row)];
}

// --- Player-of-the-Day knobs ------------------------------------------------
// (the formula they feed is documented in the header block)
const SURPRISE_EXP = 0.6;   // A
const SHARE_EXP = 0.4;      // B
const SURPRISE_CAP = 10;    // a first-ever day is notable, not infinite
const NUDGE = 0.1;          // activity nudge ceiling (+10%)
const NUDGE_HOURS = 4;      // hours at which the nudge saturates
const MIN_ELIGIBLE_HOURS = 20 / 60; // the activity gate: 20 minutes
export const DAY_DELTA_DAYS = 7;    // ring-buffer length in state.json

// Per-angle absolute floors. Also the surprise denominator's floor, so a viking
// who normally does nothing cannot turn one plank into a 50× "spike".
const FLOORS = {
  kills: 15,
  builds: 60,
  crafts: 15,
  resources: 150,
  distance: 3000, // metres
  sail: 2000,     // metres
  fish: 3,
  damage: 2000,
  map: 0.4,       // percentage points of the world revealed
  hours: 3,       // ironhide's "did things and never fell" watch
  deaths: 3,      // The Bold's entry price
};

// The plain stat angles. Each scores identically; tier 0; rotation applies.
// `alt` lets one angle qualify on a second metric (a big sail day is notable
// even when the total distance is short).
const ANGLES = [
  { key: 'builder',    label: '🏗️ The Builder',        metric: 'builds' },
  { key: 'woodcutter', label: '🪓 The Woodcutter',      metric: 'resources' },
  { key: 'smith',      label: '🔨 Master of the Forge', metric: 'crafts' },
  { key: 'wayfarer',   label: '⛵ The Wayfarer',        metric: 'distance', alt: 'sail' },
  { key: 'angler',     label: '🎣 The Angler',          metric: 'fish' },
  { key: 'hunter',     label: '⚔️ Monster-Hunter',      metric: 'kills' },
];

const BOSS_ANGLE = { key: 'boss_kill', label: '👑 Bane of Beasts (Boss-Slayer)' };
const EXPLORE_ANGLE = { key: 'most_explored', label: '🧭 Trailblazer' };
const IRONHIDE = {
  key: 'ironhide',
  label: '🛡️ Ironhide',
  minHours: 3,     // a real watch, not a cameo
  minKills: 10,    // …and they DID something
  minDamage: 2000, // …or hit hard enough that kills undercount it
};
const BOLD = {
  key: 'bold',
  label: '💀 The Bold',
  minDeaths: FLOORS.deaths,
  // A death crown must be the night's clear story, not its default: it wins only
  // when its score beats EVERY other angle by this margin, and never twice running.
  margin: 1.2,
};
const STEADFAST = {
  key: 'steadfast',
  label: '🌄 The Steadfast',
  minDaysOf5: 3,       // showed up on ≥3 of the last 5 calendar days
  windowDays: 5,
  perVikingDays: 7,    // at most once a week for the same viking
  everyNights: 3,      // …and at most once every 3 nights for anyone
  minRanked: 3,        // "bottom third" is meaningless in a clan of two
};

// Rotation (read from poty_history; state.json is the fallback).
const REPEAT_WINNER_NIGHTS = 3;
const REPEAT_WINNER_DISCOUNT = 0.5;
const REPEAT_ANGLE_NIGHTS = 2;
const REPEAT_ANGLE_DISCOUNT = 0.67;

// Anti-monopoly backstop: a viking may win at most this many evenings IN A ROW;
// the next would-be repeat is handed to the best alternative instead. EPIC wins
// (boss kill / new biome) are exempt — too rare and big to ever suppress.
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

// Context thresholds for the STORY the crown tells. A "1.0x" spike or a 9% share
// is not a story, so those tokens are left undefined and the blurb falls back to
// a template that does not reach for them.
const STORY_MIN_SURPRISE = 1.8;
const STORY_MIN_SHARE = 0.25;

/**
 * Append one evening's per-viking deltas to the ring buffer.
 *
 * Pure. Oldest-first, capped at `cap`, and keyed by date so re-running an
 * evening replaces its entry instead of double-counting it into the personal
 * baseline. ONLY the evening recap calls this — see postRecap.
 */
export function appendDayDeltas(list, entry, cap = DAY_DELTA_DAYS) {
  const prior = (Array.isArray(list) ? list : []).filter(
    (d) => d && typeof d === 'object' && typeof d.date === 'string' && d.date !== entry?.date,
  );
  if (!entry || typeof entry.date !== 'string' || !entry.date) return prior.slice(-cap);
  prior.push({ date: entry.date, byName: entry.byName && typeof entry.byName === 'object' ? entry.byName : {} });
  return prior.slice(-cap);
}

/** Sum a { name: value } tally over a set of names. */
function totalOver(map, names) {
  let t = 0;
  for (const nm of names) t += Number(map?.[nm]) || 0;
  return t;
}

/** 1 + NUDGE × min(h, NUDGE_HOURS)/NUDGE_HOURS — never decisive by design. */
function activityNudge(hours) {
  const h = Math.max(Number(hours) || 0, 0);
  return 1 + (NUDGE * Math.min(h, NUDGE_HOURS)) / NUDGE_HOURS;
}

/**
 * How far out of the ordinary tonight was for THIS viking on THIS metric.
 * 1 when there is not enough history to say (clan share carries the score).
 */
function personalSurprise(name, metricKey, value, floor, dayDeltas) {
  const days = Array.isArray(dayDeltas) ? dayDeltas : [];
  if (days.length < 2) return 1;
  let sum = 0;
  for (const d of days) sum += Number(d?.byName?.[name]?.[metricKey]) || 0;
  const denom = Math.max(sum / days.length, floor || 0);
  if (!(denom > 0)) return 1;
  return Math.min(value / denom, SURPRISE_CAP);
}

/** Rotation multiplier from poty_history (newest first). Epics skip this. */
function rotationFactor(name, key, history) {
  const h = Array.isArray(history) ? history : [];
  let f = 1;
  if (h.slice(0, REPEAT_WINNER_NIGHTS).some((e) => e && e.name === name)) f *= REPEAT_WINNER_DISCOUNT;
  if (h.slice(0, REPEAT_ANGLE_NIGHTS).some((e) => e && e.key === key)) f *= REPEAT_ANGLE_DISCOUNT;
  return f;
}

/**
 * Pick the Player of the Day from per-player window metrics (all keyed by
 * character_name). Pure + deterministic; never throws on empty/tie/single.
 * Returns { key, label, name, fields, seed, score, why } or null.
 *
 * ctx = {
 *   hours, windowDeaths, lastCause, bossesPresent, latestBoss, newBiomes,
 *   killsDelta, resourcesDelta, craftsDelta, buildsDelta, distanceDelta,
 *   sailDelta, fishDelta, damageDelta, mapDelta,
 *   dayDeltas,        // state.json ring buffer, oldest first, EXCLUDING tonight
 *   attendanceDays,   // { name: days played of the last 5 calendar days }
 *   progression,      // { name: map_explored_pct + normalised kills } clan-wide
 *   history,          // [{ name, key }] from poty_history, NEWEST FIRST
 *   lastCat, lastWinner, winStreak, forceUnderdog, seed,
 * }
 */
export function selectPlayerOfDay(ctx = {}) {
  const {
    windowDeaths: windowDeaths_ = {}, lastCause = {}, hours: hours_ = {},
    bossesPresent: bossesPresent_ = {}, latestBoss = {},
    killsDelta: killsDelta_ = {}, resourcesDelta: resourcesDelta_ = {},
    craftsDelta: craftsDelta_ = {}, buildsDelta: buildsDelta_ = {},
    distanceDelta: distanceDelta_ = {}, sailDelta: sailDelta_ = {},
    fishDelta: fishDelta_ = {}, damageDelta: damageDelta_ = {},
    mapDelta: mapDelta_ = {}, newBiomes: newBiomes_ = {},
    dayDeltas = [], attendanceDays: attendanceDays_ = {}, progression: progression_ = {},
    history = [],
    lastCat = null, lastWinner = null, winStreak = 0, forceUnderdog = false,
    seed = 0,
  } = ctx;

  // THE CROWN IS NEVER OFFERED TO AN EXCLUDED CHARACTER. buildStats already drops
  // them from every tally it builds, so in production these filters find nothing —
  // they are here because this function is EXPORTED and pure, and is called
  // directly by scripts/preview.js and by the tests. A draw that could crown an
  // alt depending on which caller assembled the ctx is not a rule, it is a habit;
  // this makes it a property of the draw itself. (db/2026-09-11_players_excluded.sql)
  const windowDeaths = withoutExcluded(windowDeaths_);
  const hours = withoutExcluded(hours_);
  const bossesPresent = withoutExcluded(bossesPresent_);
  const newBiomes = withoutExcluded(newBiomes_);
  const attendanceDays = withoutExcluded(attendanceDays_);
  const progression = withoutExcluded(progression_);
  const today = {
    kills: withoutExcluded(killsDelta_),
    resources: withoutExcluded(resourcesDelta_),
    crafts: withoutExcluded(craftsDelta_),
    builds: withoutExcluded(buildsDelta_),
    distance: withoutExcluded(distanceDelta_),
    sail: withoutExcluded(sailDelta_),
    fish: withoutExcluded(fishDelta_),
    damage: withoutExcluded(damageDelta_),
    map: withoutExcluded(mapDelta_),
    hours,
    deaths: windowDeaths,
  };

  // Tiebreak inputs: windowDeaths DESC (grit) -> hours DESC -> name ASC.
  const wd = windowDeaths || {};
  const hr = hours || {};

  // ── THE ACTIVITY GATE ────────────────────────────────────────────────────
  // 20 minutes on the world tonight, or no crown. Everything below ranks only
  // over this set; a viking who never logged in cannot be Player of the Day on
  // the strength of a stats-repair delta.
  const eligible = Object.keys(hr).filter((n) => (Number(hr[n]) || 0) >= MIN_ELIGIBLE_HOURS);

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
      score: 0,
      why: 'underdog, weekly spotlight',
    };
  };

  // ── candidate construction ───────────────────────────────────────────────
  // `tier` only ever ranks ABOVE score: 3 boss, 2 new biome, 1 steadfast, 0 rest.
  const candidates = [];
  const scored = (key, label, name, metricKey, value, opts = {}) => {
    const floor = opts.floor != null ? opts.floor : FLOORS[metricKey] || 0;
    const total = totalOver(today[metricKey], eligible);
    const share = total > 0 ? Math.min(value / total, 1) : 0;
    const surprise = personalSurprise(name, metricKey, value, floor, dayDeltas);
    const nudge = activityNudge(hr[name]);
    const base = Math.pow(surprise, SURPRISE_EXP) * Math.pow(share, SHARE_EXP) * nudge;
    const rot = opts.epic ? 1 : rotationFactor(name, key, history);
    return {
      key, label, name, tier: opts.tier || 0, metricKey, value,
      surprise, share, rot, score: base * rot, epic: !!opts.epic,
    };
  };

  // Epic 1 — a boss went down and this viking was in the fight.
  for (const nm of eligible) {
    const n = Number(bossesPresent[nm]) || 0;
    if (n >= 1) {
      candidates.push({
        key: BOSS_ANGLE.key, label: BOSS_ANGLE.label, name: nm, tier: 3,
        metricKey: 'boss', value: n, surprise: 1, share: 1, rot: 1,
        score: n * activityNudge(hr[nm]), epic: true,
      });
    }
  }

  // Epic 2 — a biome nobody in the clan had walked. Still epic, still exempt.
  for (const nm of eligible) {
    const fresh = Array.isArray(newBiomes[nm]) ? newBiomes[nm].length : 0;
    if (fresh >= 1) {
      candidates.push({
        key: EXPLORE_ANGLE.key, label: EXPLORE_ANGLE.label, name: nm, tier: 2,
        metricKey: 'newBiome', value: fresh, surprise: 1, share: 1, rot: 1,
        score: fresh * activityNudge(hr[nm]), epic: true,
      });
    }
  }

  // The map-delta Trailblazer: same crown, NOT epic — it rotates like any other
  // stat angle, because peeling fog is an ordinary night's work.
  for (const nm of eligible) {
    const v = Number(today.map[nm]) || 0;
    if (v >= FLOORS.map) candidates.push(scored(EXPLORE_ANGLE.key, EXPLORE_ANGLE.label, nm, 'map', v));
  }

  // The plain stat angles.
  for (const angle of ANGLES) {
    for (const nm of eligible) {
      const v = Number(today[angle.metric][nm]) || 0;
      const altV = angle.alt ? Number(today[angle.alt][nm]) || 0 : 0;
      const clears = v >= FLOORS[angle.metric] || (angle.alt && altV >= FLOORS[angle.alt]);
      if (!clears) continue;
      candidates.push(scored(angle.key, angle.label, nm, angle.metric, v));
    }
  }

  // Ironhide — a long watch that DID something and never fell.
  for (const nm of eligible) {
    const h = Number(hr[nm]) || 0;
    if (h < IRONHIDE.minHours) continue;
    if ((Number(wd[nm]) || 0) !== 0) continue;
    const k = Number(today.kills[nm]) || 0;
    const dmg = Number(today.damage[nm]) || 0;
    if (k < IRONHIDE.minKills && dmg < IRONHIDE.minDamage) continue;
    candidates.push(scored(IRONHIDE.key, IRONHIDE.label, nm, 'hours', h));
  }

  // ── The Steadfast (tier 1) ───────────────────────────────────────────────
  // Perseverance: keeps showing up while sitting in the bottom third of the
  // clan's progression. Fires at most once a week per viking and once every
  // three nights overall, and when it fires it outranks every routine stat win.
  const steadfastPick = () => {
    const h = Array.isArray(history) ? history : [];
    if (h.slice(0, STEADFAST.everyNights).some((e) => e && e.key === STEADFAST.key)) return null;
    const ranked = Object.keys(progression).sort(
      (a, b) => (Number(progression[b]) || 0) - (Number(progression[a]) || 0) ||
        a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    if (ranked.length < STEADFAST.minRanked) return null;
    const cut = Math.ceil(ranked.length / 3); // the bottom third, at least one
    const bottom = ranked.slice(ranked.length - cut);
    // Worst-placed first: the crown goes to the one furthest behind who still came.
    for (let i = bottom.length - 1; i >= 0; i--) {
      const nm = bottom[i];
      if (!eligible.includes(nm)) continue;
      if ((Number(attendanceDays[nm]) || 0) < STEADFAST.minDaysOf5) continue;
      if (h.slice(0, STEADFAST.perVikingDays).some((e) => e && e.key === STEADFAST.key && e.name === nm)) continue;
      return {
        key: STEADFAST.key, label: STEADFAST.label, name: nm, tier: 1,
        metricKey: 'attendance', value: Number(attendanceDays[nm]) || 0,
        surprise: 1, share: 0, rot: 1, score: 1, epic: false,
        progressRank: ranked.indexOf(nm) + 1, progressTotal: ranked.length,
      };
    }
    return null;
  };
  const steadfast = steadfastPick();
  if (steadfast) candidates.push(steadfast);

  // ── 💀 The Bold, on probation ────────────────────────────────────────────
  // Deaths are the one angle that used to run away with the crown. Now: the
  // viking must OWN tonight's death board outright, clear 3 falls, beat every
  // other angle by 20% on the same notability scale, and not have worn the
  // crown for it last night.
  (() => {
    const deathNames = eligible.filter((n) => (Number(wd[n]) || 0) >= BOLD.minDeaths);
    if (!deathNames.length) return;
    const top = Math.max(...deathNames.map((n) => Number(wd[n]) || 0));
    const owners = deathNames.filter((n) => (Number(wd[n]) || 0) === top);
    if (owners.length !== 1) return; // a tie is nobody's story
    const h = Array.isArray(history) ? history : [];
    if (h[0] && h[0].key === BOLD.key) return; // never two nights running
    const cand = scored(BOLD.key, BOLD.label, owners[0], 'deaths', top);
    const best = candidates.filter((c) => c.tier === 0).reduce((m, c) => Math.max(m, c.score), 0);
    if (cand.score < best * BOLD.margin) return;
    candidates.push(cand);
  })();

  // Rank: tier first (an epic always headlines), then notability, then the
  // uniform tiebreak chain so a draw is never resolved by object order.
  candidates.sort((a, b) =>
    b.tier - a.tier ||
    b.score - a.score ||
    (wd[b.name] || 0) - (wd[a.name] || 0) ||
    (hr[b.name] || 0) - (hr[a.name] || 0) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  // Weekly Unsung-Hero spotlight — but never bury an epic night under it
  // (a boss kill / new biome still headlines; the spotlight waits a day).
  if (forceUnderdog && !candidates.some((c) => c.epic)) {
    const u = underdogPick();
    if (u) return u;
  }

  if (!candidates.length) return null;

  let winner = candidates[0];

  // Anti-monopoly backstop: block a 3rd straight crown for the same person.
  // The rotation discount usually gets there first; this is the hard stop.
  const blocked = winStreak >= MAX_WIN_STREAK && lastWinner ? lastWinner : null;
  if (blocked && winner.name === blocked && !winner.epic) {
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

  // Last-resort category anti-repeat: the rotation discount already halves a
  // repeat, so this only fires when the same angle still wins outright and a
  // different one is genuinely available.
  if (!winner.epic && winner.key === lastCat) {
    const alt = candidates.find((c) => c.key !== winner.key && c.name !== blocked);
    if (alt) winner = alt;
  }

  const name = winner.name;
  const lb = latestBoss[name] || {};
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

  // THE STORY FIELDS. The crown should read like the story of the day, so the
  // selector hands format.js both the number AND the context that made it
  // notable — the spike multiple and the clan share, but only when either is
  // actually remarkable (see STORY_MIN_*), so a blurb never says "1.0x a normal
  // night". format.js's missing/zero guard falls back to a plain template when
  // they are absent.
  const fields = {
    boss: lb.boss,
    biome: lb.biome,
    deaths: windowDeaths[name] || 0,
    cause: lastCause[name],
    hours: hr[name] != null ? hr[name] : undefined,
    kills: num(today.kills[name]),
    resources: num(today.resources[name]),
    items: num(today.crafts[name]),
    builds: num(today.builds[name]),
    distance: num(today.distance[name]),
    sail: num(today.sail[name]),
    fish: num(today.fish[name]),
    damage: num(today.damage[name]),
    mapDelta: num(today.map[name]),
    newBiome: Array.isArray(newBiomes[name]) ? newBiomes[name][0] : undefined,
    attendanceDays: num(attendanceDays[name]),
    surpriseX: winner.surprise >= STORY_MIN_SURPRISE ? winner.surprise : undefined,
    clanShare: winner.share >= STORY_MIN_SHARE ? winner.share : undefined,
    progressRank: winner.progressRank,
    progressTotal: winner.progressTotal,
  };

  const why =
    `${winner.key}, surprise ${winner.surprise.toFixed(1)}x, ` +
    `share ${winner.share.toFixed(2)}, rot ${winner.rot.toFixed(2)}`;

  return {
    key: winner.key,
    label: winner.label,
    name,
    fields,
    seed: seed || 0,
    score: winner.score,
    why,
    // The runners-up, in rank order, for the operator log and the dry runs.
    // format.js ignores this; nothing player-visible reads it.
    alternatives: candidates
      .filter((c) => c !== winner)
      .slice(0, 3)
      .map((c) => ({
        name: c.name,
        key: c.key,
        score: c.score,
        why: `${c.key}, surprise ${c.surprise.toFixed(1)}x, share ${c.share.toFixed(2)}, rot ${c.rot.toFixed(2)}`,
      })),
  };
}

export function createRecap({ db, post, state, saveState, writeDb = null, tz = 'America/Chicago', startsAt = null, onPotyCrowned = null, channel = 'valheim' }) {
  // Calendar day in the recap's own timezone — the key the ring buffer and the
  // 5-day attendance count are both bucketed by.
  const dayKey = (ms) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  };

  async function buildStats(period) {
    const now = Date.now();
    // Fixed trailing-24h window — every recap answers "the last day", so the
    // morning and evening posts intentionally overlap.
    const windowStart = new Date(now - 24 * 3600 * 1000);
    const startMs = windowStart.getTime();
    const startIso = windowStart.toISOString();
    // Both ends, not just the start. A row dated in the FUTURE would otherwise
    // fall inside every window from now until that date arrives — so one
    // forged death (the /api/gs-ingest paths are unauthenticated by design; see
    // lib/event-time.ts) inflated the Fallen board and the "The Bold"
    // Player-of-the-Day tally every single day, forever. The clamp at ingest is
    // the real fix; this is the second lock on the same door.
    const endIso = new Date(now).toISOString();

    // Lazy-init POTY state so dry-run (state = {}) / first boot never throw.
    const snap = state.potyStatsSnapshot || {};
    const lastCat = state.lastPotyCategory || null;
    const dayDeltas = Array.isArray(state.dayDeltas) ? state.dayDeltas : [];

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
      // An excluded character (an alt — db/2026-09-11_players_excluded.sql) is off
      // every board this function feeds: the Online-today list, the hall's total
      // hours, the active-player count, and the `hours` map the Player-of-the-Day
      // draw ranks on. Dropped at the top of the loop so no downstream tally can
      // pick it up by accident.
      if (isExcludedName(s.character_name)) continue;
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

    // --- Attendance over the last 5 CALENDAR days (tonight's day counts).
    // The Steadfast's whole point is "keeps showing up", which the 24 h window
    // cannot see, so this is its own read.
    const attendStartIso = new Date(now - STEADFAST.windowDays * 24 * 3600 * 1000).toISOString();
    const attendanceDays = {};
    try {
      const { data: recent } = await db
        .from('sessions')
        .select('character_name, joined_at, left_at')
        .or(`left_at.is.null,left_at.gte.${attendStartIso}`);
      const seen = new Map(); // name -> Set(dayKey)
      const windowDayKeys = new Set(
        Array.from({ length: STEADFAST.windowDays }, (_, i) => dayKey(now - i * 24 * 3600 * 1000)),
      );
      for (const s of recent || []) {
        const nm = (s.character_name || '').trim();
        if (!nm || isExcludedName(nm)) continue;
        const t = new Date(s.joined_at).getTime();
        if (!Number.isFinite(t)) continue;
        const k = dayKey(t);
        if (!windowDayKeys.has(k)) continue;
        if (!seen.has(nm)) seen.set(nm, new Set());
        seen.get(nm).add(k);
      }
      for (const [nm, days] of seen) attendanceDays[nm] = days.size;
    } catch {
      // Attendance unreadable -> The Steadfast simply cannot fire tonight.
    }

    // --- Deaths in the window: serves the day board, the recap death count,
    // and the reckless-cause flavor. .limit(10000) is a defensive ceiling —
    // a truncated read would undercount the board.
    const { data: deathRows } = await db
      .from('events')
      .select('character_name, created_at, metadata')
      .eq('type', 'death')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .limit(10000);

    // One death reported by both producers is ONE death on the boards: fold the
    // twins before counting, so windowDeaths (and with it the death total, the
    // Fallen board and the POTY 'The Bold' tally) counts real falls only.
    const collapsedDeaths = collapseDeathRows(deathRows);

    const windowDeaths = {};
    const lastCause = {};
    const lastCauseAt = {};
    for (const r of collapsedDeaths) {
      const nm = (r.character_name || '').trim();
      if (!nm) continue;
      if (isExcludedName(nm)) continue; // off the Fallen board and the 'The Bold' tally
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
      .gte('killed_at', startIso)
      .lte('killed_at', endIso);

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
        if (isExcludedName(nm)) continue; // no boss-slayer crown for an excluded character
        bossesPresent[nm] = (bossesPresent[nm] || 0) + 1;
        if (!latestBoss[nm] || t >= latestBoss[nm].t) {
          latestBoss[nm] = { boss: b.name, biome: b.biome, t };
        }
      }
    }

    // --- player_stats snapshot + deltas.
    // Snapshot the CURRENT counters keyed by character_name for the next window's
    // baseline; diff against the prior snapshot for every angle's metric.
    //
    // A KEY THE PRIOR SNAPSHOT DOES NOT CARRY IS A HOLE, NOT A ZERO. The first
    // evening after this file ships, `snap` holds only the four old counters, so
    // treating a missing `structures_built` as 0 would hand whoever has built the
    // most in their LIFE a 4,000-piece "spike". Missing => delta 0, one night lost.
    const statsSnapshotNext = {};
    const killsDelta = {};
    const resourcesDelta = {};
    const craftsDelta = {};
    const buildsDelta = {};
    const distanceDelta = {};
    const sailDelta = {};
    const fishDelta = {};
    const damageDelta = {};
    const mapDelta = {};
    const newBiomes = {};
    const progression = {};
    try {
      // Ask for `excluded` and fall back without it: the column arrives in a
      // hand-applied migration, and naming a column that does not exist fails the
      // whole read (which here means every delta silently goes to zero).
      let playersRes = await db.from('players').select('id, character_name, excluded');
      if (playersRes.error) playersRes = await db.from('players').select('id, character_name');
      const players = playersRes.data;
      const idToName = new Map();
      for (const p of players || []) {
        const nm = (p.character_name || '').trim();
        // Excluded vikings never enter the id->name map, so their player_stats row
        // resolves to no name below and falls out of the snapshot AND of every
        // delta the POTY draw scores on. `excluded` is read when the column
        // exists; the name list covers the rest.
        if (nm && !isExcluded({ character_name: nm, excluded: p.excluded })) idToName.set(p.id, nm);
      }
      const { data: pstats } = await db
        .from('player_stats')
        .select(
          'player_id, kills, resources_harvested, items_crafted, distance_traveled, ' +
          'biomes_discovered, structures_built, map_explored_pct, damage_dealt, gs_stats',
        );
      // Raw cumulative counters, for the progression ranking below.
      const lifetime = {};
      for (const ps of pstats || []) {
        const nm = idToName.get(ps.player_id);
        if (!nm) continue;
        const gs = ps.gs_stats && typeof ps.gs_stats === 'object' ? ps.gs_stats : {};
        const sail = gs.distances && typeof gs.distances === 'object' ? gs.distances.sail : undefined;
        const cur = {
          kills: Number(ps.kills) || 0,
          resources_harvested: Number(ps.resources_harvested) || 0,
          items_crafted: Number(ps.items_crafted) || 0,
          distance_traveled: Number(ps.distance_traveled) || 0,
          structures_built: Number(ps.structures_built) || 0,
          damage_dealt: Number(ps.damage_dealt) || 0,
          map_explored_pct: ps.map_explored_pct == null ? null : Number(ps.map_explored_pct),
          sail_distance: sail == null ? null : Number(sail) || 0,
          fish_caught: gs.fishCaught == null ? null : Number(gs.fishCaught) || 0,
          biomes_discovered: Array.isArray(ps.biomes_discovered) ? ps.biomes_discovered : [],
        };
        statsSnapshotNext[nm] = cur;
        lifetime[nm] = { kills: cur.kills, map: cur.map_explored_pct };
        const prev = snap[nm];
        if (prev) {
          // clamp at 0 so a counter reset / world wipe never yields negatives,
          // and treat a key the old snapshot never carried as a HOLE (0).
          const d = (key) => {
            const before = prev[key];
            if (before === undefined || before === null) return 0;
            return Math.max((Number(cur[key]) || 0) - (Number(before) || 0), 0);
          };
          killsDelta[nm] = d('kills');
          resourcesDelta[nm] = d('resources_harvested');
          craftsDelta[nm] = d('items_crafted');
          buildsDelta[nm] = d('structures_built');
          distanceDelta[nm] = d('distance_traveled');
          damageDelta[nm] = d('damage_dealt');
          sailDelta[nm] = cur.sail_distance == null ? 0 : d('sail_distance');
          fishDelta[nm] = cur.fish_caught == null ? 0 : d('fish_caught');
          mapDelta[nm] =
            cur.map_explored_pct == null || prev.map_explored_pct == null
              ? 0
              : Math.max(cur.map_explored_pct - Number(prev.map_explored_pct), 0);
          const prevBiomes = new Set(Array.isArray(prev.biomes_discovered) ? prev.biomes_discovered : []);
          const fresh = cur.biomes_discovered.filter((x) => x && !prevBiomes.has(x));
          if (fresh.length) newBiomes[nm] = fresh;
        }
      }
      // Progression standing, clan-wide: map explored + kills, each normalised to
      // its own maximum so neither unit dominates. Used ONLY to find the bottom
      // third for The Steadfast — it is never shown to players.
      const maxMap = Math.max(...Object.values(lifetime).map((v) => Number(v.map) || 0), 0);
      const maxKills = Math.max(...Object.values(lifetime).map((v) => Number(v.kills) || 0), 0);
      for (const [nm, v] of Object.entries(lifetime)) {
        progression[nm] =
          (maxMap > 0 ? (Number(v.map) || 0) / maxMap : 0) +
          (maxKills > 0 ? (Number(v.kills) || 0) / maxKills : 0);
      }
    } catch {
      // players/player_stats unreadable -> no deltas, no progression; the crown
      // falls back to whatever the sessions/events reads alone can support.
    }

    // --- Rotation history. poty_history is the record; state.json is the
    // fallback for the one read that fails (or the very first night).
    let history = [];
    try {
      const { data: potyRows } = await db
        .from('poty_history')
        .select('character_name, award_category, awarded_at')
        .order('awarded_at', { ascending: false })
        .limit(20);
      history = (potyRows || [])
        .map((r) => ({ name: (r.character_name || '').trim(), key: r.award_category, at: r.awarded_at }))
        .filter((r) => r.name);
    } catch {
      history = [];
    }
    if (!history.length && state.lastPotyWinner) {
      history = [{ name: state.lastPotyWinner, key: state.lastPotyCategory || null }];
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
        killsDelta, resourcesDelta, craftsDelta, buildsDelta,
        distanceDelta, sailDelta, fishDelta, damageDelta, mapDelta, newBiomes,
        dayDeltas, attendanceDays, progression, history,
        lastCat,
        lastWinner: state.lastPotyWinner || null,
        winStreak: state.potyWinStreak || 0,
        forceUnderdog: underdogDue,
        seed: worldDay,
      });
      // One operator line, never posted: why this viking and not the runner-up.
      if (poty) console.log(`[recap] poty: ${poty.name} — ${poty.why}`);
      else console.log('[recap] poty: nobody cleared a floor tonight');
    }

    // Tonight's per-viking deltas, in the ring buffer's shape. postRecap appends
    // this on the EVENING only — a morning render must not move the baseline.
    //
    // ZEROES ARE OMITTED, DELIBERATELY. state.json is rewritten in full on every
    // saveState — and relay.tick() saves after EVERY relayed row — so this
    // buffer is on the hot write path. Storing seven days × the whole roster ×
    // eleven fields verbatim roughly tripled the file; personalSurprise reads
    // a missing key as 0 anyway, so the absent fields cost nothing.
    const dayDeltaEntry = { date: dayKey(now), byName: {} };
    const round = (v, p) => Math.round((Number(v) || 0) * p) / p;
    for (const nm of new Set([...Object.keys(hours), ...Object.keys(killsDelta)])) {
      if (isExcludedName(nm)) continue;
      const row = {};
      const put = (k, v) => { if (v > 0) row[k] = v; };
      put('kills', Math.round(killsDelta[nm] || 0));
      put('builds', Math.round(buildsDelta[nm] || 0));
      put('crafts', Math.round(craftsDelta[nm] || 0));
      put('resources', Math.round(resourcesDelta[nm] || 0));
      put('distance', Math.round(distanceDelta[nm] || 0));
      put('sail', Math.round(sailDelta[nm] || 0));
      put('fish', Math.round(fishDelta[nm] || 0));
      put('map', round(mapDelta[nm], 100));
      put('damage', Math.round(damageDelta[nm] || 0));
      put('hours', round(hours[nm], 100));
      put('deaths', Math.round(windowDeaths[nm] || 0));
      if (Object.keys(row).length) dayDeltaEntry.byName[nm] = row;
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
      _dayDeltaEntry: dayDeltaEntry,
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
      // The personal-surprise baseline only ever grows from evening recaps: one
      // append per night, deduped by date, capped at DAY_DELTA_DAYS.
      state.dayDeltas = appendDayDeltas(state.dayDeltas, stats._dayDeltaEntry);
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
    // The crown carries its own story, so the in-game line can say WHY.
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

  return { buildStats, postRecap, schedule, selectPlayerOfDay, collapseDeathRows, appendDayDeltas };
}
