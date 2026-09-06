import type { Metadata } from 'next';
import { Map as MapIcon, CalendarClock, CircleDashed, Swords, Trophy } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { BossTimeline } from '@/components/world/BossTimeline';
import { EarnedDeeds, HorizonDeeds } from '@/components/world/MilestoneLedger';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getUpcomingEvents, getMilestones, getMilestoneAggregates } from '@/lib/data';
import { summarizeMilestones } from '@/lib/milestones';

// SIXTY SECONDS OF ISR, NOT PER-REQUEST (2026-09-06). Nothing on this page is
// live: it is the Forsaken timeline, the Great Deeds ledger and the calendar.
// A boss falling, a deed landing or a gathering being scheduled shows up within
// a minute instead of instantly, and in exchange every viking and every friend
// refreshing this page during launch night shares one render (four Supabase
// reads, one of them four hundred days of sessions) rather than each paying for
// their own. The moment a boss falls is announced in Discord and in game, not
// discovered by staring at this page.
export const revalidate = 60;
export const metadata: Metadata = { title: 'World' };

export default async function WorldPage() {
  const [bosses, upcoming, milestones, milestoneAgg] = await Promise.all([
    getBosses(),
    getUpcomingEvents(20),
    getMilestones(),
    getMilestoneAggregates(),
  ]);

  const milestoneSummary = summarizeMilestones(milestones, milestoneAgg);
  const earnedCount = milestoneSummary.achieved.length;
  const aheadCount = milestoneSummary.upcoming.length;

  // Counts ride in the subtitle rather than in a heading badge: the columns are
  // narrow, and a badge competing with the title for that row wraps the heading.
  //
  // "Deeds still to earn", not "N trackers": a tracker is this codebase's word
  // for a grouped metric, and a reader sees a progress bar. One word per
  // concept, and the one a reader already has.
  const earnedSubtitle =
    'What the warband has done together, tallied across every viking.' +
    (earnedCount > 0 ? ` ${earnedCount} earned so far.` : '');
  const horizonSubtitle =
    'The deeds still ahead, and how near the warband stands to each.' +
    (aheadCount > 0
      ? ` ${aheadCount} ${aheadCount === 1 ? 'deed' : 'deeds'} still to earn.`
      : '');

  return (
    <div className="flex flex-col gap-12">
      <div>
        <PageHeader slot="world">
          <SectionHeader
            as="h1"
            title="World Progress"
            subtitle="Our rule: we clear the bosses in order and nobody moves ahead of the group. No one sails ahead of the longship."
            icon={<MapIcon size={22} />}
          />
        </PageHeader>

        {/* The three ledgers of the world: side by side on a wide screen,
            stacked below it — what has been felled, what has been earned, and
            what is still being worked toward. Each column is its own section
            with its own heading, scannable top to bottom on its own.

            The columns are a two-row subgrid (heading row, content row) so all
            three headings share one row height and the three cards start on the
            same line no matter how many lines a heading happens to wrap to.
            `items-start` keeps each column's content its natural height rather
            than stretching the short ones down to the boss timeline. */}
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-3 lg:grid-rows-[auto_auto] lg:gap-8">
          <section className="min-w-0 lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:items-start">
            <SectionHeader
              title="The Forsaken"
              subtitle="The bosses, in the order they must fall."
              icon={<Swords size={22} />}
            />
            <BossTimeline bosses={bosses} />
          </section>

          <section className="min-w-0 lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:items-start">
            <SectionHeader
              title="Great Deeds earned"
              subtitle={earnedSubtitle}
              icon={<Trophy size={22} />}
            />
            <EarnedDeeds summary={milestoneSummary} />
          </section>

          <section className="min-w-0 lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:items-start">
            <SectionHeader
              title="Great Deeds ahead"
              subtitle={horizonSubtitle}
              icon={<CircleDashed size={22} />}
            />
            <HorizonDeeds summary={milestoneSummary} />
          </section>
        </div>
      </div>

      {/* id: the nav's next-gathering pill links here when the event has no
          Discord link of its own. */}
      <section id="gatherings" className="scroll-mt-20">
        <SectionHeader
          title="Scheduled Gatherings"
          subtitle="Game nights, raids, and revelry. What's on the road ahead."
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
