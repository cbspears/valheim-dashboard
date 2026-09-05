// The Skald's Chronicle — ONE weekly dispatch (Sunday 20:00 America/Chicago by
// default) to CHRONICLE_CHANNEL (default #valheim), covering the TRAILING SEVEN
// DAYS: who arrived, who put in the hours, who fell and to what, kills, deeds
// earned, bosses felled with their war party, titles that changed, the week's
// Player-of-the-Day winners, and one line of what is coming next.
//
// OFF BY DEFAULT. index.js only builds this when WEEKLY_CHRONICLE=1, so nothing
// changes on launch night unless the flag is flipped.
//
// It is the weekly companion to the nightly recap (recap.js) and follows its
// shape deliberately: all reads and scoring live here, all rendering lives in
// formatChronicle below, which is PURE (a plain object in, a Discord payload
// out) so scripts/chronicle.test.mjs can assert the copy with no network.
//
// READ-ONLY against Supabase. The only thing it writes is the bot's own
// state.json (the weekly kill baseline + the last week it posted), so it runs
// unchanged under the dry run's read-only client proxy.
//
// NO LLM. The Skald retelling (retelling.js) is a separate, best-effort thing
// that calls a local model per boss; this is plain aggregation.
import cron from 'node-cron';
import { GOLD } from './format.js';
import { collapseDeathRows } from './recap.js';

const FOOTER = 'Eilif · The Cozy Canon Playthrough';

/** Trailing window the Chronicle reports on. */
export const CHRONICLE_WINDOW_DAYS = 7;
/** How many vikings the hours board names. */
export const HOURS_BOARD_LIMIT = 5;
/** How many vikings the deaths board names. */
export const FALLEN_BOARD_LIMIT = 3;

// Discord embed hard limits we could plausibly reach on a busy week.
const MAX_FIELD_VALUE = 1024;
// Discord counts title + description + footer + EVERY field name and value
// against one 6000-char ceiling and rejects the whole embed with a 400 past it.
// Seven optional boards can each reach 1024, so a very busy week could cross it
// and lose the entire weekly post. Aim under, with room to spare.
const MAX_EMBED_TOTAL = 5600;

// --- small pure helpers -----------------------------------------------------

/** Escape Discord markdown specials so a name like "Bj*rn" can't break layout. */
function escapeMd(s) {
  return String(s).replace(/([*_`~])/g, '\\$1');
}

/** Defensive 24-char cap (well under the embed field limits) + escaping. */
function nameMd(s) {
  const t = String(s);
  return escapeMd(t.length > 24 ? t.slice(0, 24) : t);
}

/** Join board lines and clip to the embed field ceiling. */
function joinLines(lines) {
  const out = lines.filter(Boolean).join('\n');
  return out.length > MAX_FIELD_VALUE ? `${out.slice(0, MAX_FIELD_VALUE - 1)}…` : out;
}

/**
 * Per-name played hours from session rows clipped to [startMs, nowMs].
 *
 * Pure and total. Shared with bosspoll.js, which ranks the same way when it
 * picks who goes on the ballot, so "most active this week" means one thing in
 * both features.
 *
 * An OPEN session (left_at NULL) that began before the window is a missed leave
 * event — the server pauses when empty, so nobody truly plays a week straight.
 * Counting it would park a phantom flat 168.0h at the top of the board forever,
 * so it is skipped and reported back to the caller for a warning. Same rule the
 * nightly recap applies to its 24h window.
 */
export function sessionHours(rows, startMs, nowMs) {
  const hours = {};
  const staleOpen = [];
  let totalMs = 0;
  for (const s of rows || []) {
    const joined = Date.parse(s?.joined_at);
    if (!Number.isFinite(joined)) continue;
    if (!s.left_at && joined < startMs) {
      staleOpen.push((s.character_name || '?').trim() || '?');
      continue;
    }
    const leftMs = s.left_at ? Date.parse(s.left_at) : nowMs;
    const start = Math.max(joined, startMs);
    const end = Math.min(Number.isFinite(leftMs) ? leftMs : nowMs, nowMs);
    if (end <= start) continue;
    totalMs += end - start;
    const nm = (s.character_name || '').trim();
    if (!nm) continue;
    hours[nm] = (hours[nm] || 0) + (end - start) / 3600000;
  }
  return { hours, staleOpen, totalHours: totalMs / 3600000 };
}

/**
 * Top N by hours: hours DESC, then name ASC (case-insensitive) so a tie always
 * renders the same way. Zero-hour entries never make the board.
 */
export function pickTopHours(hours = {}, limit = HOURS_BOARD_LIMIT) {
  return Object.keys(hours)
    .filter((n) => (hours[n] || 0) > 0)
    .map((name) => ({ name, hours: hours[name] }))
    .sort((a, b) => b.hours - a.hours || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, limit);
}

/**
 * Top N by deaths, carrying the last thing that killed each of them (the cause
 * is optional: only one of the two death producers knows it).
 * deaths DESC, then name ASC.
 */
export function pickTopFallen(windowDeaths = {}, lastCause = {}, limit = FALLEN_BOARD_LIMIT) {
  return Object.keys(windowDeaths)
    .filter((n) => (windowDeaths[n] || 0) > 0)
    .map((name) => ({ name, count: windowDeaths[name], cause: lastCause[name] }))
    .sort((a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, limit);
}

/**
 * One line of what is coming next: the first boss the clan has NOT felled, in
 * ladder order. Pure; tolerates a missing/short/unsorted boss list.
 *
 * An EMPTY or missing list is "unknown", never "finished". The bosses table is
 * seeded with the whole ladder and is never legitimately empty, so an empty read
 * means the select failed, and answering that with "every boss has fallen" would
 * publish a flatly false sentence to the hall on a week Bonemass is still alive.
 */
export function nextHorizonLine(bosses) {
  const list = (Array.isArray(bosses) ? bosses : []).filter(Boolean);
  if (!list.length) return 'The boss ladder could not be read this week, so what comes next goes unnamed.';
  const next = list
    .slice()
    .filter((b) => !b.is_killed)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
  if (!next) return 'Every boss on the ladder has fallen. What comes next is yours to name.';
  const biome = next.biome ? ` in the ${escapeMd(next.biome)}` : '';
  return `**${escapeMd(next.name)}**${biome} still stands. That is the next name for the book.`;
}

/**
 * Local calendar date (YYYY-MM-DD) in `tz`. The Chronicle posts once a week, so
 * the date it posted on is a sufficient "have I already sent this one" key, and
 * it stays readable in state.json.
 */
export function weekKey(date, tz = 'America/Chicago') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** "Aug 30 to Sep 5" for the subtitle. Never a dash: the copy doctrine bans them. */
function windowLabel(fromIso, toIso, tz) {
  const fmt = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(
        new Date(iso)
      );
    } catch {
      return String(iso).slice(0, 10);
    }
  };
  return `${fmt(fromIso)} to ${fmt(toIso)}`;
}

/** Characters Discord counts against the 6000-per-embed ceiling. */
export function embedLength(embed) {
  let n =
    (embed.title || '').length + (embed.description || '').length + (embed.footer?.text || '').length;
  for (const f of embed.fields || []) n += (f.name || '').length + (f.value || '').length;
  return n;
}

/**
 * Shrink the optional boards evenly so the whole embed fits the ceiling. Every
 * section survives, just shorter; the alternative is a 400 that loses the week's
 * post entirely (and, with it, the kill-baseline roll). Pure.
 */
export function fitBoards(boards, allowance) {
  if (!boards.length) return boards;
  const total = boards.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (total <= allowance) return boards;
  const nameChars = boards.reduce((n, f) => n + f.name.length, 0);
  const per = Math.max(60, Math.floor((allowance - nameChars) / boards.length));
  return boards.map((f) => (f.value.length > per ? { ...f, value: `${f.value.slice(0, per - 1)}…` } : f));
}

// --- rendering (pure) -------------------------------------------------------

/**
 * The weekly embed. Plain labels first, Norse flavor in the subtitle only.
 *
 * chron = { from, to, windowLabel, worldDay, activeVikings, hoursTotal,
 *           deathsTotal, killsWeek:{value,hasBaseline}, arrivals:[{name}],
 *           hoursTop:[{name,hours}], fallenTop:[{name,count,cause}],
 *           deeds:[{title}], bosses:[{name,biome,warParty:[]}],
 *           titles:[{name,title}], poty:[{name,label}], horizon, quiet }
 *
 * Every section is omitted when it is empty, so a slow week reads short instead
 * of reading like a broken dashboard.
 */
export function formatChronicle(chron) {
  const title = '📜 The week in the hall';
  const subtitle = `The Skald's Chronicle, ${chron.windowLabel}.`;

  if (chron.quiet) {
    return {
      embeds: [
        {
          title,
          description:
            `${subtitle} A quiet seven days: no arrivals, no falls, no deeds set down. ` +
            `${chron.horizon}`,
          color: GOLD,
          footer: { text: FOOTER },
        },
      ],
    };
  }

  const fields = [
    { name: 'Vikings on this week', value: `${chron.activeVikings}`, inline: true },
    { name: 'Hours logged', value: `${chron.hoursTotal.toFixed(1)}h`, inline: true },
    { name: 'Deaths', value: `${chron.deathsTotal}`, inline: true },
  ];

  // Kills only becomes a real weekly number once a baseline snapshot exists, so
  // the FIRST Chronicle says so plainly instead of publishing a lifetime total
  // dressed up as a week. A week whose counters could not be read says THAT,
  // rather than borrowing either of the other two meanings.
  fields.push({
    name: 'Kills',
    value: chron.killsWeek.unavailable
      ? 'Not counted this week'
      : chron.killsWeek.hasBaseline
        ? `${chron.killsWeek.value}`
        : 'Counting starts this week',
    inline: true,
  });
  fields.push({ name: 'World day', value: `${chron.worldDay}`, inline: true });

  // The optional boards. Collected separately from the summary row and the
  // horizon line, which always survive, so a busy week shrinks the boards
  // instead of losing the whole embed to Discord's 6000-char ceiling.
  const boards = [];

  if (chron.arrivals.length) {
    boards.push({
      name: 'New arrivals',
      value: joinLines(chron.arrivals.map((a) => `🌱 **${nameMd(a.name)}**`)),
      inline: false,
    });
  }

  if (chron.hoursTop.length) {
    boards.push({
      name: `Hours by viking (top ${Math.min(chron.hoursTop.length, HOURS_BOARD_LIMIT)})`,
      value: joinLines(
        chron.hoursTop.map((r, i) => `${i + 1}. 🛡️ **${nameMd(r.name)}** · ${Number(r.hours).toFixed(1)}h`)
      ),
      inline: false,
    });
  }

  if (chron.fallenTop.length) {
    boards.push({
      name: 'Deaths and causes',
      value: joinLines(
        chron.fallenTop.map(
          (r) =>
            `💀 **${nameMd(r.name)}** ×${r.count}` +
            (r.cause ? ` · last cause: ${escapeMd(r.cause)}` : '')
        )
      ),
      inline: false,
    });
  }

  if (chron.bosses.length) {
    boards.push({
      name: 'Bosses felled',
      value: joinLines(
        chron.bosses.map((b) => {
          const party = (b.warParty || []).map((n) => nameMd(n)).join(', ');
          return `👑 **${escapeMd(b.name)}**` + (party ? ` · war party: ${party}` : '');
        })
      ),
      inline: false,
    });
  }

  if (chron.deeds.length) {
    boards.push({
      name: 'Deeds earned',
      value: joinLines(chron.deeds.map((d) => `🏅 ${escapeMd(d.title)}`)),
      inline: false,
    });
  }

  if (chron.titles.length) {
    boards.push({
      name: 'Titles changed',
      value: joinLines(chron.titles.map((t) => `⚔️ **${nameMd(t.name)}** is now ${escapeMd(t.title)}`)),
      inline: false,
    });
  }

  if (chron.poty.length) {
    boards.push({
      name: 'Player of the Day winners',
      value: joinLines(chron.poty.map((p) => `🏆 **${nameMd(p.name)}** · ${escapeMd(p.label)}`)),
      inline: false,
    });
  }

  const horizonField = { name: 'Next on the horizon', value: chron.horizon, inline: false };
  const description = `${subtitle} Seven days of arrivals, hours, falls and deeds, set down in order.`;

  // Everything that is not a board is fixed cost; whatever is left of the
  // ceiling is what the boards get to share.
  const fixed =
    title.length +
    description.length +
    FOOTER.length +
    [...fields, horizonField].reduce((n, f) => n + f.name.length + f.value.length, 0);

  return {
    embeds: [
      {
        title,
        description,
        color: GOLD,
        fields: [...fields, ...fitBoards(boards, MAX_EMBED_TOTAL - fixed), horizonField],
        footer: { text: FOOTER },
      },
    ],
  };
}

// --- the loop ---------------------------------------------------------------

/**
 * supabase-js RESOLVES with `{ data, error }` — it does not throw, so a
 * try/catch around a select is dead code and a failed read looks exactly like
 * an empty table. This is the one place that distinguishes them:
 *   null  = the read failed (already logged)
 *   array = what the table actually holds, possibly empty
 */
function rowsOf(label, res) {
  if (res?.error) {
    console.warn(`[chronicle] ${label} read failed, that section is omitted: ${res.error.message}`);
    return null;
  }
  return res?.data || [];
}

export function createChronicle({
  db,
  post,
  state,
  saveState,
  tz = 'America/Chicago',
  channel = 'valheim',
  days = CHRONICLE_WINDOW_DAYS,
  hour = 20,
  weekday = 0, // 0 = Sunday
  startsAt = null, // launch gate, same shape as the recap's RECAPS_START
}) {
  /** Read everything the week needs. Read-only; never throws on a missing table. */
  async function buildChronicle(nowMs = Date.now()) {
    const startMs = nowMs - days * 24 * 3600 * 1000;
    const startIso = new Date(startMs).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    // --- hours + who was on -------------------------------------------------
    const sessions = rowsOf(
      'sessions',
      await db
        .from('sessions')
        .select('character_name, joined_at, left_at')
        .or(`left_at.is.null,left_at.gte.${startIso}`)
    );
    const { hours, staleOpen, totalHours } = sessionHours(sessions, startMs, nowMs);
    if (staleOpen.length) {
      console.warn(
        `[chronicle] ignored ${staleOpen.length} stale open session(s) (left_at NULL, joined >${days}d ago) — close these rows: ${staleOpen.join(', ')}`
      );
    }

    // --- deaths (twins folded exactly the way the nightly recap folds them) --
    const deathRows = rowsOf(
      'events',
      await db
        .from('events')
        .select('character_name, created_at, metadata')
        .eq('type', 'death')
        .gte('created_at', startIso)
        .limit(10000)
    );
    const windowDeaths = {};
    const lastCause = {};
    const lastCauseAt = {};
    for (const r of collapseDeathRows(deathRows)) {
      const nm = (r.character_name || '').trim();
      if (!nm) continue;
      const t = Date.parse(r.created_at);
      windowDeaths[nm] = (windowDeaths[nm] || 0) + 1;
      if (lastCauseAt[nm] === undefined || t >= lastCauseAt[nm]) {
        lastCauseAt[nm] = t;
        const c = r.metadata?.cause;
        lastCause[nm] = typeof c === 'string' && c.trim() ? c.trim() : undefined;
      }
    }
    const deathsTotal = Object.values(windowDeaths).reduce((a, b) => a + b, 0);

    // --- bosses felled this week + who actually fought ----------------------
    // A failed bosses read stays NULL all the way to nextHorizonLine, which
    // answers "unknown" rather than "every boss has fallen".
    const allBosses = rowsOf(
      'bosses',
      await db
        .from('bosses')
        .select('name, biome, sort_order, is_killed, killed_at, players_present, fight_stats')
        .order('sort_order')
    );
    const bosses = (allBosses || [])
      .filter((b) => b.is_killed && b.killed_at && Date.parse(b.killed_at) >= startMs)
      .map((b) => ({
        name: b.name,
        biome: b.biome,
        // The war party is who actually FOUGHT (fight_stats.fighters); the
        // roster column is the fallback for rows recorded before fighters were
        // captured, and can name bystanders. Mirrors recap.js and format.js.
        warParty: (b.fight_stats && Array.isArray(b.fight_stats.fighters) && b.fight_stats.fighters.length
          ? b.fight_stats.fighters
          : Array.isArray(b.players_present)
            ? b.players_present
            : []
        )
          .map((n) => String(n || '').trim())
          .filter(Boolean),
      }));

    // --- arrivals (new vikings) --------------------------------------------
    // anon may read id / character_name / first_seen_at (steam_id is revoked,
    // db/2026-07-11_players_pii_revoke.sql), so this is a legal read for the
    // bot's anon client. A failure still has to be VISIBLE, because the kill
    // baseline below is keyed off this map.
    const playerRows = rowsOf('players', await db.from('players').select('id, character_name, first_seen_at'));
    const arrivals = [];
    const idToName = new Map();
    for (const p of playerRows || []) {
      const nm = (p.character_name || '').trim();
      if (!nm) continue;
      idToName.set(p.id, nm);
      const seen = Date.parse(p.first_seen_at);
      if (Number.isFinite(seen) && seen >= startMs) arrivals.push({ name: nm, at: p.first_seen_at });
    }
    arrivals.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.name.localeCompare(b.name));

    // --- kills this week, from a weekly player_stats baseline ---------------
    // player_stats.kills is CUMULATIVE, so a week only has a number once we
    // have last week's snapshot to diff against. The snapshot lives in the
    // bot's own state.json (never in Supabase) and is refreshed on every post.
    //
    // A FAILED read must not roll the baseline forward. An empty snapshot is a
    // perfectly valid baseline (nobody has stats yet), so "did the read work"
    // cannot be inferred from the snapshot's contents: killsSnapshotNext stays
    // null when either read failed, and postChronicle leaves last week's
    // baseline in place. Without that, a single failed week wrote an empty
    // snapshot, and the NEXT week diffed every lifetime total against zero and
    // published a career kill count as one week's work.
    const chronState = state.chronicle || {};
    const hasBaseline = Boolean(chronState.killsBaselineAt);
    const prevSnap = chronState.killsSnapshot || {};
    const statRows = rowsOf('player_stats', await db.from('player_stats').select('player_id, kills'));
    let killsSnapshotNext = null;
    let killsWeek = { value: 0, hasBaseline: false, unavailable: true };
    if (playerRows && statRows) {
      killsSnapshotNext = {};
      let sum = 0;
      for (const ps of statRows) {
        const nm = idToName.get(ps.player_id);
        if (!nm) continue;
        const cur = Number(ps.kills) || 0;
        killsSnapshotNext[nm] = cur;
        if (hasBaseline) sum += Math.max(cur - (Number(prevSnap[nm]) || 0), 0); // clamp: a wipe never goes negative
      }
      killsWeek = { value: sum, hasBaseline, unavailable: false };
    }

    // --- deeds earned -------------------------------------------------------
    const deeds = (
      rowsOf(
        'milestones',
        await db.from('milestones').select('title, achieved_at').gte('achieved_at', startIso).order('achieved_at')
      ) || []
    )
      .map((d) => ({ title: d.title }))
      .filter((d) => d.title);

    // --- titles changed -----------------------------------------------------
    const titles = (
      rowsOf(
        'title_history',
        await db
          .from('title_history')
          .select('player_id, title, awarded_at')
          .gte('awarded_at', startIso)
          .order('awarded_at')
      ) || []
    )
      .map((t) => ({ name: idToName.get(t.player_id), title: t.title }))
      .filter((t) => t.name && t.title);

    // --- Player-of-the-Day winners -----------------------------------------
    const poty = (
      rowsOf(
        'poty_history',
        await db
          .from('poty_history')
          .select('character_name, award_label, awarded_at')
          .gte('awarded_at', startIso)
          .order('awarded_at')
      ) || []
    )
      .map((p) => ({ name: (p.character_name || '').trim(), label: p.award_label || '' }))
      .filter((p) => p.name);

    const { data: status, error: statusError } = await db
      .from('server_status')
      .select('player_count, world_day')
      .eq('id', 1)
      .maybeSingle();
    if (statusError) console.warn(`[chronicle] server_status read failed: ${statusError.message}`);

    const hoursTop = pickTopHours(hours, HOURS_BOARD_LIMIT);
    const fallenTop = pickTopFallen(windowDeaths, lastCause, FALLEN_BOARD_LIMIT);
    const activeVikings = Object.keys(hours).filter((n) => hours[n] > 0).length;

    return {
      from: startIso,
      to: nowIso,
      windowLabel: windowLabel(startIso, nowIso, tz),
      worldDay: status?.world_day ?? 0,
      activeVikings,
      hoursTotal: totalHours,
      deathsTotal,
      killsWeek,
      arrivals,
      hoursTop,
      fallenTop,
      deeds,
      bosses,
      titles,
      poty,
      horizon: nextHorizonLine(allBosses),
      // "A quiet seven days" is a CLAIM about the week, so it may only be made
      // when the reads that would have contradicted it actually succeeded. A
      // database outage renders the normal embed with empty sections instead.
      quiet:
        Boolean(sessions && deathRows && allBosses) &&
        activeVikings === 0 &&
        deathsTotal === 0 &&
        bosses.length === 0 &&
        deeds.length === 0 &&
        arrivals.length === 0 &&
        titles.length === 0 &&
        poty.length === 0,
      // transient: persisted by postChronicle as next week's kill baseline.
      // NULL means "the counters could not be read" -> do not roll the baseline.
      _killsSnapshotNext: killsSnapshotNext,
    };
  }

  /** Build + post, then roll the weekly baseline forward. */
  async function postChronicle(nowMs = Date.now()) {
    const chron = await buildChronicle(nowMs);
    await post(channel, formatChronicle(chron));
    state.chronicle = {
      ...(state.chronicle || {}),
      // Only a SUCCESSFUL counter read rolls the baseline; a failed week keeps
      // last week's, so the next diff is over two weeks rather than a lifetime.
      ...(chron._killsSnapshotNext
        ? { killsSnapshot: chron._killsSnapshotNext, killsBaselineAt: new Date(nowMs).toISOString() }
        : {}),
      lastPostedKey: weekKey(new Date(nowMs), tz),
      lastPostedAt: new Date(nowMs).toISOString(),
    };
    await saveState();
    return chron;
  }

  /**
   * The scheduled run. Two guards:
   *  • the launch gate (startsAt), the same one the nightly recap honours, so
   *    turning the flag on before the world opens cannot publish a week of
   *    pre-launch demo rows;
   *  • one post per local date, so a restart inside the posting minute (or an
   *    operator re-triggering the cron) cannot send the week twice.
   */
  async function runScheduled(nowMs = Date.now()) {
    if (startsAt && nowMs < startsAt.getTime()) {
      console.log(`[chronicle] gated, the Chronicle begins ${startsAt.toISOString().slice(0, 10)}`);
      return null;
    }
    const key = weekKey(new Date(nowMs), tz);
    if ((state.chronicle || {}).lastPostedKey === key) {
      console.log(`[chronicle] already posted for ${key}, skipping`);
      return null;
    }
    return postChronicle(nowMs);
  }

  /**
   * Register the weekly cron. index.js owns the one startup log line, and
   * passes in its own `safe('chronicle', ...)` wrapper so a failed weekly post
   * is recorded for the ops cockpit like every other loop. The .catch here is
   * belt and braces for a caller that hands in a bare function.
   */
  function schedule(run = runScheduled) {
    return [
      cron.schedule(
        `0 ${hour} * * ${weekday}`,
        () => Promise.resolve(run()).catch((e) => console.error('[chronicle]', e.message)),
        { timezone: tz }
      ),
    ];
  }

  return { buildChronicle, postChronicle, runScheduled, schedule };
}
