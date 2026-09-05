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

// discord.js throws a DiscordAPIError carrying the HTTP status. A 4xx means
// this row will NEVER post (bad content, missing perms), so the feed must step
// over it; 429/5xx/network errors are transient and are retried next tick.
function isPermanentPostError(e) {
  const status = Number(e?.status ?? e?.httpStatus);
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 429;
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
          posted++;
          if (ev.type === 'death') rememberDeath(ev);
        } catch (e) {
          if (!isPermanentPostError(e)) throw e; // retry this row next tick
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
