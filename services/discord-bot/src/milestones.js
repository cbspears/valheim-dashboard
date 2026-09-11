// Collective Milestones ("Great Deeds") announcer.
//
// The dashboard's evaluator (lib/milestones.ts, hooked into /api/gs-ingest)
// stamps achieved_at / achieved_value on a milestone row the moment the warband
// crosses a server-wide threshold, and writes the Saga event. THIS loop is the
// announcement half: it polls for deeds that are achieved but not yet announced
// (achieved_at not null AND announced_at is null), announces ONE per tick
// (bursts drain one snapshot at a time), and sets announced_at so it never
// re-fires.
//
// ONE ANNOUNCEMENT MOMENT (Charlie, 2026-08-22): the Discord embed AND the
// in-game voice line fire together, here, in the same pass — the evaluator no
// longer queues the voice line at threshold-crossing time. Several deeds
// crossing at once are announced SEQUENTIALLY, oldest first, one per tick, with
// MILESTONE_MIN_GAP_MS (default 1 min) of quiet between deed announcements.
// Nothing is silenced; rarity is the thresholds' job.
//
// Backfilled deeds (the silent ones from scripts/seed-milestones-backfill.mjs)
// already have announced_at set, so the plain filter excludes them — no
// meta.backfill check needed.
//
// The embed carries the deed's title, ceremonial line (the description), real-
// world equivalence, and a "Next deed" progress line toward the nearest
// unachieved milestone (by percentage). No @everyone — Great Deeds are
// celebratory, not a call to arms.
//
// Channel: env MILESTONE_CHANNEL (default 'valheim'). Needs the service-role
// client to write announced_at + the voice line; degrades to a warn-once skip
// without it, and tolerates the milestones table not existing yet.

import { GOLD } from './format.js';
import { isExcluded, isExcludedName } from './excluded.js';

const FOOTER = 'Eilif · The Cozy Canon Playthrough';
const DEFAULT_MIN_GAP_MS = 60_000; // MILESTONE_MIN_GAP_MS default — 1 minute
// A spoken line has to land center-screen in a couple of seconds, so the
// equivalence tail is dropped rather than allowed to push past this.
const VOICE_MAX_CHARS = 200;

/** Interpolate {value} (the achieved aggregate) into a ceremonial line. */
function renderLine(line, value) {
  const text = String(line ?? '');
  if (!text.includes('{value}')) return text;
  const n = Number(value);
  const shown = Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '';
  return text.replace(/\{value\}/g, shown);
}

/**
 * Charlie's ask: the equivalence the embed already shows should ride along on
 * the SPOKEN line too, as a short second sentence ("... That is about 166
 * trolls of hurt."). The equivalence copy itself lives in the DB and is written
 * to read casually, so it's dropped in as-is; only a leading ≈ is spelled out.
 * Returns `line` unchanged when there's no equivalence or the pair would run
 * past what's readable in-game.
 */
function withEquivalence(line, equivalence) {
  const base = String(line ?? '').trim();
  const eq = String(equivalence ?? '').trim().replace(/^≈\s*/, 'about ').replace(/[.!?]+$/, '');
  if (!base || !eq) return base;
  const combined = `${base} That is ${eq}.`;
  return combined.length > VOICE_MAX_CHARS ? base : combined;
}

// Postgres "relation does not exist" — the milestones migration isn't applied.
function isMissingTable(error) {
  if (!error) return false;
  const msg = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return error.code === '42P01' || /milestones.* does not exist|could not find the table/.test(msg);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Per-mode distance (metres) folded into gs_stats.distances by /api/gs-ingest.
function distances(row) {
  const d = row?.gs_stats?.distances;
  return { walk: num(d?.walk), run: num(d?.run), sail: num(d?.sail) };
}
const sumStats = (rows, key) => rows.reduce((t, r) => t + num(r[key]), 0);

// Catches, summed from a viking's per-species fish breakdown in gs_stats — there
// is no dedicated column. Mirrors fishCount() in lib/milestones.ts, including
// its fallback for a bare `{ prefabId: count }` map.
function fishCount(row) {
  const list = row?.gs_stats?.fish;
  if (Array.isArray(list)) {
    return list.reduce((t, f) => t + (f && typeof f === 'object' ? num(f.count) : 0), 0);
  }
  if (list && typeof list === 'object') {
    return Object.values(list).reduce((t, v) => t + num(v), 0);
  }
  return 0;
}

// Total playtime minutes per character, from sessions — mirrors
// lib/data.playtimeMinutesByCharacter (open sessions only count for the live,
// currently-online character; earlier dangling opens are dropped).
function playtimeMinutes(sessions, onlineNames) {
  const byName = new Map();
  for (const s of sessions) {
    if (!s.character_name) continue;
    const arr = byName.get(s.character_name) ?? [];
    arr.push(s);
    byName.set(s.character_name, arr);
  }
  const now = Date.now();
  let total = 0;
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
    sorted.forEach((s, i) => {
      if (s.duration_minutes != null) {
        total += s.duration_minutes;
      } else if (i === sorted.length - 1 && onlineNames.has(name)) {
        total += Math.max(0, Math.round((now - new Date(s.joined_at).getTime()) / 60000));
      }
    });
  }
  return total;
}

// The v1 metric map — kept in lockstep with METRICS in lib/milestones.ts. Only
// used here to compute the display-only "next deed" progress percentage.
function computeAggregates({ stats, sessions, onlineNames }) {
  return {
    sail_total: stats.reduce((t, r) => t + distances(r).sail, 0),
    walk_run_total: stats.reduce((t, r) => t + distances(r).walk + distances(r).run, 0),
    deaths_total: sumStats(stats, 'deaths'),
    kills_total: sumStats(stats, 'kills'),
    boss_kills_total: sumStats(stats, 'boss_kills'),
    damage_total: sumStats(stats, 'damage_dealt'),
    resources_total: sumStats(stats, 'resources_harvested'),
    crafts_total: sumStats(stats, 'items_crafted'),
    builds_total: sumStats(stats, 'structures_built'),
    fish_total: stats.reduce((t, r) => t + fishCount(r), 0),
    playtime_total_hours: playtimeMinutes(sessions, onlineNames) / 60,
    explored_avg_pct: (() => {
      const p = stats.map((r) => r.map_explored_pct).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return p.length ? p.reduce((t, v) => t + v, 0) / p.length : 0;
    })(),
  };
}

export function createMilestonesAnnouncer({
  db,
  writeDb,
  post,
  channel = 'valheim',
  state = {},
  saveState = async () => {},
  minGapMs = DEFAULT_MIN_GAP_MS,
  log = console,
}) {
  let warnedMissing = false;
  let warnedNoWrite = false;
  const gapMs = Number.isFinite(minGapMs) && minGapMs >= 0 ? minGapMs : DEFAULT_MIN_GAP_MS;

  // Deeds THIS PROCESS has already posted. The database row is the truth across
  // restarts; this set covers the window the row cannot — between the embed
  // going out and `announced_at` being written. See the note in tick().
  const announcedHere = new Set();
  // Deed ids whose failed mark has already been reported once, so the quiet
  // retry does not become a per-minute error line.
  const markFailureLogged = new Set();

  /**
   * Stamp announced_at. `.is('announced_at', null)` keeps it a safe claim: a
   * concurrent tick (or a second bot) can never double-mark. Returns true when
   * the write reported no error; never throws.
   */
  async function markAnnounced(deed) {
    let error = null;
    try {
      ({ error } = await writeDb
        .from('milestones')
        .update({ announced_at: new Date().toISOString() })
        .eq('id', deed.id)
        .is('announced_at', null));
    } catch (e) {
      error = e;
    }
    if (!error) {
      markFailureLogged.delete(deed.id);
      return true;
    }
    if (!markFailureLogged.has(deed.id)) {
      markFailureLogged.add(deed.id);
      log.error?.(
        `[milestones] mark announced failed for ${deed.id}: ${error.message ?? String(error)} — ` +
          'already announced in this process; retrying the write quietly',
      );
    }
    return false;
  }

  // Epoch ms of the last deed announcement, persisted across restarts.
  function lastPostAt() {
    const t = Date.parse(state.lastMilestonePostAt ?? '');
    return Number.isFinite(t) ? t : null;
  }

  /**
   * The roster read behind the progress line: online set + exclusion, one query.
   * Two-tier for the same reason lib/milestones.ts readPlayersForAggregate is —
   * `players.excluded` arrives by hand, and a select naming a missing column fails
   * outright, which here would empty the online set and undercount playtime.
   */
  async function readPlayersForProgress(client) {
    const withFlag = await client.from('players').select('id, character_name, is_online, excluded');
    if (!withFlag.error) return withFlag;
    return client.from('players').select('id, character_name, is_online');
  }

  // The nearest unachieved milestone by percentage, with its progress %.
  async function nextDeedProgress(allRows) {
    const pending = allRows.filter((m) => !m.achieved_at);
    if (pending.length === 0) return null;

    const [statsRes, sessionsRes, playersRes] = await Promise.all([
      db.from('player_stats').select('*'),
      db.from('sessions').select('*'),
      readPlayersForProgress(db),
    ]);

    // The "Next deed (NN%)" line under every Great Deed embed is the same number
    // the site's progress bar shows, and lib/data.ts computes that one from
    // filtered inputs. If this one counted an excluded character (an alt —
    // db/2026-09-11_players_excluded.sql) the bot would advertise a percentage
    // the site never reaches, on a deed the evaluator will fire at a different
    // moment. Filter the same three person-keyed inputs, the same way.
    const playerRows = playersRes.data ?? [];
    const excludedIds = new Set(
      playerRows.filter((p) => isExcluded(p)).map((p) => p.id).filter(Boolean),
    );
    const stats = (statsRes.data ?? []).filter((s) => !excludedIds.has(s.player_id));
    const sessions = (sessionsRes.data ?? []).filter((s) => !isExcludedName(s.character_name));
    const onlineNames = new Set(
      playerRows
        .filter((p) => p.is_online && p.character_name && !isExcluded(p))
        .map((p) => p.character_name),
    );
    const agg = computeAggregates({ stats, sessions, onlineNames });

    let best = null;
    for (const m of pending) {
      const value = agg[m.metric];
      if (typeof value !== 'number' || !(m.threshold > 0)) continue;
      const pct = Math.min(99, Math.round((value / m.threshold) * 100));
      if (!best || pct > best.pct) best = { title: m.title, pct };
    }
    return best;
  }

  function buildEmbed(deed, next, line) {
    const fields = [];
    if (deed.equivalence) fields.push({ name: 'That is', value: deed.equivalence, inline: false });
    if (next) fields.push({ name: 'Next deed', value: `${next.title} (${next.pct}%)`, inline: false });
    return {
      embeds: [
        {
          // "Great Deed", not "Milestone": the site, the in-game boards and the
          // ledger all call these Great Deeds, and the embed is the one place a
          // player met the internal word.
          title: `🏆 Great Deed: ${deed.title}`,
          description: line,
          color: GOLD,
          fields,
          footer: { text: FOOTER },
        },
      ],
    };
  }

  async function tick() {
    if (!writeDb) {
      if (!warnedNoWrite) {
        log.warn?.('[milestones] no service-role client — Great Deeds announcer disabled');
        warnedNoWrite = true;
      }
      return 0;
    }

    // Sequential pacing: when several deeds cross together they still all get
    // announced, just one per MILESTONE_MIN_GAP_MS (default 1 min), oldest
    // first. Nothing is dropped — the queue drains at a pace that still reads
    // as one deed at a time rather than a wall of embeds.
    const last = lastPostAt();
    if (last != null && Date.now() - last < gapMs) return 0;

    // One achieved-but-unannounced deed, oldest first (announce cap = 1/tick).
    // A whole evaluator cycle stamps the SAME achieved_at on every deed it
    // crosses, so achieved_at alone leaves same-instant bursts in arbitrary
    // order. `sort` (the ladder column the ledger orders by) breaks the tie, so
    // a chain announces bottom rung first.
    const { data: pending, error } = await db
      .from('milestones')
      .select('*')
      .not('achieved_at', 'is', null)
      .is('announced_at', null)
      .order('achieved_at', { ascending: true })
      .order('sort', { ascending: true })
      .limit(1);

    if (error) {
      if (isMissingTable(error)) {
        if (!warnedMissing) {
          log.info?.('[milestones] table not migrated yet — skipping until db/2026-07-05_milestones.sql is applied');
          warnedMissing = true;
        }
        return 0;
      }
      log.error?.(`[milestones] poll failed: ${error.message}`);
      return 0;
    }
    warnedMissing = false;
    const deed = pending?.[0];
    if (!deed) return 0;

    // ALREADY ANNOUNCED BY THIS PROCESS (T-3 audit, bot-1).
    //
    // The embed and the in-game voice line fire before `announced_at` can be
    // written, and that write can fail (a permission error, a dropped
    // connection). It used to be logged and forgotten: the row still matched the
    // pending filter, so the SAME deed announced again on the next tick — one
    // duplicate embed plus one duplicate center-screen voice line, for every
    // player online, every MILESTONE_MIN_GAP_MS, until the write happened to
    // succeed. The set is the memory the row cannot provide until it is stamped.
    // Retry the mark quietly here and announce nothing.
    if (announcedHere.has(deed.id)) {
      await markAnnounced(deed);
      return 0;
    }

    // Progress toward the nearest unachieved deed (best-effort; never blocks).
    let next = null;
    try {
      const { data: all } = await db.from('milestones').select('id, title, metric, threshold, achieved_at');
      if (all) next = await nextDeedProgress(all);
    } catch (e) {
      log.warn?.(`[milestones] progress calc skipped: ${e.message}`);
    }

    // ── the single announcement moment: Discord embed + in-game voice line ──
    const line = renderLine(deed.line, deed.achieved_value);

    await post(channel, buildEmbed(deed, next, line));
    // The embed is out. From this line on the deed counts as announced whatever
    // the database write below does — a post that happened cannot be unhappened,
    // and repeating it is worse than losing the record of it.
    announcedHere.add(deed.id);

    // Eilif speaks the same ceremonial line center-screen, with the deed's
    // equivalence tacked on when it fits. Exempt from the voice engine's
    // ambient min-gap — a Great Deed is never small talk.
    const spoken = withEquivalence(line, deed.equivalence);
    try {
      const { error: vErr } = await writeDb.from('voice_lines').insert({
        text: spoken,
        speaker: 'Eilif',
        kind: 'event',
        meta: { source: 'milestone', id: deed.id, title: deed.title },
        status: 'queued',
        queued_at: new Date().toISOString(),
      });
      if (vErr) log.error?.(`[milestones] voice enqueue failed for ${deed.id}: ${vErr.message}`);
    } catch (e) {
      log.error?.(`[milestones] voice enqueue failed for ${deed.id}: ${e.message}`);
    }

    // Mark announced. A failure here is no longer load-bearing: `announcedHere`
    // already holds this deed, so the next tick retries the write instead of the
    // announcement.
    await markAnnounced(deed);

    state.lastMilestonePostAt = new Date().toISOString();
    await saveState();

    log.info?.(`[milestones] announced "${deed.title}" to #${channel} (embed + voice)`);
    return 1;
  }

  return { tick };
}
