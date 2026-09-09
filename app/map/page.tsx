import type { Metadata } from 'next';
import Link from 'next/link';
import { Map, Camera, Landmark, History } from 'lucide-react';
import { SectionHeader, Card, CardBody, Badge, EmptyState } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { LiveWorld } from '@/components/map/LiveWorld';
// NOTE: the demo timelapse (`components/map/MapTimelapse`) + its fixtures
// (`config/map-demo.generated.ts`, `public/map-demo/`) are intentionally NOT
// rendered here anymore — the real live world + real replay + real /pin markers
// are the whole story now. The demo files are kept on disk as the launch-day
// reference (and as the model for this page's look), just no longer imported.
import { SERVER_NAME, MAP_ENABLED } from '@/config/server';
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

// SIXTY SECONDS OF ISR, AND WHAT THAT ACTUALLY COSTS (2026-09-06). The
// composite this page shows is itself only redrawn every five minutes by
// eilif-map-snapshot, and the staleness badge trips at six hours
// (MAP_STALE_AFTER_MS), so a per-request render was re-reading three storage
// objects and two tables to show the same picture. One render a minute now
// serves everybody.
//
// Be honest about the staleness: 60 s is the FLOOR, not the ceiling, and it is
// not only the caption. ISR is stale-while-revalidate — the first request after
// the window expires is served the OLD render and only triggers the new one, so
// on a quiet route the staleness is bounded by the gap between visitors rather
// than by the window. And LiveWorld builds the composite's `src` as
// `current.webp?t=<liveMap.updatedAt>`, so the freshness value doubles as the
// image cache-buster: a frozen render pins the picture too, not just the "last
// charted" line under it. Busy nights are unaffected; the quiet hours and the
// first look after a world wipe are the cases to know about — see the ISR note
// at the top of lib/data.ts for the launch-morning consequence.
export const revalidate = 60;

export default async function MapPage() {
  const [liveMap, pins, photosByPin] = await Promise.all([
    getLiveMap(),
    getPins(),
    getPhotosByPin(),
  ]);

  // The scrubber under the map only exists once two in-game days are archived
  // (LiveWorld `replayReady`). On a freshly wiped world there is nothing to
  // press, so the footnote must not tell anyone to press play.
  const replayReady = (liveMap?.frames.length ?? 0) >= 2;

  return (
    <div>
      <PageHeader slot="map">
        <SectionHeader
          as="h1"
          title="The Known World"
          subtitle={
            MAP_ENABLED
              ? 'Only the ground the warband has actually walked or sailed. Redrawn from the server every 5 minutes.'
              : 'The atlas is paused while the map mod is rebuilt for Valheim 1.0. Nothing new is charted until it returns.'
          }
          icon={<Map size={22} />}
          action={
            !MAP_ENABLED ? (
              <Badge tone="gold">Map paused</Badge>
            ) : liveMap ? (
              liveMap.stale ? (
                <Badge tone="gold">Map paused</Badge>
              ) : (
                <Badge tone="online">Live</Badge>
              )
            ) : null
          }
        />
      </PageHeader>

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
              action={
                <Link
                  href="/get-started"
                  className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
                >
                  Get Started
                </Link>
              }
            />
          </CardBody>
        </Card>
      )}

      <div className="mx-auto mt-6 max-w-3xl">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <History size={14} className="mt-0.5 shrink-0 text-gold" />
          <span>
            How it works: the server tracks everywhere the warband has been and renders the charted
            world; the dashboard pulls a fresh masked snapshot every 5 minutes and archives one
            frame per in-game day. Watching the light spread across the dark is the story of the
            season.{' '}
            {replayReady
              ? 'Press play above to replay it.'
              : 'The replay opens as soon as a second in-game day is archived.'}
          </span>
        </p>
      </div>

      {/* HOW TO TAKE PART, BELOW THE MAP AND FOLDED SHUT. It used to stand
          above it: two cards teaching a newcomer to contribute to an artefact
          they had not seen yet, which pushed the atlas itself to roughly y=741
          on a desktop and below three screens on a phone. The map is the figure
          on this page; this is the ground. */}
      <details className="mx-auto mt-8 max-w-3xl">
        <summary className="gold-ring cursor-pointer rounded-md border border-rune bg-surface-raised px-4 py-3 font-display text-sm text-ash transition-colors hover:border-gold-dim hover:text-gold-light">
          Put your own places and photos on this map
        </summary>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
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
                    That&apos;s it. Your pin joins the atlas at the next map update, and the story
                    remembers who named it.
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                Notable places only, vikings: homes and discoveries, not wood piles. Boss altars and
                traders chart themselves when found, so no pin is needed.
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
                  @Eilif sunset at Odinshold
                </span>
                . The photo lands in the{' '}
                <span className="text-ash">Gallery</span> and on{' '}
                <span className="text-ash">Odinshold&apos;s marker</span>{' '}here. Click any marker to
                see its album. Pin first or photo first, either order works: a photo naming a place
                that isn&apos;t pinned yet attaches itself the moment the pin appears.
              </p>
            </CardBody>
          </Card>
        </div>
      </details>
    </div>
  );
}
