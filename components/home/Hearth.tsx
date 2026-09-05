import { Flame, Sun } from 'lucide-react';
import { Card, CardHeader, CardBody, OnlineDot, VikingLink } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import type { Player, ServerStatus } from '@/lib/types';

type HearthState = 'lively' | 'banked' | 'sleeping';

/**
 * The one line the Hearth shows when the server is up but the stats feed has
 * gone quiet (lib/data statsFreshness). Says what still works, because the log
 * poller keeps presence and deaths flowing without the Emitter.
 */
const STATS_PAUSED_LINE = 'Live stats are paused; joins and deaths still count.';

/**
 * The Hearth — the Hall's pulse, distilled into one card. Reacts to server
 * status + who's online with a lit/banked/dark ember treatment and saga-voiced
 * copy. Pure-CSS flame glow, scoped below (globals.css stays untouched).
 */
export function Hearth({
  status,
  online,
  statsStale = false,
}: {
  status: ServerStatus | null;
  online: Player[];
  /** Server reads online but server_status has gone stale — see lib/data statsFreshness. */
  statsStale?: boolean;
}) {
  const isOnline = status?.is_online ?? false;
  const playerCount = status?.player_count ?? online.length;
  const worldDay = status?.world_day;

  const state: HearthState = !isOnline ? 'sleeping' : playerCount > 0 ? 'lively' : 'banked';

  const copy = {
    lively: {
      title: 'The hall is lively',
      body:
        typeof worldDay === 'number'
          ? `Day ${worldDay}. Voices and laughter ring beneath the rafters.`
          : 'Voices and laughter ring beneath the rafters.',
    },
    banked: {
      title: 'The hall is quiet',
      body:
        typeof worldDay === 'number'
          ? `Day ${worldDay}. The server is up, but no one is online.`
          : 'The server is up, but no one is online.',
    },
    sleeping: {
      title: 'The hall sleeps',
      body: 'The server is offline.',
    },
  }[state];

  return (
    <Card glow={state === 'lively'}>
      <CardHeader
        title="The Hearth"
        icon={<Flame size={16} />}
        action={
          typeof worldDay === 'number' && state !== 'sleeping' ? (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Sun size={12} className="text-gold-dim" />
              Day {worldDay}
            </span>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        <div className="flex items-center gap-4">
          <div className={`hearth-ember hearth-ember--${state}`} aria-hidden="true">
            <Flame size={22} className="hearth-ember-icon" strokeWidth={2} />
          </div>
          <div>
            <p className="font-display text-base text-ash">{copy.title}</p>
            <p className="mt-0.5 text-sm text-ash-dim">{copy.body}</p>
          </div>
        </div>

        {statsStale && (
          <p className="rounded-md border border-gold-dim/40 bg-gold/5 px-3 py-2 text-xs leading-relaxed text-gold-light">
            {STATS_PAUSED_LINE}
            {status?.updated_at ? ` Last stats update ${timeAgo(status.updated_at)}.` : ''}
          </p>
        )}

        {state === 'lively' && (
          <>
            <hr className="rune-divider" />
            <ul className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {online.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 text-sm">
                  <OnlineDot online />
                  <VikingLink
                    name={p.character_name}
                    className="gold-ring truncate rounded-sm text-ash transition-colors hover:text-gold-light"
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>

      <style>{`
        .hearth-ember {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 3rem;
          height: 3rem;
          flex-shrink: 0;
          border-radius: 9999px;
          border: 1px solid var(--color-rune);
        }
        .hearth-ember-icon { position: relative; z-index: 1; }

        .hearth-ember--lively {
          background: radial-gradient(circle, rgba(232, 184, 75, 0.35), rgba(200, 149, 42, 0.08) 70%);
          border-color: var(--color-gold-dim);
          color: var(--color-gold-light);
          animation: hearth-flicker 2.4s ease-in-out infinite;
        }
        .hearth-ember--banked {
          background: radial-gradient(circle, rgba(200, 149, 42, 0.16), transparent 70%);
          border-color: var(--color-rune-bright);
          color: var(--color-gold-dim);
        }
        .hearth-ember--sleeping {
          background: radial-gradient(circle, rgba(200, 149, 42, 0.05), transparent 70%);
          color: var(--color-muted);
        }

        @keyframes hearth-flicker {
          0%, 100% { box-shadow: 0 0 14px 1px rgba(232, 184, 75, 0.35); transform: scale(1); }
          50% { box-shadow: 0 0 20px 4px rgba(232, 184, 75, 0.5); transform: scale(1.04); }
        }

        @media (prefers-reduced-motion: reduce) {
          .hearth-ember--lively { animation: none; }
        }
      `}</style>
    </Card>
  );
}
