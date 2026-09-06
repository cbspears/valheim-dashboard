'use client';

// The info button that captions a number.
//
// One of these sits beside anything on the cockpit that is a measurement: a
// state chip, a lag percentile, a queue depth, a budget bar. Pressing it opens a
// small panel with the same five fields every time (what it measures, why it
// matters, what healthy looks like, what to do when it is not, and a link), read
// out of lib/ops/glossary.ts.
//
// NO LIBRARIES. No popover package, no floating-ui, no portal.
//
// WHY THE PANEL IS position: fixed AND NOT absolute. The first cut placed it
// absolutely inside a relative wrapper, and every instance inside a <Card/> was
// sliced off at the card's edge: `components/ui/Card.tsx` is
// `card-surface relative overflow-hidden`, and an absolutely positioned
// descendant of an overflow-hidden ancestor is clipped by it. A fixed element's
// containing block is the viewport (no ancestor here sets transform, filter or
// contain), so overflow-hidden cannot touch it. The cost is that the position
// has to be computed rather than inherited: the trigger's rect is measured on
// open, the panel is flipped or shifted to stay on screen, its height is capped
// to the space actually available, and the whole thing is recomputed on scroll
// and resize while it is open.
//
// ACCESSIBILITY, and what each piece is actually for:
//   • The trigger is a real <button type="button"> with an aria-label that names
//     the term, so a screen reader announces "What is Poller lag? button" rather
//     than "button".
//   • aria-expanded plus aria-controls tie the trigger to the panel, and the
//     panel is role="dialog" with an aria-label, so it is announced as a thing
//     that opened rather than as loose text appearing mid-page.
//   • Opening moves focus into the panel (tabIndex -1). Closing returns focus to
//     the trigger, which is what keeps keyboard-only reading from dumping the
//     user back at the top of the document.
//   • Escape closes. A pointerdown anywhere outside closes. Focus leaving the
//     wrapper (tabbing past the last link inside) closes. All three listeners are
//     attached only while open and removed on close, so a page with thirty of
//     these carries no idle listeners.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { GlossaryEntry } from '@/lib/ops/glossary';

export interface ExplainProps {
  /**
   * The entry to show. Pass GLOSSARY['<id>'] from lib/ops/glossary.ts, or an
   * inline object of the same shape for a one-off caption that is not worth
   * registering.
   */
  entry: GlossaryEntry;
  /** Trigger size. 'sm' beside inline text, 'md' beside a section heading. */
  size?: 'sm' | 'md';
  /**
   * Preferred edge of the trigger to line the panel up with. The panel is
   * shifted back on screen if that preference would push it off the viewport,
   * so this is a hint, not a constraint.
   */
  align?: 'start' | 'end';
  /** Extra classes for the wrapper, for spacing against the label beside it. */
  className?: string;
}

/** Where the fixed panel sits, in viewport coordinates. */
interface PanelPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** Preferred panel width, and the margin kept clear of every viewport edge. */
const PANEL_WIDTH = 320;
const EDGE_MARGIN = 12;
/** Below this much room under the trigger, the panel opens upward instead. */
const MIN_ROOM_BELOW = 220;

export function Explain({ entry, size = 'sm', align = 'start', className }: ExplainProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  /**
   * Measure the trigger and place the panel: preferred edge first, shifted back
   * on screen if that overflows, opened upward when the room below is too
   * small, and always height-capped to the space it actually has (the body then
   * scrolls) rather than running off the bottom of the window.
   */
  const computePos = useCallback((): PanelPos | null => {
    const btn = buttonRef.current;
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(PANEL_WIDTH, vw - EDGE_MARGIN * 2);

    let left = align === 'end' ? r.right - width : r.left;
    left = Math.min(Math.max(EDGE_MARGIN, left), vw - width - EDGE_MARGIN);

    const roomBelow = vh - r.bottom - 8 - EDGE_MARGIN;
    const roomAbove = r.top - 8 - EDGE_MARGIN;
    if (roomBelow >= MIN_ROOM_BELOW || roomBelow >= roomAbove) {
      return { top: r.bottom + 8, left, width, maxHeight: Math.max(140, roomBelow) };
    }
    const maxHeight = Math.max(140, roomAbove);
    return { top: Math.max(EDGE_MARGIN, r.top - 8 - maxHeight), left, width, maxHeight };
  }, [align]);

  const toggle = useCallback(() => {
    if (open) {
      close(true);
      return;
    }
    // Placed before the panel exists, so it never paints in the wrong spot first.
    setPos(computePos());
    setOpen(true);
  }, [open, close, computePos]);

  // Every listener lives here, and only while the panel is open.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      close(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      close(false);
    };

    // A fixed panel does not travel with the page, so it is re-placed rather
    // than left behind. Capture phase catches scrolling inside a card's own
    // overflow container, not only the window.
    const onReflow = () => setPos(computePos());

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, close, computePos]);

  // Move focus into the panel once it exists, so the reader is where the text is.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const iconSize = size === 'md' ? 15 : 13;

  return (
    <span ref={wrapRef} className={clsx('relative inline-flex align-middle', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label={`What is ${entry.title}?`}
        className={clsx(
          'inline-flex items-center justify-center rounded-full border border-rune text-muted transition',
          'hover:border-gold-dim hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-dim',
          open && 'border-gold-dim text-gold',
          size === 'md' ? 'h-5 w-5' : 'h-4 w-4',
        )}
      >
        <Info size={iconSize} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && pos && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={`${entry.title}: what this measures`}
          tabIndex={-1}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
          className={clsx(
            'z-30 overflow-y-auto rounded-lg border border-rune-bright',
            'bg-surface-raised p-4 text-left shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)] focus:outline-none',
          )}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h3 className="font-display text-sm uppercase tracking-wide text-ash">{entry.title}</h3>
            <button
              type="button"
              onClick={() => close(true)}
              aria-label="Close explanation"
              className="-mr-1 -mt-1 rounded p-1 text-muted transition hover:text-ash focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-dim"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <dl className="space-y-2.5 text-xs leading-relaxed">
            <Field term="What it measures" text={entry.what} />
            <Field term="Why it matters" text={entry.why} />
            <Field term="Healthy" text={entry.healthy} tone="good" />
            <Field term="When it is not" text={entry.whenRed} tone="bad" />
          </dl>

          {entry.link && (
            <a
              href={entry.link.href}
              target={entry.link.href.startsWith('http') ? '_blank' : undefined}
              rel={entry.link.href.startsWith('http') ? 'noreferrer' : undefined}
              className="mt-3 inline-block text-xs font-medium text-gold-dim transition hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-dim"
            >
              {entry.link.label}
            </a>
          )}
        </div>
      )}
    </span>
  );
}

function Field({
  term,
  text,
  tone,
}: {
  term: string;
  text: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div>
      <dt
        className={clsx(
          'text-[10px] font-semibold uppercase tracking-wider',
          tone === 'good' && 'text-online-glow',
          tone === 'bad' && 'text-raid',
          !tone && 'text-muted',
        )}
      >
        {term}
      </dt>
      <dd className="text-ash-dim">{text}</dd>
    </div>
  );
}
