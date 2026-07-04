import type { Metadata } from 'next';
import { Map, Camera, Compass, CalendarDays, Landmark, EyeOff, History } from 'lucide-react';
import { SectionHeader, Card, CardBody, StatTile, Badge } from '@/components/ui';
import { MapTimelapse } from '@/components/map/MapTimelapse';
import { LiveWorld } from '@/components/map/LiveWorld';
import {
  MAP_DEMO_DAYS,
  MAP_DEMO_LABELS,
  MAP_DEMO_REVEALED_BY_DAY,
  MAP_DEMO_REVEALED_PCT,
} from '@/config/map-demo.generated';
import { SERVER_NAME } from '@/config/server';
import { getLiveMap, getPins } from '@/lib/data';

export const metadata: Metadata = {
  title: 'Map',
  description: `The known world of ${SERVER_NAME} — only what the warband has charted.`,
};

// the live snapshot check must run per-request
export const dynamic = 'force-dynamic';

export default async function MapPage() {
  const [liveMap, pins] = await Promise.all([getLiveMap(), getPins()]);
  // how much fresh ground the warband charted in the last seven days
  const byDay = MAP_DEMO_REVEALED_BY_DAY;
  const weeklyGrowth = byDay.length > 7 ? byDay[byDay.length - 1] - byDay[byDay.length - 8] : 0;
  const weeklyHint =
    weeklyGrowth > 0
      ? `+${weeklyGrowth.toFixed(1)}% charted this past week`
      : 'Charted by walking and sailing it';

  return (
    <div>
      <SectionHeader
        title="The Known World"
        subtitle="Only what the warband has charted. The rest of the world keeps its secrets."
        icon={<Map size={22} />}
        action={liveMap ? <Badge tone="online">Live</Badge> : <Badge tone="gold">Demo</Badge>}
      />

      {/* The LIVE known world — fed by the real server (fog-masked before upload) */}
      {liveMap && (
        <Card glow className="mx-auto mb-8 max-w-3xl">
          <CardBody>
            <LiveWorld
              currentUrl={liveMap.url}
              updatedLabel={liveMap.updatedAt}
              frames={liveMap.frames}
              pins={pins}
            />
            <p className="mt-3 text-center text-xs text-muted">
              The real {SERVER_NAME} world, exactly as far as the warband has walked and sailed it —
              refreshed from the server every ~10 minutes
              {liveMap.updatedAt ? ` · last charted ${new Date(liveMap.updatedAt).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT` : ''}.
              The unexplored dark is real: nobody has been there yet.
            </p>
          </CardBody>
        </Card>
      )}

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
                  /pin The Dark Chapel
                </span>{' '}
                — or{' '}
                <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                  /pin base Odinshold
                </span>{' '}
                if it&apos;s a settlement.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                3
              </span>
              <p className="text-sm leading-relaxed text-ash-dim">
                That&apos;s it — your pin joins the atlas at the next map update, and the Saga
                remembers who named it.
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            Notable places only, vikings — homes and discoveries, not wood piles. The Cartographer
            keeps the map honest. Boss altars and traders chart themselves when found — no pin
            needed.
          </p>
        </CardBody>
      </Card>

      {/* How to add photos to a place */}
      <Card className="mb-6 border-l-2 border-l-gold">
        <CardBody>
          <div className="mb-3 flex items-center gap-2">
            <Camera size={18} className="text-gold" />
            <h2 className="font-display text-base tracking-wide text-ash">
              Add photos to a place
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-ash-dim">
            Post a screenshot in Discord, tag the bot, and{' '}
            <span className="font-semibold text-ash">name the place in your caption</span> — e.g.{' '}
            <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
              @Eilif sunset at Draugheim
            </span>
            . The photo lands in the{' '}
            <span className="text-ash">Gallery</span> and on{' '}
            <span className="text-ash">Draugheim&apos;s marker</span> here — click any marker to
            see its album. Pin first or photo first, either order works: a photo naming a place
            that isn&apos;t pinned yet attaches itself the moment the pin appears.
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
          hint={weeklyHint}
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
