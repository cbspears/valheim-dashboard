import { Swords, Sword, Zap, Timer, Crosshair, Crown } from 'lucide-react';
import { Card, EmptyState, BossLink } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { matchBossName } from '@/lib/slug';
import type { PlayerStats, Boss } from '@/lib/types';

/** Seconds -> "1h 4m" / "12m 30s" / "45s". */
function dur(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Prettify a Valheim prefab/skill token into a readable name. */
function pretty(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw
    .replace(/^\$(?:enemy|item|character)_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

interface Rec {
  label: string;
  value: string;
  icon: React.ReactNode;
  show: boolean;
}

/**
 * The client-mod "Feats of Arms" surfacing for a single viking: combat records
 * (favored weapon, hardest hit, longest life…) plus the beasts they've felled
 * and the boss damage they've dealt. Renders nothing until the client reports.
 */
export function FeatsOfArms({
  stats,
  first,
  knownBosses = [],
}: {
  stats: PlayerStats | null;
  first: string;
  /** Known forsaken, used to resolve `bossDamage[].boss` (a raw prefab-ish
   *  token) to a real boss before linking — see `matchBossName`. */
  knownBosses?: Boss[];
}) {
  const gs = stats?.gs_stats ?? null;
  if (!gs) return null;

  const records: Rec[] = [
    {
      label: 'Favored Weapon',
      value: gs.records.topWeapon ? pretty(gs.records.topWeapon) : '—',
      icon: <Sword size={14} />,
      show: !!gs.records.topWeapon,
    },
    {
      label: 'Hardest Hit',
      value: formatNumber(Math.round(gs.records.hardestHit)),
      icon: <Zap size={14} />,
      show: gs.records.hardestHit > 0,
    },
    {
      label: 'Biggest Swing',
      value: formatNumber(Math.round(gs.records.biggestSwing)),
      icon: <Swords size={14} />,
      show: gs.records.biggestSwing > 0,
    },
    {
      label: 'Longest Life',
      value: dur(stats?.longest_life_sec ?? 0),
      icon: <Timer size={14} />,
      show: (stats?.longest_life_sec ?? 0) > 0,
    },
    {
      label: 'Kills in a Life',
      value: formatNumber(stats?.best_kills_before_death ?? 0),
      icon: <Crosshair size={14} />,
      show: (stats?.best_kills_before_death ?? 0) > 0,
    },
  ].filter((r) => r.show);

  const beasts = (gs.creatureKills ?? []).filter((c) => c.kills > 0).slice(0, 8);
  const bosses = (gs.bossDamage ?? []).filter((b) => b.damageDealt > 0).slice(0, 8);

  // Nothing worth showing yet.
  if (records.length === 0 && beasts.length === 0 && bosses.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Records */}
      <Card className="flex flex-col">
        <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
          <span className="text-gold">
            <Swords size={16} />
          </span>
          <h3 className="font-display text-sm uppercase tracking-wide text-ash">Feats of Arms</h3>
        </div>
        {records.length === 0 ? (
          <EmptyState
            icon={<Swords size={26} />}
            title="No feats yet"
            message={`${first} has yet to leave a mark worth carving.`}
          />
        ) : (
          <ul className="flex-1 divide-y divide-rune/50">
            {records.map((r) => (
              <li key={r.label} className="flex items-center gap-3 px-5 py-2.5">
                <span className="text-gold-dim">{r.icon}</span>
                <span className="flex-1 text-sm text-ash-dim">{r.label}</span>
                <span className="shrink-0 font-display text-sm tabular-nums text-ash">{r.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Beasts slain */}
      {beasts.length > 0 && (
        <Card className="flex flex-col">
          <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
            <span className="text-death">
              <Crosshair size={16} />
            </span>
            <h3 className="font-display text-sm uppercase tracking-wide text-ash">Beasts Slain</h3>
          </div>
          <ol className="flex-1 divide-y divide-rune/50">
            {beasts.map((c) => (
              <li key={c.creature} className="flex items-center gap-3 px-5 py-2.5">
                <span className="flex-1 truncate text-sm text-ash">{pretty(c.creature)}</span>
                <span className="shrink-0 text-sm tabular-nums text-ash-dim">
                  {formatNumber(c.kills)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* Boss damage */}
      {bosses.length > 0 && (
        <Card className="flex flex-col">
          <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
            <span className="text-gold">
              <Crown size={16} />
            </span>
            <h3 className="font-display text-sm uppercase tracking-wide text-ash">Bane of Bosses</h3>
          </div>
          <ol className="flex-1 divide-y divide-rune/50">
            {bosses.map((b) => {
              const label = pretty(b.boss);
              const matched = matchBossName(label, knownBosses);

              return (
                <li key={b.boss} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="flex-1 truncate text-sm text-ash">
                    <BossLink name={matched} className="hover:text-gold-light">
                      {label}
                    </BossLink>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-ash-dim">
                    {formatNumber(b.damageDealt)} dmg
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
