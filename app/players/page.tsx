import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Users,
  Sailboat,
  Skull,
  Swords,
  Flame,
  Clock,
  Pickaxe,
  Hammer,
  Footprints,
  Castle,
  Map as MapIcon,
  Crown,
  CalendarDays,
  FishSymbol,
} from 'lucide-react';
import { Card, SectionHeader, Badge, EmptyState, OnlineDot, VikingLink } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import {
  LeaderboardCard,
  type LeaderboardEntry,
} from '@/components/players/LeaderboardCard';
import { PotyArchive } from '@/components/players/PotyArchive';
import { AttendanceCalendar } from '@/components/players/AttendanceCalendar';
import { HowWeDie } from '@/components/players/HowWeDie';
import {
  getOnlinePlayers,
  getAllPlayers,
  getPlayersWithStats,
  getPotyArchive,
  getSessionsSince,
  getEventsSince,
  playtimeMinutesByCharacter,
} from '@/lib/data';
import type { PlayerWithStats } from '@/lib/types';
import {
  timeAgo,
  formatPlaytime,
  formatNumber,
  formatDistance,
  formatPercent,
} from '@/lib/format';
import { vikingPath } from '@/lib/slug';
import { epithetsFor } from '@/lib/epithets';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vikings',
};

/** Build a top-N board: skip non-positive values, sort desc, format each value. */
function topBy(
  players: PlayerWithStats[],
  selector: (p: PlayerWithStats) => number,
  format: (n: number) => string,
  n = 5,
  subtitleFor?: (p: PlayerWithStats) => string | undefined
): LeaderboardEntry[] {
  return players
    .map((p) => ({ id: p.id, name: p.character_name, raw: selector(p), player: p }))
    .filter((e) => e.raw > 0)
    .sort((a, b) => b.raw - a.raw)
    .slice(0, n)
    .map((e) => ({
      id: e.id,
      name: e.name,
      value: format(e.raw),
      subtitle: subtitleFor?.(e.player),
    }));
}

/**
 * A concurrent ingest agent may stash per-mode travel distances (walked /
 * sailed / run) somewhere inside `player_stats.gs_stats` jsonb. The shape
 * isn't finalized, so this reads a handful of plausible layouts defensively
 * and falls back to no subtitle if none match — never throws, never assumes.
 */
function travelSubtitle(p: PlayerWithStats): string | undefined {
  const gs = p.stats?.gs_stats as unknown;
  if (!gs || typeof gs !== 'object') return undefined;

  const obj = gs as Record<string, unknown>;
  const bag =
    (obj.distanceByMode as Record<string, unknown> | undefined) ??
    (obj.travel as Record<string, unknown> | undefined) ??
    (obj.movement as Record<string, unknown> | undefined) ??
    obj;

  const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);
  const walked = num(bag.walked) || num(bag.Walk) || num(bag.walk);
  const sailed = num(bag.sailed) || num(bag.Sail) || num(bag.sail) || num(bag.boat);
  const run = num(bag.run) || num(bag.Run) || num(bag.ran);

  const total = walked + sailed + run;
  if (total <= 0) return undefined;

  const shares: [string, number][] = [
    ['mostly by sea', sailed],
    ['mostly at a run', run],
    ['mostly on foot', walked],
  ];
  shares.sort((a, b) => b[1] - a[1]);
  const [label, top] = shares[0];
  return top / total >= 0.5 ? label : undefined;
}

/** Fishing skill level from `gs_stats.skills`, 0 if absent. */
function fishingLevel(p: PlayerWithStats): number {
  const skills = p.stats?.gs_stats?.skills ?? [];
  return skills.find((sk) => sk.skill === 'Fishing')?.level ?? 0;
}

/** Total catches (sum of `gs_stats.fish[].count`), 0 if absent. */
function totalCatches(p: PlayerWithStats): number {
  const fish = p.stats?.gs_stats?.fish ?? [];
  return fish.reduce((sum, f) => sum + f.count, 0);
}

/**
 * Anglers board: ranked by Fishing skill level, ties broken by total catches —
 * distinct enough from the single-metric `topBy` helper to warrant its own
 * sort (two numbers, not one).
 */
function anglerEntries(players: PlayerWithStats[], n = 5): LeaderboardEntry[] {
  return players
    .map((p) => ({ id: p.id, name: p.character_name, level: fishingLevel(p), catches: totalCatches(p) }))
    .filter((e) => e.level > 0 || e.catches > 0)
    .sort((a, b) => b.level - a.level || b.catches - a.catches)
    .slice(0, n)
    .map((e) => ({
      id: e.id,
      name: e.name,
      value: `L${e.level} · ${formatNumber(e.catches)} catches`,
    }));
}

interface Board {
  key: string;
  title: string;
  icon: ReactNode;
  accent: string;
  empty: string;
  /** headline above `empty`; defaults to "No deeds recorded" */
  emptyTitle?: string;
  /** always-visible in-tone note under the title (e.g. data source context) */
  subtitle?: string;
  entries: LeaderboardEntry[];
}

export default async function PlayersPage() {
  const [online_, roster_, withStats_, potyArchive, sessions, deaths] = await Promise.all([
    getOnlinePlayers(),
    getAllPlayers(),
    getPlayersWithStats(),
    getPotyArchive(),
    getSessionsSince(70),
    getEventsSince(70, ['death']),
  ]);

  const attendanceSessions = sessions.map((s) => ({
    character_name: s.character_name,
    joined_at: s.joined_at,
    duration_minutes: s.duration_minutes,
  }));

  // The `players.total_playtime_minutes` column isn't kept fresh by the real
  // pipeline yet — derive it live from session rows so Hours Logged / Total
  // Time reflect real playtime instead of reading back as 0.
  const onlineNames = new Set(online_.map((p) => p.character_name));
  const playtimeByName = playtimeMinutesByCharacter(sessions, onlineNames);
  const online = online_.map((p) => ({
    ...p,
    total_playtime_minutes: playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
  }));
  const roster = roster_
    .map((p) => ({
      ...p,
      total_playtime_minutes: playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
    }))
    .sort((a, b) => b.total_playtime_minutes - a.total_playtime_minutes);
  const withStats = withStats_.map((p) => ({
    ...p,
    total_playtime_minutes: playtimeByName.get(p.character_name) ?? p.total_playtime_minutes,
  }));

  // Auto-generated epithets for the roster subtitles (deterministic; judged
  // against the whole warband). Death causes feed the Treefoe override.
  const causesByName = new Map<string, string[]>();
  for (const e of deaths) {
    const nm = e.character_name;
    if (!nm) continue;
    const cause = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : '';
    if (!cause) continue;
    const arr = causesByName.get(nm) ?? [];
    arr.push(cause);
    causesByName.set(nm, arr);
  }
  // Roster-global assignment: every viking a UNIQUE title, incumbent current_title
  // as the hysteresis anchor (defaulted inside epithetsFor from the roster rows).
  const epithets = epithetsFor(withStats, { causesByName });
  const epithetByName = new Map<string, string>();
  for (const p of withStats) {
    epithetByName.set(p.character_name, epithets.get(p.character_name)?.title ?? '');
  }

  const boards: Board[] = [
    {
      key: 'deaths',
      title: 'Most Deaths',
      icon: <Skull size={16} />,
      accent: 'text-death',
      empty: 'No warrior has fallen yet. The halls of Valhalla wait.',
      entries: topBy(withStats, (p) => p.stats?.deaths ?? 0, formatNumber),
    },
    {
      key: 'kills',
      title: 'Most Kills',
      icon: <Swords size={16} />,
      accent: 'text-gold',
      empty: 'No blood has been spilled across the realms.',
      entries: topBy(withStats, (p) => p.stats?.kills ?? 0, formatNumber),
    },
    {
      key: 'damage',
      title: 'Damage Dealt',
      icon: <Flame size={16} />,
      accent: 'text-gold',
      empty: 'No wounds dealt. Every blade still rests in its sheath.',
      entries: topBy(withStats, (p) => p.stats?.damage_dealt ?? 0, formatNumber),
    },
    {
      key: 'hours',
      title: 'Hours Logged',
      icon: <Clock size={16} />,
      accent: 'text-gold',
      empty: 'No voyages recorded. The longships remain moored.',
      entries: topBy(withStats, (p) => p.total_playtime_minutes ?? 0, formatPlaytime),
    },
    {
      key: 'resources',
      title: 'Resources Gathered',
      icon: <Pickaxe size={16} />,
      accent: 'text-gold',
      empty: 'No ore mined, no wood felled. The wilds stand untouched.',
      entries: topBy(withStats, (p) => p.stats?.resources_harvested ?? 0, formatNumber),
    },
    {
      key: 'crafted',
      title: 'Items Crafted',
      icon: <Hammer size={16} />,
      accent: 'text-gold',
      empty: 'The forges are cold. Nothing has been wrought.',
      entries: topBy(withStats, (p) => p.stats?.items_crafted ?? 0, formatNumber),
    },
    {
      key: 'distance',
      title: 'Distance Traveled',
      icon: <Footprints size={16} />,
      accent: 'text-gold',
      emptyTitle: 'No trails blazed yet',
      empty: 'No footsteps have been counted across the realms. As vikings wander, their trails will be tallied here.',
      entries: topBy(
        withStats,
        (p) => p.stats?.distance_traveled ?? 0,
        formatDistance,
        5,
        travelSubtitle
      ),
    },
    {
      key: 'built',
      title: 'Structures Built',
      icon: <Castle size={16} />,
      accent: 'text-gold',
      empty: 'Not a single nail driven. The longhouses are yet to rise.',
      entries: topBy(withStats, (p) => p.stats?.structures_built ?? 0, formatNumber),
    },
    {
      key: 'explored',
      title: 'Map Explored',
      icon: <MapIcon size={16} />,
      accent: 'text-gold',
      subtitle: 'Fills in as players run the companion map-share mod (in the modpack).',
      emptyTitle: 'No frontier charted',
      empty: 'The fog hangs thick over every shore. No mapmaker has yet turned in their ledger.',
      entries: topBy(withStats, (p) => p.stats?.map_explored_pct ?? 0, formatPercent),
    },
    {
      key: 'anglers',
      title: 'Anglers',
      icon: <FishSymbol size={16} />,
      accent: 'text-gold',
      subtitle: 'Fishing skill — ties broken by total catches.',
      emptyTitle: 'No catches yet',
      empty: 'No viking has yet pulled a fish from the water.',
      entries: anglerEntries(withStats),
    },
  ];

  return (
    <div className="flex flex-col gap-12">
      {/* ── Header ─────────────────────────────────────────────── */}
      <PageHeader slot="players">
        <SectionHeader
          title="The Vikings"
          subtitle="Every warrior who has set foot on these shores — the warband that carves its saga into the world."
          icon={<Users size={22} />}
          action={
            <Badge tone="neutral">{roster.length} sworn</Badge>
          }
        />
      </PageHeader>

      {/* Sailing Now + The Warband sit side by side on desktop (stacked below lg),
          so the online cards drop to one per row inside the half-width column. */}
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start lg:gap-8">
        {/* ── Sailing Now ────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Sailing Now"
            subtitle="Who's online right now."
            icon={<Sailboat size={20} />}
            action={
              online.length > 0 ? (
                <Badge tone="online">
                  <OnlineDot online />
                  {online.length} at sea
                </Badge>
              ) : undefined
            }
          />

          {online.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Sailboat size={28} />}
                title="The seas are calm"
                message="No Vikings are sailing right now. The longhouse fires burn low, awaiting their return."
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {online.map((p) => (
                <Card key={p.id} className="flex items-center gap-3 p-4">
                  <OnlineDot online />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-base text-ash">
                      <VikingLink
                        name={p.character_name}
                        className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                      />
                    </p>
                    <p className="truncate text-xs text-muted">
                      {formatPlaytime(p.total_playtime_minutes)} logged
                    </p>
                  </div>
                  <Badge tone="online">Sailing</Badge>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* ── The Warband (roster) ──────────────────────────────── */}
        <section>
          <SectionHeader
            title="The Warband"
            subtitle="Everyone who has played, ranked by hours in the world."
            icon={<Users size={20} />}
          />

          <Card>
            {roster.length === 0 ? (
              <EmptyState
                icon={<Users size={28} />}
                title="No Vikings have landed"
                message="The shores are empty. As warriors join the server, they will be enshrined here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rune text-left text-xs uppercase tracking-wider text-muted">
                      <th className="w-10 px-4 py-3 font-medium sm:px-5">
                        <span className="sr-only">Status</span>
                      </th>
                      <th className="px-2 py-3 font-medium">Name</th>
                      <th className="hidden px-2 py-3 font-medium sm:table-cell">
                        Last Seen
                      </th>
                      <th className="px-4 py-3 text-right font-medium sm:px-5">
                        Total Time
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((p) => (
                      <tr
                        key={p.id}
                        className="border-t border-rune/60 transition-colors even:bg-surface-raised/25 hover:bg-surface-raised/60"
                      >
                        <td className="px-4 py-3 sm:px-5">
                          <OnlineDot online={p.is_online} />
                        </td>
                        <td className="px-2 py-3">
                          <Link
                            href={vikingPath(p.character_name)}
                            className="gold-ring font-display text-ash transition-colors hover:text-gold-light"
                          >
                            {p.character_name}
                          </Link>
                          {p.is_online && (
                            <span className="ml-2 align-middle text-[11px] uppercase tracking-wide text-online-glow">
                              online
                            </span>
                          )}
                          {epithetByName.get(p.character_name) && (
                            <span className="mt-0.5 block font-display text-xs text-gold-dim">
                              {epithetByName.get(p.character_name)}
                            </span>
                          )}
                          <span className="mt-0.5 block text-xs text-muted sm:hidden">
                            {p.is_online ? 'Sailing now' : timeAgo(p.last_seen_at)}
                          </span>
                        </td>
                        <td className="hidden px-2 py-3 text-muted sm:table-cell">
                          {p.is_online ? 'Sailing now' : timeAgo(p.last_seen_at)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ash-dim sm:px-5">
                          {formatPlaytime(p.total_playtime_minutes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>

      {/* ── Attendance Constellation ───────────────────────────── */}
      <section>
        <SectionHeader
          title="Attendance"
          subtitle="The last ten weeks — every night the longhouse fires were lit, and by whom."
          icon={<CalendarDays size={20} />}
        />
        <AttendanceCalendar sessions={attendanceSessions} />
      </section>

      {/* ── Leaderboards ───────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Leaderboards"
          subtitle="The deeds — and misdeeds — that will be sung of in the mead halls."
          icon={<Swords size={20} />}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((board) => (
            <LeaderboardCard
              key={board.key}
              title={board.title}
              icon={board.icon}
              accent={board.accent}
              entries={board.entries}
              emptyMessage={board.empty}
              emptyTitle={board.emptyTitle}
              subtitle={board.subtitle}
            />
          ))}
        </div>
      </section>

      {/* ── How We Die ─────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="How We Die"
          subtitle="Every warrior meets Valhalla eventually. These are the roads that take them there."
          icon={<Skull size={20} />}
        />
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <HowWeDie deaths={deaths} />
        </div>
      </section>

      {/* ── Players of the Day (history) ───────────────────────── */}
      <section>
        <SectionHeader
          title="Players of the Day"
          subtitle="The nightly crown — every champion the saga has named, and who's worn it most."
          icon={<Crown size={20} />}
        />
        <PotyArchive entries={potyArchive} />
      </section>
    </div>
  );
}
