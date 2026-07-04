'use client';

import { useRef, useState } from 'react';
import { Camera, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { VikingLink } from '@/components/ui';
import { timeAgo } from '@/lib/format';

const MAX_ZOOM = 6;

/** A real gallery photo linked to this pin (via caption ↔ place matching). */
export interface MarkerPhoto {
  id: string;
  url: string;
  caption: string | null;
  posted_by: string | null;
  posted_at: string;
}

export interface ZoomableMapMarker {
  id: string;
  x: number; // 0-1 fraction of the image
  y: number;
  kind: 'base' | 'poi';
  name: string;
  by?: string | null;
  day?: number | null;
  photos?: MarkerPhoto[];
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

const kindLabel = (kind: ZoomableMapMarker['kind']) =>
  kind === 'base' ? '⌂ Base' : '◆ Place of interest';

/** The map viewport: zoom buttons + drag-to-pan, edge-clamped. Same interaction
 *  model as the demo timelapse; this one wraps a single (live) image. Clicking a
 *  marker opens a place panel with that pin's real gallery photos. */
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
  const [selected, setSelected] = useState<ZoomableMapMarker | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false); // distinguish a drag from a marker click

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
    moved.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
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

        {markers.map((m) => {
          const count = m.photos?.length ?? 0;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (!moved.current) setSelected(m);
              }}
              className="group absolute animate-[fadeIn_0.6s_ease] cursor-pointer gold-ring"
              style={{
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                transform: `translate(-50%, -50%) scale(${1 / zoom})`,
              }}
              aria-label={`${m.name} — ${kindLabel(m.kind)}${m.by ? `, pinned by ${m.by}` : ''}${count ? `, ${count} photo${count === 1 ? '' : 's'}` : ''}`}
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
                  {kindLabel(m.kind)}
                  {m.by ? (
                    <>
                      {' '}
                      · pinned by{' '}
                      <VikingLink
                        name={m.by}
                        className="pointer-events-auto gold-ring rounded-sm text-ash transition-colors hover:text-gold-light"
                      />
                    </>
                  ) : null}
                </div>
                {count > 0 && (
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-gold-dim">
                    <Camera size={11} /> {count} {count === 1 ? 'photo' : 'photos'} — click to view
                  </div>
                )}
              </div>
            </button>
          );
        })}
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

      {/* Place panel — a pin's real gallery photos (mirrors the demo timelapse panel). */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-pitch/80 p-4 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="card-surface w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-rune px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <MarkerGlyph kind={selected.kind} />
                <h3 className="font-display text-base tracking-wide text-ash">{selected.name}</h3>
              </div>
              <button
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="rounded-md p-1.5 text-ash-dim hover:text-ash gold-ring"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-ash-dim">
                {kindLabel(selected.kind)}
                {selected.by ? (
                  <>
                    {' '}
                    · pinned by{' '}
                    <VikingLink
                      name={selected.by}
                      className="gold-ring rounded-sm text-ash transition-colors hover:text-gold-light"
                    />
                  </>
                ) : null}
                {selected.day ? ` · Day ${selected.day}` : ''}
              </p>
              {selected.photos && selected.photos.length > 0 ? (
                <div
                  className={`mt-4 grid gap-2 ${
                    selected.photos.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
                  }`}
                >
                  {selected.photos.map((photo, i) => (
                    <figure
                      key={photo.id}
                      className={
                        // odd count >1: let the first photo span the full row
                        selected.photos!.length > 1 &&
                        selected.photos!.length % 2 === 1 &&
                        i === 0
                          ? 'col-span-2'
                          : undefined
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.url}
                        alt={photo.caption ?? `${selected.name} — from the gallery`}
                        loading="lazy"
                        className="aspect-video w-full rounded-md border border-rune object-cover"
                      />
                      <figcaption className="mt-1 flex items-baseline justify-between gap-2 px-0.5">
                        <span className="truncate text-[11px] text-ash-dim">
                          {photo.caption ?? selected.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted">
                          {photo.posted_by ?? 'a viking'} · {timeAgo(photo.posted_at)}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <p className="mt-4 rounded-md border border-dashed border-rune px-4 py-5 text-center text-xs text-muted">
                  No photos of {selected.name} yet.
                </p>
              )}
              <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted">
                <Camera size={13} className="mt-0.5 shrink-0 text-gold-dim" />
                <span>
                  Post a screenshot in Discord, tag the bot, and name the place in your caption —
                  it lands in the Gallery and here.
                </span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
