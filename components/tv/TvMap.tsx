import type { LivePin } from '@/lib/data';

/**
 * The live fog-masked world, rendered big and calm for a second-monitor TV.
 * Deliberately NON-interactive: no zoom/pan/click chrome (see ZoomableMap for
 * the interactive /map version) — just the current snapshot plus the real
 * player-placed /pin markers, sized to read from across the room. Reuses the
 * `.map-text-halo` legibility utility from globals.css.
 *
 * TV-ONLY: `players` are the live positions of currently-online vikings. Per
 * Charlie's display decree these render on /tv exclusively and never on the
 * public /map atlas — keep this prop out of any shared map component.
 */

// A live player as the map draws it: fractional (0..1) map coordinates already
// converted from world coords by the caller, plus display fields.
export interface TvPlayerDot {
  name: string;
  x: number;
  y: number;
  biome: string | null;
}

function MarkerGlyph({ kind }: { kind: LivePin['kind'] }) {
  const glow = 'shadow-[0_0_8px_rgba(200,149,42,0.9)]';
  return kind === 'base' ? (
    <span className={`block h-3 w-3 border border-gold bg-gold/80 ${glow}`} />
  ) : (
    <span className={`block h-2.5 w-2.5 rotate-45 border border-gold bg-gold/40 ${glow}`} />
  );
}

export function TvMap({
  src,
  pins = [],
  players = [],
  updatedLabel,
}: {
  src: string;
  pins?: LivePin[];
  players?: TvPlayerDot[];
  updatedLabel?: string | null;
}) {
  return (
    <div className="relative aspect-square h-full max-h-full w-full overflow-hidden rounded-2xl border border-rune bg-pitch shadow-[0_0_60px_-18px_rgba(200,149,42,0.4)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="The known world of Eilif"
        className="block h-full w-full select-none object-cover"
        draggable={false}
      />

      {pins.map((p) => (
        <div
          key={p.id}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        >
          <MarkerGlyph kind={p.kind} />
          <span className="map-text-halo whitespace-nowrap font-display text-sm font-semibold tracking-wide text-gold-light">
            {p.name}
          </span>
        </div>
      ))}

      {/* Live players — distinct from the static gold pin markers: a bright,
          pulsing dot that reads as ALIVE, with the name (and current biome)
          labelled beneath it. TV-only per the display decree. */}
      {players.map((p) => (
        <div
          key={`player-${p.name}`}
          className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        >
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-online/70" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full border border-online-glow bg-online shadow-[0_0_12px_rgba(111,220,134,0.95)]" />
          </span>
          <span className="map-text-halo whitespace-nowrap font-display text-sm font-semibold tracking-wide text-online-glow">
            {p.name}
          </span>
          {p.biome && (
            <span className="map-text-halo -mt-0.5 whitespace-nowrap text-xs text-ash-dim">
              {p.biome}
            </span>
          )}
        </div>
      ))}

      {/* Live badge (top-right), mirrors LiveWorld's corner treatment */}
      <div className="absolute right-4 top-4 flex items-center gap-2 rounded-md border border-online/40 bg-pitch/85 px-3 py-1.5 text-sm font-medium text-online-glow backdrop-blur-sm">
        <span className="block h-2 w-2 animate-pulse rounded-full bg-online" />
        Live
      </div>

      {updatedLabel && (
        <div className="absolute bottom-4 left-4 rounded-md border border-rune bg-pitch/80 px-3 py-1.5 text-xs text-ash-dim backdrop-blur-sm">
          Charted{' '}
          {new Date(updatedLabel).toLocaleTimeString('en-US', {
            timeZone: 'America/Chicago',
            hour: 'numeric',
            minute: '2-digit',
          })}{' '}
          CT
        </div>
      )}
    </div>
  );
}
