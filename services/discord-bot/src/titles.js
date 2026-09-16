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
//   1. ONE HOLDER PER EARNED TITLE, ALWAYS (Charlie, 2026-09-16). An earned
//      title is HELD by its wearer until the engine offers it to a DIFFERENT
//      viking and that offer is CONFIRMED (rule 3, the 15-minute two-pass
//      window). At that moment, in the SAME pass, the title changes hands: the
//      challenger takes it, and the previous holder is re-assigned to whatever
//      the engine currently offers them — their rank-2 title, another earned
//      title, or a hall-name. Both halves are one proclamation of two lines, and
//      cost ONE of the daily budget.
//      Until that happens the wearer keeps what they have: the engine offering
//      "of the Quiet Fjord" to the Bane of Beasts is noise, not news, and a
//      viking is never quietly taken back to a placeholder on their own row.
//      (This replaces the old "NEVER DEMOTE, indefinitely" rule, which is what
//      let two vikings wear the same title: the engine crowned the new leader
//      while the bot held the old one forever. Production carried three such
//      pairs on 2026-09-16 — Bane of Beasts, Stonewright, the Heavy-Handed.)
//   2. PLACEHOLDER -> PLACEHOLDER IS SILENT. The uniqueness reshuffle can move a
//      no-standout viking from one hall-name to another; that is bookkeeping.
//      The registry is updated so it stays unique, with NO title_history row, no
//      proclamation and no voice line.
//   3. CONFIRMATION. Any announced change (placeholder -> earned, or earned ->
//      a different earned title) must be offered by the engine on TWO passes at
//      least TITLE_CONFIRM_MS (default 15 min) apart. A different offer resets
//      the clock. This alone kills every flip-flop that resolves inside one tick.
//   4. TENURE. A viking VOLUNTARILY moving from one earned title to another
//      additionally waits TITLE_MIN_TENURE_MS (default 24 h) from
//      title_updated_at: they keep the name the hall gave them for at least a
//      day. Placeholder -> earned has NO tenure gate: a viking earning their
//      first real title is the special moment the whole feature exists for.
//      TENURE DOES NOT PROTECT A HOLDER AGAINST A CONFIRMED TAKEOVER of their
//      own title (Charlie, 2026-09-16: uniqueness beats stickiness). It gates
//      the viking who is moving, never the viking being passed.
//   4b. NEVER CREATE A DUPLICATE. An offer of a title somebody else currently
//      wears is not confirmed while that holder's OWN offer of a different
//      EARNED title is itself still unconfirmed: the holder may yet move on
//      their own, and a pass must resolve a takeover, never open one. Once the
//      holder is settled (their move is confirmed, or the engine only offers
//      them a hall-name), the challenger's confirmed offer takes the title and
//      carries the holder with it. (2026-09-11: Kætiløy held "the Far-Seer"
//      under tenure while the engine gave the map crown to Rosir, and the hall
//      proclaimed a second Far-Seer. Under this rule Rosir takes it and Kætiløy
//      is moved on in the same breath.)
//   5. DAILY BUDGET. At most TITLES_PER_DAY (default 3) proclamations per rolling
//      24 h, counted from title_history. A handover is ONE proclamation (two
//      lines, one history row), not two. When more qualify at once they are ranked
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
import { isExcluded } from './excluded.js';

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
 * The EARNED titles — both rungs of every ladder in lib/epithets.ts DIMENSIONS
 * (the rank-1 crown and the rank-2 title for the clear runner-up), the five
 * death-cause overrides, and "the Unslain". Thirty in all. Anything else the
 * engine can produce is a placeholder from FLAVOR_POOL.
 *
 * The bot is plain JS and cannot import the TypeScript engine, so this list is a
 * MIRROR and must be kept in step: a missing entry here would read a real earned
 * title as a placeholder and hand it out a second time, which is the exact bug
 * this file exists to prevent. `scripts/epithets.test.mjs` in the repo root
 * asserts this array equals the engine's own set, so drift fails the root test
 * suite.
 */
export const EARNED_TITLES = Object.freeze([
  // rank 1 — the crowns
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
  'the Angler',
  'the Sea-Wolf',
  // rank 2 — the clear runner-up on each board
  'the Hearth-Bound',
  'Beast-Hewer',
  'the Bone-Breaker',
  'Thorn of the Forsaken',
  'the Twice-Buried',
  'the Gatherer',
  'the Anvil-Sworn',
  'the Road-Worn',
  'the Timber-Wise',
  'the Horizon-Chaser',
  'the Line-Caster',
  'the Salt-Sworn',
  // the overrides
  'Treefoe',
  'the Cliff-Kisser',
  'the Half-Drowned',
  'the Singed',
  'the Sting-Struck',
  'the Unslain',
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

  /**
   * Proclaim a change.
   *
   * `handover`, when present, means this title CHANGED HANDS: `{ name, title }`
   * is the viking who wore it until now and the title the engine moves them to.
   * It adds a second line to the same Discord message and folds the same fact
   * into the one voice line, because the hall should hear a title being passed
   * as one event and not as two unrelated ones. A plain new crown keeps the
   * format it has always had, byte for byte.
   */
  async function announce(row, title, handover = null) {
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
    const content = handover
      ? `${line}\n**${nameMd(handover.name)}** passes **${escapeMd(title)}** to **${nameMd(name)}** and takes up **${escapeMd(handover.title)}**.`
      : line;
    const voice = handover
      ? `From tonight, ${firstName(name)} goes by ${title}, and ${firstName(handover.name)} takes up ${handover.title}.`
      : `From tonight, ${firstName(name)} goes by ${title}.`;
    if (dryRun) {
      log.info?.(
        handover
          ? `[titles] (dry) would announce: ${name} -> "${title}", ${handover.name} -> "${handover.title}"`
          : `[titles] (dry) would announce: ${name} -> "${title}"`,
      );
      return;
    }
    // Proclaim in the title channel, then let Eilif speak it in-game. Neither
    // failure should block the registry write below (the caller's try).
    try {
      await post(channel, { content });
    } catch (e) {
      log.error?.(`[titles] #${channel} post failed for ${name}: ${e.message}`);
    }
    try {
      const { error: vErr } = await writeDb.from('voice_lines').insert({
        text: voice,
        kind: 'event',
        meta: handover
          ? { title, player_id: row.id, passedFrom: handover.name, passedTo: handover.title }
          : { title, player_id: row.id },
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

    // `excluded` rides along so an excluded character is skipped below. Asked for
    // first and dropped on error, because the column lands in a hand-applied
    // migration and naming it too early would fail the read and stop ALL titling.
    let res = await writeDb
      .from('players')
      .select('id, character_name, current_title, title_updated_at, excluded');
    if (res.error) {
      res = await writeDb
        .from('players')
        .select('id, character_name, current_title, title_updated_at');
    }
    const { data, error } = res;
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

    // WHO WEARS WHAT, right now. Built from the same players read the loop walks,
    // so it is exactly what the hall currently proclaims, and MUTATED as this
    // pass writes — a title handed over earlier in the pass is already free by
    // the time a later candidate looks at it. Excluded rows never hold anything
    // (their crown is cleared once by db/2026-09-11_players_excluded.sql and
    // never refreshed). Production can contain a DUPLICATE here (two vikings
    // wearing one title, the bug this rewrite closes), so first-wins is not a
    // judgement, only a deterministic choice: the other wearer's own row is
    // moved on by the engine's offer like any other change.
    const rowByName = new Map();
    const wornBy = new Map(); // earned title -> character_name
    // character_name -> the title they wear AS OF NOW IN THIS PASS. Kept beside
    // the rows rather than written into them: the rows are the caller's data and
    // a pass must not leave footprints in them.
    const liveTitle = new Map();
    for (const row of data || []) {
      const holder = (row.character_name || '').trim();
      if (!holder || isExcluded(row)) continue;
      if (!rowByName.has(holder)) rowByName.set(holder, row);
      const held = String(row.current_title || '').trim();
      if (!liveTitle.has(holder)) liveTitle.set(holder, held);
      if (isEarnedTitle(held) && !wornBy.has(held)) wornBy.set(held, holder);
    }

    /** What the engine offers this viking right now, or null. */
    const offerFor = (who) => computed.get(who) ?? null;
    const isEarnedOffer = (entry) =>
      entry ? (entry.source ? entry.source !== 'flavor' : isEarnedTitle(entry.title)) : false;

    /**
     * Rule 4b. `holder` wears the title `name` is being offered. Is the holder
     * still mid-move of their own? An unconfirmed offer of a DIFFERENT EARNED
     * title means they may yet step aside by themselves, so the challenger waits
     * rather than forcing a handover the holder did not need. An offer of a
     * hall-name (or no offer at all) is not a move: rule 1 would hold them on
     * that title forever, and only a takeover can free it.
     */
    function holderStillMoving(holderName) {
      if (!rowByName.has(holderName)) return false;
      const entry = offerFor(holderName);
      if (!entry) return false;
      if (entry.title === (liveTitle.get(holderName) || '')) return false;
      if (!isEarnedOffer(entry)) return false;
      const p = pending.get(holderName);
      const confirmed =
        !!p && p.title === entry.title && nowMs - p.firstOfferedAt >= confirmMs;
      return !confirmed;
    }

    for (const row of data || []) {
      const name = (row.character_name || '').trim();
      if (!name) continue;
      if (handled.has(name)) continue;
      handled.add(name);
      // STICKY TITLES STOP AT AN EXCLUDED CHARACTER. /api/titles already computes
      // from a filtered roster, so `computed` never names one — but this loop also
      // WRITES players.current_title, and that column is what the in-game boards
      // and the #server proclamation render. Skipping here means an excluded row's
      // last crown is never refreshed, re-announced, or reshuffled by the
      // uniqueness pass. (db/2026-09-11_players_excluded.sql clears it once.)
      if (isExcluded(row)) continue;
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

      // 1. HOLD an earned title against a placeholder offer. The only thing that
      //    takes it away is a CONFIRMED offer of it to somebody else, which is
      //    handled from the challenger's row (the takeover below), never here.
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
      // tenure window (or through a holder's own unfinished move) is already
      // confirmed the moment the way clears.
      const prior = pending.get(name);
      if (!prior || prior.title !== title) {
        pending.set(name, { title, firstOfferedAt: nowMs });
      }
      const offeredForMs = nowMs - pending.get(name).firstOfferedAt;

      // 4b. NEVER CREATE A DUPLICATE. Somebody else wears this title and is
      //     themselves mid-move: wait for them to land. The clock keeps running,
      //     so the moment they settle this offer is already proven.
      const holderName = wornBy.get(title);
      if (holderName && holderName !== name && holderStillMoving(holderName)) {
        quiet(
          nowMs,
          name,
          `offered "${title}" but ${holderName} wears it and has an unconfirmed move of their own; waiting`,
        );
        pass.held++;
        continue;
      }

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

      // Vikings already moved by an earlier candidate's handover in this same
      // pass: their registry row is written and their new title proclaimed, so
      // their own entry below is spent.
      const absorbed = new Set();

      for (const c of candidates) {
        if (absorbed.has(c.name)) continue;
        if (remaining <= 0) {
          log.info?.(
            `[titles] ${c.name}: "${c.title}" deferred (daily budget ${perDay}/${perDay} used)`,
          );
          pass.deferred++;
          continue; // stays pending; re-evaluated next pass
        }

        // THE TAKEOVER. If somebody still wears this title, the confirmed offer
        // takes it off them, and they take up whatever the engine offers them
        // instead. Resolved against `wornBy`, which this loop keeps current, so
        // a holder who already moved earlier in the pass is not moved twice.
        let handover = null;
        const holderName = wornBy.get(c.title);
        if (holderName && holderName !== c.name) {
          const hRow = rowByName.get(holderName);
          const hEntry = offerFor(holderName);
          // Without a row to write or an engine offer to move them to, a takeover
          // would strand the holder on a title somebody else now wears. Hold
          // instead; the offer stays pending and the next pass tries again.
          if (!hRow || !hEntry || hEntry.title === c.title) {
            quiet(
              nowMs,
              c.name,
              `offered "${c.title}" but ${holderName} wears it and the engine names them nothing else; waiting`,
            );
            pass.held++;
            continue;
          }
          handover = { row: hRow, name: holderName, title: hEntry.title };
        }

        if (dryRun) {
          await announce(c.row, c.title, handover);
          pass.announced++;
          remaining--;
          if (handover) absorbed.add(handover.name);
          continue;
        }

        // Record first — the registry is the truth even if the proclamation fails.
        const upErr = await record(c.row, c.title, nowIso);
        if (upErr) {
          log.error?.(`[titles] update failed for ${c.name}: ${upErr.message}`);
          continue;
        }
        if (handover) {
          const hErr = await record(handover.row, handover.title, nowIso);
          if (hErr) {
            log.error?.(
              `[titles] handover write failed for ${handover.name}: ${hErr.message}`,
            );
          }
        }
        // ONE history row per proclamation, so the rolling-24h budget counts a
        // handover as the single event the hall heard.
        await writeDb.from('title_history').insert({
          player_id: c.row.id,
          title: c.title,
          awarded_at: nowIso,
        });
        await announce(c.row, c.title, handover);

        // Keep the in-pass picture of who wears what honest for later candidates.
        if (isEarnedTitle(c.current) && wornBy.get(c.current) === c.name) {
          wornBy.delete(c.current);
        }
        wornBy.set(c.title, c.name);
        liveTitle.set(c.name, c.title);
        pending.delete(c.name);
        if (handover) {
          if (isEarnedTitle(handover.title)) wornBy.set(handover.title, handover.name);
          liveTitle.set(handover.name, handover.title);
          pending.delete(handover.name);
          absorbed.add(handover.name);
        }
        pass.announced++;
        remaining--;
        log.info?.(
          handover
            ? `[titles] ${c.name}: "${c.current}" -> "${c.title}" (taken from ${handover.name}, who takes up "${handover.title}")`
            : `[titles] ${c.name}: "${c.current}" -> "${c.title}"`,
        );
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
