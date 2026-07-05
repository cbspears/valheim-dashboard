import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Clock,
  Skull,
  Swords,
  Flame,
  Pickaxe,
  Hammer,
  Footprints,
  Castle,
  Map as MapIcon,
  CalendarDays,
  Crown,
  Camera,
  ChevronLeft,
  AtSign,
} from 'lucide-react';
import { Badge, SectionHeader, StatTile, Card, EmptyState } from '@/components/ui';
import { AttendanceCalendar } from '@/components/players/AttendanceCalendar';
import { DeathLog } from '@/components/viking/DeathLog';
import { FeatsOfArms } from '@/components/viking/FeatsOfArms';
import { NamedPlaces } from '@/components/viking/NamedPlaces';
import { PhotoGrid } from '@/components/gallery/PhotoGrid';
import {
  getPlayersWithStats,
  getSessionsSince,
  getEventsSince,
  getPotyArchive,
  getGalleryPhotos,
  getBosses,
  getPins,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import { slugify } from '@/lib/slug';
import { epithetFor, generatedBioLine } from '@/lib/epithets';
import {
  formatPlaytime,
  formatNumber,
  formatDistance,
  formatPercent,
  shortDate,
} from '@/lib/format';
import type { PlayerWithStats, GameEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Raw death-cause strings for one viking (feeds the Treefoe epithet override). */
function causesFor(name: string, deaths: GameEvent[]): string[] {
  return deaths
    .filter((e) => e.character_name === name)
    .map((e) => (typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : ''))
    .filter(Boolean);
}

function findViking(roster: PlayerWithStats[], slug: string): PlayerWithStats | undefined {
  return roster.find((p) => slugify(p.character_name) === slug);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [roster, deaths] = await Promise.all([
    getPlayersWithStats(),
    getEventsSince(70, ['death']),
  ]);
  const viking = findViking(roster, slug);
  if (!viking) return { title: 'Unknown Viking' };

  const epithet = epithetFor(viking, roster, causesFor(viking.character_name, deaths));
  const name = viking.character_name;
  const description = `${name} · ${epithet.title} — a viking of the Eilif saga, and the deeds recorded in their name.`;

  return {
    // layout template turns this into "{Name} · Eilif"
    title: name,
    description,
    openGraph: { title: `${name} · ${epithet.title}`, description },
    twitter: { title: `${name} · ${epithet.title}`, description },
  };
}

interface Tile {
  label: string;
  value: string;
  icon: ReactNode;
  show: boolean;
}

export default async function VikingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const [roster_, sessions, deaths, potyArchive, photos, bosses, pins] = await Promise.all([
    getPlayersWithStats(),
    getSessionsSince(70),
    getEventsSince(70, ['death']),
    getPotyArchive(),
    getGalleryPhotos(),
    getBosses(),
    getPins(),
  ]);

  // The `players.total_playtime_minutes` column isn't kept fresh by the real
  // pipeline yet — derive it live from session rows so Hours reflects real
  // playtime instead of reading back as 0.
  const onlineNames = new Set(roster_.filter((p) => p.is_online).map((p) => p.character_name));
  const playtimeByName = playtimeMinutesByCharacter(sessions, onlineNames);
  const roster = roster_.map((p) => ({
    ...p,
    total_playtime_minutes: playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
  }));

  const viking = findViking(roster, slug);
  if (!viking) notFound();

  const name = viking.character_name;
  const first = name.trim().split(/\s+/)[0] || name;
  const stats = viking.stats;

  const epithet = epithetFor(viking, roster, causesFor(name, deaths));

  // Discord↔character link. `discord_user_id` is undefined pre-link (or
  // pre-migration) → `isLinked` false → the header callout + gallery hint
  // point the viking at the `@Eilif I am <name>` ritual.
  const linkedDiscordId = viking.discord_user_id ?? null;
  const isLinked = Boolean(linkedDiscordId);
  const discordUsername = viking.discord_username ?? null;

  const myDeaths = deaths.filter((e) => e.character_name === name);
  const myCrowns = potyArchive.filter((e) => e.character_name === name);

  // Places: real map pins credited to this exact viking (slug-equal author).
  const myPlaces = pins
    .filter((p) => slugify(p.by_character_name ?? '') === slug)
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, day: p.day }));

  // Photos: attach via the explicit Discord↔character link.
  const myPhotos = isLinked
    ? photos
        .filter((p) => p.discord_user_id && p.discord_user_id === linkedDiscordId)
        .map((p) => ({ ...p, matchedViking: name }))
    : [];

  const attendanceSessions = sessions.map((s) => ({
    character_name: s.character_name,
    joined_at: s.joined_at,
    duration_minutes: s.duration_minutes,
  }));

  const tiles: Tile[] = [
    {
      label: 'Hours',
      value: formatPlaytime(viking.total_playtime_minutes),
      icon: <Clock size={15} />,
      show: (viking.total_playtime_minutes ?? 0) > 0,
    },
    {
      label: 'Kills',
      value: formatNumber(stats?.kills),
      icon: <Swords size={15} />,
      show: (stats?.kills ?? 0) > 0,
    },
    {
      label: 'Damage',
      value: formatNumber(stats?.damage_dealt),
      icon: <Flame size={15} />,
      show: (stats?.damage_dealt ?? 0) > 0,
    },
    {
      label: 'Deaths',
      value: formatNumber(stats?.deaths),
      icon: <Skull size={15} />,
      show: (stats?.deaths ?? 0) > 0,
    },
    {
      label: 'Resources',
      value: formatNumber(stats?.resources_harvested),
      icon: <Pickaxe size={15} />,
      show: (stats?.resources_harvested ?? 0) > 0,
    },
    {
      label: 'Crafted',
      value: formatNumber(stats?.items_crafted),
      icon: <Hammer size={15} />,
      show: (stats?.items_crafted ?? 0) > 0,
    },
    {
      label: 'Distance',
      value: formatDistance(stats?.distance_traveled),
      icon: <Footprints size={15} />,
      show: (stats?.distance_traveled ?? 0) > 0,
    },
    {
      label: 'Built',
      value: formatNumber(stats?.structures_built),
      icon: <Castle size={15} />,
      show: (stats?.structures_built ?? 0) > 0,
    },
    {
      label: 'Explored',
      value: formatPercent(stats?.map_explored_pct),
      icon: <MapIcon size={15} />,
      show: (stats?.map_explored_pct ?? 0) > 0,
    },
  ];
  const shownTiles = tiles.filter((t) => t.show);

  return (
    <div className="flex flex-col gap-10">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header>
        <Link
          href="/players"
          className="gold-ring mb-5 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ash-dim"
        >
          <ChevronLeft size={14} />
          The Warband
        </Link>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="heading-engraved text-3xl text-ash sm:text-4xl">{name}</h1>
          {viking.role && <Badge tone="gold">{viking.role}</Badge>}
          {isLinked && discordUsername && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-gold-dim/40 bg-pitch/70 px-2.5 py-0.5 text-xs font-medium text-gold-dim"
              title={`Linked to Discord as ${discordUsername}`}
            >
              <AtSign size={12} />
              {discordUsername}
            </span>
          )}
        </div>
        <p className="mt-1 font-display text-lg text-gold-light">{epithet.title}</p>

        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ash-dim">
          {viking.bio ? (
            viking.bio
          ) : (
            <span className="italic text-muted">{generatedBioLine(viking, epithet)}</span>
          )}
        </p>

        {!isLinked && (
          <div className="mt-5 flex max-w-2xl items-start gap-3 rounded-[var(--radius-card)] border border-gold-dim/30 bg-surface-raised/60 px-4 py-3">
            <span className="mt-0.5 shrink-0 text-gold-dim">
              <AtSign size={16} />
            </span>
            <p className="text-sm leading-relaxed text-ash-dim">
              This viking has not yet told Eilif who they are. Type{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs text-gold-light">
                @Eilif I am {name}
              </span>{' '}
              in Discord to bind this saga to your voice.
            </p>
          </div>
        )}
      </header>

      {/* ── Stat tiles ─────────────────────────────────────────── */}
      {shownTiles.length > 0 && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shownTiles.map((t) => (
            <StatTile key={t.label} label={t.label} value={t.value} icon={t.icon} />
          ))}
        </section>
      )}

      {/* ── Feats of Arms (client-mod combat records) ──────────── */}
      {stats?.gs_stats && (
        <section>
          <SectionHeader
            title="Feats of Arms"
            subtitle={`The weapons ${first} favored, the beasts felled, and the bosses bled.`}
            icon={<Swords size={20} />}
          />
          <FeatsOfArms stats={stats} first={first} knownBosses={bosses} />
        </section>
      )}

      {/* ── Attendance ─────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Nights at the Hearth"
          subtitle={`Every night ${first} lit the longhouse fires, across ten weeks.`}
          icon={<CalendarDays size={20} />}
        />
        <AttendanceCalendar sessions={attendanceSessions} lockedTo={name} />
      </section>

      {/* ── Crowns + Death-roll ────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <SectionHeader title="Crowns Worn" icon={<Crown size={20} />} />
          {myCrowns.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Crown size={26} />}
                title="Uncrowned — for now"
                message={`${first} has yet to be named Player of the Day. The saga is young.`}
              />
            </Card>
          ) : (
            <Card>
              <ul className="divide-y divide-rune/50">
                {myCrowns.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-3 px-5 py-2.5">
                    <Crown size={13} className="translate-y-0.5 shrink-0 text-gold" />
                    <span className="flex-1 text-sm text-ash">{c.award_label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {shortDate(c.awarded_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div>
          <SectionHeader title="The Death-Roll" icon={<Skull size={20} />} />
          <DeathLog deaths={myDeaths} first={first} />
        </div>
      </section>

      {/* ── Named places ───────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Places They Named"
          subtitle="Every settlement and landmark this viking set upon the map."
          icon={<MapIcon size={20} />}
        />
        <NamedPlaces places={myPlaces} first={first} />
      </section>

      {/* ── Gallery ────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Sagas in Silver"
          subtitle={`Scenes ${first} carried back from the realms.`}
          icon={<Camera size={20} />}
        />
        {!isLinked ? (
          <Card>
            <EmptyState
              icon={<Camera size={26} />}
              title="Photos await"
              message={`Once ${first} is linked (see the note above), every screenshot they've shared will gather here.`}
            />
          </Card>
        ) : myPhotos.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Camera size={26} />}
              title="No sagas in silver"
              message={`${first} has shared no images to the hall — yet.`}
            />
          </Card>
        ) : (
          <PhotoGrid photos={myPhotos} />
        )}
      </section>

      {/* ── Back link ──────────────────────────────────────────── */}
      <div className="border-t border-rune/60 pt-6 text-center">
        <Link
          href="/players"
          className="gold-ring inline-flex items-center gap-1.5 font-display text-sm text-muted transition-colors hover:text-gold-light"
        >
          <ChevronLeft size={15} />
          Back to the Warband
        </Link>
      </div>
    </div>
  );
}
