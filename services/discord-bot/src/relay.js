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
