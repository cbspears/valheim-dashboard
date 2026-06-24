import Link from 'next/link';
import Image from 'next/image';
import {
  Users,
  Sun,
  Swords,
  Skull,
  Crown,
  Clock,
  ScrollText,
  Map as MapIcon,
  Anchor,
  ArrowRight,
  Signal,
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
} from '@/components/ui';
import { AutoRefresh } from '@/components/home/AutoRefresh';
import {
  getServerStatus,
  getOnlinePlayers,
  getAllPlayers,
  getBosses,
  getRecentEvents,
  getActiveSessions,
} from '@/lib/data';
import { describeEvent } from '@/lib/events';
import { timeAgo, liveSessionLength } from '@/lib/format';
import { SERVER_NAME, SERVER_TAGLINE, SERVER_ADDRESS, MAX_PLAYERS } from '@/config/server';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [status, online, allPlayers, bosses, events, activeSessions] = await Promise.all([
    getServerStatus(),
    getOnlinePlayers(),
    getAllPlayers(),
    getBosses(),
    getRecentEvents(8),
    getActiveSessions(),
  ]);

  const isOnline = status?.is_online ?? false;
  const playerCount = status?.player_count ?? online.length;
  const worldDay = status?.world_day ?? 0;

  // Map a player to the join time of their currently-open session so we can show a
  // live "in the realm" duration. Sessions may be keyed by player_id or character_name.
  const joinedByPlayer = new Map<string, string>();
  const joinedByName = new Map<string, string>();
  for (const s of activeSessions) {
    if (s.player_id && !joinedByPlayer.has(s.player_id)) joinedByPlayer.set(s.player_id, s.joined_at);
    if (s.character_name && !joinedByName.has(s.character_name))
      joinedByName.set(s.character_name, s.joined_at);
  }

  const totalBosses = bosses.length || 8;
  const felledBosses = bosses.filter((b) => b.is_killed);
  const felledCount = felledBosses.length;
  const nextBoss = bosses.find((b) => !b.is_killed) ?? null;
  const bossPercent = totalBosses > 0 ? Math.round((felledCount / totalBosses) * 100) : 0;

  return (
    <div className="space-y-10">
      <AutoRefresh />

      {/* ───────────────────────── HERO BANNER ───────────────────────── */}
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
      </div>

      {/* ───────────────────── STAT STRIP ────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label="Online Now" value={playerCount} icon={<Users size={16} />} hint="vikings sailing" />
        <StatTile label="World Day" value={worldDay} icon={<Sun size={16} />} hint="of the tenth world" />
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
          {/* Currently Online */}
          <Card>
            <CardHeader
              title="Currently Online"
              icon={<Users size={16} />}
              action={
                <Badge tone={online.length > 0 ? 'online' : 'offline'}>
                  {online.length} {online.length === 1 ? 'viking' : 'vikings'}
                </Badge>
              }
            />
            <CardBody className="p-0">
              {online.length === 0 ? (
                <EmptyState
                  icon={<Anchor size={28} />}
                  title="The mead hall is quiet…"
                  message="No vikings are sailing right now."
                />
              ) : (
                <ul className="divide-y divide-rune">
                  {online.map((p) => {
                    const joinedAt =
                      joinedByPlayer.get(p.id) ?? joinedByName.get(p.character_name) ?? null;
                    return (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 px-5 py-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <OnlineDot online />
                          <span className="truncate font-medium text-ash">
                            {p.character_name}
                          </span>
                        </div>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-ash-dim">
                          <Clock size={13} className="text-gold-dim" />
                          {joinedAt ? liveSessionLength(joinedAt) : 'in the realm'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Recent Saga */}
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
                    return (
                      <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                        <span className={`mt-0.5 shrink-0 ${accent}`}>
                          <Icon size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-snug text-ash-dim">{description}</p>
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
                    {b.name}
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
                  Hunt <span className="font-display text-gold-light">{nextBoss.name}</span>
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
