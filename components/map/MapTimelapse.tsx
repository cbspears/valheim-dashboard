'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Pause, Play, SkipForward, X } from 'lucide-react';
import {
  MAP_DEMO_DAYS,
  MAP_DEMO_LABELS,
  type MapLabel,
} from '@/config/map-demo.generated';

/** Demo only — in production these come from gallery_photos rows linked to the marker. */
const DEMO_PLACE_PHOTOS: Record<string, string[]> = {
  Midgard: ['/banner-eilif.webp', '/og-eilif.jpg'],
  Draugheim: ['/bg-eilif.webp'],
};

const KIND_LABEL: Record<MapLabel['kind'], string> = {
  base: '⌂ Base',
  poi: '◆ Place of interest',
  boss: 'Boss altar',
  trader: 'Trader',
};

const pinVerb = (kind: MapLabel['kind']) =>
  kind === 'base' || kind === 'poi' ? 'pinned by' : 'first sighted by';

const frameSrc = (day: number) => `/map-demo/day-${String(day).padStart(3, '0')}.webp`;

/** One glyph per marker kind — base/poi are player pins; boss/trader are system layers. */
function MarkerGlyph({ kind }: { kind: 'base' | 'poi' | 'boss' | 'trader' }) {
  const glow = 'shadow-[0_0_6px_rgba(200,149,42,0.8)]';
  switch (kind) {
    case 'base':
      return <span className={`block h-2 w-2 border border-gold bg-gold/80 ${glow}`} />;
    case 'poi':
      return <span className={`block h-1.5 w-1.5 rotate-45 border border-gold bg-gold/40 ${glow}`} />;
    case 'boss':
      return <span className={`block h-2.5 w-2.5 rounded-full border-2 border-gold bg-death/40 ${glow}`} />;
    case 'trader':
      return <span className={`block h-2 w-2 rounded-full border border-gold bg-gold/80 ${glow}`} />;
  }
}

/** Milliseconds per frame while playing (~10s for a full season). */
const FRAME_MS = 100;

export function MapTimelapse() {
  const [day, setDay] = useState(MAP_DEMO_DAYS);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<MapLabel | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Warm the browser cache so scrubbing is instant: newest frames first
  // (that's what visitors see), then the rest in the background.
  useEffect(() => {
    const order: number[] = [];
    for (let d = MAP_DEMO_DAYS; d >= 1; d--) order.push(d);
    let i = 0;
    const loadNext = () => {
      if (i >= order.length) return;
      const img = new Image();
      img.onload = img.onerror = loadNext;
      img.src = frameSrc(order[i++]);
    };
    // a few parallel lanes
    for (let lane = 0; lane < 4; lane++) loadNext();
  }, []);

  useEffect(() => {
    if (!playing) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      setDay((d) => {
        if (d >= MAP_DEMO_DAYS) {
          setPlaying(false);
          return d;
        }
        return d + 1;
      });
    }, FRAME_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing]);

  const togglePlay = () => {
    if (!playing && day >= MAP_DEMO_DAYS) setDay(1); // replay from the start
    setPlaying((p) => !p);
  };

  return (
    <div>
      {/* The map itself */}
      <div className="relative overflow-hidden rounded-lg border border-rune bg-pitch">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frameSrc(day)}
          alt={`The known world as of day ${day}`}
          className="block aspect-square w-full select-none"
          draggable={false}
        />
        {MAP_DEMO_LABELS.filter((l) => l.day <= day).map((l) => (
          <button
            key={l.name}
            onClick={() => setSelected(l)}
            className="group absolute -translate-x-1/2 -translate-y-1/2 animate-[fadeIn_0.6s_ease] cursor-pointer gold-ring"
            style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%` }}
            aria-label={`${l.name} — ${KIND_LABEL[l.kind]}, ${pinVerb(l.kind)} ${l.by} on day ${l.day}`}
          >
            <div className="flex flex-col items-center gap-0.5">
              <MarkerGlyph kind={l.kind} />
              <span className="whitespace-nowrap font-display text-[11px] tracking-wide text-gold-light [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
                {l.name}
              </span>
            </div>
            {/* hover card */}
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-rune bg-pitch/95 px-3 py-2 text-left shadow-lg backdrop-blur-sm group-hover:block">
              <div className="font-display text-xs text-gold-light">{l.name}</div>
              <div className="mt-0.5 text-[11px] text-ash-dim">
                {KIND_LABEL[l.kind]} · {pinVerb(l.kind)}{' '}
                <span className="text-ash">{l.by}</span> · Day {l.day}
              </div>
              {DEMO_PLACE_PHOTOS[l.name] && (
                <div className="mt-0.5 flex items-center gap-1 text-[11px] text-gold-dim">
                  <Camera size={11} /> {DEMO_PLACE_PHOTOS[l.name].length}{' '}
                  {DEMO_PLACE_PHOTOS[l.name].length === 1 ? 'photo' : 'photos'} — click to view
                </div>
              )}
            </div>
          </button>
        ))}
        {/* day readout, engraved into the corner */}
        <div className="absolute right-3 top-3 rounded-md border border-rune bg-pitch/75 px-2.5 py-1 font-display text-sm text-gold-light backdrop-blur-sm">
          Day {day}
        </div>
        {/* marker legend */}
        <div className="absolute bottom-3 left-3 flex items-center gap-3.5 rounded-md border border-rune bg-pitch/75 px-2.5 py-1.5 backdrop-blur-sm">
          {(
            [
              ['base', 'Base'],
              ['poi', 'Place of interest'],
              ['boss', 'Boss altar'],
              ['trader', 'Trader'],
            ] as const
          ).map(([kind, label]) => (
            <span key={kind} className="flex items-center gap-1.5 text-[11px] tracking-wide text-ash-dim">
              <MarkerGlyph kind={kind} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Scrubber + transport */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause the timelapse' : 'Play the timelapse'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gold-dim bg-gold/10 text-gold-light transition-colors hover:border-gold hover:bg-gold/20 gold-ring"
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <input
          type="range"
          min={1}
          max={MAP_DEMO_DAYS}
          value={day}
          onChange={(e) => {
            setPlaying(false);
            setDay(Number(e.target.value));
          }}
          aria-label="Scrub through the season"
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-raised"
          style={{ accentColor: 'var(--color-gold, #c8952a)' }}
        />
        <button
          onClick={() => {
            setPlaying(false);
            setDay(MAP_DEMO_DAYS);
          }}
          aria-label="Jump to today"
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 text-xs font-medium tracking-wide text-ash-dim transition-colors hover:text-ash gold-ring"
        >
          <SkipForward size={13} />
          Today
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-muted">
        Day {day} of {MAP_DEMO_DAYS} — drag the slider to travel through the saga. Hover a marker
        for its story; click for photos.
      </p>

      {/* place panel */}
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
                {KIND_LABEL[selected.kind]} · {pinVerb(selected.kind)}{' '}
                <span className="text-ash">{selected.by}</span> · Day {selected.day}
              </p>
              {DEMO_PLACE_PHOTOS[selected.name] ? (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {DEMO_PLACE_PHOTOS[selected.name].map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={src}
                      src={src}
                      alt={`${selected.name} — from the gallery`}
                      className="aspect-video w-full rounded-md border border-rune object-cover"
                    />
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
