import type { Metadata } from 'next';
import { Map, Camera, Landmark, History } from 'lucide-react';
import { SectionHeader, Card, CardBody, Badge, EmptyState } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { LiveWorld } from '@/components/map/LiveWorld';
// NOTE: the demo timelapse (`components/map/MapTimelapse`) + its fixtures
// (`config/map-demo.generated.ts`, `public/map-demo/`) are intentionally NOT
// rendered here anymore — the real live world + real replay + real /pin markers
// are the whole story now. The demo files are kept on disk as the launch-day
// reference (and as the model for this page's look), just no longer imported.
import { SERVER_NAME } from '@/config/server';
import { getLiveMap, getPins, getPhotosByPin } from '@/lib/data';

/**
 * The two lines the live section shows when the composite has stopped
 * refreshing (older than MAP_STALE_AFTER_MS, or with no readable timestamp).
 * The last image stays on screen, dimmed, and the replay scrubber keeps working
 * from the archived day frames — only the "this is live" claim is withdrawn.
 */
const MAP_PAUSED_LINE =
  "The map feed is paused; it resumes on its own when the server's map plugin is back.";

/** "Sep 3, 7:12 PM" in Central. The site dates everything in CT; Vercel renders in UTC. */
function chartedAtCT(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export const metadata: Metadata = {
  title: 'Map',
  description: `The known world of ${SERVER_NAME}: only what the warband has charted.`,
};

// the live snapshot check must run per-request
export const dynamic = 'force-dynamic';

export default async function MapPage() {
  const [liveMap, pins, photosByPin] = await Promise.all([
    getLiveMap(),
    getPins(),
    getPhotosByPin(),
  ]);

  return (
    <div>
      <PageHeader slot="map">
        <SectionHeader
          title="The Known World"
          icon={<Map size={22} />}
          action={
            liveMap ? (
              liveMap.stale ? (
                <Badge tone="gold">Map paused</Badge>
              ) : (
                <Badge tone="online">Live</Badge>
              )
            ) : null
          }
        />
      </PageHeader>

      {/* How to take part — the two explainers, above the map so nobody misses them */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* How to pin — the naming of places */}
        <Card className="h-full border-l-2 border-l-gold">
          <CardBody>
            <div className="mb-3 flex items-center gap-2">
              <Landmark size={18} className="text-gold" />
              <h2 className="font-display text-base tracking-wide text-ash">Name a place</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-3 md:grid-cols-1">
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                  1
                </span>
                <p className="text-sm leading-relaxed text-ash-dim">
                  Stand at the spot in-game. The pin lands exactly where you are.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                  2
                </span>
                <p className="text-sm leading-relaxed text-ash-dim">
                  <span className="font-semibold text-ash">Shout</span> it in chat, leading with{' '}
                  <span className="font-mono text-xs text-ash">/s</span>:{' '}
                  <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                    /s /pin The Dark Chapel
                  </span>{' '}
                  or{' '}
                  <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                    /s /pin base Odinshold
                  </span>{' '}
                  if it&apos;s a settlement. A plain chat line never leaves the campfire.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-sm text-gold-light">
                  3
                </span>
                <p className="text-sm leading-relaxed text-ash-dim">
                  That&apos;s it. Your pin joins the atlas at the next map update, and the Saga
                  remembers who named it.
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">
              Notable places only, vikings: homes and discoveries, not wood piles. The Cartographer
              keeps the map honest. Boss altars and traders chart themselves when found, so no pin
              is needed.
            </p>
          </CardBody>
        </Card>

        {/* How to add photos to a place */}
        <Card className="h-full border-l-2 border-l-gold">
          <CardBody>
            <div className="mb-3 flex items-center gap-2">
              <Camera size={18} className="text-gold" />
              <h2 className="font-display text-base tracking-wide text-ash">
                Add photos to a place
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-ash-dim">
              Post a screenshot in Discord, tag the bot, and{' '}
              <span className="font-semibold text-ash">name the place in your caption</span>, e.g.{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                @Eilif sunset at Draugheim
              </span>
              . The photo lands in the{' '}
              <span className="text-ash">Gallery</span> and on{' '}
              <span className="text-ash">Draugheim&apos;s marker</span> here. Click any marker to
              see its album. Pin first or photo first, either order works: a photo naming a place
              that isn&apos;t pinned yet attaches itself the moment the pin appears.
            </p>
          </CardBody>
        </Card>
      </div>

      {/* The LIVE known world — fed by the real server (fog-masked before upload),
          with the real per-in-game-day replay scrubber and real /pin markers. */}
      {liveMap ? (
        <Card glow={!liveMap.stale} className="mx-auto mb-8 max-w-3xl">
          <CardBody>
            <LiveWorld
              currentUrl={liveMap.url}
              updatedLabel={liveMap.updatedAt}
              frames={liveMap.frames}
              pins={pins}
              photosByPin={photosByPin}
              stale={liveMap.stale}
            />
            {liveMap.stale ? (
              <>
                <p className="mt-3 text-center text-sm leading-relaxed text-gold-light">
                  {chartedAtCT(liveMap.updatedAt)
                    ? `Last charted ${chartedAtCT(liveMap.updatedAt)} CT. `
                    : ''}
                  {MAP_PAUSED_LINE}
                </p>
                <p className="mt-1.5 text-center text-xs text-muted">
                  What you see is the last chart the warband sent home.
                  {liveMap.frames.length >= 2
                    ? ' The season replay above still walks every archived day.'
                    : ''}
                </p>
              </>
            ) : (
              <p className="mt-3 text-center text-xs text-muted">
                The real {SERVER_NAME} world, exactly as far as the warband has walked and sailed
                it, refreshed from the server every 5 minutes
                {chartedAtCT(liveMap.updatedAt) ? ` · last charted ${chartedAtCT(liveMap.updatedAt)} CT` : ''}.
                The unexplored dark is real: nobody has been there yet.
              </p>
            )}
          </CardBody>
        </Card>
      ) : (
        <Card className="mx-auto mb-8 max-w-3xl">
          <CardBody>
            <EmptyState
              icon={<Map size={28} />}
              title="The map charts itself once the warband sails"
              message={`As soon as the ${SERVER_NAME} server is live, its fog-masked world lands here. Terrain appears only where vikings have actually walked or sailed, a snapshot is archived every in-game day for the season replay, and every /pin becomes a marker.`}
            />
          </CardBody>
        </Card>
      )}

      <div className="mx-auto mt-6 max-w-3xl">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <History size={14} className="mt-0.5 shrink-0 text-gold-dim" />
          <span>
            How it works: the server tracks everywhere the warband has been and renders the charted
            world; the dashboard pulls a fresh masked snapshot every 5 minutes and archives one
            frame per in-game day. Watching the light spread across the dark is the story of the
            season, and press play above to replay it. The finale gets the full replay.
          </span>
        </p>
      </div>
    </div>
  );
}
