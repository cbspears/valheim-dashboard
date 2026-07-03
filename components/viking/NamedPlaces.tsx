import Link from 'next/link';
import { MapPin, Compass } from 'lucide-react';
import { Card, EmptyState, Badge } from '@/components/ui';
import type { MapLabel } from '@/config/map-demo.generated';

// NOTE: demo data — a viking's named places come from MAP_DEMO_LABELS. At launch
// this swaps for the real `map_markers` table (same shape: name / day / kind / by).

const KIND_LABEL: Record<string, string> = {
  base: 'Settlement',
  poi: 'Landmark',
  boss: 'Altar',
  trader: 'Trader',
};

export function NamedPlaces({ places, first }: { places: MapLabel[]; first: string }) {
  const sorted = [...places].sort((a, b) => a.day - b.day);

  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-rune px-5 py-3.5">
        <span className="text-gold">
          <Compass size={16} />
        </span>
        <h3 className="font-display text-sm uppercase tracking-wide text-ash">Places They Named</h3>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<MapPin size={26} />}
          title="No ground yet claimed"
          message={`${first} has left no name upon the map — every frontier still awaits their mark.`}
        />
      ) : (
        <ul className="divide-y divide-rune/50">
          {sorted.map((p) => (
            <li key={`${p.name}-${p.day}`}>
              <Link
                href="/map"
                className="gold-ring flex items-baseline gap-3 px-5 py-2.5 transition-colors hover:bg-surface-raised/50"
              >
                <MapPin size={13} className="translate-y-0.5 shrink-0 text-gold-dim" />
                <span className="flex-1 font-display text-sm text-ash">{p.name}</span>
                <Badge tone="neutral">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                <span className="shrink-0 font-display text-xs text-gold-dim">Day {p.day}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
