import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Users,
  Camera,
  Swords,
  Map as MapIcon,
  CalendarClock,
  Clock,
  Droplet,
  Flame,
  Moon,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState, StatTile, VikingLink } from '@/components/ui';
import { BossHero } from '@/components/boss/BossHero';
import { BossTellings } from '@/components/boss/BossTellings';
import { BossPortrait } from '@/components/art/BossPortrait';
import { ART_ENABLED } from '@/config/art';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import {
  getBosses,
  getBossTellings,
  getGalleryPhotos,
  getUpcomingEvents,
  getAllPlayers,
  getOffices,
  getPins,
} from '@/lib/data';
import { findAltarPin } from '@/components/boss/altar';
import { slugify, bossPath, vikingPath, matchVikingName, resolvePhotoViking } from '@/lib/slug';
import { currentHolder, currentOffice } from '@/components/viking/office';
import type { Boss } from '@/lib/types';

// SIXTY SECONDS OF ISR (2026-09-06). A Forsaken's page changes on exactly two
// events: the kill that flips it, and a photo or a boss night being added. Both
// reach the page within the minute, and the eight of them stop re-reading the
// roster and the gallery on every view.
export const revalidate = 60;

/**
 * The eight Forsaken, by slug. Without this a dynamic segment is rendered fresh
 * on EVERY request no matter what `revalidate` says — measured on the scratch
 * build: three Supabase reads per view, three again on the next view. With it
 * the eight pages are built once and refreshed on the 60 s window above.
 *
 * `dynamicParams` stays at its default (true), so a ninth Forsaken added to the
 * table after a deploy still renders on demand rather than 404ing, and a
 * database that is unreachable at build time yields an empty list and exactly
 * today's behaviour rather than a failed build.
 */
export async function generateStaticParams() {
  const bosses = await getBosses();
  return bosses.map((b) => ({ slug: slugify(b.name) }));
}

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

/**
 * The boss AND its neighbours in the chain. A war room used to be an island:
 * no breadcrumb, no way back to the timeline, and nothing saying where in the
 * eight this one sits, while /viking/[slug] has had breadcrumbs all along.
 */
async function resolveBossInChain(slug: string) {
  const bosses = await getBosses();
  const index = bosses.findIndex((b) => slugify(b.name) === slug);
  if (index < 0) return null;
  const previous = index > 0 ? bosses[index - 1] : null;
  return {
    boss: bosses[index],
    index,
    total: bosses.length,
    previous,
    next: index < bosses.length - 1 ? bosses[index + 1] : null,
    // What is actually standing in the way, which is NOT the same thing as the
    // previous link. On /boss/the-elder the previous boss is Eikthyr, who is
    // already felled, so "after Eikthyr falls" would tell a launch-night reader
    // that a dead boss still has to die — and contradict /world, which sends
    // them here from "Current objective: The Elder".
    blocker: previous && !previous.is_killed ? previous : null,
    // Every boss before this one is down, so this one is the next fight. Only
    // claimed when it is true of the whole chain, not just the neighbour.
    isNext: bosses.slice(0, index).every((b) => b.is_killed),
  };
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
  const chain = await resolveBossInChain(slug);
  if (!chain) notFound();
  const { boss, index, total, previous, next, blocker, isNext } = chain;

  if (boss.is_killed) {
    const [photos, roster, tellings, offices, pins] = await Promise.all([
      getGalleryPhotos(),
      getAllPlayers(),
      // The tellings of this fall: the Skald's, and any a viking has told with
      // `@Eilif retell <Boss>: <text>`. Empty before
      // db/2026-09-06_boss_tellings.sql is applied, which is exactly the case
      // BossTellings falls back to `boss.retelling` for.
      getBossTellings(boss.id),
      // The roll of hall offices (db/2026-09-06_offices.sql). Empty before that
      // migration, and empty while the office is vacant, which is the same
      // page either way: no Storyteller line, and the untold clock runs from
      // the kill instead of from a term.
      getOffices(),
      // The atlas, for the altar link below. /api/gs-ingest charts a pin of kind
      // 'boss' named "<Boss> altar" where the war party stood when this one
      // fell, so the link is driven by whether that pin EXISTS rather than by a
      // list somebody typed. Same cached read /map and /viking already do.
      getPins(),
    ]);
    const nameLower = boss.name.toLowerCase();
    const depiction = photos.find((p) => p.caption?.toLowerCase().includes(nameLower)) ?? null;
    // Prefer the explicit Discord↔character link, then loose name matching.
    const depictionPoster = resolvePhotoViking(depiction, roster);
    const altarPin = findAltarPin(pins, boss.name);

    return (
      <div className="flex flex-col gap-8">
        <BossBreadcrumb />

        {ART_ENABLED ? (
          <div className="flex flex-col gap-5 sm:flex-row sm:items-stretch">
            <div className="mx-auto w-32 shrink-0 sm:mx-0 sm:w-44">
              <BossPortrait name={boss.name} status="defeated" />
            </div>
            <div className="min-w-0 flex-1">
              <BossHero boss={boss} index={index} total={total} />
            </div>
          </div>
        ) : (
          <BossHero boss={boss} index={index} total={total} />
        )}

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

        {/* The Retelling: the chosen telling, with the rest folded underneath. */}
        <BossTellings
          tellings={tellings}
          fallback={boss.retelling ?? null}
          notes={boss.notes}
          storyteller={currentHolder(offices)}
          killedAt={boss.killed_at}
          // Empty on every hall that has not run db/2026-09-06_offices.sql and
          // opened a term, which is what keeps the untold line off a war room
          // whose Storyteller has not shipped.
          officeKnown={offices.length > 0}
          officeSince={currentOffice(offices)?.since ?? null}
        />

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
                    className="prose-link gold-ring rounded-sm transition-colors hover:text-gold-light"
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
              message="No depiction yet. Post one in Discord, tag Eilif and name the beast in the caption."
              action={
                <Link
                  href="/gallery"
                  className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
                >
                  The gallery
                </Link>
              }
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
                    First blood, hardest blows, the fight&apos;s full record: no runes were carved
                    for this fall.
                  </p>
                )}
              </CardBody>
            </Card>
          );
        })()}

        {/* Only when the altar is really charted. A boss that fell with nobody's
            position fresh enough to place gets no pin and no link, which is the
            honest page: there is nothing on the atlas to go and look at. */}
        {altarPin && (
          <Link
            href="/map"
            className="gold-ring inline-flex w-fit items-center gap-2 text-sm text-gold-light transition-colors hover:text-gold"
          >
            <MapIcon size={14} />
            The altar is marked on the atlas. View the map
          </Link>
        )}

        <BossFooterNav previous={previous} next={next} />
      </div>
    );
  }

  // ── AWAITING ────────────────────────────────────────────────────────
  const upcoming = await getUpcomingEvents(20);
  const nameLower = boss.name.toLowerCase();
  const bossNight = upcoming.filter((e) => e.name.toLowerCase().includes(nameLower));

  return (
    <div className="flex flex-col gap-8">
      <BossBreadcrumb />

      {ART_ENABLED ? (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-stretch">
          <div className="mx-auto w-32 shrink-0 sm:mx-0 sm:w-44">
            <BossPortrait name={boss.name} status="locked" />
          </div>
          <div className="min-w-0 flex-1">
            <BossHero boss={boss} index={index} total={total} />
          </div>
        </div>
      ) : (
        <BossHero boss={boss} index={index} total={total} />
      )}

      {/* ONE CARD, NOT THREE. An unfought war room used to say the same fact
          three times over: the eyebrow, the status chip, a card reading "The
          altar awaits." and a second card holding nothing but the Seers' line.
          The Seers appear nowhere else on this site, so they are gone; what is
          left is the thing a reader actually wants, which is where this one
          sits in the chain. */}
      <Card className="bg-surface/60">
        <CardHeader title="What we know" icon={<Moon size={16} />} />
        <CardBody>
          <p className="text-sm leading-relaxed text-ash-dim">
            Nobody has fought {boss.name} yet. It waits in the {boss.biome}
            {blocker ? (
              <>
                , after{' '}
                <Link
                  href={bossPath(blocker.name)}
                  className="gold-ring rounded-sm text-gold-light prose-link transition-colors"
                >
                  {blocker.name}
                </Link>{' '}
                falls
              </>
            ) : isNext ? (
              <>, and it is next</>
            ) : null}
            .
          </p>
          <p className="mt-2 text-sm text-muted">
            Its cairn is unbuilt, its tale unwritten.
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

      <BossFooterNav previous={previous} next={next} />
    </div>
  );
}

/** The way back up, matching the pattern /viking/[slug] has had all along. */
function BossBreadcrumb() {
  return (
    <Link
      href="/world"
      className="gold-ring inline-flex w-fit items-center gap-1 text-xs text-muted transition-colors hover:text-ash-dim"
    >
      <ChevronLeft size={14} />
      World progression
    </Link>
  );
}

/** The way onward: the timeline, and the two Forsaken either side of this one. */
function BossFooterNav({ previous, next }: { previous: Boss | null; next: Boss | null }) {
  const link = 'gold-ring inline-flex items-center gap-1.5 font-display text-sm text-muted transition-colors hover:text-gold-light';
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rune/60 pt-6">
      {previous ? (
        <Link href={bossPath(previous.name)} className={link}>
          <ChevronLeft size={15} />
          {previous.name}
        </Link>
      ) : (
        <span />
      )}

      <Link href="/world" className={link}>
        Back to the boss timeline
      </Link>

      {next ? (
        <Link href={bossPath(next.name)} className={link}>
          {next.name}
          <ChevronRight size={15} />
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
