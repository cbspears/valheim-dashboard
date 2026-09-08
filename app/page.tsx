import Link from 'next/link';
import Image from 'next/image';
import {
  Users,
  Sun,
  Hourglass,
  MapPin,
  Skull,
  Crown,
  ScrollText,
  ArrowRight,
  Compass,
  CalendarClock,
  Feather,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  EmptyState,
  OnlineDot,
  StatTile,
  BossLink,
} from '@/components/ui';
import { AutoRefresh } from '@/components/home/AutoRefresh';
import { FirstRunBand } from '@/components/home/FirstRunBand';
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
  getPins,
  statsFreshness,
} from '@/lib/data';
import { summarizeMilestones, formatMetricValue, metricInfo } from '@/lib/milestones';
import { summarizeBosses } from '@/lib/bosses';
import { describeEvent } from '@/lib/events';
import { timeAgo, formatEventWhen } from '@/lib/format';
import { SERVER_NAME, SERVER_TAGLINE, MAX_PLAYERS } from '@/config/server';
import { LaunchNotice } from '@/components/LaunchNotice';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [
    status,
    online,
    allPlayers,
    bosses,
    events,
    upcoming,
    oaths,
    milestones,
    milestoneAgg,
    pins,
  ] = await Promise.all([
    getServerStatus(),
    getOnlinePlayers(),
    getAllPlayers(),
    getBosses(),
    // Five, not eight (UX plan, proposal 2). Eight rows of a feed whose most
    // common event is one viking arriving and leaving spent a whole card
    // repeating one name. The joins themselves stay: on launch night they are
    // the only story there is, and filtering them would put "The story has not
    // begun" on the Hall while people are actually walking in.
    getRecentEvents(5),
    getUpcomingEvents(3),
    getOaths(),
    getMilestones(),
    getMilestoneAggregates(),
    // Only the count is shown, but there is no count-only reader in lib/data and
    // this one is narrow (six columns, no gs_stats blob) and React-cached, so
    // /map and the Hall share a single read inside one request.
    getPins(),
  ]);

  const milestoneSummary = summarizeMilestones(milestones, milestoneAgg);

  // Server up, but the stats feed (Emitter → server_status) has gone quiet.
  // The Hearth says so plainly rather than presenting old numbers as live.
  const { statsStale } = statsFreshness(status);

  const oathCount = oaths.length;
  const latestOath = oathCount > 0 ? oaths[oathCount - 1] : null;
  const latestOathName =
    latestOath?.character_name?.trim() || latestOath?.discord_name || 'A viking';

  const isOnline = status?.is_online ?? false;
  const playerCount = status?.player_count ?? online.length;
  const worldDay = status?.world_day ?? 0;

  // The ledger, reduced in one place (lib/bosses). `ledgerEmpty` is the guard that
  // matters: getBosses() returns [] for a FAILED read as well as an unfelled world,
  // and "no unfelled boss" was previously enough to announce a completed saga.
  const saga = summarizeBosses(bosses);
  const felledBosses = saga.felled;
  const felledCount = saga.felledCount;
  const nextBoss = saga.next;
  const totalBosses = saga.total || 8;
  const bossPercent = saga.percent;

  // The soonest scheduled Discord event (recurring rows already rolled forward
  // by getUpcomingEvents). Null when nothing is on the calendar — the hero then
  // renders no "Up next" line at all rather than an empty placeholder.
  const nextEvent = upcoming[0] ?? null;

  // Everything beneath the hero art: the live quick-info strip, the next
  // gathering (when one exists), and world progress. Rendered inside both the
  // current banner hero and the art-backed HomeHero, so it survives either path.
  const heroFooter = (
    <div className="border-t border-rune bg-pitch/50 backdrop-blur-sm">
      <div className="space-y-2 px-5 py-3 sm:px-7">
        {/* Quick info — server pulse, world day, who is sailing, how to join */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Badge tone={isOnline ? 'online' : 'offline'}>
            <OnlineDot online={isOnline} />
            {isOnline ? 'Server Online' : 'Server Offline'}
          </Badge>
          <span className="flex items-center gap-1.5 text-ash-dim">
            <Sun size={14} className="text-gold" />
            {/* "of this world", not "of the tenth world": the tenth world is a
                phrase this group carries and nothing on the site explains it,
                so it was the first unexplained words a stranger met. It stays
                in the flavour lines (the footer, the felled-saga line) and out
                of the hero's first fact. */}
            {worldDay > 0 ? `Day ${worldDay} of this world` : 'A new world, not yet a day old'}
          </span>
          <span className="flex items-center gap-1.5 text-ash-dim">
            <Users size={14} className="text-gold" />
            {playerCount} / {MAX_PLAYERS} sailing
          </span>
          {/* The address used to sit here bare. It is the one thing a stranger
              must not use yet (the server is modded and refuses an unmodded
              join), so the chip points at the page that hands it over in
              order. The address itself lives on Get Started. */}
          {/* 44px tall on a phone, where this is the newcomer's whole route in
              from the Hall; the chip was 111x26 and cleared SC 2.5.8's 24px
              floor by 2px. Back to chip height from `sm` up, where it sits in a
              row of badges and a pointer is doing the aiming. */}
          <Link
            href="/get-started"
            className="gold-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-gold-dim/60 bg-gold/10 px-4 py-2 text-xs font-medium text-gold-light transition-colors hover:bg-gold/20 sm:min-h-0 sm:px-3 sm:py-1.5"
          >
            <Compass size={13} />
            How to join
          </Link>
        </div>

        {/* Up next — only when a gathering is actually scheduled */}
        {nextEvent && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Badge tone="gold">
              <CalendarClock size={12} />
              Up next
            </Badge>
            {nextEvent.url ? (
              <a
                href={nextEvent.url}
                target="_blank"
                rel="noopener noreferrer"
                className="gold-ring rounded font-display text-ash transition-colors hover:text-gold-light"
              >
                {nextEvent.name}
              </a>
            ) : (
              <span className="font-display text-ash">{nextEvent.name}</span>
            )}
            <span className="text-muted">· {formatEventWhen(nextEvent.next_at)}</span>
          </div>
        )}
      </div>

      {/* World progress — the same bar the World page uses, compacted to a row */}
      <div className="flex items-center gap-3 border-t border-rune/60 px-5 py-2.5 sm:px-7">
        <span className="shrink-0 text-sm text-ash-dim">
          <span className="font-display text-ash">{felledCount}</span> of {totalBosses} Forsaken
          felled
        </span>
        <div
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full border border-rune bg-pitch"
          role="progressbar"
          aria-valuenow={felledCount}
          aria-valuemin={0}
          aria-valuemax={totalBosses}
          aria-label="Forsaken felled"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-gold-dim via-gold to-gold-light shadow-[0_0_12px_-2px_rgba(232,184,75,0.6)] transition-all"
            style={{ width: `${bossPercent}%` }}
          />
        </div>
        <span className="shrink-0 font-display text-sm text-gold-light">{bossPercent}%</span>
      </div>
    </div>
  );

  // Current banner hero — the graceful fallback rendered verbatim while the
  // art manifest is empty (zero visual change).
  const heroFallback = (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-gold-dim/40 shadow-[0_0_50px_-14px_rgba(200,149,42,0.45)]">
      <Image
        src="/banner-eilif.webp"
        alt={`${SERVER_NAME} · ${SERVER_TAGLINE}`}
        width={1983}
        height={793}
        priority
        className="h-auto w-full"
      />
      {/* Live info beneath the art (keeps the banner pristine) */}
      {heroFooter}
    </div>
  );

  return (
    <div className="space-y-10">
      <AutoRefresh />

      {/* Only rendered when config/server.ts LAUNCH_NOTICE is set. */}
      <LaunchNotice />

      {/* ───────────────────────── HERO BANNER ───────────────────────── */}
      <HomeHero fallback={heroFallback} footer={heroFooter} />

      {/* ──────────────────── FIRST RUN BAND ─────────────────── */}
      {/* The Hall had no link to /get-started anywhere in its body; on a phone
          the only route in was the tenth item in the nav drawer. */}
      <FirstRunBand />

      {/* ───────────────────── STAT STRIP ────────────────────── */}
      {/* FACTS THE HERO DOES NOT ALREADY CARRY, and only those. Online now,
          world day and bosses felled all live in the hero strip two hundred
          pixels above this row, so the strip used to spend the page's most
          valuable band restating itself three times over. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label="Total vikings"
          value={allPlayers.length}
          icon={<Users size={16} />}
          hint="have set foot here"
        />
        {/* Labels come from lib/milestones METRIC_INFO, the one register for
            metric names, so the Hall cannot drift from the /world ledger and
            the /players boards. Values are formatted by the same module ("1,204
            h", "24"). */}
        <StatTile
          label={metricInfo('playtime_total_hours').label}
          value={formatMetricValue('playtime_total_hours', milestoneAgg.playtime_total_hours ?? 0)}
          icon={<Hourglass size={16} />}
          hint="every viking's time, combined"
        />
        <StatTile
          label={metricInfo('deaths_total').label}
          value={formatMetricValue('deaths_total', milestoneAgg.deaths_total ?? 0)}
          icon={<Skull size={16} />}
          hint="every fall, all vikings"
        />
        {/* "Pins", not "Places named": section 4 of the UX plan makes pin the
            one word for this thing and retires "place", the plan's own sketch
            labels this tile Pins, and it is the word a player types (/pin). */}
        <StatTile
          label="Pins"
          value={pins.length}
          icon={<MapPin size={16} />}
          hint="named on the atlas with /pin"
        />
      </div>

      {/* READING ORDER, deliberately (UX plan, proposal 2): the band above is
          for the stranger, then facts the hero does not carry, then what the
          warband is doing about the world (the objective), who is on, what it
          has earned and what is next, and only then the record. Boss progress
          used to be the LAST card on the page, under everything else. */}
      {/* ─────────────────────── BOSS PROGRESS ───────────────── */}
      {/* The count + progress bar now live in the hero; what remains here is
          what the hero cannot say: which beast is next, and which are down. */}
      <Card>
        <CardHeader
          title="Boss progress"
          icon={<Skull size={16} />}
          action={
            <Link
              href="/world"
              className="gold-ring inline-flex items-center gap-1 rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
            >
              The boss timeline <ArrowRight size={13} />
            </Link>
          }
        />
        <CardBody className="space-y-5">
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
                    className="prose-link gold-ring rounded-sm font-display text-gold-light transition-colors hover:text-gold"
                  />
                  <span className="text-muted"> in the {nextBoss.biome}</span>
                </p>
              </div>
            </div>
          ) : saga.sagaComplete ? (
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-gold-light">
                <Crown size={18} />
              </span>
              <div>
                {/* The pair to "Current objective" above, and plainly said:
                    "Saga" is retired as a label everywhere the reader can see
                    it. The flavour is the line underneath. */}
                <p className="text-xs uppercase tracking-wider text-muted">Every boss felled</p>
                <p className="mt-0.5 text-ash">
                  Every forsaken one has fallen. The tenth world belongs to the bold.
                </p>
              </div>
            </div>
          ) : (
            /* Empty ledger: the read failed, or the rows are not there yet. Say so —
               claiming victory here is exactly the T-3 audit finding (site-2). */
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-muted">
                <Skull size={18} />
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted">Current objective</p>
                <p className="mt-0.5 text-ash-dim">
                  Unknown for now. The ledger of the Forsaken did not answer.
                </p>
              </div>
            </div>
          )}

          <hr className="rune-divider" />

          {/* Felled bosses */}
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted">Felled so far</p>
            {felledBosses.length === 0 ? (
              <p className="text-sm text-ash-dim">
                {saga.ledgerEmpty
                  ? 'The ledger did not answer. Nothing can be counted right now.'
                  : 'None yet. Every forsaken one still holds its ground.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {felledBosses.map((b) => (
                  <Badge key={b.id} tone="gold">
                    <Crown size={12} />
                    <BossLink
                      name={b.name}
                      className="gold-ring rounded-sm transition-colors hover:underline"
                    />
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ──────────────────── WHO IS ON NOW ──────────────────── */}
      {/* Full width: the hall's pulse is the first live thing a returning
          viking looks for, and at 1440px the roster reads four names across
          instead of two. */}
      <Hearth status={status} online={online} statsStale={statsStale} />

      {/* ───────────── GREAT DEEDS AND COMING UP ─────────────── */}
      {/* Side by side on a wide screen: what the warband has earned, and what
          it has agreed to turn up for. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <GreatDeedsCard summary={milestoneSummary} />

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
      </div>

      {/* ─────────────────────── RECENT STORY ────────────────── */}
      <Card>
        <CardHeader
          title="Recent story"
          icon={<ScrollText size={16} />}
          action={
            <Link
              href="/events"
              className="gold-ring rounded text-xs font-medium text-gold-light hover:text-gold-light/80"
            >
              The full story →
            </Link>
          }
        />
        <CardBody className="p-0">
          {events.length === 0 ? (
            /* On launch night this card IS the Hall, so it carries the way
               in rather than only saying it is empty. "Story" here, not
               "saga": the card above it, the tab and the page it opens all
               say Story. */
            <EmptyState
              icon={<ScrollText size={28} />}
              title="The story has not begun"
              message="Deeds, deaths and conquests will be etched here as they happen. Be the first: install the mods and join."
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

      {/* ─────────────────────── THE OATH TEASER ─────────────── */}
      {/* /oath folded into /players#oaths (it is a 308 in next.config.ts), so
          this points at where the wall actually lives rather than paying for
          the redirect hop on every click. */}
      <Link href="/players#oaths" className="gold-ring block rounded-[var(--radius-card)]">
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
                      the oath wall, and nested anchors are invalid HTML. */}
                  <span className="font-display text-gold-light">{latestOathName}</span>
                  <span className="italic">: &ldquo;{latestOath.oath_text}&rdquo;</span>
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-ash-dim">
                  Be the first to swear your oath to Odin.
                </p>
              )}
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-gold-light">
              {/* Spelled exactly as the section it opens, which is headed
                  "Oaths sworn" on /players. One object, one spelling. */}
              Oaths sworn
              <ArrowRight size={14} />
            </span>
          </CardBody>
        </Card>
      </Link>
    </div>
  );
}
