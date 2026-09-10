// The Living Titles announcer.
//
// The dashboard's shared epithet engine (lib/epithets.ts) names every viking from
// their deeds + rank against the warband; GET /api/titles exposes the current
// title for each player as the single source of truth. THIS loop polls that
// endpoint (~every 10 min), compares each viking's computed title to the one the
// hall currently knows them by (players.current_title), and decides — under the
// policy below — whether anything is PROCLAIMED: a #server/#valheim line plus an
// in-game voice line for Eilif to speak center-screen.
//
// ── STICKY AND RARE (Charlie, 2026-09-10) ─────────────────────────────────────
// This REVERSES the old "NO RATE LIMITING, by decision (Charlie, 2026-08-22)"
// header. Launch night proved why: Rosir flipped "the Ever-Present" <-> "of the
// Quiet Fjord" five times in six hours, and Ræginál and Charleif traded earned
// titles inside an hour. Charlie's rule: "I don't want titles to switch that
// often. A little more sticky, only 2-3 title changes a night. Special and
// memorable."
//
// So, in order, per viking, per pass:
//
//   1. NEVER DEMOTE. A viking wearing an EARNED title (a stat dimension or
//      Treefoe) is never taken back to a placeholder, however long they hold it.
//      The engine offering "of the Quiet Fjord" to the Bane of Beasts is noise,
//      not news. (This replaces the 60-minute TITLE_HOLD_MS from launch night,
//      which only delayed the demotion by an hour.)
//   2. PLACEHOLDER -> PLACEHOLDER IS SILENT. The uniqueness reshuffle can move a
//      no-standout viking from one hall-name to another; that is bookkeeping.
//      The registry is updated so it stays unique, with NO title_history row, no
//      proclamation and no voice line.
//   3. CONFIRMATION. Any announced change (placeholder -> earned, or earned ->
//      a different earned title) must be offered by the engine on TWO passes at
//      least TITLE_CONFIRM_MS (default 15 min) apart. A different offer resets
//      the clock. This alone kills every flip-flop that resolves inside one tick.
//   4. TENURE. Earned -> a different earned title additionally waits
//      TITLE_MIN_TENURE_MS (default 24 h) from title_updated_at. A viking keeps
//      the name the hall gave them for at least a day. Placeholder -> earned has
//      NO tenure gate: a viking earning their first real title is the special
//      moment the whole feature exists for.
//   5. DAILY BUDGET. At most TITLES_PER_DAY (default 3) proclamations per rolling
//      24 h, counted from title_history. When more qualify at once they are ranked
//      deterministically — first titles first, then combat crowns (kills, damage,
//      boss damage), then by name — and the rest simply stay pending and are
//      re-evaluated next pass.
//   6. SEEDING stays silent and free: a viking whose current_title is still NULL
//      is recorded WITHOUT announcing and without spending budget, so the first
//      pass after a migration or a wipe never dumps a storm on the channel.
//
// Proclamations remain exempt from the voice engine's ambient min-gap
// (VOICE_MIN_GAP_MS) and from the Great Deeds gap — with 2-3 a night there is
// nothing left to rate-limit.
//
// Gated behind TITLES_ANNOUNCE (on by default; set 0 to disable). Degrades
// gracefully before db/2026-07-05_titles.sql is applied: it detects the missing
// column, logs once, and skips (no seed, no announcement).

import { nameMd, escapeMd } from './format.js';

const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'viking';

// undici has no default timeout, so a stalled dashboard socket would hold this
// loop open indefinitely and block the next tick.
const FETCH_TIMEOUT_MS = 20000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Policy knobs. Defaults are Charlie's 2026-09-10 rule; every one is an env var
// so the hall can be loosened for an event night without a deploy.
const ENV_MIN_TENURE_MS = Number(process.env.TITLE_MIN_TENURE_MS || DAY_MS);
const ENV_CONFIRM_MS = Number(process.env.TITLE_CONFIRM_MS || 15 * MINUTE_MS);
const ENV_PER_DAY = Number(process.env.TITLES_PER_DAY || 3);

// A "hold" is the normal, permanent state of a well-titled hall, so its log line
// would otherwise repeat every ten minutes forever. One per viking per hour.
const QUIET_LOG_MS = HOUR_MS;

/**
 * The EARNED titles — every dimension epithet in lib/epithets.ts DIMENSIONS plus
 * the Treefoe override. Anything else the engine can produce is a placeholder
 * from FLAVOR_POOL.
 *
 * The bot is plain JS and cannot import the TypeScript engine, so this list is a
 * MIRROR and must be kept in step: a missing entry here would read a real earned
 * title as a placeholder and let rule 1 demote it, which is the exact bug this
 * file exists to prevent. `scripts/epithets.test.mjs` in the repo root asserts
 * this array equals the engine's own set, so drift fails the root test suite.
 */
export const EARNED_TITLES = Object.freeze([
  'the Ever-Present',
  'Bane of Beasts',
  'the Heavy-Handed',
  'Bane of the Forsaken',
  'the Oft-Slain',
  'the Provider',
  'the Forgehand',
  'the Far-Strider',
  'Stonewright',
  'the Far-Seer',
  'Treefoe',
]);
const EARNED_SET = new Set(EARNED_TITLES);

/** Fighting dimensions — these jump the queue when the daily budget is tight. */
const COMBAT_SOURCES = new Set(['kills', 'damage', 'bossdmg']);

/** Is this recorded title one a viking EARNED, or a personalized placeholder? */
export function isEarnedTitle(title) {
  return EARNED_SET.has(String(title || '').trim());
}

// Postgres "column does not exist" (registry not migrated yet).
function isMissingColumn(error) {
  if (!error) return false;
  const msg = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return error.code === '42703' || /current_title|title_updated_at|column .* does not exist/.test(msg);
}

const emptyPass = () => ({
  seeded: 0,
  announced: 0,
  unchanged: 0,
  reshuffled: 0,
  held: 0,
  confirming: 0,
  deferred: 0,
});

export function createTitlesAnnouncer({
  db,
  post,
  writeDb,
  apiUrl,
  log = console,
  dryRun = false,
  // Where proclamations go. 'server' is the historical (and pilot) behaviour;
  // index.js reads TITLE_CHANNEL, whose launch value is 'valheim' if titles
  // should follow deeds/oaths/recaps out of #server.
  channel = 'server',
  // Injectable for the tests: a clock and the HTTP call. Production passes
  // neither.
  now = () => Date.now(),
  fetchImpl = (...args) => fetch(...args),
  minTenureMs = ENV_MIN_TENURE_MS,
  confirmMs = ENV_CONFIRM_MS,
  perDay = ENV_PER_DAY,
}) {
  let warnedMissing = false;
  let warnedNoWrite = false;

  // name -> { title, firstOfferedAt }: an announced change the engine has offered
  // but that has not yet been offered twice, TITLE_CONFIRM_MS apart. In memory on
  // purpose — a bot restart simply asks the engine to prove itself again, which
  // is the conservative direction.
  const pending = new Map();
  // name -> ms of the last "held"/"holding" line, so a settled hall stays quiet.
  const lastQuietLog = new Map();

  function quiet(nowMs, name, message) {
    const last = lastQuietLog.get(name) || 0;
    if (nowMs - last < QUIET_LOG_MS) return;
    lastQuietLog.set(name, nowMs);
    log.info?.(`[titles] ${name}: ${message}`);
  }

  async function fetchComputed() {
    const res = await fetchImpl(apiUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET ${apiUrl} -> ${res.status}`);
    const body = await res.json();
    const players = Array.isArray(body?.players) ? body.players : [];
    // name -> title (last wins; names are unique on the roster)
    const map = new Map();
    for (const p of players) {
      const name = String(p?.name || '').trim();
      const title = String(p?.title || '').trim();
      if (name && title) map.set(name, { title, source: String(p?.source || '') });
    }
    return map;
  }

  /**
   * Proclamations in the last rolling 24 h, straight from title_history — the
   * budget survives a bot restart because it is not kept in memory. Seeds and
   * silent reshuffles write no history row and so cost nothing.
   *
   * Unreadable history returns 0 (fail open): the confirmation and tenure gates
   * above already make a storm impossible, and freezing every title because one
   * read failed would be the worse failure.
   */
  async function announcedInLastDay(nowMs) {
    const since = new Date(nowMs - DAY_MS).toISOString();
    try {
      const { data, error } = await writeDb
        .from('title_history')
        .select('id, awarded_at')
        .gte('awarded_at', since);
      if (error) {
        log.warn?.(`[titles] title_history read failed, budget assumed free: ${error.message}`);
        return 0;
      }
      return Array.isArray(data) ? data.length : 0;
    } catch (e) {
      log.warn?.(`[titles] title_history read failed, budget assumed free: ${e.message}`);
      return 0;
    }
  }

  async function announce(row, title) {
    const name = (row.character_name || '').trim() || 'A viking';
    // THE ONE THAT GOT MISSED (red-team round 2, 2026-09-05). Every sibling
    // announcement path escapes the character name — chronicle.js, bosspoll.js,
    // and formatBossKill as of this round — but this line interpolated it raw.
    // The name is player-chosen, so `**`, a backtick or `||…||` broke the line's
    // formatting and a URL in a name posted a live link into the channel.
    // `title` is server-authored (lib/epithets.ts, via GET /api/titles) and
    // contains no markdown characters today; escaping it costs nothing and
    // keeps that from becoming load-bearing.
    const line = `⚔️ **${nameMd(name)}** has earned a new title: **${escapeMd(title)}**`;
    if (dryRun) {
      log.info?.(`[titles] (dry) would announce: ${name} -> "${title}"`);
      return;
    }
    // Proclaim in the title channel, then let Eilif speak it in-game. Neither
    // failure should block the registry write below (the caller's try).
    try {
      await post(channel, { content: line });
    } catch (e) {
      log.error?.(`[titles] #${channel} post failed for ${name}: ${e.message}`);
    }
    try {
      const { error: vErr } = await writeDb.from('voice_lines').insert({
        text: `From tonight, ${firstName(name)} goes by ${title}.`,
        kind: 'event',
        meta: { title, player_id: row.id },
        status: 'queued',
        queued_at: new Date(now()).toISOString(),
      });
      if (vErr) log.error?.(`[titles] voice enqueue failed for ${name}: ${vErr.message}`);
    } catch (e) {
      log.error?.(`[titles] voice enqueue failed for ${name}: ${e.message}`);
    }
  }

  /** Write the registry without announcing (seeds and silent reshuffles). */
  async function record(row, title, nowIso) {
    const { error } = await writeDb
      .from('players')
      .update({ current_title: title, title_updated_at: nowIso })
      .eq('id', row.id);
    return error || null;
  }

  async function tick() {
    if (!writeDb) {
      if (!warnedNoWrite) {
        log.warn?.('[titles] no service-role client — titles registry disabled');
        warnedNoWrite = true;
      }
      return emptyPass();
    }

    let computed;
    try {
      computed = await fetchComputed();
    } catch (e) {
      log.warn?.(`[titles] titles API unreachable, skipping: ${e.message}`);
      return emptyPass();
    }
    if (computed.size === 0) return emptyPass();

    const { data, error } = await writeDb
      .from('players')
      .select('id, character_name, current_title, title_updated_at');
    if (error) {
      if (isMissingColumn(error)) {
        if (!warnedMissing) {
          log.info?.('[titles] registry not migrated yet (players.current_title missing) — skipping until db/2026-07-05_titles.sql is applied');
          warnedMissing = true;
        }
        return emptyPass();
      }
      log.error?.(`[titles] players read failed: ${error.message}`);
      return emptyPass();
    }
    warnedMissing = false;

    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const pass = emptyPass();

    // Candidates for an actual proclamation, collected first so the daily budget
    // can rank them against each other instead of rewarding whoever the players
    // read happened to return first.
    const candidates = [];

    // One proclamation per NAME per pass — duplicate players rows (the 2026-07-25
    // Testman incident: 325 dups → 325 announcements) must never multiply the
    // announcement, whatever upstream let them in.
    const handled = new Set();

    for (const row of data || []) {
      const name = (row.character_name || '').trim();
      if (!name) continue;
      if (handled.has(name)) continue;
      handled.add(name);
      const entry = computed.get(name);
      if (!entry) continue; // no computed title for this viking this pass
      const title = entry.title;
      const current = row.current_title;

      if (title === current) {
        pass.unchanged++;
        pending.delete(name);
        continue;
      }

      // 6. SEED — first title we have ever recorded for this viking. Silent, and
      //    it does not spend a proclamation.
      if (current == null || String(current).trim() === '') {
        if (dryRun) {
          log.info?.(`[titles] (dry) would seed ${name} -> "${title}"`);
          pass.seeded++;
          continue;
        }
        const upErr = await record(row, title, nowIso);
        if (upErr) {
          log.error?.(`[titles] seed failed for ${name}: ${upErr.message}`);
          continue;
        }
        pass.seeded++;
        continue;
      }

      const currentEarned = isEarnedTitle(current);
      // The API always reports a source; fall back to the title itself if a
      // future/partial payload ever omits it, so an unknown source can never be
      // mistaken for an earned crown.
      const offeredEarned = entry.source ? entry.source !== 'flavor' : isEarnedTitle(title);

      // 1. NEVER DEMOTE an earned title to a placeholder. Indefinitely.
      if (currentEarned && !offeredEarned) {
        quiet(nowMs, name, `holding "${current}" (earned; engine offers placeholder "${title}")`);
        pass.held++;
        pending.delete(name);
        continue;
      }

      // 2. PLACEHOLDER -> PLACEHOLDER: the uniqueness reshuffle. Record it so the
      //    registry stays unique, announce nothing, write no history row.
      if (!currentEarned && !offeredEarned) {
        if (dryRun) {
          log.info?.(`[titles] (dry) would silently reshuffle ${name}: "${current}" -> "${title}"`);
          pass.reshuffled++;
          continue;
        }
        const upErr = await record(row, title, nowIso);
        if (upErr) {
          log.error?.(`[titles] reshuffle failed for ${name}: ${upErr.message}`);
          continue;
        }
        pass.reshuffled++;
        continue;
      }

      // Everything below is a change that WOULD be proclaimed.
      const kind = currentEarned ? 'earned' : 'promotion';

      // Track the offer BEFORE the gates, so an offer that stands through a whole
      // tenure window is already confirmed the moment tenure clears.
      const prior = pending.get(name);
      if (!prior || prior.title !== title) {
        pending.set(name, { title, firstOfferedAt: nowMs });
      }
      const offeredForMs = nowMs - pending.get(name).firstOfferedAt;

      // 4. TENURE — a viking keeps an earned title at least a day.
      if (kind === 'earned') {
        const heldForMs = row.title_updated_at ? nowMs - Date.parse(row.title_updated_at) : NaN;
        if (Number.isFinite(heldForMs) && heldForMs < minTenureMs) {
          quiet(
            nowMs,
            name,
            `holding "${current}" (${Math.floor(heldForMs / HOUR_MS)} h of ${Math.round(minTenureMs / HOUR_MS)} h tenure)`,
          );
          pass.held++;
          continue;
        }
      }

      // 3. CONFIRMATION — two passes, at least confirmMs apart, same offer.
      if (offeredForMs < confirmMs) {
        log.info?.(
          `[titles] ${name}: "${title}" offered, confirming (first seen ${Math.round(offeredForMs / MINUTE_MS)} min ago)`,
        );
        pass.confirming++;
        continue;
      }

      candidates.push({ row, name, title, current, kind, source: entry.source });
    }

    // 5. DAILY BUDGET. Rank first, so the same three changes win regardless of
    //    row order: first titles, then combat crowns, then alphabetically.
    if (candidates.length > 0) {
      const used = await announcedInLastDay(nowMs);
      let remaining = Math.max(0, perDay - used);
      const kindRank = (c) => (c.kind === 'promotion' ? 0 : 1);
      const combatRank = (c) => (COMBAT_SOURCES.has(c.source) ? 0 : 1);
      candidates.sort(
        (a, b) =>
          kindRank(a) - kindRank(b) ||
          (a.kind === 'earned' ? combatRank(a) - combatRank(b) : 0) ||
          a.name.localeCompare(b.name),
      );

      for (const c of candidates) {
        if (remaining <= 0) {
          log.info?.(
            `[titles] ${c.name}: "${c.title}" deferred (daily budget ${perDay}/${perDay} used)`,
          );
          pass.deferred++;
          continue; // stays pending; re-evaluated next pass
        }

        if (dryRun) {
          await announce(c.row, c.title);
          pass.announced++;
          remaining--;
          continue;
        }

        // Record first — the registry is the truth even if the proclamation fails.
        const upErr = await record(c.row, c.title, nowIso);
        if (upErr) {
          log.error?.(`[titles] update failed for ${c.name}: ${upErr.message}`);
          continue;
        }
        await writeDb.from('title_history').insert({
          player_id: c.row.id,
          title: c.title,
          awarded_at: nowIso,
        });
        await announce(c.row, c.title);
        pending.delete(c.name);
        pass.announced++;
        remaining--;
        log.info?.(`[titles] ${c.name}: "${c.current}" -> "${c.title}"`);
      }
    }

    if (pass.seeded || pass.announced || pass.reshuffled || pass.deferred) {
      log.info?.(
        `[titles] pass: seeded ${pass.seeded}, announced ${pass.announced}, reshuffled ${pass.reshuffled}, held ${pass.held}, confirming ${pass.confirming}, deferred ${pass.deferred}, unchanged ${pass.unchanged}${dryRun ? ' (dry-run)' : ''}`,
      );
    }
    return pass;
  }

  return { tick };
}
