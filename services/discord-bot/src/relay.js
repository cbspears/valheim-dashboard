// Relay: polls the events table and posts new activity to #server.
import { formatFeedEvent } from './format.js';

export function createRelay({ db, post, state, saveState }) {
  if (!state.relay) state.relay = { lastEventAt: new Date().toISOString() };

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
      if (payload) {
        await post('server', payload);
        posted++;
      }
      state.relay.lastEventAt = ev.created_at; // advance cursor even for skipped types
    }
    await saveState();
    return posted;
  }

  return { tick };
}
