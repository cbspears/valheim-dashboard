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

// How far ahead of now an event row may be dated and still be relayed. Kept in
// step with lib/event-time.ts FUTURE_EVENT_TOLERANCE_MS on the site side (this
// service is a separate npm project and cannot import the TypeScript).
const FUTURE_EVENT_TOLERANCE_MS = 5 * 60_000;

// THE BUG THIS GUARDS (red-team, 2026-09-05). The cursor below IS
// events.created_at and only ever moves forward. Two of the ingest paths on
// /api/gs-ingest are unauthenticated by design, and until the clamp in
// lib/event-time.ts they accepted any tsUtc — so one anonymous POST naming any
// online viking, dated 2999-01-01, parked the cursor in the year 2999 and the
// `.gt(created_at, cursor)` query never matched again. #server went silent
// permanently, and silently: a tick that posts nothing is a success, so the ops
// heartbeat and the watchdog both stayed green.
//
// The clamp at ingest is the real fix. This is the second lock on the same door:
// a future-dated row already in the table (or written by some future producer we
// do not control) stops the batch instead of consuming it, so the cursor stays
// where the last honest event left it and the feed keeps running.

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

  // Future-dated rows already reported, so one warning per row per process.
  const warnedFuture = new Set();

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
    const held = state.relay.lastEventAt;
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

  async function tick() {
    const cursor = state.relay.lastEventAt;
    const { data, error } = await db
      .from('events')
      .select('*')
      .gt('created_at', cursor)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw new Error(`events query: ${error.message}`);
    if (!data || data.length === 0) return 0;

    let posted = 0;
    const futureLimit = Date.now() + FUTURE_EVENT_TOLERANCE_MS;
    for (const ev of data) {
      // Rows arrive strictly ascending by created_at, so the first future-dated
      // one means every row after it is future-dated too: stop the batch here
      // WITHOUT advancing the cursor onto it. The row is re-read each tick (and
      // sorts last, so it never starves a real event out of the 50-row window)
      // until someone deletes it.
      const at = Date.parse(ev.created_at);
      if (Number.isFinite(at) && at > futureLimit) {
        const id = String(ev.id ?? ev.created_at);
        if (!warnedFuture.has(id)) {
          warnedFuture.add(id);
          log.error?.(
            `[relay] event ${id} is dated ${ev.created_at}, which is in the future — not relayed, and the ` +
              `cursor stays put. Delete the row: it is either a producer with a broken clock or a forged ` +
              `report on one of the unauthenticated ingest paths.`,
          );
        }
        break;
      }

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
      // Advance + persist the cursor after EVERY row (posted or skipped), not
      // just at the end of the batch. If the process dies mid-batch, the next
      // tick resumes strictly after the last row it actually posted — so a
      // crash can never cause the same death (or any event) to go out twice.
      state.relay.lastEventAt = ev.created_at;
      await saveState();
    }
    return posted;
  }

  return { tick };
}
