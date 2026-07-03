import type { Metadata } from 'next';
import { Map, Compass, CalendarDays, Landmark, EyeOff, History } from 'lucide-react';
import { SectionHeader, Card, CardBody, StatTile, Badge } from '@/components/ui';
import { MapTimelapse } from '@/components/map/MapTimelapse';
import {
  MAP_DEMO_DAYS,
  MAP_DEMO_LABELS,
  MAP_DEMO_REVEALED_PCT,
} from '@/config/map-demo.generated';
import { SERVER_NAME } from '@/config/server';

export const metadata: Metadata = {
  title: 'Map',
  description: `The known world of ${SERVER_NAME} — only what the warband has charted.`,
};

export default function MapPage() {
  return (
    <div>
      <SectionHeader
        title="The Known World"
        subtitle="Only what the warband has charted. The rest of the world keeps its secrets."
        icon={<Map size={22} />}
        action={<Badge tone="gold">Demo</Badge>}
      />

      {/* How to pin — the naming of places */}
      <Card className="mb-6 border-l-2 border-l-gold">
        <CardBody>
          <div className="mb-3 flex items-center gap-2">
            <Landmark size={18} className="text-gold" />
            <h2 className="font-display text-base tracking-wide text-ash">Name a place</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                1
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                Stand at the spot in-game — the pin lands exactly where you are.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                2
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                Type in chat:{' '}
                <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                  /pin base Odinshold
                </span>{' '}
                for a settlement, or{' '}
                <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                  /pin poi The Dark Chapel
                </span>{' '}
                for a landmark.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                3
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                The Cartographer blesses it in Discord — approved names join the atlas, and the
                Saga, forever.
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            Notable places only, vikings — homes and discoveries, not wood piles. The Cartographer
            keeps the map honest.
          </p>
        </CardBody>
      </Card>

      {/* Demo explainer */}
      <Card className="mb-6 border-l-2 border-l-gold">
        <CardBody>
          <p className="text-sm leading-relaxed text-ash-dim">
            <EyeOff size={14} className="mr-1.5 inline align-text-bottom text-gold-dim" />
            This is a <span className="font-semibold text-ash">demo</span> — a simulated world
            with {MAP_DEMO_DAYS} simulated days of exploration. At launch it becomes the real{' '}
            {SERVER_NAME} world, refreshed from the server itself: terrain appears only where
            vikings have actually walked or sailed, and unexplored lands stay hidden — the full
            map never leaves the server. A snapshot is archived every day from Day 1, so the
            timelapse below will replay the entire saga.
          </p>
        </CardBody>
      </Card>

      {/* Season at a glance */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Days charted"
          value={MAP_DEMO_DAYS}
          icon={<CalendarDays size={15} />}
          hint="One snapshot per day, from launch night on"
        />
        <StatTile
          label="World revealed"
          value={`${MAP_DEMO_REVEALED_PCT}%`}
          icon={<Compass size={15} />}
          hint="Charted by walking and sailing it"
        />
        <StatTile
          label="Named places"
          value={MAP_DEMO_LABELS.length}
          icon={<Landmark size={15} />}
          hint="Naming a place writes it into the atlas"
        />
      </div>

      {/* The atlas + timelapse */}
      <Card glow className="mx-auto max-w-3xl">
        <CardBody>
          <MapTimelapse />
        </CardBody>
      </Card>

      <div className="mx-auto mt-6 max-w-3xl">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <History size={14} className="mt-0.5 shrink-0 text-gold-dim" />
          <span>
            How it works at launch: the server tracks everywhere the warband has been and renders
            the charted world; the dashboard pulls a fresh masked snapshot every half hour and
            archives one frame per day. Watching the light spread across the dark is the story of
            the season — and the finale gets the full replay.
          </span>
        </p>
      </div>
    </div>
  );
}
