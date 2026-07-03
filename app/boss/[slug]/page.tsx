import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Users, ScrollText, Camera, Swords, Map as MapIcon, CalendarClock } from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState } from '@/components/ui';
import { BossHero } from '@/components/boss/BossHero';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getGalleryPhotos, getUpcomingEvents } from '@/lib/data';
import { slugify, vikingPath } from '@/lib/slug';

export const dynamic = 'force-dynamic';

// Bosses with a marked altar on the demo atlas — see config/map-demo.generated.ts.
// Hardcoded here since the map's marker set is demo-only content, not queryable data.
const BOSSES_ON_MAP = new Set(['eikthyr', 'the elder']);

async function resolveBoss(slug: string) {
  const bosses = await getBosses();
  return bosses.find((b) => slugify(b.name) === slug) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const boss = await resolveBoss(slug);
  return { title: boss ? boss.name : 'Unknown Forsaken' };
}

export default async function BossPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const boss = await resolveBoss(slug);
  if (!boss) notFound();

  if (boss.is_killed) {
    const photos = await getGalleryPhotos();
    const nameLower = boss.name.toLowerCase();
    const depiction = photos.find((p) => p.caption?.toLowerCase().includes(nameLower)) ?? null;
    const onMap = BOSSES_ON_MAP.has(nameLower);

    return (
      <div className="flex flex-col gap-8">
        <BossHero boss={boss} />

        {/* The Circle */}
        <Card>
          <CardHeader title="The Circle" icon={<Users size={16} />} />
          <CardBody>
            {boss.players_present.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {boss.players_present.map((name) => (
                  <Link
                    key={name}
                    href={vikingPath(name)}
                    className="gold-ring rounded-full border border-rune bg-surface-raised px-3 py-1 text-sm text-ash-dim transition-colors hover:border-gold-dim hover:text-gold-light"
                  >
                    {name}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No war party recorded for this fight.</p>
            )}
          </CardBody>
        </Card>

        {/* The Retelling */}
        <Card>
          <CardHeader title="The Retelling" icon={<ScrollText size={16} />} />
          <CardBody>
            {boss.notes ? (
              <p className="text-sm italic leading-relaxed text-ash-dim">{boss.notes}</p>
            ) : (
              <p className="text-sm text-muted">
                The Skald has not yet set this battle to words.
              </p>
            )}
          </CardBody>
        </Card>

        {/* The Depiction */}
        <Card>
          <CardHeader title="The Depiction" icon={<Camera size={16} />} />
          {depiction ? (
            <CardBody>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={depiction.url}
                alt={depiction.caption ?? boss.name}
                className="w-full rounded-[var(--radius-card)] border border-rune object-cover"
              />
              {depiction.posted_by && (
                <p className="mt-2 text-xs text-muted">Posted by {depiction.posted_by}</p>
              )}
            </CardBody>
          ) : (
            <EmptyState
              icon={<Camera size={28} />}
              title="No depiction yet"
              message="No depiction yet — post one in Discord and name the beast."
            />
          )}
        </Card>

        {/* Combat records — arrives post-launch via the stats pipeline */}
        <Card className="bg-surface/60">
          <CardHeader title="The Full Record" icon={<Swords size={16} />} />
          <CardBody>
            <p className="text-sm text-muted">
              First blood, hardest blows, the fight&apos;s full record — the runes await the
              launch.
            </p>
          </CardBody>
        </Card>

        {onMap && (
          <Link
            href="/map"
            className="gold-ring inline-flex w-fit items-center gap-2 text-sm text-gold-dim transition-colors hover:text-gold-light"
          >
            <MapIcon size={14} />
            The altar is marked on the atlas &mdash; view the map
          </Link>
        )}
      </div>
    );
  }

  // ── AWAITING ────────────────────────────────────────────────────────
  const upcoming = await getUpcomingEvents(20);
  const nameLower = boss.name.toLowerCase();
  const bossNight = upcoming.filter((e) => e.name.toLowerCase().includes(nameLower));

  return (
    <div className="flex flex-col gap-8">
      <BossHero boss={boss} />

      <Card className="bg-surface/60">
        <CardBody>
          <p className="font-display text-lg text-ash-dim">The altar awaits.</p>
          <p className="mt-1 text-sm text-muted">
            No clan has yet stood before {boss.name} in the {boss.biome}. Its cairn is unbuilt,
            its tale unwritten.
          </p>
        </CardBody>
      </Card>

      {bossNight.length > 0 && (
        <Card>
          <CardHeader title="Boss Night" icon={<CalendarClock size={16} />} />
          <CardBody className="p-0">
            <UpcomingEvents events={bossNight} detailed />
          </CardBody>
        </Card>
      )}

      <Card className="bg-surface/60">
        <CardBody>
          <p className="text-sm text-muted">
            The Seers&apos; ledger opens when the horn sounds.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
