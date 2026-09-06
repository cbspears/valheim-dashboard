import type { Metadata } from 'next';
import { ScrollText, BookOpenText } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { EventFeed } from '@/components/events/EventFeed';
import { EpisodeList } from '@/components/events/EpisodeList';
import { getAllEvents, getSessionsSince, getEventsSince, getOaths, getPinsForEpisodes } from '@/lib/data';
import { buildEpisodes } from '@/lib/episodes';

// SIXTY SECONDS OF ISR (2026-09-06). The Saga is a record of what already
// happened — 200 events, 70 days of sessions, the oaths and the pins, five
// reads and the two largest payloads on the site. A new deed or death joining
// the feed a minute late costs the reader nothing; #server already told them.
export const revalidate = 60;

export const metadata: Metadata = {
  title: 'The Saga',
};

export default async function EventsPage() {
  const [events, sessions, sagaEvents, oaths, pins] = await Promise.all([
    getAllEvents(200),
    getSessionsSince(70),
    getEventsSince(70),
    getOaths(),
    getPinsForEpisodes(70),
  ]);

  const episodes = buildEpisodes(sessions, sagaEvents, oaths, pins);

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-6">
        <PageHeader slot="events">
          <SectionHeader
            title="The Episodes"
            subtitle="Each night the vikings gather becomes a chapter of the season."
            icon={<BookOpenText size={22} />}
          />
        </PageHeader>
        <EpisodeList episodes={episodes} />
      </section>

      <section className="flex flex-col gap-6">
        <SectionHeader
          title="The Full Chronicle"
          subtitle="The complete event log: every deed, death, and triumph as it was recorded."
          icon={<ScrollText size={22} />}
        />
        <EventFeed events={events} />
      </section>
    </div>
  );
}
