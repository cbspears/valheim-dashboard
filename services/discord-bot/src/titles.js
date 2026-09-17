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
//   1a. THE HANDOVER TARGET MUST BE FREE (Charlie, 2026-09-17). The title the
//      outgoing holder takes up may not be worn by ANY other registry row once
//      this pass's writes are in — including a title handed out earlier in the
//      same pass. The engine's offer for them is used when it is free; when it
//      is not, they take up their PLACEHOLDER, the hall-name /api/titles now
//      publishes for every viking (the engine's own FLAVOR_POOL pick, already
//      de-duplicated across the roster). If even that is worn — only possible
//      against a stale registry — the bot falls back to the first free hall-name
//      it has seen in this pass's payload and logs a warning. Nothing is ever
//      appended to a title to force it unique.
//      (2026-09-17: "Halldor takes Bane of the Forsaken, Charleif takes up the
//      Forgehand" — which S'aeien was already wearing.)
//   1b. EVERY HOLDER IS HANDED OFF (Charlie, 2026-09-17). A takeover re-assigns
//      EVERY registry row wearing the title, not just the first one found: the
//      pre-fix era could leave two vikings on one title, and moving one of them
//      left the duplicate standing. Each gets their own handover line, all of it
//      one proclamation and ONE of the daily budget.
//      (2026-09-17: Asbjorn took Bane of Beasts from Mikael while Thorfinn, who
//      also wore it, was never touched.)
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
//   1c. THE STALE WEARER YIELDS (Charlie, 2026-09-17, from the first live pass
//      after 1a/1b shipped). A takeover only fires from a CHALLENGER's row, and a
//      duplicate left over from the pre-fix era has none: the engine already
//      names one of the two wearers, so that wearer's row reads "unchanged" and
//      the OTHER is held forever by rule 1 ("Thorfinn: holding \"Bane of Beasts\"
//      (earned; engine offers placeholder \"the Cheerful Ballast\")", 12:15).
//      So: a viking who wears an earned title that ANOTHER registry row also
//      wears, while the engine's offer names that other row as its holder and
//      names this viking something else, is the STALE wearer and must YIELD.
//      After the ordinary 15-minute confirmation of their own offer they are
//      written to it (or, if it is worn, to a free title per rule 1a) and the
//      hall hears ONE quiet line:
//        **Thorfinn** yields **Bane of Beasts** to **Asbjorn** and takes up **the Cheerful Ballast**.
//      It costs one of the daily budget. It is NOT subject to rule 7's cool-down:
//      nothing changes hands, a duplicate is being closed. Tenure does not gate
//      it either — the title was never really theirs. A viking who IS the
//      engine's holder never yields.
//   7. TAKEOVER COOL-DOWN (Charlie, 2026-09-17). A title cannot be taken over
//      within TITLE_TAKEOVER_COOLDOWN_MS (default 24 h) of its last change of
//      holder — the title_updated_at of whoever wears it, or, for a row carrying
//      no usable stamp, the challenger's own confirmed offer time. The
//      CHALLENGER simply waits ("waiting: T changed hands N h ago"); the wearer
//      is never disturbed and nothing is written, so a wait can never open a
//      duplicate. There are no epic-style exemptions: a fighting crown waits like
//      any other. This is what kills a flip-flop that outlives the 15-minute
//      confirmation — "the Heavy-Handed" went Yonk -> Fjällhnot -> Yonk inside
//      five hours on 2026-09-17, each hop confirmed, each hop legal under rules
//      1-6. The confirmation window is unchanged and still applies first.
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
// Rule 7: how long a title rests after changing hands before anyone may take it
// off its new wearer.
const ENV_TAKEOVER_COOLDOWN_MS = Number(process.env.TITLE_TAKEOVER_COOLDOWN_MS || DAY_MS);

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
  takeoverCooldownMs = ENV_TAKEOVER_COOLDOWN_MS,
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
      if (!name || !title) continue;
      map.set(name, {
        title,
        source: String(p?.source || ''),
        // The hall-name the engine would give this viking if they earned nothing,
        // de-duplicated across the roster (lib/epithets.ts `Epithet.placeholder`).
        // Rule 1a lands a dethroned wearer on it. An older dashboard deploy omits
        // the field; `freeTitleFor` then falls through to the names it has seen.
        placeholder: String(p?.placeholder || '').trim(),
      });
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
   * `handovers` is every viking who wore this title until now, each with the
   * title they take up: `[{ name, title }, …]`. It adds ONE line per outgoing
   * holder to the same Discord message and folds them all into the one voice
   * line, because the hall should hear a title being passed as one event and not
   * as several unrelated ones. A plain new crown, and a handover from a single
   * holder, keep the formats they have always had, byte for byte.
   */
  async function announce(row, title, handovers = []) {
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
    const content = [
      line,
      ...handovers.map(
        (h) =>
          `**${nameMd(h.name)}** passes **${escapeMd(title)}** to **${nameMd(name)}** and takes up **${escapeMd(h.title)}**.`,
      ),
    ].join('\n');
    const voice = handovers.length
      ? `From tonight, ${firstName(name)} goes by ${title}${handovers
          .map((h) => `, and ${firstName(h.name)} takes up ${h.title}`)
          .join('')}.`
      : `From tonight, ${firstName(name)} goes by ${title}.`;
    if (dryRun) {
      log.info?.(
        handovers.length
          ? `[titles] (dry) would announce: ${name} -> "${title}", ${handovers
              .map((h) => `${h.name} -> "${h.title}"`)
              .join(', ')}`
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
        meta:
          handovers.length === 1
            ? {
                title,
                player_id: row.id,
                passedFrom: handovers[0].name,
                passedTo: handovers[0].title,
              }
            : handovers.length > 1
              ? {
                  title,
                  player_id: row.id,
                  passed: handovers.map((h) => ({ from: h.name, to: h.title })),
                }
              : { title, player_id: row.id },
        status: 'queued',
        queued_at: new Date(now()).toISOString(),
      });
      if (vErr) log.error?.(`[titles] voice enqueue failed for ${name}: ${vErr.message}`);
    } catch (e) {
      log.error?.(`[titles] voice enqueue failed for ${name}: ${e.message}`);
    }
  }

  /**
   * Proclaim a YIELD (rule 1c): a stale wearer stepping off a title the engine
   * has already given to somebody else. ONE quiet line — no "has earned a new
   * title" fanfare, because nothing was earned and nothing changed hands; a
   * duplicate the hall should never have seen is being closed.
   */
  async function announceYield(row, vacated, toName, takes) {
    const name = (row.character_name || '').trim() || 'A viking';
    const content = `**${nameMd(name)}** yields **${escapeMd(vacated)}** to **${nameMd(toName)}** and takes up **${escapeMd(takes)}**.`;
    const voice = `${firstName(name)} yields ${vacated} to ${firstName(toName)} and takes up ${takes}.`;
    if (dryRun) {
      log.info?.(
        `[titles] (dry) would announce: ${name} yields "${vacated}" to ${toName}, takes up "${takes}"`,
      );
      return;
    }
    try {
      await post(channel, { content });
    } catch (e) {
      log.error?.(`[titles] #${channel} post failed for ${name}: ${e.message}`);
    }
    try {
      const { error: vErr } = await writeDb.from('voice_lines').insert({
        text: voice,
        kind: 'event',
        meta: { title: takes, player_id: row.id, yielded: vacated, yieldedTo: toName },
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
    // title (earned OR hall-name) -> Set of character_names wearing it. A SET, not
    // one name: production can carry two wearers of one title (the bug this file
    // keeps closing), and rule 1b hands EVERY one of them off, so "who else wears
    // this" has to be the whole list. Hall-names are tracked too, because rule 1a
    // asks whether a placeholder is free before landing anybody on it.
    const wornBy = new Map();
    // character_name -> the title they wear AS OF NOW IN THIS PASS. Kept beside
    // the rows rather than written into them: the rows are the caller's data and
    // a pass must not leave footprints in them.
    const liveTitle = new Map();
    // title -> ms when it last changed holder, rule 7's clock. Seeded from the
    // wearers' title_updated_at (the latest one, if the pre-fix era left two
    // wearers on it) and kept current as this pass writes.
    const handsAt = new Map();

    const wear = (title, who) => {
      const t = String(title || '').trim();
      if (!t) return;
      let set = wornBy.get(t);
      if (!set) wornBy.set(t, (set = new Set()));
      set.add(who);
    };
    const unwear = (title, who) => {
      const t = String(title || '').trim();
      const set = wornBy.get(t);
      if (!set) return;
      set.delete(who);
      if (set.size === 0) wornBy.delete(t);
    };
    /** Everyone wearing `title` right now in this pass, in registry order. */
    const holdersOf = (title) => [...(wornBy.get(String(title || '').trim()) || [])];

    for (const row of data || []) {
      const holder = (row.character_name || '').trim();
      if (!holder || isExcluded(row)) continue;
      if (!rowByName.has(holder)) rowByName.set(holder, row);
      const held = String(row.current_title || '').trim();
      if (!liveTitle.has(holder)) liveTitle.set(holder, held);
      wear(held, holder);
      const at = row.title_updated_at ? Date.parse(row.title_updated_at) : NaN;
      if (held && Number.isFinite(at)) {
        const prev = handsAt.get(held);
        if (prev === undefined || at > prev) handsAt.set(held, at);
      }
    }

    /** What the engine offers this viking right now, or null. */
    const offerFor = (who) => computed.get(who) ?? null;
    const isEarnedOffer = (entry) =>
      entry ? (entry.source ? entry.source !== 'flavor' : isEarnedTitle(entry.title)) : false;

    /**
     * Every hall-name this pass has SEEN, in the order /api/titles returned them:
     * each entry's `placeholder`, plus any hall-name the engine is offering. The
     * bot deliberately keeps no copy of the engine's FLAVOR_POOL — a stale mirror
     * is exactly the failure EARNED_TITLES is warned about above — so this is its
     * entire vocabulary for the last-resort landing spot in `freeTitleFor`. The
     * roster order is deterministic, so the choice is too.
     */
    const seenFlavorNames = [];
    {
      const seen = new Set();
      for (const entry of computed.values()) {
        const cands = [entry.placeholder];
        if (!isEarnedOffer(entry)) cands.push(entry.title);
        for (const cand of cands) {
          const t = String(cand || '').trim();
          if (!t || seen.has(t) || isEarnedTitle(t)) continue;
          seen.add(t);
          seenFlavorNames.push(t);
        }
      }
    }

    /**
     * 1a. WHERE AN OUTGOING HOLDER LANDS. The title they take up must be worn by
     * nobody else once this pass's writes are in, so it is resolved against
     * `wornBy` (which this pass keeps current) plus `reserved`, the titles already
     * promised to earlier holders inside this same takeover. In order:
     *   1. the engine's own offer for them — the old behaviour, and still the
     *      right answer whenever it is free;
     *   2. their PLACEHOLDER from /api/titles — the hall-name the engine would
     *      give them with no deed at all, already de-duplicated across the roster,
     *      so it is free unless the registry is stale;
     *   3. failing both, the first free hall-name this pass has seen, with a
     *      warning. Nothing is APPENDED to a title to force uniqueness: an
     *      invented name reads worse in the hall than a plain one.
     * Returns null when even that finds nothing; the caller then leaves the title
     * where it is rather than write a duplicate.
     */
    function freeTitleFor(who, taking, reserved) {
      const free = (t) => {
        const title = String(t || '').trim();
        if (!title || title === taking || reserved.has(title)) return false;
        const holders = wornBy.get(title);
        if (!holders) return true;
        for (const h of holders) if (h !== who) return false;
        return true;
      };
      const entry = offerFor(who);
      if (entry && free(entry.title)) return { title: entry.title, via: 'offer' };
      if (entry && free(entry.placeholder)) return { title: entry.placeholder, via: 'placeholder' };
      const fallback = seenFlavorNames.find(free);
      if (fallback) return { title: fallback, via: 'fallback' };
      return null;
    }

    /**
     * 1c. IS THIS VIKING THE STALE WEARER OF `current`? True when somebody else
     * on the registry also wears it AND the engine's offer names that other row
     * as its holder, while naming this viking something else. Returns the
     * engine's holder (so the proclamation can name them), or null.
     *
     * The narrow shape is deliberate: a duplicate is only closed here when the
     * engine has actually picked a side. Two wearers whom the engine names
     * neither of (a roster it cannot see, an excluded row) stay held by rule 1
     * rather than both stepping off a title nobody would then wear.
     */
    function staleDuplicateOf(name, current) {
      if (!isEarnedTitle(current)) return null;
      const mine = offerFor(name);
      if (!mine || mine.title === current) return null; // the engine still names them
      for (const other of holdersOf(current)) {
        if (other === name) continue;
        const theirs = offerFor(other);
        if (theirs && theirs.title === current) return other;
      }
      return null;
    }

    /**
     * Rule 7's clock: when `title` last changed holder. The registry's answer is
     * the title_updated_at of whoever wears it; a row carrying no usable stamp
     * falls back to the challenger's own confirmed offer time, so an un-stamped
     * row still rests a day instead of being taken over on sight. With neither,
     * NaN — no cool-down at all — because a takeover is then the only thing that
     * can clear the row, and a title nobody can date has not just changed hands.
     */
    const changedHandsAt = (title, challengerName) => {
      const at = handsAt.get(String(title || '').trim());
      if (Number.isFinite(at)) return at;
      const p = pending.get(challengerName);
      return p ? p.firstOfferedAt + confirmMs : NaN;
    };

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
        wear(title, name);
        liveTitle.set(name, title);
        handsAt.set(title, nowMs);
        pass.seeded++;
        continue;
      }

      const currentEarned = isEarnedTitle(current);
      // The API always reports a source; fall back to the title itself if a
      // future/partial payload ever omits it, so an unknown source can never be
      // mistaken for an earned crown.
      const offeredEarned = entry.source ? entry.source !== 'flavor' : isEarnedTitle(title);

      // 1c. STALE DUPLICATE. Another row wears this title and the engine names
      //     THEM its holder: this viking is wearing a leftover and yields it.
      //     Checked before rule 1, because a stale wearer offered a hall-name is
      //     exactly the case rule 1 would hold forever.
      const yieldTo = staleDuplicateOf(name, current);

      // 1. HOLD an earned title against a placeholder offer. The only thing that
      //    takes it away is a CONFIRMED offer of it to somebody else, which is
      //    handled from the challenger's row (the takeover below), never here.
      if (!yieldTo && currentEarned && !offeredEarned) {
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
        unwear(current, name);
        wear(title, name);
        liveTitle.set(name, title);
        handsAt.set(title, nowMs);
        pass.reshuffled++;
        continue;
      }

      // Everything below is a change that WOULD be proclaimed.
      const kind = yieldTo ? 'yield' : currentEarned ? 'earned' : 'promotion';

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
      // A yield takes nothing over — rule 1a picks it a free landing spot at
      // write time — so it waits for nobody.
      const unsettled =
        kind === 'yield' ? null : holdersOf(title).find((h) => h !== name && holderStillMoving(h));
      if (unsettled) {
        quiet(
          nowMs,
          name,
          `offered "${title}" but ${unsettled} wears it and has an unconfirmed move of their own; waiting`,
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

      candidates.push({ row, name, title, current, kind, source: entry.source, yieldTo });
    }

    // 5. DAILY BUDGET. Rank first, so the same three changes win regardless of
    //    row order: first titles, then combat crowns, then alphabetically.
    if (candidates.length > 0) {
      const used = await announcedInLastDay(nowMs);
      let remaining = Math.max(0, perDay - used);
      // Yields go first: they close a duplicate the hall can currently SEE, which
      // is worth more than any new crown. Then first titles, then the rest.
      const KIND_ORDER = { yield: 0, promotion: 1, earned: 2 };
      const kindRank = (c) => KIND_ORDER[c.kind] ?? 2;
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

        // 1c. THE YIELD. No takeover, no cool-down, nothing changes hands: the
        //     stale wearer simply steps off a title the engine gave to somebody
        //     else. The landing spot is resolved HERE rather than reused from the
        //     offer, because an earlier candidate in this same pass may have taken
        //     it in the meantime (rule 1a decides, in the same order it always
        //     does: the offer, their placeholder, then the first free hall-name).
        if (c.kind === 'yield') {
          const landing = freeTitleFor(c.name, c.current, new Set([c.current]));
          if (!landing) {
            quiet(nowMs, c.name, `should yield "${c.current}" to ${c.yieldTo} but has nowhere free to go; waiting`);
            pass.held++;
            continue;
          }
          if (landing.via === 'fallback') {
            log.warn?.(
              `[titles] ${c.name}: the engine's offer and their placeholder are both worn already — taking up "${landing.title}" (first free hall-name in this pass's payload)`,
            );
          }
          const takes = landing.title;
          if (!dryRun) {
            const yErr = await record(c.row, takes, nowIso);
            if (yErr) {
              log.error?.(`[titles] yield write failed for ${c.name}: ${yErr.message}`);
              continue;
            }
            // One history row, so the yield spends one of the day's budget.
            await writeDb.from('title_history').insert({
              player_id: c.row.id,
              title: takes,
              awarded_at: nowIso,
            });
          }
          await announceYield(c.row, c.current, c.yieldTo, takes);
          // The title stays where the engine put it; only this row moves off it,
          // so `handsAt` for the vacated title is deliberately NOT touched.
          unwear(c.current, c.name);
          wear(takes, c.name);
          liveTitle.set(c.name, takes);
          handsAt.set(takes, nowMs);
          pending.delete(c.name);
          pass.announced++;
          remaining--;
          log.info?.(
            `[titles] ${c.name}: yields "${c.current}" to ${c.yieldTo} and takes up "${takes}"`,
          );
          continue;
        }

        // THE TAKEOVER. EVERY viking still wearing this title steps off it — the
        // pre-fix era could leave two of them on one title (rule 1b) — and each
        // takes up a title nobody else wears (rule 1a). Resolved against
        // `wornBy`, which this loop keeps current, so a holder who already moved
        // earlier in the pass is not moved twice.
        const handovers = [];
        const holders = holdersOf(c.title).filter((h) => h !== c.name);
        if (holders.length > 0) {
          // 7. COOL-DOWN — a title may not change hands twice inside a day. The
          //    challenger waits; the wearers are not disturbed and nothing is
          //    written, so waiting can never open a duplicate.
          const sinceMs = nowMs - changedHandsAt(c.title, c.name);
          if (Number.isFinite(sinceMs) && sinceMs < takeoverCooldownMs) {
            quiet(
              nowMs,
              c.name,
              `waiting: "${c.title}" changed hands ${Math.floor(sinceMs / HOUR_MS)} h ago`,
            );
            pass.held++;
            continue;
          }
          // The title being taken is reserved from the start: nobody steps off it
          // and back onto it.
          const reserved = new Set([c.title]);
          let blocked = null;
          for (const holderName of holders) {
            const hRow = rowByName.get(holderName);
            if (!hRow) {
              blocked = `${holderName} has no registry row to write`;
              break;
            }
            const landing = freeTitleFor(holderName, c.title, reserved);
            // Without anywhere free to put them, a takeover would strand the
            // holder on a title somebody else now wears. Hold instead; the offer
            // stays pending and the next pass tries again.
            if (!landing) {
              blocked = `nothing free for ${holderName} to take up`;
              break;
            }
            if (landing.via === 'fallback') {
              log.warn?.(
                `[titles] ${holderName}: the engine's offer and their placeholder are both worn already — taking up "${landing.title}" (first free hall-name in this pass's payload)`,
              );
            }
            reserved.add(landing.title);
            handovers.push({ row: hRow, name: holderName, title: landing.title });
          }
          if (blocked) {
            quiet(nowMs, c.name, `offered "${c.title}" but it cannot change hands (${blocked}); waiting`);
            pass.held++;
            continue;
          }
        }

        // Keep the in-pass picture of who wears what honest for later candidates.
        const commitPicture = () => {
          unwear(c.current, c.name);
          for (const h of handovers) unwear(c.title, h.name);
          wear(c.title, c.name);
          liveTitle.set(c.name, c.title);
          handsAt.set(c.title, nowMs);
          pending.delete(c.name);
          for (const h of handovers) {
            wear(h.title, h.name);
            liveTitle.set(h.name, h.title);
            handsAt.set(h.title, nowMs);
            pending.delete(h.name);
            absorbed.add(h.name);
          }
        };

        if (dryRun) {
          await announce(c.row, c.title, handovers);
          commitPicture();
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
        for (const h of handovers) {
          const hErr = await record(h.row, h.title, nowIso);
          if (hErr) {
            log.error?.(`[titles] handover write failed for ${h.name}: ${hErr.message}`);
          }
        }
        // ONE history row per proclamation, so the rolling-24h budget counts a
        // handover — however many holders it moved — as the single event the hall
        // heard.
        await writeDb.from('title_history').insert({
          player_id: c.row.id,
          title: c.title,
          awarded_at: nowIso,
        });
        await announce(c.row, c.title, handovers);

        commitPicture();
        pass.announced++;
        remaining--;
        log.info?.(
          handovers.length
            ? `[titles] ${c.name}: "${c.current}" -> "${c.title}" (${handovers
                .map((h) => `taken from ${h.name}, who takes up "${h.title}"`)
                .join('; ')})`
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
