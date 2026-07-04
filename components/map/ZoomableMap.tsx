'use client';

import { useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

const MAX_ZOOM = 6;

/** The map viewport: zoom buttons + drag-to-pan, edge-clamped. Same interaction
 *  model as the demo timelapse; this one wraps a single (live) image. */
export function ZoomableMap({ src, alt, corner }: { src: string; alt: string; corner?: React.ReactNode }) {
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
