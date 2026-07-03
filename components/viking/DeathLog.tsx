import { Skull } from 'lucide-react';
import { Card, EmptyState } from '@/components/ui';
import { phraseDeath } from '@/lib/episodes';
import type { GameEvent } from '@/lib/types';

// Some death causes arrive as a bare noun ("Troll", "Tree") and some as a full
// clause the game already wrote ("was slain by a Greydwarf Brute", "drowned").
// Bare nouns get the saga phrasing from lib/episodes; clauses are used as-is.
function phraseAny(cause: string): string {
  const c = cause.trim();
  if (!c) return 'lost to the wilds';
  if (/^(was\s|fell|drowned|slain|killed|burned|froze|starved|crushed|impaled)/i.test(c) || /\bby\b/i.test(c)) {
    return c.replace(/^was\s+/i, '');
  }
  return phraseDeath(c);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function worldDay(e: GameEvent): number | null {
  const d = e.metadata?.world_day;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

export function DeathLog({ deaths, first }: { deaths: GameEvent[]; first: string }) {
  const sorted = [...deaths].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
        <span className="text-death">
          <Skull size={16} />
        </span>
        <h3 className="font-display text-sm uppercase tracking-wide text-ash">The Death-Roll</h3>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<Skull size={26} />}
          title="Yet unbowed"
          message={`No death has been recorded for ${first}. Valhalla waits, but not today.`}
        />
      ) : (
        <ul className="divide-y divide-rune/50">
          {sorted.map((e, i) => {
            const cause = typeof e.metadata?.cause === 'string' ? (e.metadata.cause as string) : '';
            const day = worldDay(e);
            return (
              <li key={e.id ?? i} className="flex items-baseline gap-3 px-5 py-2.5">
                <span className="flex-1 text-sm text-ash-dim">{cap(phraseAny(cause))}</span>
                {day != null && (
                  <span className="shrink-0 font-display text-xs text-gold-dim">Day {day}</span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted">{dateLabel(e.created_at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
