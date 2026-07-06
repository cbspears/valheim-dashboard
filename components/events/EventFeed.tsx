'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { format, isToday, isYesterday } from 'date-fns';
import { clsx } from 'clsx';
import { ScrollText } from 'lucide-react';
import type { GameEvent, EventType } from '@/lib/types';
import { describeEvent, EVENT_FILTERS } from '@/lib/events';
import { Card, Badge, EmptyState } from '@/components/ui';
import { timeAgo, shortDate } from '@/lib/format';
import { bossPath } from '@/lib/slug';

type BadgeTone = 'gold' | 'online' | 'offline' | 'death' | 'raid' | 'frost' | 'neutral';

/** Map an event type to a Badge tone for the small type label. */
const BADGE_TONE: Record<string, BadgeTone> = {
  death: 'death',
  boss: 'gold',
  raid: 'raid',
  join: 'online',
  leave: 'offline',
  chat: 'frost',
  discovery: 'frost',
  craft: 'neutral',
};

/** Subtle left-border tint per event type so the feed reads at a glance. */
const ROW_TINT: Record<string, string> = {
  death: 'border-l-death/60',
  boss: 'border-l-gold/70',
  raid: 'border-l-raid/60',
  join: 'border-l-online/50',
  leave: 'border-l-muted/60',
};

interface DayGroup {
  key: string;
  label: string;
  events: GameEvent[];
}

export function EventFeed({ events }: { events: GameEvent[] }) {
  const [active, setActive] = useState<string>('all');

  // Count per filter, computed once from the full set.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of EVENT_FILTERS) {
      c[f.key] =
        f.types.length === 0
          ? events.length
          : events.filter((e) => f.types.includes(e.type as EventType)).length;
    }
    return c;
  }, [events]);

  // Events matching the active filter (events arrive newest-first).
  const filtered = useMemo(() => {
    const f = EVENT_FILTERS.find((x) => x.key === active) ?? EVENT_FILTERS[0];
    if (f.types.length === 0) return events;
    return events.filter((e) => f.types.includes(e.type as EventType));
  }, [events, active]);

  // Group the filtered feed by calendar day, preserving newest-first order.
  const groups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, GameEvent[]>();
    for (const e of filtered) {
      const d = new Date(e.created_at);
      const key = Number.isNaN(d.getTime()) ? 'unknown' : format(d, 'yyyy-MM-dd');
      const bucket = map.get(key);
      if (bucket) bucket.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries()).map(([key, evs]) => {
      let label = 'Long ago';
      if (key !== 'unknown') {
        const d = new Date(evs[0].created_at);
        label = isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : shortDate(evs[0].created_at);
      }
      return { key, label, events: evs };
    });
  }, [filtered]);

  return (
    <div className="flex flex-col gap-5">
      {/* ── Filter pills ─────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {EVENT_FILTERS.map((f) => {
          const isActive = f.key === active;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setActive(f.key)}
              aria-pressed={isActive}
              className={clsx(
                'gold-ring inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-gold-dim bg-gold/10 text-gold-light'
                  : 'border-rune bg-surface-raised text-ash-dim hover:border-rune-bright hover:text-ash'
              )}
            >
              <span>{f.label}</span>
              <span
                className={clsx(
                  'rounded-full px-1.5 py-0.5 text-[11px] tabular-nums',
                  isActive ? 'bg-gold/15 text-gold-light' : 'bg-night/60 text-muted'
                )}
              >
                {counts[f.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── The feed ─────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={28} />}
            title="Nothing here yet"
            message="No events of this type have been recorded yet — try another filter."
          />
        ) : (
          <div className="max-h-[72vh] overflow-y-auto">
            {groups.map((group) => (
              <section key={group.key}>
                {/* sticky day divider */}
                <div className="sticky top-0 z-10 bg-surface/95 px-5 pb-2 pt-4 backdrop-blur-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-display text-[11px] uppercase tracking-[0.2em] text-gold-dim">
                      {group.label}
                    </span>
                    <hr className="rune-divider flex-1" />
                    <span className="text-[11px] tabular-nums text-muted">
                      {group.events.length}
                    </span>
                  </div>
                </div>

                <ul>
                  {group.events.map((e) => {
                    const { icon: Icon, accent, description, label } = describeEvent(e);
                    // Boss kills carry the beast's name in metadata — link straight to its
                    // war-room. No other event type identifies a boss reliably, so we don't guess.
                    const bossName =
                      e.type === 'boss' && typeof e.metadata?.boss === 'string'
                        ? e.metadata.boss
                        : null;
                    return (
                      <li
                        key={e.id}
                        className={clsx(
                          'flex items-center gap-3 border-l-2 px-5 py-3 transition-colors hover:bg-surface-raised/40',
                          ROW_TINT[e.type] ?? 'border-l-transparent'
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-rune bg-surface-raised">
                          <Icon size={16} className={accent} />
                        </span>

                        {bossName ? (
                          <Link
                            href={bossPath(bossName)}
                            className="gold-ring min-w-0 flex-1 truncate text-sm text-ash transition-colors hover:text-gold-light"
                          >
                            {description}
                          </Link>
                        ) : (
                          <p className="min-w-0 flex-1 truncate text-sm text-ash">{description}</p>
                        )}

                        <Badge
                          tone={BADGE_TONE[e.type] ?? 'neutral'}
                          className="hidden uppercase sm:inline-flex"
                        >
                          {label}
                        </Badge>

                        <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                          {timeAgo(e.created_at)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
