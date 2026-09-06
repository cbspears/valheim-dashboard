// Relay: polls the events table and posts new activity to #server.
import { formatFeedEvent } from './format.js';

// Two ingest paths (the `gs` mod report and the `eilif` death report) can write
// the SAME death milliseconds apart, which used to put two identical lines in
// #server. Collapse a repeat for the same viking inside this window only:
// a corpse run that ends in a second death a minute later is a REAL second
// death and must still post, so never widen this.
const DEATH_COLLAPSE_MS = 10_000;
// How long a name's last-death stamp is kept in state.json.
const DEATH_MEMORY_MS = 3600_000;
// …and how many names at once, whatever the clock says. The map is keyed by a
// name from the events table, and two of the ingest paths that write that table
// carry no token, so the key space is not "the roster" — it is "whatever anyone
// posted". state.json is rewritten after EVERY relayed row, so an hour of
// distinct forged names turned a 1 KB file into a megabyte one and then wrote
// it fifty times a tick. 200 is ten times the player cap; the oldest go first,
// which is exactly what the time-based prune would have done anyway.
const DEATH_MEMORY_MAX = 200;

// How many rows one tick will consume. The query asks for this PLUS the tie
// list below, so rows already relayed can never eat into the window.
const BATCH = 50;

// How far ahead of now an event row may be dated and still be relayed. Kept in
// step with lib/event-time.ts FUTURE_EVENT_TOLERANCE_MS on the site side (this
// service is a separate npm project and cannot import the TypeScript).
const FUTURE_EVENT_TOLERANCE_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// THE CURSOR, AND THE TWO BUGS IT HAS HAD
//
// 1. THE SILENT EVENT LOSS (found by the launch rehearsal, 2026-09-06:
//    `join 20/20 · leave 0/20 · death 2/3 — 21 of 43 feed rows NEVER POSTED`).
//    The cursor used to BE `events.created_at`, which is PRODUCER-supplied and
//    is not insertion order. The log poller stamps a join/leave with the LOG
//    LINE's time and ships it on its next 20 s SFTP poll, so its rows land
//    20-30 s after the instant they claim; gs-ingest and the bot's own rows
//    land at real now. A client death at 12:00:00 relayed at 12:00:05 parked
//    the cursor at 12:00:00, the poller then wrote a leave stamped 11:59:50 at
//    12:00:08, and `.gt('created_at', '12:00:00')` never matched it again. The
//    row was lost from #server forever, silently: a tick that posts nothing is
//    a success, so the ops heartbeat and the watchdog both stayed green.
//
//    The fix is db/2026-09-06_events_inserted_at.sql: cursor on `inserted_at`
//    (server-side `now()` at INSERT, which no producer can supply) and use
//    created_at only for ordering ties and for rendering. `events.id` is a UUID,
//    so that column is the only insertion-order key there is.
//
// 2. THE FROZEN FEED (red-team, 2026-09-05). Two ingest paths on /api/gs-ingest
//    are unauthenticated by design, and until the clamp in lib/event-time.ts
//    they accepted any tsUtc — so one anonymous POST naming any online viking,
//    dated 2999-01-01, parked the created_at cursor in the year 2999 and the
//    feed went permanently, silently quiet. The clamp at ingest is the real fix.
//
//    Bug 2's guard used to STOP the batch on a future-dated row. Under an
//    insertion-order cursor that would now cause bug 1: rows no longer arrive
//    sorted by created_at, so a future-dated row is not "last" — it sits
//    wherever it was inserted, with honest rows behind it, and stopping there
//    holds the cursor in front of all of them for as long as the row exists.
//    Stalling would be strictly worse than the hole it was written to prevent.
//    So the guard now SKIPS the row (one error line per row per process) and
//    lets the cursor advance past it. It is safe to do that because
//    `inserted_at` is the DB's own clock: a forged created_at can no longer
//    move the cursor at all, only cost its own row a feed line. The legacy
//    fallback path below still stalls, because there the cursor IS created_at.
//
// TIES. `inserted_at` has microsecond resolution, but `now()` is fixed for a
// whole transaction, so two rows written by one statement share a value and a
// plain `.gt` on it would skip the second one — the same class of silent loss.
// So the query is `.gte(cursor)` and the ids already relayed AT EXACTLY that
// timestamp are carried in state.relay.lastInsertedIds and skipped by id. The
// query asks for BATCH + that list's length so the re-read rows cannot starve
// real ones out of the window.
// ─────────────────────────────────────────────────────────────────────────────

// How many already-relayed ids are remembered for the current lastInsertedAt.
// One statement writing >200 events rows in a single transaction is the only
// way to exceed it, and nothing in this repo does that. If it ever happened the
// oldest ids are dropped, which risks a REPEATED line rather than a lost one —
// the trade this whole file is built around.
const INSERTED_IDS_MAX = 200;

// discord.js throws a DiscordAPIError carrying the HTTP status.
//
// PERMANENT means "this ROW will never post" — the payload itself is the
// problem — and only then may the feed step over it and burn the event.
//
// THE SILENT LOSS THIS FIXES (red-team, 2026-09-05). The old test was "any 4xx
// but 429", with "bad content, missing perms" in its comment. Missing perms is
// not a property of the row: pull Send Messages on #server for ten minutes on
// launch night (or move the channel under a category that denies it, or have
// the bot's role reordered) and every join, leave and death in that window was
// logged as a poison row and skipped, cursor and all. Nobody would ever know
// which events were lost — a skip is one line in the journal and the feed looks
// healthy again the moment the permission comes back.
//
// So: 400 (Invalid Form Body — the payload) and 413 (too large) are permanent.
// 401/403/404 are the ENVIRONMENT, and stall the feed instead. Stalling is the
// right failure: the backlog drains by itself once someone fixes the channel,
// the loop reports failing to the ops cockpit the whole time, and the worst
// case is a late feed rather than a hole in the saga nobody can reconstruct.
function isPermanentPostError(e) {
  const status = Number(e?.status ?? e?.httpStatus);
  return status === 400 || status === 413;
}

// PostgREST's answer when db/2026-09-06_events_inserted_at.sql has not been
// applied yet: SQLSTATE 42703, "column events.inserted_at does not exist".
function isMissingInsertedAt(error) {
  if (!error) return false;
  if (String(error.code ?? '') === '42703') return true;
  const m = `${error.message ?? ''} ${error.details ?? ''}`;
  return /inserted_at/.test(m) && /does not exist/i.test(m);
}

// How long the relay stays on the legacy cursor before probing for the column
// again, so applying the migration under a running bot heals it without a
// restart, and a genuinely un-migrated database is not asked every 15 s.
const MIGRATION_RECHECK_MS = 5 * 60_000;

export function createRelay({ db, post, state, saveState, log = console }) {
  if (!state.relay) state.relay = { lastEventAt: new Date().toISOString() };

  // SELF-REPAIR. If a cursor was already poisoned before this guard shipped, the
  // feed is dead until someone hand-edits state.json — which is exactly the kind
  // of recovery nobody performs at 11pm on launch night. Pull it back to now and
  // say so loudly. Events between the real last-relayed row and now are skipped,
  // which is the right trade: the alternative is a permanently silent #server.
  {
    const cur = Date.parse(state.relay.lastEventAt);
    const limit = Date.now() + FUTURE_EVENT_TOLERANCE_MS;
    if (!Number.isFinite(cur) || cur > limit) {
      const was = state.relay.lastEventAt;
      state.relay.lastEventAt = new Date().toISOString();
      log.error?.(
        `[relay] the saved cursor was ${was}, which is not a usable time — reset to ` +
          `${state.relay.lastEventAt}. Any events between the last relayed one and now are not posted. ` +
          `A future-dated events row is the usual cause; look for one and delete it.`,
      );
    }
  }

  // THE TRANSITION. A bot upgraded in place has a created_at cursor and no
  // insertion-order one. The migration backfills inserted_at = created_at for
  // every row that already existed, so for history the two columns are the same
  // clock and lastEventAt is a usable starting point.
  //
  // The seeded cursor is used with `.gte` and an EMPTY id list, so the single
  // row the old cursor last landed on is re-read and may post one duplicate line
  // at the moment of the switch (a death self-collapses; a join or leave would
  // show twice). That is deliberate: the alternative — "skip anything dated at
  // or before the seed" — is the exact rule that lost twenty leaves.
  if (!Array.isArray(state.relay.lastInsertedIds)) state.relay.lastInsertedIds = [];
  {
    const cur = Date.parse(state.relay.lastInsertedAt);
    const limit = Date.now() + FUTURE_EVENT_TOLERANCE_MS;
    if (typeof state.relay.lastInsertedAt !== 'string' || !Number.isFinite(cur)) {
      const was = state.relay.lastInsertedAt;
      state.relay.lastInsertedAt = state.relay.lastEventAt;
      state.relay.lastInsertedIds = [];
      if (was === undefined || was === null) {
        log.info?.(
          `[relay] first run on the insertion-order cursor: seeded lastInsertedAt from lastEventAt ` +
            `(${state.relay.lastInsertedAt}). db/2026-09-06_events_inserted_at.sql backfills inserted_at ` +
            `from created_at, so history keeps its order.`,
        );
      } else {
        log.error?.(
          `[relay] the saved insertion cursor was ${JSON.stringify(was)}, which is not a usable time — ` +
            `re-seeded from lastEventAt (${state.relay.lastInsertedAt}).`,
        );
      }
    } else if (cur > limit) {
      // inserted_at is the database's own now(), so this means a bad server
      // clock or a hand-edited state.json. Either way the feed is frozen until
      // it is pulled back.
      const was = state.relay.lastInsertedAt;
      state.relay.lastInsertedAt = new Date().toISOString();
      state.relay.lastInsertedIds = [];
      log.error?.(
        `[relay] the saved insertion cursor was ${was}, which is in the future — reset to ` +
          `${state.relay.lastInsertedAt}. Events between the last relayed row and now are not posted. ` +
          `inserted_at is written by the database, so check the Postgres clock.`,
      );
    }
  }

  // Future-dated rows already reported, so one warning per row per process.
  const warnedFuture = new Set();

  // Set once PostgREST says the column is missing, cleared once it appears.
  let pendingMigration = false;
  let nextMigrationProbe = 0;

  // THE OUTAGE THE JOURNAL COULD NOT NAME (round 3, 2026-09-05). A stall
  // rethrows, index.js safe() catches it, and the journal gets one bare
  // `[relay] Missing Permissions` every POLL_INTERVAL_MS for as long as the
  // outage lasts. That per-tick line is the ops-cockpit signal and must stay,
  // but on its own it never says WHICH failure this is, that the feed is
  // holding rather than dropping, or that the backlog drains by itself. So:
  // one explanatory line when a stall starts, one when it clears, and nothing
  // in between however many ticks it spans.
  let stalledSince = null;

  // THE CONFIDENT MISDIAGNOSIS (round 3 review, 2026-09-05). The first cut of
  // noteStall was called from the `!isPermanentPostError` branch — which is
  // EVERY retryable failure, not only the permission ones — but its copy was
  // written for 403 alone. A plain rate limit printed "#server is refusing our
  // posts ... Check the bot's Send Messages / View Channel on #server", which
  // sends whoever reads the journal to Discord's permission screens for a
  // problem that clears itself on the next tick. On launch night the relay
  // posts up to 50 rows a tick with no backoff of its own, so a 429 or a
  // Discord 5xx is the MOST likely thing to land here.
  //
  // The mechanics are identical either way: hold the cursor, retry the row.
  // Only the diagnosis differs, so only the copy branches.
  //   401/403/404 -> the ENVIRONMENT (token, channel, permissions). Somebody
  //                  has to go fix something, and this says what.
  //   everything else -> transient. Say so, and say what happens next.
  const ENVIRONMENT_STATUSES = new Set([401, 403, 404]);
  function noteStall(status, message) {
    if (stalledSince) return;
    stalledSince = Date.now();
    const held = state.relay.lastInsertedAt;
    if (ENVIRONMENT_STATUSES.has(status)) {
      log.error?.(
        `[relay] #server is refusing our posts (${status}: ${message}). The feed is STALLED, ` +
          `not dropping: the cursor is holding at ${held} and every event since then posts ` +
          `by itself once the channel accepts us again. Check the bot's Send Messages / View Channel on ` +
          `#server, and that CHANNEL_SERVER still names a channel it can see. No restart is needed.`,
      );
      return;
    }
    log.error?.(
      `[relay] #server did not accept a post (${status ?? 'no status'}: ${message}). This is a transient ` +
        `failure, not a permission problem, so do not go looking at the channel yet: the cursor is holding ` +
        `at ${held}, the same event is retried on the next tick, and nothing is dropped. No restart is ` +
        `needed. If it never clears, check Discord's own status before anything on this box.`,
    );
  }
  function noteRecovered() {
    if (!stalledSince) return;
    // Whole minutes made a twenty-second blip read "after about 0 minute(s)",
    // which looks like a bug to whoever finds it in the journal at 23:00.
    const ms = Date.now() - stalledSince;
    let held;
    if (ms < 90_000) {
      const secs = Math.max(1, Math.round(ms / 1000));
      held = `${secs} second${secs === 1 ? '' : 's'}`;
    } else {
      const mins = Math.round(ms / 60000);
      held = `about ${mins} minute${mins === 1 ? '' : 's'}`;
    }
    log.error?.(`[relay] #server is accepting posts again after ${held}. Draining the backlog.`);
    stalledSince = null;
  }
  // name -> ISO timestamp of the last death we actually posted for that viking.
  // Persisted with the cursor so the collapse survives ticks AND restarts.
  if (!state.relay.lastDeathByName || typeof state.relay.lastDeathByName !== 'object') {
    state.relay.lastDeathByName = {};
  }

  function isDuplicateDeath(ev) {
    if (ev.type !== 'death') return false;
    const name = String(ev.character_name || '').trim();
    if (!name) return false;
    const prev = Date.parse(state.relay.lastDeathByName[name] ?? '');
    const at = Date.parse(ev.created_at);
    if (!Number.isFinite(prev) || !Number.isFinite(at)) return false;
    return Math.abs(at - prev) <= DEATH_COLLAPSE_MS;
  }

  function rememberDeath(ev) {
    const name = String(ev.character_name || '').trim();
    if (!name) return;
    const map = state.relay.lastDeathByName;
    map[name] = ev.created_at;
    // Keep state.json small. Pruning against the EVENT's clock (not wall time)
    // so a backfill replay behaves the same as a live tick.
    const cutoff = Date.parse(ev.created_at) - DEATH_MEMORY_MS;
    for (const [k, v] of Object.entries(map)) {
      const t = Date.parse(v);
      if (!Number.isFinite(t) || t < cutoff) delete map[k];
    }
    // Hard size cap on top of the clock (see DEATH_MEMORY_MAX): drop the oldest
    // stamps until the map fits. The name we just recorded is the newest, so it
    // is never the one dropped.
    const keys = Object.keys(map);
    if (keys.length > DEATH_MEMORY_MAX) {
      keys
        .sort((a, b) => (Date.parse(map[a]) || 0) - (Date.parse(map[b]) || 0))
        .slice(0, keys.length - DEATH_MEMORY_MAX)
        .forEach((k) => delete map[k]);
    }
  }

  // Remember an id as already relayed at the CURRENT lastInsertedAt.
  function rememberInserted(id) {
    if (!id) return;
    const ids = state.relay.lastInsertedIds;
    if (ids.includes(id)) return;
    ids.push(id);
    if (ids.length > INSERTED_IDS_MAX) ids.splice(0, ids.length - INSERTED_IDS_MAX);
  }

  // Move the insertion-order cursor onto a consumed row. Never backwards: the
  // query is ordered, but a fake/replaying source (or a row with no
  // inserted_at at all) must not be able to rewind the feed into a replay.
  function advanceInsertion(ev) {
    const id = ev.id === undefined || ev.id === null ? '' : String(ev.id);
    const ins = typeof ev.inserted_at === 'string' && ev.inserted_at ? ev.inserted_at : null;
    if (!ins) {
      rememberInserted(id);
      return;
    }
    if (ins === state.relay.lastInsertedAt) {
      rememberInserted(id);
      return;
    }
    const next = Date.parse(ins);
    const cur = Date.parse(state.relay.lastInsertedAt);
    if (Number.isFinite(next) && Number.isFinite(cur) && next < cur) {
      rememberInserted(id);
      return;
    }
    state.relay.lastInsertedAt = ins;
    state.relay.lastInsertedIds = id ? [id] : [];
  }

  // The cursor of record: insertion order, which no producer supplies.
  function fetchByInsertion() {
    return db
      .from('events')
      .select('*')
      .gte('inserted_at', state.relay.lastInsertedAt)
      .order('inserted_at', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(BATCH + state.relay.lastInsertedIds.length);
  }

  // Pre-migration only. Keeps the bot working if it restarts before
  // db/2026-09-06_events_inserted_at.sql is applied — and this is the path with
  // the event-loss bug, so it is a bridge, not a mode anyone should sit in.
  function fetchByCreatedAt() {
    return db
      .from('events')
      .select('*')
      .gt('created_at', state.relay.lastEventAt)
      .order('created_at', { ascending: true })
      .limit(BATCH);
  }

  async function tick() {
    let byInsertion = !pendingMigration || Date.now() >= nextMigrationProbe;
    let data;
    let error;

    if (byInsertion) {
      ({ data, error } = await fetchByInsertion());
      if (isMissingInsertedAt(error)) {
        if (!pendingMigration) {
          pendingMigration = true;
          log.error?.(
            `[relay] events.inserted_at does not exist — db/2026-09-06_events_inserted_at.sql is UNAPPLIED. ` +
              `Falling back to the old created_at cursor, which SILENTLY LOSES any row written with an ` +
              `earlier timestamp than one already relayed (the log poller's joins and leaves, every time). ` +
              `Apply the migration; the relay picks the new cursor up by itself within ` +
              `${Math.round(MIGRATION_RECHECK_MS / 60000)} minutes, no restart needed.`,
          );
        }
        nextMigrationProbe = Date.now() + MIGRATION_RECHECK_MS;
        byInsertion = false;
        ({ data, error } = await fetchByCreatedAt());
      } else if (!error && pendingMigration) {
        pendingMigration = false;
        log.error?.('[relay] events.inserted_at is present now — back on the insertion-order cursor.');
      }
    } else {
      ({ data, error } = await fetchByCreatedAt());
    }

    if (error) throw new Error(`events query: ${error.message}`);
    if (!data || data.length === 0) return 0;

    // Ids relayed at exactly lastInsertedAt. The list only ever holds ids at the
    // cursor's own timestamp, and ids are UUIDs, so matching on id alone cannot
    // skip an unrelated row.
    const alreadyRelayed = byInsertion ? new Set(state.relay.lastInsertedIds) : null;

    let posted = 0;
    const futureLimit = Date.now() + FUTURE_EVENT_TOLERANCE_MS;
    for (const ev of data) {
      const rowId = ev.id === undefined || ev.id === null ? '' : String(ev.id);
      if (alreadyRelayed && rowId && alreadyRelayed.has(rowId)) continue;

      const at = Date.parse(ev.created_at);
      const isFuture = Number.isFinite(at) && at > futureLimit;
      if (isFuture) {
        const id = rowId || String(ev.created_at);
        if (!warnedFuture.has(id)) {
          warnedFuture.add(id);
          log.error?.(
            `[relay] event ${id} is dated ${ev.created_at}, which is in the future — not relayed. ` +
              (byInsertion
                ? `The insertion cursor steps past it, so the rest of the feed keeps moving. Delete the ` +
                  `row: it is either a producer with a broken clock or a forged report on one of the ` +
                  `unauthenticated ingest paths.`
                : `The cursor stays put (the inserted_at migration is not applied, so the cursor is still ` +
                  `created_at and stepping over this row would burn every event behind it). Delete the row.`),
          );
        }
        // Pre-migration the cursor IS created_at, so stepping over a
        // future-dated row would consume everything behind it. Hold instead.
        if (!byInsertion) break;
      } else {
        const payload = formatFeedEvent(ev);
        if (payload && isDuplicateDeath(ev)) {
          log.info?.(`[relay] collapsed a duplicate death for ${ev.character_name}`);
        } else if (payload) {
          try {
            await post('server', payload);
            noteRecovered();
            posted++;
            if (ev.type === 'death') rememberDeath(ev);
          } catch (e) {
            if (!isPermanentPostError(e)) {
              noteStall(Number(e?.status ?? e?.httpStatus) || null, e?.message ?? String(e));
              throw e; // retry this row next tick
            }
            // A poison row must never stall the feed: log it, walk past it (the
            // cursor advances below), keep the rest of the batch moving.
            log.error?.(`[relay] Discord rejected event ${ev.id ?? ev.created_at}: ${e.message}. Skipping it.`);
          }
        }
      }

      // Advance + persist the cursor after EVERY row (posted or skipped), not
      // just at the end of the batch. If the process dies mid-batch, the next
      // tick resumes strictly after the last row it actually posted — so a
      // crash can never cause the same death (or any event) to go out twice.
      if (byInsertion) {
        advanceInsertion(ev);
      } else if (!isFuture) {
        // Pre-migration, keep the insertion cursor in step with the legacy one.
        // The migration backfills inserted_at = created_at for every row that
        // already existed — which is exactly the rows this branch is relaying —
        // so this is the value the insertion cursor will need the moment the
        // column appears. Without it, the flip back would re-read the whole
        // legacy window and post all of it a second time. The id goes with it so
        // the boundary row itself is skipped rather than duplicated.
        state.relay.lastInsertedAt = ev.created_at;
        state.relay.lastInsertedIds = rowId ? [rowId] : [];
      }
      // lastEventAt is now only the legacy/pre-migration cursor and the seed for
      // lastInsertedAt, so on the insertion path it is kept MONOTONE: a
      // back-dated row (the whole point of the insertion cursor) must not rewind
      // it, and a future-dated one must not poison it. On the legacy path it is
      // the cursor itself and moves exactly as it always did.
      if (!isFuture) {
        if (!byInsertion) {
          state.relay.lastEventAt = ev.created_at;
        } else if (Number.isFinite(at)) {
          const prev = Date.parse(state.relay.lastEventAt);
          if (!Number.isFinite(prev) || at >= prev) state.relay.lastEventAt = ev.created_at;
        }
      }
      await saveState();
    }
    return posted;
  }

  return { tick };
}
