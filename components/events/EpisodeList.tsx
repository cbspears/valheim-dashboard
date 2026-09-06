import Link from 'next/link';
import { Skull, Compass, Clock, ScrollText, Swords } from 'lucide-react';
import type { Episode } from '@/lib/episodes';
import { phraseDeath } from '@/lib/episodes';
import { Card, EmptyState, VikingLink } from '@/components/ui';
import { EpisodeTales } from './EpisodeTales';
import { bossPath } from '@/lib/slug';

const EVENT_TZ = 'America/Chicago';

/** ISO -> "Sat, Jun 28" in the community's timezone. */
function episodeDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

function daysLabel(range: [number, number] | null): string | null {
  if (!range) return null;
  const [lo, hi] = range;
  // Hyphen, not an en dash: no en/em dashes in player-facing text (CLAUDE.md).
  return lo === hi ? `Day ${lo}` : `Days ${lo}-${hi}`;
}

/** "3.5" -> "3.5", "4.0" -> "4" — hours read cleanly on the stat row. */
function trimHours(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

const SHOWN = 10;

export function EpisodeList({ episodes }: { episodes: Episode[] }) {
  if (episodes.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<ScrollText size={28} />}
          title="The season has not yet begun"
          message="Nothing recorded yet. Every night anyone plays becomes a card here."
          action={
            <Link
              href="/get-started"
              className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
            >
              Get Started
            </Link>
          }
        />
      </Card>
    );
  }

  // Newest episode first; keep the latest handful, note the rest.
  const latest = [...episodes].reverse();
  const shown = latest.slice(0, SHOWN);
  const remaining = latest.length - shown.length;

  return (
    <div className="flex flex-col gap-4">
      {shown.map((ep) => (
        <EpisodeCard key={ep.number} ep={ep} />
      ))}

      {remaining > 0 && (
        <p className="px-1 pt-1 text-center text-sm text-muted">
          …and {remaining} earlier {remaining === 1 ? 'night' : 'nights'}, back to the founding.
        </p>
      )}
    </div>
  );
}

function EpisodeCard({ ep }: { ep: Episode }) {
  const days = daysLabel(ep.worldDayRange);

  return (
    <Card className="p-5">
      {/* header line: Night N · Sat, Jun 28 · Days 88-91 */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs font-medium uppercase tracking-[0.18em] text-gold">
        <span>Night {ep.number}</span>
        <span className="text-rune-bright">·</span>
        <span className="text-muted normal-case tracking-normal">{episodeDate(ep.startedAt)}</span>
        {days && (
          <>
            <span className="text-rune-bright">·</span>
            <span className="text-muted normal-case tracking-normal">{days}</span>
          </>
        )}
      </div>

      {/* title — a sword glyph links to the war room when this night felled a boss */}
      <h3 className="mt-1.5 flex items-center gap-2 font-display text-xl text-gold-light">
        {ep.title}
        {ep.bossKills.length > 0 && (
          <Link
            href={bossPath(ep.bossKills[0])}
            title={`Visit ${ep.bossKills[0]}'s war room`}
            className="gold-ring inline-flex text-gold transition-colors hover:text-gold-light"
          >
            <Swords size={16} />
          </Link>
        )}
      </h3>

      {/* dynamic saga blurb of what happened this day */}
      {ep.description && (
        <p className="mt-2 text-sm leading-relaxed text-ash-dim">{ep.description}</p>
      )}

      {/* what the Storyteller wrote about this night, when anyone did */}
      <EpisodeTales tales={ep.tales} />

      {/* Participant chips. The whole chip is the link, not the 22 px of text
          inside it: a 51x15 target with 22 px between centres fails SC 2.5.8
          even on its spacing exception. */}
      {ep.participants.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {ep.participants.map((p) => (
            <VikingLink
              key={p.name}
              name={p.name}
              className="gold-ring inline-flex items-center rounded-full border border-rune bg-surface-raised px-3 py-1.5 text-xs text-ash-dim transition-colors hover:border-gold-dim hover:text-gold-light"
            />
          ))}
        </div>
      )}

      {/* compact stat row: hours played · deaths · discoveries.
          "viking-hours" was a coinage nobody has met: it reads as a unit of
          time rather than as "everyone's hours added up", which is what it is. */}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Clock size={13} className="text-gold" />
          <span className="tabular-nums text-ash-dim">{trimHours(ep.totalVikingHours)}</span> hours
          played by <span className="tabular-nums text-ash-dim">{ep.participants.length}</span>{' '}
          {ep.participants.length === 1 ? 'viking' : 'vikings'}
        </span>
        {ep.deaths.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Skull size={13} className="text-death/80" />
            <span className="tabular-nums text-ash-dim">{ep.deaths.length}</span>
            {ep.deaths.length === 1 ? 'death' : 'deaths'}
          </span>
        )}
        {ep.discoveries.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Compass size={13} className="text-frost/80" />
            <span className="tabular-nums text-ash-dim">{ep.discoveries.length}</span>
            {ep.discoveries.length === 1 ? 'discovery' : 'discoveries'}
          </span>
        )}
      </div>

      {/* One-line death notes. The WHOLE line is the link, not the name alone:
          a bare name measured 50x15 px with 20 px between target centres, which
          fails SC 2.5.8 including its spacing exception. */}
      {ep.deaths.length > 0 && (
        <ul className="mt-3 border-t border-rune/60 pt-2">
          {ep.deaths.map((d, i) => (
            <li key={`${d.name}-${i}`} className="text-xs text-ash-dim">
              <VikingLink
                name={d.name}
                className="gold-ring block rounded-sm py-1.5 leading-6 transition-colors hover:text-gold-light"
              >
                <span className="text-ash">{d.name.split(/\s+/)[0]}</span>
                <span className="text-muted">, {phraseDeath(d.cause)}</span>
              </VikingLink>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
