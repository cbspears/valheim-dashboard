import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Users,
  ScrollText,
  Camera,
  Swords,
  Map as MapIcon,
  CalendarClock,
  Clock,
  Droplet,
  Flame,
} from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState, StatTile, VikingLink } from '@/components/ui';
import { BossHero } from '@/components/boss/BossHero';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import { getBosses, getGalleryPhotos, getUpcomingEvents, getAllPlayers } from '@/lib/data';
import { slugify, vikingPath, matchVikingName, resolvePhotoViking } from '@/lib/slug';

export const dynamic = 'force-dynamic';

// Bosses with a marked altar on the demo atlas — see config/map-demo.generated.ts.
// Hardcoded here since the map's marker set is demo-only content, not queryable data.
const BOSSES_ON_MAP = new Set(['eikthyr', 'the elder']);

/** 82 → "1m 22s", 45 → "45s", 3600 → "1h 0m". Guards non-finite input. */
function formatFightLength(sec: number): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

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
    const [photos, roster] = await Promise.all([getGalleryPhotos(), getAllPlayers()]);
    const nameLower = boss.name.toLowerCase();
    const depiction = photos.find((p) => p.caption?.toLowerCase().includes(nameLower)) ?? null;
    // Prefer the explicit Discord↔character link, then loose name matching.
    const depictionPoster = resolvePhotoViking(depiction, roster);
    const onMap = BOSSES_ON_MAP.has(nameLower);

    return (
      <div className="flex flex-col gap-8">
        <BossHero boss={boss} />

        {/* The Circle — the TRUE war party (those who actually fought). Prefer the
            honest fighter set; fall back to players_present for rows recorded
            before fighters were captured. Anyone who was online but didn't swing
            is noted in a muted line so the record stays honest without inflating
            the war-party. */}
        {(() => {
          const fs = boss.fight_stats;
          const fighters =
            fs?.fighters && fs.fighters.length > 0 ? fs.fighters : boss.players_present;
          const fighterSet = new Set(fighters.map((n) => n.toLowerCase()));
          const alsoInRealm = (fs?.onlineAtKill ?? []).filter(
            (n) => !fighterSet.has(n.toLowerCase()),
          );

          return (
            <Card>
              <CardHeader title="The War Party" icon={<Users size={16} />} />
              <CardBody>
                {fighters.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {fighters.map((name) => (
                        <Link
                          key={name}
                          href={vikingPath(name)}
                          className="gold-ring rounded-full border border-rune bg-surface-raised px-3 py-1 text-sm text-ash-dim transition-colors hover:border-gold-dim hover:text-gold-light"
                        >
                          {name}
                        </Link>
                      ))}
                    </div>
                    {alsoInRealm.length > 0 && (
                      <p className="mt-3 text-xs text-muted">
                        Also in the realm: {alsoInRealm.join(', ')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted">No war party recorded for this fight.</p>
                )}
              </CardBody>
            </Card>
          );
        })()}

        {/* The Retelling */}
        <Card>
          <CardHeader title="The Skald's Retelling" icon={<ScrollText size={16} />} />
          <CardBody>
            {boss.retelling?.trim() ? (
              <figure>
                <p className="text-sm italic leading-relaxed text-ash-dim">
                  {boss.retelling.trim()}
                </p>
                <figcaption className="mt-3 text-xs uppercase tracking-wider text-gold-dim">
                  — the Skald
                </figcaption>
              </figure>
            ) : boss.notes ? (
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
          <CardHeader title="Screenshots" icon={<Camera size={16} />} />
          {depiction ? (
            <CardBody>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={depiction.url}
                alt={depiction.caption ?? boss.name}
                className="w-full rounded-[var(--radius-card)] border border-rune object-cover"
              />
              {depiction.posted_by && (
                <p className="mt-2 text-xs text-muted">
                  Posted by{' '}
                  <VikingLink
                    name={depictionPoster}
                    className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                  >
                    {depiction.posted_by}
                  </VikingLink>
                </p>
              )}
            </CardBody>
          ) : (
            <EmptyState
              icon={<Camera size={28} />}
              title="No screenshots yet"
              message="No depiction yet — post one in Discord and name the beast."
            />
          )}
        </Card>

        {/* The Full Record — real fight detail from bosses.fight_stats. */}
        {(() => {
          const fs = boss.fight_stats;
          const length =
            fs && typeof fs.fightSec === 'number' ? formatFightLength(fs.fightSec) : null;
          const firstBlood = fs?.firstBlood?.trim() || null;
          const topPlayer = fs?.topDamagePlayer?.trim() || null;
          const topDamage =
            fs && typeof fs.topDamage === 'number' && Number.isFinite(fs.topDamage)
              ? Math.round(fs.topDamage)
              : null;
          const warriors =
            fs && typeof fs.participants === 'number' && fs.participants > 0
              ? fs.participants
              : boss.players_present.length || null;
          const hasRecord = Boolean(length || firstBlood || topPlayer || topDamage || warriors);

          return (
            <Card className={hasRecord ? undefined : 'bg-surface/60'}>
              <CardHeader title="Fight Record" icon={<Swords size={16} />} />
              <CardBody>
                {hasRecord ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {length && (
                      <StatTile label="Fight length" value={length} icon={<Clock size={14} />} />
                    )}
                    {firstBlood && (
                      <StatTile
                        label="First blood"
                        icon={<Droplet size={14} />}
                        value={
                          <VikingLink name={matchVikingName(firstBlood, roster)}>
                            {firstBlood}
                          </VikingLink>
                        }
                      />
                    )}
                    {topPlayer && (
                      <StatTile
                        label="Top damage"
                        icon={<Flame size={14} />}
                        value={
                          <VikingLink name={matchVikingName(topPlayer, roster)}>
                            {topPlayer}
                          </VikingLink>
                        }
                        hint={topDamage != null ? `${topDamage.toLocaleString()} damage` : undefined}
                      />
                    )}
                    {warriors && (
                      <StatTile
                        label="Fighters"
                        value={warriors}
                        icon={<Users size={14} />}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted">
                    First blood, hardest blows, the fight&apos;s full record — no runes were carved
                    for this fall.
                  </p>
                )}
              </CardBody>
            </Card>
          );
        })()}

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
