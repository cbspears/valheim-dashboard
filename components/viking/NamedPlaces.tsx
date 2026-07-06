import Link from 'next/link';
import { MapPin, Compass } from 'lucide-react';
import { Card, EmptyState, Badge } from '@/components/ui';

// A viking's named places come from the real `pins` table (in-game /pin,
// captured server-side and credited to the pinner's exact character name).
export interface NamedPlace {
  id: string;
  name: string;
  kind: string; // 'base' | 'poi'
  day: number | null;
}

const KIND_LABEL: Record<string, string> = { base: 'Settlement', poi: 'Landmark' };
// Rune-like glyphs: a hearth for a settlement, a marker lozenge for a landmark.
const KIND_GLYPH: Record<string, string> = { base: '⌂', poi: '◆' };

export function NamedPlaces({ places, first }: { places: NamedPlace[]; first: string }) {
  // Newest ground claimed first (highest in-game day), unknown days last.
  const sorted = [...places].sort((a, b) => (b.day ?? -1) - (a.day ?? -1));

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
          title="No places named yet"
          message={`${first} hasn't named any places yet — shout /pin <name> in-game to plant a marker.`}
        />
      ) : (
        <ul className="divide-y divide-rune/50">
          {sorted.map((p) => (
            <li key={p.id}>
              <Link
                href="/map"
                className="gold-ring flex items-baseline gap-3 px-5 py-2.5 transition-colors hover:bg-surface-raised/50"
                title={`See ${p.name} on the map`}
              >
                <span
                  aria-hidden
                  className="w-4 shrink-0 translate-y-0.5 text-center font-display text-gold-dim"
                >
                  {KIND_GLYPH[p.kind] ?? '◆'}
                </span>
                <span className="flex-1 font-display text-sm text-ash">{p.name}</span>
                <Badge tone="neutral">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                {p.day != null && (
                  <span className="shrink-0 font-display text-xs text-gold-dim">Day {p.day}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
