import { Flame, Sun, Users, ScrollText, CalendarClock, Map as MapIcon } from 'lucide-react';
import {
  getServerStatus,
  getOnlinePlayers,
  getLiveMap,
  getPins,
  getRecentEvents,
  getUpcomingEvents,
} from '@/lib/data';
import { describeEvent } from '@/lib/events';
import { timeAgo, eventCountdown, formatEventWhen } from '@/lib/format';
import { SERVER_NAME } from '@/config/server';
import { TvMap } from '@/components/tv/TvMap';
import { TvRefresh } from '@/components/tv/TvRefresh';

// Live values (roster, pulse, map snapshot) must be fresh on every request;
// TvRefresh re-runs this on a 60s interval client-side.
export const dynamic = 'force-dynamic';

type HallState = 'lively' | 'banked' | 'sleeping';

export default async function TvPage() {
  const [status, online, liveMap, pins, events, upcoming] = await Promise.all([
    getServerStatus(),
    getOnlinePlayers(),
    getLiveMap(),
    getPins(),
    getRecentEvents(8),
    getUpcomingEvents(1),
  ]);

  const isOnline = status?.is_online ?? false;
  const playerCount = status?.player_count ?? online.length;
  const worldDay = status?.world_day ?? 0;
  const nextUp = upcoming[0] ?? null;

  // Mirror the Hearth's three states.
  const hall: HallState = !isOnline ? 'sleeping' : playerCount > 0 ? 'lively' : 'banked';
  const hallCopy = {
    lively: { title: 'The hall is lively', body: 'Voices ring beneath the rafters.' },
    banked: { title: 'The fire is banked', body: 'The server is up, but no one sails.' },
    sleeping: { title: 'The hall sleeps', body: 'The server is offline.' },
  }[hall];

  return (
    <>
      <TvRefresh />

      {/* ── Minimal header: wordmark + world day ── */}
      <header className="flex shrink-0 items-baseline justify-between gap-6 px-8 pt-6 pb-4 md:px-12 md:pt-8">
        <h1 className="font-display text-4xl font-semibold tracking-[0.14em] text-gold-light md:text-5xl">
          {SERVER_NAME.toUpperCase()}
        </h1>
        <div className="flex items-center gap-2.5 text-xl text-ash-dim md:text-2xl">
          <Sun size={22} className="text-gold-dim" />
          Day {worldDay}
        </div>
      </header>

      {/* ── Main stage: map (dominant) + side rail ── */}
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-6 px-8 pb-8 md:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] md:px-12 md:pb-10">
        {/* Map — the dominant element */}
        <section className="flex min-h-0 items-center justify-center">
          {liveMap ? (
            <TvMap src={`${liveMap.url}?t=${liveMap.updatedAt ?? 'now'}`} pins={pins} updatedLabel={liveMap.updatedAt} />
          ) : (
            <div className="flex aspect-square h-full max-h-full w-full flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-rune bg-pitch/60 p-10 text-center">
              <MapIcon size={44} className="text-gold-dim" />
              <p className="max-w-md text-lg text-ash-dim">
                The map charts itself once the warband sails. The known world lands here the moment
                the {SERVER_NAME} server is live.
              </p>
            </div>
          )}
        </section>

        {/* Side rail */}
        <aside className="flex min-h-0 flex-col gap-6 overflow-hidden">
          {/* 1 + 2 — In the hall (roster) with the pulse state */}
          <div className="shrink-0 rounded-2xl border border-rune bg-surface/70 p-6">
            <div className="mb-4 flex items-center gap-3">
              <Flame size={22} className={hall === 'lively' ? 'text-gold-light' : 'text-gold-dim'} />
              <h2 className="font-display text-2xl tracking-wide text-ash">In the hall</h2>
            </div>
            <p className="font-display text-xl text-ash">{hallCopy.title}</p>
            <p className="mt-1 text-base text-ash-dim">{hallCopy.body}</p>

            {hall === 'lively' && (
              <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-rune pt-4 sm:grid-cols-2">
                {online.map((p) => (
                  <li key={p.id} className="flex items-center gap-3">
                    <span className="block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-online shadow-[0_0_8px_rgba(111,220,134,0.8)]" />
                    <span className="truncate font-display text-2xl text-ash">{p.character_name}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex items-center gap-2 border-t border-rune pt-4 text-base text-muted">
              <Users size={16} className="text-gold-dim" />
              {playerCount} {playerCount === 1 ? 'viking' : 'vikings'} sailing · Day {worldDay}
            </div>
          </div>

          {/* 3 — The chronicle ticker */}
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-rune bg-surface/70 p-6">
            <div className="mb-4 flex shrink-0 items-center gap-3">
              <ScrollText size={22} className="text-gold" />
              <h2 className="font-display text-2xl tracking-wide text-ash">The chronicle</h2>
            </div>
            {events.length === 0 ? (
              <p className="text-base text-ash-dim">
                The saga has not begun — deeds and deaths will be etched here as they happen.
              </p>
            ) : (
              <ul className="min-h-0 flex-1 space-y-3 overflow-hidden">
                {events.map((e) => {
                  const { icon: Icon, accent, description } = describeEvent(e);
                  return (
                    <li key={e.id} className="flex items-start gap-3">
                      <span className={`mt-1 shrink-0 ${accent}`}>
                        <Icon size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-lg leading-snug text-ash-dim">{description}</p>
                        <p className="text-sm text-muted">{timeAgo(e.created_at)}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 4 — Coming up (next gathering), small */}
          {nextUp && (
            <div className="shrink-0 rounded-2xl border border-rune bg-surface/70 px-6 py-4">
              <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted">
                <CalendarClock size={15} className="text-gold-dim" />
                Coming up
              </div>
              <p className="mt-1 truncate font-display text-xl text-ash">{nextUp.name}</p>
              <p className="text-base text-ash-dim">
                {formatEventWhen(nextUp.next_at)}
                <span className="text-gold-light"> · {eventCountdown(nextUp.next_at)}</span>
              </p>
            </div>
          )}
        </aside>
      </main>
    </>
  );
}
