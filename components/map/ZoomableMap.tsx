'use client';

import { useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

const MAX_ZOOM = 6;

export interface ZoomableMapMarker {
  id: string;
  x: number; // 0-1 fraction of the image
  y: number;
  kind: 'base' | 'poi';
  name: string;
  by?: string | null;
}

/** One glyph per pin kind (mirrors MapTimelapse's demo glyphs). */
function MarkerGlyph({ kind }: { kind: ZoomableMapMarker['kind'] }) {
  const glow = 'shadow-[0_0_6px_rgba(200,149,42,0.8)]';
  return kind === 'base' ? (
    <span className={`block h-2 w-2 border border-gold bg-gold/80 ${glow}`} />
  ) : (
    <span className={`block h-1.5 w-1.5 rotate-45 border border-gold bg-gold/40 ${glow}`} />
  );
}

/** The map viewport: zoom buttons + drag-to-pan, edge-clamped. Same interaction
 *  model as the demo timelapse; this one wraps a single (live) image. */
export function ZoomableMap({
  src,
  alt,
  corner,
  markers = [],
}: {
  src: string;
  alt: string;
  corner?: React.ReactNode;
  markers?: ZoomableMapMarker[];
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // % of unscaled content
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const clampPan = (p: { x: number; y: number }, z: number) => {
    const limit = ((z - 1) * 50) / z;
    return {
      x: Math.max(-limit, Math.min(limit, p.x)),
      y: Math.max(-limit, Math.min(limit, p.y)),
    };
  };

  const changeZoom = (factor: number) => {
    setZoom((z) => {
      const next = Math.max(1, Math.min(MAX_ZOOM, z * factor));
      setPan((p) => clampPan(p, next));
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === 1) return;
    drag.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setPan((p) =>
      clampPan(
        { x: p.x + (dx / rect.width) * (100 / zoom), y: p.y + (dy / rect.height) * (100 / zoom) },
        zoom,
      ),
    );
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={viewportRef}
      className="relative mx-auto aspect-square w-full max-w-[min(100%,66vh)] touch-none overflow-hidden rounded-lg border border-rune bg-pitch"
      style={{ cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="relative h-full w-full"
        style={{ transform: `scale(${zoom}) translate(${pan.x}%, ${pan.y}%)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="block h-full w-full select-none" draggable={false} />

        {markers.map((m) => (
          <div
            key={m.id}
            className="group absolute animate-[fadeIn_0.6s_ease]"
            style={{
              left: `${m.x * 100}%`,
              top: `${m.y * 100}%`,
              transform: `translate(-50%, -50%) scale(${1 / zoom})`,
            }}
          >
            <div className="flex flex-col items-center gap-0.5">
              <MarkerGlyph kind={m.kind} />
              <span className="whitespace-nowrap font-display text-[11px] tracking-wide text-gold-light [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
                {m.name}
              </span>
            </div>
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-rune bg-pitch/95 px-3 py-2 text-left shadow-lg backdrop-blur-sm group-hover:block">
              <div className="font-display text-xs text-gold-light">{m.name}</div>
              <div className="mt-0.5 text-[11px] text-ash-dim">
                {m.kind === 'base' ? '⌂ Base' : '◆ Place of interest'}
                {m.by ? (
                  <>
                    {' '}
                    · pinned by <span className="text-ash">{m.by}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="absolute left-3 top-3 flex flex-col gap-1">
        <button
          onClick={() => changeZoom(1.5)}
          aria-label="Zoom in"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-rune bg-pitch/75 text-ash-dim backdrop-blur-sm transition-colors hover:text-gold-light gold-ring"
        >
          <Plus size={15} />
        </button>
        <button
          onClick={() => changeZoom(1 / 1.5)}
          aria-label="Zoom out"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-rune bg-pitch/75 text-ash-dim backdrop-blur-sm transition-colors hover:text-gold-light gold-ring"
        >
          <Minus size={15} />
        </button>
        {zoom > 1 && (
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            aria-label="Reset view"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-rune bg-pitch/75 text-ash-dim backdrop-blur-sm transition-colors hover:text-gold-light gold-ring"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>

      {corner}
    </div>
  );
}
