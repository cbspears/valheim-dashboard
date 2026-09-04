// Discord scheduled-events sync. Fetches the guild's scheduled events and
// forwards them to the dashboard webhook → `discord_events` table → the
// dashboard's "Coming Up" / "Scheduled Gatherings" sections.
//
// Gated behind EVENTS_SYNC=1 (see index.js): leave it off until real events
// exist, so the seeded demo events stay in place. Requires the
// GuildScheduledEvents gateway intent (added in discord.js).

const STATUS = { 1: 'scheduled', 2: 'active', 3: 'completed', 4: 'canceled' };
const FETCH_TIMEOUT_MS = 20000;

// Map Discord's recurrence rule to a display label + a roll-forward interval
// (days) the dashboard uses to keep weekly events from going stale. Only the
// common daily/weekly cases get an interval; others just get a label.
function recurrence(rule) {
  if (!rule) return { recurrence: null, recurrence_days: null };
  const n = rule.interval ?? 1;
  switch (rule.frequency) {
    case 3: // Daily
      return { recurrence: n === 1 ? 'Daily' : `Every ${n} days`, recurrence_days: n };
    case 2: // Weekly
      return { recurrence: n === 1 ? 'Weekly' : `Every ${n} weeks`, recurrence_days: 7 * n };
    case 1: // Monthly
      return { recurrence: n === 1 ? 'Monthly' : `Every ${n} months`, recurrence_days: null };
    default:
      return { recurrence: 'Recurring', recurrence_days: null };
  }
}

export function createEventsSync({ client, guildId, webhookUrl, webhookSecret, log = console }) {
  if (!webhookUrl || !webhookSecret) {
    throw new Error('events sync requires WEBHOOK_URL and WEBHOOK_SECRET');
  }

  async function collect() {
    const guild =
      (guildId && client.guilds.cache.get(guildId)) || client.guilds.cache.first();
    if (!guild) return [];

    const events = await guild.scheduledEvents.fetch();
    const out = [];
    for (const ev of events.values()) {
      const status = STATUS[ev.status] ?? 'scheduled';
      if (status === 'completed' || status === 'canceled') continue;
      if (!ev.scheduledStartAt) continue;

      const { recurrence: label, recurrence_days } = recurrence(ev.recurrenceRule);
      out.push({
        discord_event_id: ev.id,
        name: ev.name,
        description: ev.description ?? null,
        host: ev.creator?.displayName ?? ev.creator?.username ?? null,
        location: ev.channel?.name ?? ev.entityMetadata?.location ?? null,
        starts_at: ev.scheduledStartAt.toISOString(),
        ends_at: ev.scheduledEndAt ? ev.scheduledEndAt.toISOString() : null,
        status,
        user_count: ev.userCount ?? 0,
        cover_url: typeof ev.coverImageURL === 'function' ? ev.coverImageURL({ size: 512 }) : null,
        url: ev.url ?? null,
        recurrence: label,
        recurrence_days,
      });
    }
    return out;
  }

  async function post(events) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': webhookSecret },
      body: JSON.stringify({ type: 'events_sync', metadata: { events } }),
      // undici has no default timeout: a stalled socket would otherwise hold
      // this loop open forever (and block the next tick).
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook ${res.status}: ${text.slice(0, 120)}`);
    }
  }

  async function tick() {
    const events = await collect();
    await post(events);
    log.info?.(`[events] synced ${events.length} scheduled event(s)`);
    return events.length;
  }

  return { tick };
}
