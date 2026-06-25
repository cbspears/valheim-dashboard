import { CalendarClock, Repeat, MapPin, Users, ExternalLink } from 'lucide-react';
import { Badge, EmptyState } from '@/components/ui';
import { formatEventWhen, eventCountdown } from '@/lib/format';
import type { UpcomingEvent } from '@/lib/types';

/**
 * Shared list of upcoming community events. `detailed` shows the description
 * (used on the World page); the compact form (Hall) omits it.
 */
export function UpcomingEvents({
  events,
  detailed = false,
  emptyMessage,
}: {
  events: UpcomingEvent[];
  detailed?: boolean;
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock size={28} />}
        title="Nothing on the horizon"
        message={
          emptyMessage ??
          'No gatherings are scheduled yet. Plan one in Discord and it will appear here.'
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-rune">
      {events.map((ev) => (
        <li key={ev.id} className="flex items-start gap-3 px-5 py-3.5">
          <span className="mt-0.5 shrink-0 text-gold" title={ev.recurrence ? 'Recurring' : 'One-time'}>
            {ev.recurrence ? <Repeat size={16} /> : <CalendarClock size={16} />}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-display text-sm text-ash">
                {ev.name}
                {ev.host && <span className="text-muted"> · hosted by {ev.host}</span>}
              </p>
              <Badge tone="gold" className="shrink-0">
                {eventCountdown(ev.next_at)}
              </Badge>
            </div>

            <p className="mt-0.5 text-xs text-gold-light">
              {formatEventWhen(ev.next_at)}
              {ev.recurrence && <span className="text-muted"> · {ev.recurrence}</span>}
            </p>

            {detailed && ev.description && (
              <p className="mt-1.5 text-sm leading-relaxed text-ash-dim">{ev.description}</p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              {ev.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} />
                  {ev.location}
                </span>
              )}
              {ev.user_count > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Users size={12} />
                  {ev.user_count} going
                </span>
              )}
              {ev.url && (
                <a
                  href={ev.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gold-ring inline-flex items-center gap-1 rounded text-gold-light hover:underline"
                >
                  View in Discord
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
