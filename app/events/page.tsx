import type { Metadata } from 'next';
import { ScrollText } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { EventFeed } from '@/components/events/EventFeed';
import { getAllEvents } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Saga',
};

export default async function EventsPage() {
  const events = await getAllEvents(200);

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="The Saga"
        subtitle="Every deed, death, and triumph."
        icon={<ScrollText size={22} />}
      />

      <EventFeed events={events} />
    </div>
  );
}
