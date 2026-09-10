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
  PenLine,
  ScrollText,
  ExternalLink,
} from 'lucide-react';
import {
  Card,
  CardBody,
  SectionHeader,
  Badge,
  EmptyState,
  OnlineDot,
  VikingLink,
} from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { SignatureWall } from '@/components/oath/SignatureWall';
import { SERVER_NAME, DISCORD_URL } from '@/config/server';
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
  getOaths,
  getSessionsSince,
  getEventsSince,
  getServerStatus,
  playtimeMinutesByCharacter,
  durablePlaytimeMinutesByCharacter,
  statsFreshness,
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
import { metricInfo, type MetricKey } from '@/lib/milestones';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vikings',
  // The oath wall folded in here on 2026-09-06 and /oath is a 308 to
  // /players#oaths, so this description has to answer for both.
  description: `Every viking who has sailed ${SERVER_NAME}, the oaths they have sworn, and the leaderboards they stand on.`,
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
      value: `L${e.level} · ${formatNumber(e.catches)} ${e.catches === 1 ? 'catch' : 'catches'}`,
    }));
}

interface Board {
  key: string;
  /**
   * The metric key in `lib/milestones.ts` METRIC_INFO that names this number.
   * One number, one name: the board title, the /world count label and the
   * viking stat tile all read the same string from there rather than three
   * hand-typed sets that drift (Structures Built / Pieces built / Built).
   * `titleOverride` is for the one board named after the people rather than
   * the number (Anglers), which is deliberate.
   * Typed as the register's own key union, so a typo is a build error rather
   * than a raw column name rendered to players as a board title.
   */
  metric: MetricKey;
  titleOverride?: string;
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
  const [online_, roster_, withStats_, potyArchive, oaths, sessions, deaths, status] =
    await Promise.all([
      getOnlinePlayers(),
      getAllPlayers(),
      getPlayersWithStats(),
      getPotyArchive(),
      getOaths(),
      getSessionsSince(70),
      getEventsSince(70, ['death']),
      getServerStatus(),
    ]);

  // The wall reads newest first; getOaths() returns oldest first.
  const oathCount = oaths.length;
  const signatures = [...oaths].reverse();

  // Empty until the permanent invite is set (config/server.ts). The one
  // instruction in the oath section that sends a reader somewhere else sends
  // them to Discord, so it carries the exit the moment there is one to carry.
  const discord = DISCORD_URL || null;

  // Server up, but the stats feed has gone quiet: every board below is still
  // the last real number, just no longer moving. Flagged in the header.
  const { statsStale } = statsFreshness(status);

  const attendanceSessions = sessions.map((s) => ({
    character_name: s.character_name,
    joined_at: s.joined_at,
    duration_minutes: s.duration_minutes,
  }));

  // The `players.total_playtime_minutes` column isn't kept fresh by the real
  // pipeline yet — derive it live from session rows so the Hours played board
  // and the roster column reflect real playtime instead of reading back as 0.
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
  //
  // The titles rank on the DURABLE hours value (closed-session minutes), NOT the
  // live-elapsed playtime the boards above display. GET /api/titles does the same,
  // so the subtitle a viking reads here and the title the bot announces are computed
  // from the identical, online-independent number and can't disagree — and "the
  // Ever-Present" no longer churns as people log on and off. The display boards keep
  // the live counter (a growing "Hours Logged" is the point there).
  const durablePlaytimeByName = durablePlaytimeMinutesByCharacter(sessions);
  const epithetRoster = withStats.map((p) => ({
    ...p,
    total_playtime_minutes:
      durablePlaytimeByName.get(p.character_name) ?? 0,
  }));
  const epithets = epithetsFor(epithetRoster, { causesByName });
  // THE HALL, NOT THE ENGINE (2026-09-10). What a viking is shown wearing is
  // `players.current_title` — the title actually PROCLAIMED — whenever one is
  // recorded. Under the sticky policy (services/discord-bot/src/titles.js) the
  // engine's live answer is often deliberately not announced: an earned title is
  // never demoted to a placeholder, a new one waits for confirmation, tenure and
  // the daily budget. Rendering the engine here would show a title the hall has
  // never spoken, and take one away that it did. The engine is the fallback only
  // for a viking with no registry title yet (pre-seed).
  const epithetByName = new Map<string, string>();
  for (const p of withStats) {
    const proclaimed = (p.current_title ?? '').trim();
    epithetByName.set(
      p.character_name,
      proclaimed || epithets.get(p.character_name)?.title || '',
    );
  }

  const boards: Board[] = [
    {
      key: 'deaths',
      metric: 'deaths_total',
      icon: <Skull size={16} />,
      accent: 'text-death',
      empty: 'No warrior has fallen yet. The halls of Valhalla wait.',
      entries: topBy(withStats, (p) => p.stats?.deaths ?? 0, formatNumber),
    },
    {
      key: 'kills',
      metric: 'kills_total',
      icon: <Swords size={16} />,
      accent: 'text-gold',
      empty: 'No blood has been spilled across the realms.',
      entries: topBy(withStats, (p) => p.stats?.kills ?? 0, formatNumber),
    },
    {
      key: 'damage',
      metric: 'damage_total',
      icon: <Flame size={16} />,
      accent: 'text-gold',
      empty: 'No wounds dealt. Every blade still rests in its sheath.',
      entries: topBy(withStats, (p) => p.stats?.damage_dealt ?? 0, formatNumber),
    },
    {
      key: 'hours',
      metric: 'playtime_total_hours',
      icon: <Clock size={16} />,
      accent: 'text-gold',
      empty: 'No voyages recorded. The longships remain moored.',
      entries: topBy(withStats, (p) => p.total_playtime_minutes ?? 0, formatPlaytime),
    },
    {
      key: 'resources',
      metric: 'resources_total',
      icon: <Pickaxe size={16} />,
      accent: 'text-gold',
      empty: 'No ore mined, no wood felled. The wilds stand untouched.',
      entries: topBy(withStats, (p) => p.stats?.resources_harvested ?? 0, formatNumber),
    },
    {
      key: 'crafted',
      metric: 'crafts_total',
      icon: <Hammer size={16} />,
      accent: 'text-gold',
      empty: 'The forges are cold. Nothing has been wrought.',
      entries: topBy(withStats, (p) => p.stats?.items_crafted ?? 0, formatNumber),
    },
    {
      key: 'distance',
      metric: 'walk_run_total',
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
      metric: 'builds_total',
      icon: <Castle size={16} />,
      accent: 'text-gold',
      empty: 'Not a single nail driven. The longhouses are yet to rise.',
      entries: topBy(withStats, (p) => p.stats?.structures_built ?? 0, formatNumber),
    },
    {
      key: 'explored',
      metric: 'explored_avg_pct',
      icon: <MapIcon size={16} />,
      accent: 'text-gold',
      subtitle: 'Fills in as vikings run the companion map-share mod (in the modpack).',
      emptyTitle: 'No frontier charted',
      empty: 'The fog hangs thick over every shore. No mapmaker has yet turned in their ledger.',
      entries: topBy(withStats, (p) => p.stats?.map_explored_pct ?? 0, formatPercent),
    },
    {
      key: 'anglers',
      metric: 'fish_total',
      // The one board named for the people, not the number: the ranking is a
      // skill level, not a count of fish.
      titleOverride: 'Anglers',
      icon: <FishSymbol size={16} />,
      accent: 'text-gold',
      subtitle: 'Fishing skill, with ties broken by total catches.',
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
          as="h1"
          title="The Vikings"
          subtitle="Every warrior who has set foot on these shores: the warband that carves its saga into the world."
          icon={<Users size={22} />}
          action={
            <div className="flex items-center gap-2">
              {statsStale && <Badge tone="gold">Stats paused</Badge>}
              <Badge tone="neutral">{roster.length} {roster.length === 1 ? 'viking' : 'vikings'}</Badge>
            </div>
          }
        />
      </PageHeader>

      {/* Who is on now + the roster sit side by side on desktop (stacked below
          lg), so the online cards drop to one per row inside the half-width
          column. */}
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start lg:gap-8">
        {/* ── Who is on now ──────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Who is on now"
            subtitle="Every viking sailing this world right this minute."
            icon={<Sailboat size={20} />}
            action={
              online.length > 0 ? (
                <Badge tone="online">
                  <OnlineDot online />
                  {online.length} online
                </Badge>
              ) : undefined
            }
          />

          {online.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Sailboat size={28} />}
                title="The seas are calm"
                message="Nobody is on right now. The longhouse fires burn low, awaiting their return."
                action={
                  <Link
                    href="/get-started"
                    className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
                  >
                    The server address and password are on Get Started
                  </Link>
                }
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
                  <Badge tone="online">Online</Badge>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* ── All vikings (roster) ──────────────────────────────── */}
        <section>
          <SectionHeader
            title="All vikings"
            subtitle="Everyone who has played, ranked by hours in the world."
            icon={<Users size={20} />}
          />

          <Card>
            {roster.length === 0 ? (
              <EmptyState
                icon={<Users size={28} />}
                title="No vikings yet"
                message="The shores are empty. Be the first: install the mods and join."
                action={
                  <Link
                    href="/get-started"
                    className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
                  >
                    Get Started
                  </Link>
                }
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
                      {/* Same number as the leaderboard 200 lines below, so it
                          reads from the same register. "Total Time" was the
                          third name this one figure carried on this page. */}
                      <th className="px-4 py-3 text-right font-medium sm:px-5">
                        {metricInfo('playtime_total_hours').label}
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
                            <span className="ml-2 align-middle text-xs uppercase tracking-wide text-online-glow">
                              online
                            </span>
                          )}
                          {epithetByName.get(p.character_name) && (
                            <span className="mt-0.5 block font-display text-xs text-gold">
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

      {/*
        ── Oaths sworn ───────────────────────────────────────────
        Was its own tab and its own page until 2026-09-06. It is the roster's
        other half (who these people said they would be), so it sits directly
        under the roster, and /oath is a 308 to this anchor. `scroll-mt-20`
        clears the 64px sticky header a reader arriving on that redirect would
        otherwise land behind.

        The wall gave up its ISR in the move: /oath carried `revalidate = 60`
        from the 2026-09-05 perf pass and this page is force-dynamic, because
        "Who is on now" is worthless cached. So a link to the wall now costs a
        full render of this page. That is the price of the fold and it is
        deliberate; docs/STRESS-TEST.md and docs/LAUNCH-WIPE.md were corrected
        to stop listing /oath among the cached pages.

        On a wide screen the wall takes two thirds and the rite rides in a
        one-third rail beside it, `items-start` so neither column stretches to
        the other's height. Below lg they stack, wall first: the empty state
        carries its own next step, so a first-timer is never left without one.
      */}
      <section id="oaths" className="scroll-mt-20">
        <SectionHeader
          title="Oaths sworn"
          subtitle={
            oathCount === 0
              ? // Not a second "no oaths yet": the wall's own empty state says
                // that, 90px below, and it is the one that carries the next
                // step. This line says what the section is instead.
                'What each viking swore to be, in their own words.'
              : 'Every vow as it was spoken, newest first.'
          }
          icon={<PenLine size={20} />}
          action={
            oathCount > 0 ? (
              <Badge tone="neutral">
                {oathCount} {oathCount === 1 ? 'oath' : 'oaths'}
              </Badge>
            ) : undefined
          }
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
          <Card className="lg:col-span-2">
            <CardBody>
              <SignatureWall oaths={signatures} />
            </CardBody>
          </Card>

          {/* How to swear, three lines and a link. The full rite used to be
              printed both here and on Get Started, and the two copies had
              already drifted apart. Get Started is the model register and owns
              the procedure; this holds the wall. */}
          {/* Sticky from lg up: on a long wall the rite would otherwise scroll
              away and leave the whole right third empty. */}
          <Card className="border-l-2 border-l-gold lg:sticky lg:top-20">
            <CardBody className="space-y-3">
              <div className="flex items-center gap-2">
                <ScrollText size={18} className="text-gold" />
                <h3 className="font-display text-base tracking-wide text-ash">
                  How to swear, and how to link your Discord
                </h3>
              </div>
              <p className="text-sm leading-relaxed text-ash-dim">
                Swearing an oath also binds your Discord to your viking, so your deeds, photos and
                title gather under one name.
              </p>
              <p className="text-sm leading-relaxed text-ash-dim">
                Ask {SERVER_NAME}{' '}
                {discord ? (
                  <a
                    href={discord}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gold-ring inline-flex items-center gap-1 rounded font-medium text-gold-light prose-link"
                  >
                    in Discord
                    <ExternalLink size={12} />
                  </a>
                ) : (
                  'in Discord'
                )}
                , shout the rune it sends back, and your vow is carved here.
              </p>
              <p className="text-sm leading-relaxed text-ash-dim">
                Full walkthrough on{' '}
                <Link
                  href="/get-started"
                  className="gold-ring rounded font-medium text-gold-light prose-link"
                >
                  Get Started
                </Link>
                .
              </p>
              <p className="text-xs leading-relaxed text-muted">
                Re-swear anytime in game with{' '}
                <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                  /s /oath your new vow
                </span>
                . Your latest oath replaces the last.
              </p>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ── Attendance Constellation ───────────────────────────── */}
      <section>
        <SectionHeader
          title="Activity"
          subtitle="The last ten weeks. Every night the longhouse fires were lit, and by whom."
          icon={<CalendarDays size={20} />}
        />
        <AttendanceCalendar sessions={attendanceSessions} />
      </section>

      {/* ── Leaderboards ───────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Leaderboards"
          subtitle="Every number below is one viking's own, on this world, all time. The deeds, and the misdeeds, that will be sung of in the mead halls."
          icon={<Swords size={20} />}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((board) => (
            <LeaderboardCard
              key={board.key}
              title={board.titleOverride ?? metricInfo(board.metric).label}
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
          subtitle="The last ten weeks. Every warrior meets Valhalla eventually, and these are the roads that take them there."
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
          subtitle="The nightly crown. Every champion the saga has named, and who's worn it most."
          icon={<Crown size={20} />}
        />
        <PotyArchive entries={potyArchive} />
      </section>
    </div>
  );
}
