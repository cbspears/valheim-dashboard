// Collective Milestones ("Great Deeds") announcer.
//
// The dashboard's evaluator (lib/milestones.ts, hooked into /api/gs-ingest)
// stamps achieved_at / achieved_value on a milestone row the moment the warband
// crosses a server-wide threshold, and queues the in-game voice line + Saga
// event. THIS loop is the Discord half: it polls for deeds that are achieved but
// not yet cross-posted (achieved_at not null AND announced_at is null), announces
// ONE per tick (the spec's announce cap — bursts drain one snapshot at a time),
// and sets announced_at so it never re-fires.
//
// Backfilled deeds (the silent ones from scripts/seed-milestones-backfill.mjs)
// already have announced_at set, so the plain filter excludes them — no
// meta.backfill check needed.
//
// The embed carries the deed's title, ceremonial line, real-world equivalence,
// and a "Next deed" progress line toward the nearest unachieved milestone (by
// percentage). No @everyone — Great Deeds are celebratory, not a call to arms.
//
// Channel: env MILESTONE_CHANNEL (default 'valheim'). Needs the service-role
// client to write announced_at; degrades to a warn-once skip without it, and
// tolerates the milestones table not existing yet (pre-migration).

import { GOLD } from './format.js';

const FOOTER = 'Eilif · The Cozy Canon Playthrough';

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
    playtime_total_hours: playtimeMinutes(sessions, onlineNames) / 60,
    explored_avg_pct: (() => {
      const p = stats.map((r) => r.map_explored_pct).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return p.length ? p.reduce((t, v) => t + v, 0) / p.length : 0;
    })(),
  };
}

export function createMilestonesAnnouncer({ db, writeDb, post, channel = 'valheim', log = console }) {
  let warnedMissing = false;
  let warnedNoWrite = false;

  // The nearest unachieved milestone by percentage, with its progress %.
  async function nextDeedProgress(allRows) {
    const pending = allRows.filter((m) => !m.achieved_at);
    if (pending.length === 0) return null;

    const [statsRes, sessionsRes, playersRes] = await Promise.all([
      db.from('player_stats').select('*'),
      db.from('sessions').select('*'),
      db.from('players').select('character_name, is_online'),
    ]);
    const stats = statsRes.data ?? [];
    const sessions = sessionsRes.data ?? [];
    const onlineNames = new Set(
      (playersRes.data ?? []).filter((p) => p.is_online && p.character_name).map((p) => p.character_name),
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

  function buildEmbed(deed, next) {
    const fields = [];
    if (deed.equivalence) fields.push({ name: 'That is', value: deed.equivalence, inline: false });
    if (next) fields.push({ name: 'Next deed', value: `${next.title} — ${next.pct}%`, inline: false });
    return {
      embeds: [
        {
          title: `🏆 A Great Deed: ${deed.title}`,
          description: deed.line,
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

    // One achieved-but-unannounced deed, oldest first (announce cap = 1/tick).
    const { data: pending, error } = await db
      .from('milestones')
      .select('*')
      .not('achieved_at', 'is', null)
      .is('announced_at', null)
      .order('achieved_at', { ascending: true })
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

    // Progress toward the nearest unachieved deed (best-effort; never blocks).
    let next = null;
    try {
      const { data: all } = await db.from('milestones').select('id, title, metric, threshold, achieved_at');
      if (all) next = await nextDeedProgress(all);
    } catch (e) {
      log.warn?.(`[milestones] progress calc skipped: ${e.message}`);
    }

    await post(channel, buildEmbed(deed, next));

    // Mark announced (guarded so a concurrent tick can't double-post).
    const { error: upErr } = await writeDb
      .from('milestones')
      .update({ announced_at: new Date().toISOString() })
      .eq('id', deed.id)
      .is('announced_at', null);
    if (upErr) log.error?.(`[milestones] mark announced failed for ${deed.id}: ${upErr.message}`);

    log.info?.(`[milestones] announced "${deed.title}" to #${channel}`);
    return 1;
  }

  return { tick };
}
