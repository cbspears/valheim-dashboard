import type { Metadata } from 'next';
import { ScrollText, BookOpenText } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { EventFeed } from '@/components/events/EventFeed';
import { EpisodeList } from '@/components/events/EpisodeList';
import { StorytellerToggle } from '@/components/events/StorytellerToggle';
import {
  getAllEvents,
  getSessionsSince,
  getEventsSince,
  getOaths,
  getPinsForEpisodes,
  getTales,
} from '@/lib/data';
import { buildEpisodes } from '@/lib/episodes';
import { daysAgoCtKey } from '@/lib/tales';

// SIXTY SECONDS OF ISR (2026-09-06). The Saga is a record of what already
// happened — 200 events, 70 days of sessions, the oaths, the pins and the
// tales, six reads and the two largest payloads on the site. A new deed or
// death joining the feed a minute late costs the reader nothing; #server
// already told them.
//
// AND THIS PAGE MUST NOT READ `searchParams`. It is a request-time API, so
// touching it opts the route out of the build-time prerender entirely (Next 16
// `page.md`: "Using it will opt the page into dynamic rendering at request
// time"). That was measured here on 2026-09-06 while the Storyteller's filter
// still lived on `?by=`: /events moved from `○ (Static)` with a 1m revalidate
// to `ƒ (Dynamic)`, dropped out of `prerender-manifest.json`, started answering
// `Cache-Control: private, no-cache, no-store` instead of `s-maxage=60`, and
// paid all six Supabase reads on every single request. The filter is now its
// own static route, app/events/storyteller/page.tsx, and both are prerendered.
export const revalidate = 60;

const WINDOW_DAYS = 70;

export const metadata: Metadata = {
  title: 'The Saga',
};

export default async function EventsPage() {
  const [events, sessions, sagaEvents, oaths, pins, tales] = await Promise.all([
    getAllEvents(200),
    getSessionsSince(WINDOW_DAYS),
    getEventsSince(WINDOW_DAYS),
    getOaths(),
    getPinsForEpisodes(WINDOW_DAYS),
    // The same stretch of the season the sessions cover, as a calendar day
    // rather than an instant: `tales.told_for` is a date and comparing it to a
    // timestamp would be a conversion nobody needs.
    getTales({ sinceDay: daysAgoCtKey(WINDOW_DAYS), limit: 200 }),
  ]);

  const episodes = buildEpisodes(sessions, sagaEvents, oaths, pins, tales);

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
        <StorytellerToggle active="all" />
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
