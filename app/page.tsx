import Link from 'next/link';
import Image from 'next/image';
import {
  Users,
  Sun,
  Swords,
  Skull,
  Crown,
  ScrollText,
  Map as MapIcon,
  Anchor,
  ArrowRight,
  Signal,
  CalendarClock,
  Feather,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  CardBody,
  SectionHeader,
  Badge,
  EmptyState,
  OnlineDot,
  StatTile,
  VikingLink,
  BossLink,
} from '@/components/ui';
import { AutoRefresh } from '@/components/home/AutoRefresh';
import { HomeHero } from '@/components/art/HomeHero';
import { Hearth } from '@/components/home/Hearth';
import { GreatDeedsCard } from '@/components/milestones/GreatDeedsCard';
import { UpcomingEvents } from '@/components/events/UpcomingEvents';
import {
  getServerStatus,
  getOnlinePlayers,
  getAllPlayers,
  getBosses,
  getRecentEvents,
  getUpcomingEvents,
  getOaths,
  getMilestones,
  getMilestoneAggregates,
} from '@/lib/data';
import { summarizeMilestones } from '@/lib/milestones';
import { describeEvent } from '@/lib/events';
import { timeAgo } from '@/lib/format';
import { SERVER_NAME, SERVER_TAGLINE, SERVER_ADDRESS, MAX_PLAYERS } from '@/config/server';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [status, online, allPlayers, bosses, events, upcoming, oaths, milestones, milestoneAgg] =
    await Promise.all([
      getServerStatus(),
      getOnlinePlayers(),
      getAllPlayers(),
      getBosses(),
      getRecentEvents(8),
      getUpcomingEvents(3),
      getOaths(),
      getMilestones(),
      getMilestoneAggregates(),
    ]);

  const milestoneSummary = summarizeMilestones(milestones, milestoneAgg);

  const oathCount = oaths.length;
  const latestOath = oathCount > 0 ? oaths[oathCount - 1] : null;
  const latestOathName =
    latestOath?.character_name?.trim() || latestOath?.discord_name || 'A viking';

  const isOnline = status?.is_online ?? false;
  const playerCount = status?.player_count ?? online.length;
  const worldDay = status?.world_day ?? 0;

  const totalBosses = bosses.length || 8;
  const felledBosses = bosses.filter((b) => b.is_killed);
  const felledCount = felledBosses.length;
  const nextBoss = bosses.find((b) => !b.is_killed) ?? null;
  const bossPercent = totalBosses > 0 ? Math.round((felledCount / totalBosses) * 100) : 0;

  // Live status strip beneath the hero art. Rendered inside both the current
  // banner hero and the art-backed HomeHero, so it survives either path.
  const statusStrip = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rune bg-pitch/50 px-5 py-3 text-sm backdrop-blur-sm sm:px-7">
      <Badge tone={isOnline ? 'online' : 'offline'}>
        <OnlineDot online={isOnline} />
        {isOnline ? 'Server Online' : 'Server Offline'}
      </Badge>
      <span className="flex items-center gap-1.5 text-ash-dim">
        <Sun size={14} className="text-gold-dim" />
        Day {worldDay} of the tenth world
      </span>
      <span className="flex items-center gap-1.5 text-ash-dim">
        <Users size={14} className="text-gold-dim" />
        {playerCount} / {MAX_PLAYERS} sailing
      </span>
      {SERVER_ADDRESS && (
        <span className="inline-flex items-center gap-2 rounded-full border border-rune bg-pitch/70 px-3 py-1">
          <Signal size={13} className="text-online-glow" />
          <span className="font-mono text-xs text-ash">{SERVER_ADDRESS}</span>
        </span>
      )}
    </div>
  );

  // Current banner hero — the graceful fallback rendered verbatim while the
  // art manifest is empty (zero visual change).
  const heroFallback = (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-gold-dim/40 shadow-[0_0_50px_-14px_rgba(200,149,42,0.45)]">
      <Image
        src="/banner-eilif.webp"
        alt={`${SERVER_NAME} — ${SERVER_TAGLINE}`}
        width={1983}
        height={793}
        priority
        className="h-auto w-full"
      />
      {/* Live status strip beneath the art (keeps the banner pristine) */}
      {statusStrip}
    </div>
  );

  return (
    <div className="space-y-10">
      <AutoRefresh />

      {/* ───────────────────────── HERO BANNER ───────────────────────── */}
      <HomeHero fallback={heroFallback} statusStrip={statusStrip} />

      {/* ───────────────────── STAT STRIP ────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label="Online Now" value={playerCount} icon={<Users size={16} />} hint="in the world right now" />
        <StatTile label="World Day" value={worldDay} icon={<Sun size={16} />} hint="in-game days since landfall" />
        <StatTile
          label="Total Vikings"
          value={allPlayers.length}
          icon={<Swords size={16} />}
          hint="have set foot here"
        />
        <StatTile
          label="Bosses Felled"
          value={felledCount}
          icon={<Skull size={16} />}
          hint={`of ${totalBosses} forsaken ones`}
        />
      </div>

      {/* ──────────────────── LIVE FROM THE HALL ─────────────── */}
      <section>
        <SectionHeader
          title="Live from the Hall"
          subtitle="Who is sailing right now, and the latest deeds recorded in the saga"
          icon={<Anchor size={20} />}
        />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* The Hearth — server pulse + who's online */}
          <Hearth status={status} online={online} />

          {/* Great Deeds — the collective-milestone counterpart to the Hearth */}
          <GreatDeedsCard summary={milestoneSummary} />
        </div>

        {/* Recent Saga — full width beneath the pulse cards */}
        <div className="mt-5">
          <Card>
            <CardHeader
              title="Recent Saga"
              icon={<ScrollText size={16} />}
              action={
                <Link
                  href="/events"
                  className="gold-ring rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
                >
                  All tales →
                </Link>
              }
            />
            <CardBody className="p-0">
              {events.length === 0 ? (
                <EmptyState
                  icon={<ScrollText size={28} />}
                  title="The saga has not begun"
                  message="Deeds, deaths, and conquests will be etched here as they happen."
                />
              ) : (
                <ul className="divide-y divide-rune">
                  {events.map((e) => {
                    const { icon: Icon, accent, description } = describeEvent(e);
                    // Boss kills carry the beast's name in metadata — link the
                    // whole line to its war-room (mirrors EventFeed on /events).
                    const bossName =
                      e.type === 'boss' && typeof e.metadata?.boss === 'string'
                        ? e.metadata.boss
                        : null;
                    return (
                      <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                        <span className={`mt-0.5 shrink-0 ${accent}`}>
                          <Icon size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          {bossName ? (
                            <BossLink
                              name={bossName}
                              className="gold-ring block text-sm leading-snug text-ash-dim transition-colors hover:text-gold-light"
                            >
                              {description}
                            </BossLink>
                          ) : (
                            <p className="text-sm leading-snug text-ash-dim">{description}</p>
                          )}
                          <p className="mt-0.5 text-xs text-muted">{timeAgo(e.created_at)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ─────────────────────── THE OATH TEASER ─────────────── */}
      <Link href="/oath" className="gold-ring block rounded-[var(--radius-card)]">
        <Card className="border-l-2 border-l-gold transition-colors hover:border-gold-dim/60 hover:bg-surface-raised/40">
          <CardBody className="flex items-center gap-4">
            <span className="hidden shrink-0 text-gold sm:block">
              <Feather size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <h3 className="font-display text-base tracking-wide text-ash">The Oath</h3>
                <span className="text-sm text-muted">
                  · {oathCount} sworn
                </span>
              </div>
              {latestOath ? (
                <p className="mt-0.5 truncate text-sm text-ash-dim">
                  {/* Not a VikingLink: this whole teaser is already an <a> to
                      /oath, and nested anchors are invalid HTML. */}
                  <span className="font-display text-gold-light">{latestOathName}</span>
                  <span className="italic"> — &ldquo;{latestOath.oath_text}&rdquo;</span>
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-ash-dim">
                  Swear the charter before we sail — be the first to set your mark.
                </p>
              )}
            </div>
            <span className="shrink-0 text-gold-light">
              <ArrowRight size={16} />
            </span>
          </CardBody>
        </Card>
      </Link>

      {/* ─────────────────────── COMING UP ──────────────────── */}
      <Card>
        <CardHeader
          title="Coming Up"
          icon={<CalendarClock size={16} />}
          action={
            <Link
              href="/world"
              className="gold-ring rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
            >
              Full schedule →
            </Link>
          }
        />
        <CardBody className="p-0">
          <UpcomingEvents events={upcoming} />
        </CardBody>
      </Card>

      {/* ─────────────────── WORLD PROGRESS TEASER ───────────── */}
      <Card>
        <CardHeader
          title="World Progress"
          icon={<MapIcon size={16} />}
          action={
            <Link
              href="/world"
              className="gold-ring inline-flex items-center gap-1 rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
            >
              View the full saga <ArrowRight size={13} />
            </Link>
          }
        />
        <CardBody className="space-y-5">
          {/* Progress bar */}
          <div>
            <div className="mb-2 flex items-end justify-between gap-3">
              <span className="text-sm text-ash-dim">
                <span className="font-display text-base text-ash">{felledCount}</span>
                <span className="text-muted"> / {totalBosses} bosses felled</span>
              </span>
              <span className="font-display text-sm text-gold-light">{bossPercent}%</span>
            </div>
            <div
              className="h-3 w-full overflow-hidden rounded-full border border-rune bg-pitch"
              role="progressbar"
              aria-valuenow={felledCount}
              aria-valuemin={0}
              aria-valuemax={totalBosses}
              aria-label="Bosses felled"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold-dim via-gold to-gold-light shadow-[0_0_12px_-2px_rgba(232,184,75,0.6)] transition-all"
                style={{ width: `${bossPercent}%` }}
              />
            </div>
          </div>

          {/* Felled bosses */}
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted">Forsaken ones felled</p>
            {felledBosses.length === 0 ? (
              <p className="text-sm text-ash-dim">
                None yet — Eikthyr awaits at the edge of the Meadows.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {felledBosses.map((b) => (
                  <Badge key={b.id} tone="gold">
                    <Crown size={12} />
                    <BossLink name={b.name} className="gold-ring rounded-sm transition-colors hover:underline" />
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <hr className="rune-divider" />

          {/* Current objective */}
          {nextBoss ? (
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-gold">
                <Skull size={18} />
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted">Current objective</p>
                <p className="mt-0.5 text-ash">
                  Hunt{' '}
                  <BossLink
                    name={nextBoss.name}
                    className="gold-ring rounded-sm font-display text-gold-light transition-colors hover:text-gold"
                  />
                  <span className="text-muted"> in the {nextBoss.biome}</span>
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-gold-light">
                <Crown size={18} />
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted">The saga is complete</p>
                <p className="mt-0.5 text-ash">
                  Every forsaken one has fallen. The tenth world belongs to the bold.
                </p>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
