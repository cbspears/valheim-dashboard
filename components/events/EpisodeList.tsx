import Link from 'next/link';
import { Skull, Compass, Clock, ScrollText, Swords } from 'lucide-react';
import type { Episode } from '@/lib/episodes';
import { phraseDeath } from '@/lib/episodes';
import { Card, EmptyState, VikingLink } from '@/components/ui';
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
  return lo === hi ? `Day ${lo}` : `Days ${lo}–${hi}`;
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
          title="The season has not yet begun…"
          message="When the vikings gather, their nights will be chronicled here as episodes."
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
          …and {remaining} earlier {remaining === 1 ? 'episode' : 'episodes'}, back to the founding.
        </p>
      )}
    </div>
  );
}

function EpisodeCard({ ep }: { ep: Episode }) {
  const days = daysLabel(ep.worldDayRange);

  return (
    <Card className="p-5">
      {/* header line: Episode N · Sat, Jun 28 · Days 88–91 */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] font-medium uppercase tracking-[0.18em] text-gold-dim">
        <span>Episode {ep.number}</span>
        <span className="text-rune-bright">·</span>
        <span className="text-muted normal-case tracking-normal">{episodeDate(ep.startedAt)}</span>
        {days && (
          <>
            <span className="text-rune-bright">·</span>
            <span className="text-muted normal-case tracking-normal">{days}</span>
          </>
        )}
      </div>

      {/* title — a sword glyph links to the war-room when this night felled a forsaken */}
      <h3 className="mt-1.5 flex items-center gap-2 font-display text-xl text-gold-light">
        {ep.title}
        {ep.bossKills.length > 0 && (
          <Link
            href={bossPath(ep.bossKills[0])}
            title={`Visit ${ep.bossKills[0]}'s war-room`}
            className="gold-ring inline-flex text-gold-dim transition-colors hover:text-gold-light"
          >
            <Swords size={16} />
          </Link>
        )}
      </h3>

      {/* participant chips */}
      {ep.participants.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ep.participants.map((p) => (
            <span
              key={p.name}
              className="rounded-full border border-rune bg-surface-raised px-2.5 py-0.5 text-xs text-ash-dim"
            >
              <VikingLink
                name={p.name}
                className="gold-ring rounded-full transition-colors hover:text-gold-light"
              />
            </span>
          ))}
        </div>
      )}

      {/* compact stat row: viking-hours · deaths · discoveries */}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Clock size={13} className="text-gold-dim" />
          <span className="tabular-nums text-ash-dim">{trimHours(ep.totalVikingHours)}</span> viking-hours
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

      {/* one-line death notes */}
      {ep.deaths.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-rune/60 pt-3">
          {ep.deaths.map((d, i) => (
            <li key={`${d.name}-${i}`} className="text-xs text-ash-dim">
              <VikingLink
                name={d.name}
                className="gold-ring rounded-sm text-ash transition-colors hover:text-gold-light"
              >
                {d.name.split(/\s+/)[0]}
              </VikingLink>
              <span className="text-muted"> — {phraseDeath(d.cause)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
