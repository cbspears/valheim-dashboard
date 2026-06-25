import type { Metadata } from 'next';
import { Map as MapIcon, CalendarClock } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { BossTimeline } from '@/components/world/BossTimeline';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getUpcomingEvents } from '@/lib/data';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'World' };

export default async function WorldPage() {
  const [bosses, upcoming] = await Promise.all([getBosses(), getUpcomingEvents(20)]);

  return (
    <div className="flex flex-col gap-12">
      <section>
        <SectionHeader
          title="World Progress"
          subtitle="The forsaken gate the realm. None sail ahead of the longship."
          icon={<MapIcon size={22} />}
        />
        <BossTimeline bosses={bosses} />
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
