import type { Metadata } from 'next';
import { Map as MapIcon, CalendarClock, Trophy } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { BossTimeline } from '@/components/world/BossTimeline';
import { MilestoneLedger } from '@/components/world/MilestoneLedger';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getUpcomingEvents, getMilestones, getMilestoneAggregates } from '@/lib/data';
import { summarizeMilestones } from '@/lib/milestones';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'World' };

export default async function WorldPage() {
  const [bosses, upcoming, milestones, milestoneAgg] = await Promise.all([
    getBosses(),
    getUpcomingEvents(20),
    getMilestones(),
    getMilestoneAggregates(),
  ]);

  const milestoneSummary = summarizeMilestones(milestones, milestoneAgg);

  return (
    <div className="flex flex-col gap-12">
      <section>
        <SectionHeader
          title="World Progress"
          subtitle="Boss-gated progression — each forsaken felled opens the next leg of the journey. No one sails ahead of the longship."
          icon={<MapIcon size={22} />}
        />
        <BossTimeline bosses={bosses} />
      </section>

      <section>
        <SectionHeader
          title="Great Deeds"
          subtitle="Server-wide milestones — what the warband has done together, tallied across every viking. Earned deeds and the ones still ahead."
          icon={<Trophy size={22} />}
        />
        <MilestoneLedger summary={milestoneSummary} />
      </section>

      <section>
        <SectionHeader
          title="Scheduled Gatherings"
          subtitle="Game nights, raids, and revelry — what's on the road ahead."
          icon={<CalendarClock size={22} />}
        />
        <Card>
          <CardBody className="p-0">
            <UpcomingEvents
              events={upcoming}
              detailed
              emptyMessage="No gatherings on the calendar yet. Schedule one in Discord and it will appear here."
            />
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
