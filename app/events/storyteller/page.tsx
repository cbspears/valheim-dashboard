import type { Metadata } from 'next';
import { Feather } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { StorytellerToggle } from '@/components/events/StorytellerToggle';
import { StorytellerWork } from '@/components/events/StorytellerWork';
import { getBosses, getPlayerTellings, getTales } from '@/lib/data';
import { storytellerWork } from '@/lib/tales';

// THE SAGA'S SECOND VIEW, AND WHY IT IS A ROUTE RATHER THAN A `?by=`.
//
// Charlie asked for "a way to filter to show just the storyteller's work". The
// obvious shape is /events?by=storyteller, and it was built that way first. It
// cost the Saga its prerender: `searchParams` is a request-time API, so reading
// it on app/events/page.tsx moved that route from `○ (Static)` to
// `ƒ (Dynamic)`, dropped it out of the prerender manifest, and put all six of
// its Supabase reads on every single request (measured on a scratch build,
// 2026-09-06). An address is the whole state this filter has, so it gets its
// own address instead, and both halves of the Saga stay static and edge-served.
//
// Sixty seconds, matching /events: this page is a record of what has already
// been written down.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "The Storyteller's Work",
  description:
    'Every night the Storyteller has set down, and every fall the vikings have told in their own words.',
};

export default async function StorytellerPage() {
  const [tales, tellings, bosses] = await Promise.all([
    // No `sinceDay`: this view is the record of everything anyone has written,
    // and a tale about the founding night should still be in it. It is also the
    // ONLY place a tale about a night nobody played can appear, because an
    // episode is a night with at least one session (lib/episodes.ts).
    getTales({ limit: 200 }),
    getPlayerTellings(60),
    getBosses(),
  ]);
  const entries = storytellerWork(tales, tellings, bosses);

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-6">
        <PageHeader slot="events">
          <SectionHeader
            title="The Storyteller's Work"
            subtitle="Every night set down in a viking's own words, and every fall they have told."
            icon={<Feather size={22} />}
          />
        </PageHeader>
        <StorytellerToggle active="storyteller" />
        <StorytellerWork entries={entries} />
      </section>
    </div>
  );
}
