import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  Users,
  Sailboat,
  Skull,
  Swords,
  Clock,
  Pickaxe,
  Hammer,
  Footprints,
  Castle,
  Map,
  Crown,
} from 'lucide-react';
import { Card, SectionHeader, Badge, EmptyState, OnlineDot } from '@/components/ui';
import {
  LeaderboardCard,
  type LeaderboardEntry,
} from '@/components/players/LeaderboardCard';
import { PotyArchive } from '@/components/players/PotyArchive';
import { getOnlinePlayers, getAllPlayers, getPlayersWithStats, getPotyArchive } from '@/lib/data';
import type { PlayerWithStats } from '@/lib/types';
import {
  timeAgo,
  formatPlaytime,
  formatNumber,
  formatDistance,
  formatPercent,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vikings',
};

/** Build a top-N board: skip non-positive values, sort desc, format each value. */
function topBy(
  players: PlayerWithStats[],
  selector: (p: PlayerWithStats) => number,
  format: (n: number) => string,
  n = 5
): LeaderboardEntry[] {
  return players
    .map((p) => ({ id: p.id, name: p.character_name, raw: selector(p) }))
    .filter((e) => e.raw > 0)
    .sort((a, b) => b.raw - a.raw)
    .slice(0, n)
    .map((e) => ({ id: e.id, name: e.name, value: format(e.raw) }));
}

interface Board {
  key: string;
  title: string;
  icon: ReactNode;
  accent: string;
  empty: string;
  entries: LeaderboardEntry[];
}

export default async function PlayersPage() {
  const [online, roster, withStats, potyArchive] = await Promise.all([
    getOnlinePlayers(),
    getAllPlayers(),
    getPlayersWithStats(),
    getPotyArchive(),
  ]);

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
      title: 'Greatest Slayer',
      icon: <Swords size={16} />,
      accent: 'text-gold',
      empty: 'No blood has been spilled across the realms.',
      entries: topBy(withStats, (p) => p.stats?.kills ?? 0, formatNumber),
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
      title: 'Master Crafter',
      icon: <Hammer size={16} />,
      accent: 'text-gold',
      empty: 'The forges are cold. Nothing has been wrought.',
      entries: topBy(withStats, (p) => p.stats?.items_crafted ?? 0, formatNumber),
    },
    {
      key: 'distance',
      title: 'Farthest Wandered',
      icon: <Footprints size={16} />,
      accent: 'text-gold',
      empty: 'No tracks in the snow. The map remains unexplored.',
      entries: topBy(withStats, (p) => p.stats?.distance_traveled ?? 0, formatDistance),
    },
    {
      key: 'built',
      title: 'Master Builder',
      icon: <Castle size={16} />,
      accent: 'text-gold',
      empty: 'Not a single nail driven. The longhouses are yet to rise.',
      entries: topBy(withStats, (p) => p.stats?.structures_built ?? 0, formatNumber),
    },
    {
      key: 'explored',
      title: 'Cartographer',
      icon: <Map size={16} />,
      accent: 'text-gold',
      empty: 'The fog hangs thick. No frontier has been charted.',
      entries: topBy(withStats, (p) => p.stats?.map_explored_pct ?? 0, formatPercent),
    },
  ];

  return (
    <div className="flex flex-col gap-12">
      {/* ── Header ─────────────────────────────────────────────── */}
      <SectionHeader
        title="The Vikings"
        subtitle="Every warrior who has set foot on these shores — the warband that carves its saga into the world."
        icon={<Users size={22} />}
        action={
          <Badge tone="neutral">{roster.length} sworn</Badge>
        }
      />

      {/* ── Sailing Now ────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Sailing Now"
          subtitle="Vikings currently braving the realms."
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {online.map((p) => (
              <Card key={p.id} className="flex items-center gap-3 p-4">
                <OnlineDot online />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-base text-ash">
                    {p.character_name}
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
          subtitle="The full muster, ranked by time spent in the realms."
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
                        <span className="font-display text-ash">
                          {p.character_name}
                        </span>
                        {p.is_online && (
                          <span className="ml-2 align-middle text-[11px] uppercase tracking-wide text-online-glow">
                            online
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

      {/* ── Leaderboards ───────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Sagas & Records"
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
            />
          ))}
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
