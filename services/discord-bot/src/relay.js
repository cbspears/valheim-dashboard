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

// discord.js throws a DiscordAPIError carrying the HTTP status. A 4xx means
// this row will NEVER post (bad content, missing perms), so the feed must step
// over it; 429/5xx/network errors are transient and are retried next tick.
function isPermanentPostError(e) {
  const status = Number(e?.status ?? e?.httpStatus);
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 429;
}

export function createRelay({ db, post, state, saveState, log = console }) {
  if (!state.relay) state.relay = { lastEventAt: new Date().toISOString() };
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
    for (const ev of data) {
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
