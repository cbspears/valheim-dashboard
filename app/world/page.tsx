import type { Metadata } from 'next';
import { Map as MapIcon, Milestone, Hammer, Crown, CalendarClock, Check } from 'lucide-react';
import { SectionHeader, Card, CardBody, Badge, EmptyState } from '@/components/ui';
import { BossTimeline } from '@/components/world/BossTimeline';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getRoadmap, getUpcomingEvents } from '@/lib/data';
import { shortDate } from '@/lib/format';
import type { RoadmapItem, RoadmapType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'World' };

const TYPE_META: Record<RoadmapType, { tone: 'gold' | 'frost' | 'neutral' | 'raid'; icon: typeof Crown }> = {
  boss: { tone: 'gold', icon: Crown },
  build: { tone: 'frost', icon: Hammer },
  milestone: { tone: 'neutral', icon: Milestone },
  event: { tone: 'raid', icon: CalendarClock },
};

function typeMeta(type: RoadmapType) {
  return TYPE_META[type] ?? { tone: 'neutral' as const, icon: Milestone };
}

function RoadmapCard({ item }: { item: RoadmapItem }) {
  const { tone, icon: Icon } = typeMeta(item.type);
  const done = item.status === 'completed';
  const active = item.status === 'in_progress';

  return (
    <div
      className={
        'card-surface p-4 ' +
        (active ? 'border-l-2 border-l-gold' : done ? 'bg-surface/50' : '')
      }
    >
      <div className="flex items-start justify-between gap-3">
        <h4
          className={
            'font-display text-base ' +
            (done ? 'text-muted line-through decoration-rune' : 'text-ash')
          }
        >
          {item.title}
        </h4>
        <Badge tone={done ? 'offline' : tone}>
          <Icon size={12} />
          {item.type}
        </Badge>
      </div>

      {item.description && (
        <p className={'mt-2 text-sm ' + (done ? 'text-muted' : 'text-ash-dim')}>
          {item.description}
        </p>
      )}

      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        {done ? (
          <>
            <Check size={12} className="text-online" />
            {item.completed_at ? `Completed ${shortDate(item.completed_at)}` : 'Completed'}
          </>
        ) : item.target_date ? (
          <>
            <CalendarClock size={12} className={active ? 'text-gold' : ''} />
            by {shortDate(item.target_date)}
          </>
        ) : (
          <span className="italic">No set date</span>
        )}
      </div>
    </div>
  );
}

function RoadmapColumn({
  title,
  items,
  accent,
}: {
  title: string;
  items: RoadmapItem[];
  accent: string;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className={'h-2 w-2 rounded-full ' + accent} />
        <h3 className="font-display text-sm uppercase tracking-wide text-ash-dim">{title}</h3>
        <span className="text-xs text-muted">({items.length})</span>
      </div>
      <div className="flex flex-col gap-3">
        {items.length === 0 ? (
          <p className="card-surface px-4 py-6 text-center text-sm text-muted">Nothing here yet.</p>
        ) : (
          items.map((item) => <RoadmapCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}

export default async function WorldPage() {
  const [bosses, roadmap, upcoming] = await Promise.all([
    getBosses(),
    getRoadmap(),
    getUpcomingEvents(10),
  ]);

  const inProgress = roadmap.filter((r) => r.status === 'in_progress');
  const planned = roadmap.filter((r) => r.status === 'planned');
  const completed = roadmap.filter((r) => r.status === 'completed');

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
          subtitle="Game nights, raids, and revelry — straight from the Discord calendar."
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

      <section>
        <SectionHeader
          title="The Road Ahead"
          subtitle="What the clan is building toward."
          icon={<Milestone size={22} />}
        />
        {roadmap.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                icon={<Milestone size={28} />}
                title="The road is uncharted"
                message="No plans have been laid yet. The jarl will mark the way soon."
              />
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <RoadmapColumn title="In Progress" items={inProgress} accent="bg-gold online-pulse" />
            <RoadmapColumn title="Planned" items={planned} accent="bg-frost" />
            <RoadmapColumn title="Completed" items={completed} accent="bg-online" />
          </div>
        )}
      </section>
    </div>
  );
}
