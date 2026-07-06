import Link from 'next/link';
import { clsx } from 'clsx';
import { Crown, Lock, Swords, Target, Trophy } from 'lucide-react';
import { Badge, Card, CardBody, EmptyState, VikingLink } from '@/components/ui';
import { BossPortrait } from '@/components/art/BossPortrait';
import { ART_ENABLED } from '@/config/art';
import { shortDate } from '@/lib/format';
import { bossPath } from '@/lib/slug';
import type { Boss } from '@/lib/types';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Vertical boss-progression timeline + a progress hero.
 * Killed forsaken are lit in gold; the first unkilled boss is highlighted
 * as the current objective; the rest are locked behind it.
 */
export function BossTimeline({ bosses }: { bosses: Boss[] }) {
  if (bosses.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Swords size={28} />}
          title="No bosses felled yet"
          message="The timeline lights up when the first forsaken falls."
        />
      </Card>
    );
  }

  const total = bosses.length;
  const killedCount = bosses.filter((b) => b.is_killed).length;
  const nextIndex = bosses.findIndex((b) => !b.is_killed);
  const nextBoss = nextIndex >= 0 ? bosses[nextIndex] : null;
  const allDone = killedCount === total;
  const pct = total > 0 ? Math.round((killedCount / total) * 100) : 0;

  return (
    <div>
      {/* Progress hero */}
      <Card glow className="mb-8">
        <CardBody className="flex flex-col gap-5 sm:gap-6">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted">
                Realm Progression
              </p>
              <p className="mt-1 font-display text-2xl text-ash sm:text-3xl">
                <span className="text-gold-light">{killedCount}</span>
                <span className="text-muted"> / {total} </span>
                forsaken defeated
              </p>
            </div>
            <Badge tone={allDone ? 'gold' : 'frost'}>
              {allDone ? (
                <>
                  <Trophy size={13} /> Realm conquered
                </>
              ) : (
                `${pct}% complete`
              )}
            </Badge>
          </div>

          {/* Segmented progress bar — one cell per forsaken */}
          <div className="flex gap-1.5" aria-hidden>
            {bosses.map((b, i) => (
              <div
                key={b.id}
                className={clsx(
                  'h-2 flex-1 rounded-full transition-colors',
                  b.is_killed
                    ? 'bg-gradient-to-r from-gold-dim to-gold shadow-[0_0_10px_-2px_rgba(200,149,42,0.7)]'
                    : i === nextIndex
                      ? 'bg-gold-dim/40 ring-1 ring-gold-dim/60'
                      : 'bg-rune'
                )}
              />
            ))}
          </div>

          <p className="text-sm text-muted">
            {allDone ? (
              'Every forsaken has fallen. The tenth world bows to the clan.'
            ) : nextBoss ? (
              <>
                Current objective:{' '}
                <span className="font-medium text-gold-light">{nextBoss.name}</span>
                <span className="text-muted"> · {nextBoss.biome}</span>
              </>
            ) : (
              'No forsaken charted on the map yet.'
            )}
          </p>
        </CardBody>
      </Card>

      {/* Timeline */}
      <ol className="relative">
        {bosses.map((boss, i) => {
          const isLast = i === bosses.length - 1;
          const status: 'killed' | 'next' | 'locked' = boss.is_killed
            ? 'killed'
            : i === nextIndex
              ? 'next'
              : 'locked';

          return (
            <li key={boss.id} className="relative flex gap-4 pb-8 last:pb-0 sm:gap-5">
              {/* Connector line — gold through the felled portion, rune beyond */}
              {!isLast && (
                <span
                  aria-hidden
                  className={clsx(
                    'absolute top-10 bottom-0 left-5 -ml-px w-px',
                    boss.is_killed
                      ? 'bg-gradient-to-b from-gold-dim to-gold-dim/30'
                      : 'bg-rune'
                  )}
                />
              )}

              {/* Node marker */}
              <div className="shrink-0">
                {status === 'killed' && (
                  <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 border-gold bg-gold/15 text-gold-light shadow-[0_0_18px_-4px_rgba(200,149,42,0.6)]">
                    <Crown size={18} />
                  </div>
                )}
                {status === 'next' && (
                  <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 border-gold bg-surface-raised text-gold shadow-[0_0_22px_-3px_rgba(200,149,42,0.65)]">
                    <span
                      aria-hidden
                      className="absolute inset-0 rounded-full ring-1 ring-gold/40 animate-ping"
                    />
                    <Swords size={18} />
                  </div>
                )}
                {status === 'locked' && (
                  <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 border-rune bg-surface text-muted">
                    <Lock size={16} />
                  </div>
                )}
              </div>

              {/* Content */}
              <div
                className={clsx(
                  'card-surface min-w-0 flex-1 p-4 sm:p-5',
                  status === 'killed' && 'border-l-2 border-l-gold',
                  status === 'next' &&
                    'border-l-2 border-l-gold-dim ring-1 ring-gold-dim/40 shadow-[0_0_30px_-16px_rgba(200,149,42,0.6)]',
                  status === 'locked' && 'bg-surface/60'
                )}
              >
                {/* Boss portrait — only once art has landed (ART_ENABLED),
                    so the timeline is byte-identical while the manifest is
                    empty. Floats beside the text; the card copy flows around. */}
                {ART_ENABLED && (
                  <div className="float-right ml-4 mb-2 w-16 sm:w-20">
                    <BossPortrait
                      name={boss.name}
                      status={status === 'killed' ? 'defeated' : status}
                    />
                  </div>
                )}

                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
                  Forsaken {ROMAN[i] ?? i + 1}
                </p>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h3 className="font-display text-lg">
                    <Link
                      href={bossPath(boss.name)}
                      className={clsx(
                        'gold-ring rounded transition-colors hover:text-gold-light',
                        status === 'killed' && 'text-ash',
                        status === 'next' && 'text-ash-dim',
                        status === 'locked' && 'text-muted'
                      )}
                    >
                      {boss.name}
                    </Link>
                  </h3>
                  <Badge tone={status === 'locked' ? 'offline' : 'frost'}>{boss.biome}</Badge>
                  {status === 'killed' && <Badge tone="gold">Defeated</Badge>}
                  {status === 'next' && <Badge tone="gold">Next objective</Badge>}
                  {status === 'locked' && <Badge tone="offline">Locked</Badge>}
                </div>

                {status === 'killed' && (
                  <>
                    <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-gold">
                      <Crown size={13} />
                      Felled {shortDate(boss.killed_at)}
                    </div>
                    {boss.players_present.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted">War party:</span>
                        {boss.players_present.map((p) => (
                          <Badge key={p} tone="neutral" className="text-[11px]">
                            <VikingLink
                              name={p}
                              className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                            />
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {status === 'next' && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-gold-light/90">
                    <Target size={13} />
                    Hunt this forsaken to unseal the next region.
                  </div>
                )}

                {status === 'locked' && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                    <Lock size={12} />
                    Locked — fell the previous forsaken to advance.
                  </div>
                )}

                {boss.notes && (
                  <p className="mt-3 border-l border-rune pl-3 text-sm italic text-muted">
                    {boss.notes}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
