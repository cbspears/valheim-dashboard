'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipForward } from 'lucide-react';
import { ZoomableMap } from './ZoomableMap';
import type { LiveMapFrame } from '@/lib/data';

const FRAME_MS = 700; // real days are few (for now) — let each one breathe

/** The live known world + the REAL season timelapse, built from one archived
 *  frame per in-game day. The last position is always "Now" (current.webp). */
export function LiveWorld({
  currentUrl,
  updatedLabel,
  frames,
}: {
  currentUrl: string;
  updatedLabel: string | null;
  frames: LiveMapFrame[];
}) {
  // positions 0..frames.length-1 = archived days; frames.length = Now
  const nowIndex = frames.length;
  const [pos, setPos] = useState(nowIndex);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      setPos((p) => {
        if (p >= nowIndex) {
          setPlaying(false);
          return p;
        }
        return p + 1;
      });
    }, FRAME_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, nowIndex]);

  const atNow = pos >= nowIndex;
  const src = atNow ? `${currentUrl}?t=${updatedLabel ?? 'now'}` : frames[pos].url;
  const label = atNow ? 'Now' : `Day ${frames[pos].day}`;
  const replayReady = frames.length >= 2;

  return (
    <div>
      <ZoomableMap
        src={src}
        alt={`The known world — ${label}`}
        corner={
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <div className="rounded-md border border-rune bg-pitch/75 px-2.5 py-1 font-display text-sm text-gold-light backdrop-blur-sm">
              {label}
            </div>
            {atNow && (
              <div className="flex items-center gap-1.5 rounded-md border border-online/40 bg-pitch/75 px-2.5 py-1 text-xs font-medium text-online-glow backdrop-blur-sm">
                <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-online" />
                Live
              </div>
            )}
          </div>
        }
      />

      {replayReady ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => {
              if (!playing && pos >= nowIndex) setPos(0);
              setPlaying((p) => !p);
            }}
            aria-label={playing ? 'Pause the replay' : 'Replay the saga'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gold-dim bg-gold/10 text-gold-light transition-colors hover:border-gold hover:bg-gold/20 gold-ring"
          >
            {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={nowIndex}
            value={pos}
            onChange={(e) => {
              setPlaying(false);
              setPos(Number(e.target.value));
            }}
            aria-label="Scrub through the archived days"
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-raised"
            style={{ accentColor: 'var(--color-gold, #c8952a)' }}
          />
          <button
            onClick={() => {
              setPlaying(false);
              setPos(nowIndex);
            }}
            aria-label="Jump to now"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 text-xs font-medium tracking-wide text-ash-dim transition-colors hover:text-ash gold-ring"
          >
            <SkipForward size={13} />
            Now
          </button>
        </div>
      ) : (
        <p className="mt-3 text-center text-xs text-muted">
          The saga replay unlocks as in-game days bank — {frames.length === 1 ? 'one day' : `${frames.length} days`} archived so far.
        </p>
      )}
    </div>
  );
}
