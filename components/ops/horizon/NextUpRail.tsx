// One ordered rail of everything on this tab that has a next time.
//
// The panels below each answer for one producer. This answers the question an
// operator actually asks at 22:50 on a play night, which is "what happens in the
// next hour". Items whose time cannot be computed are kept and sorted to the
// bottom rather than dropped: "the recap has no countdown because the bot has
// not reported its hour" is information, and silently omitting the recap from a
// list called "what fires next" is not.

import { CalendarClock, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { formatCountdownSec, untilSecFrom } from '@/lib/ops/window';
import { stampInZone, LAUNCH_TZ, type ScheduleItem } from '@/lib/ops/horizon';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Nothing } from './Panel';

export function NextUpRail({ items, nowMs }: { items: ScheduleItem[]; nowMs: number }) {
  const overdueCount = items.filter((i) => {
    const s = i.atMs === null ? null : untilSecFrom(nowMs, i.atMs);
    return s !== null && s < -30;
  }).length;

  return (
    <HorizonCard
      title="What fires next"
      entry={HORIZON_GLOSSARY['next-up-rail']}
      icon={<CalendarClock size={15} />}
      aside={
        overdueCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-raid">
            <AlertTriangle size={12} aria-hidden="true" />
            {overdueCount} overdue
          </span>
        ) : (
          `${items.length} clocks`
        )
      }
    >
      {items.length === 0 ? (
        <Nothing>Nothing on any clock the cockpit can read.</Nothing>
      ) : (
        <ol className="divide-y divide-rune/60">
          {items.map((item) => {
            const sec = item.atMs === null ? null : untilSecFrom(nowMs, item.atMs);
            const overdue = sec !== null && sec < -30;
            const soon = sec !== null && sec >= -30 && sec < 900;
            return (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-2">
                <span className="min-w-0 flex-1 text-sm text-ash">{item.label}</span>
                <span
                  className={clsx(
                    'shrink-0 text-sm tabular-nums',
                    overdue ? 'text-raid' : soon ? 'text-gold' : 'text-ash-dim',
                  )}
                >
                  {sec === null ? 'no countdown' : formatCountdownSec(sec)}
                </span>
                <span className="w-full text-xs text-muted">
                  {item.detail}
                  {item.atMs !== null && (
                    <span className="ml-1 text-muted">
                      {stampInZone(item.atMs, LAUNCH_TZ)} {LAUNCH_TZ}.
                    </span>
                  )}
                  {item.estimated && <span className="ml-1">Projected from a cadence, not a clock.</span>}
                  {item.conditional && <span className="ml-1">Only fires if its condition holds.</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </HorizonCard>
  );
}
