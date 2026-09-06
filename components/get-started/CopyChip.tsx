'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { clsx } from 'clsx';

type CopyState = 'idle' | 'copied' | 'blocked';

/** What the chip says about itself. The word is the confirmation, not the icon. */
const STATUS: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  blocked: 'Copy blocked, select it by hand',
};

/**
 * A styled, copy-pasteable code chip. Click anywhere on it to copy the raw
 * `value` to the clipboard. Used on the Get Started page for the modpack code,
 * the server address, and the in-game commands.
 *
 * Three things this has to get right, because it carries the single most
 * important copy on the site:
 *   - it says "Copied" in words, and announces it from a live region beside
 *     the button, not from a 13px icon swap inside it;
 *   - it has one fixed name ("Copy the modpack code"), which is what a screen
 *     reader reads instead of 36 characters of code;
 *   - a blocked clipboard says so instead of failing in silence;
 *   - it is comfortable to hit with a thumb (44px on a touch screen).
 */
export function CopyChip({
  value,
  label,
  className,
  describe,
  oneLine,
}: {
  value: string;
  /** what shows on the chip, if different from the copied value */
  label?: string;
  className?: string;
  /**
   * What this chip holds, for the button's accessible name: "the modpack code"
   * becomes "Copy the modpack code". Without it the chip's own text is the
   * name, which is fine for a short address and poor for a 300-character code.
   */
  describe?: string;
  /**
   * Scroll the text sideways on one line instead of breaking it mid-word.
   * Defaults on for anything with a space in it, which is exactly the commands
   * (`/s /oath ...`, `xattr -cr ...`): a command broken across lines mid-word
   * cannot be read back. Codes, addresses and passwords have no spaces and keep
   * wrapping, which is what makes them fit a 390px screen.
   */
  oneLine?: boolean;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const shown = label ?? value;
  const scroll = oneLine ?? (value.includes(' ') || shown.includes(' '));

  // One fixed accessible name, always. Without it the name was computed from
  // the chip's own contents, so it read as the raw value with the status word
  // stuck on the end ("01a0440c-b54a-8d15-5882-22f86a4333b4Copy") and then
  // CHANGED under the reader's cursor when the word became "Copied". A name
  // that mutates on a focused control is reported as a new control by some
  // screen readers. `describe` is what makes it a sentence a person would say.
  const name = `Copy ${describe ?? shown}`;

  async function copy() {
    if (timer.current) window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      timer.current = window.setTimeout(() => setState('idle'), 2400);
    } catch {
      // Clipboard blocked (an insecure origin, a locked-down browser). The text
      // is still selectable; the chip now says so rather than doing nothing.
      setState('blocked');
      timer.current = window.setTimeout(() => setState('idle'), 6000);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={name}
        className={clsx(
          'gold-ring group inline-flex max-w-full items-center gap-2 rounded border border-gold-dim/40 bg-gold/10 px-2.5 py-1.5 text-left font-mono text-xs font-semibold text-gold-light transition-colors hover:border-gold-dim hover:bg-gold/15 pointer-coarse:min-h-11',
          className
        )}
      >
        <span
          className={clsx('min-w-0', scroll ? 'overflow-x-auto whitespace-nowrap' : 'break-all')}
        >
          {shown}
        </span>
        {/* The word on screen. Hidden from the reader because `aria-label`
            above is the name and the live region below is the announcement;
            left in the tree it would be read as part of the button twice. */}
        <span
          aria-hidden
          className={clsx(
            'flex items-center gap-1 font-sans font-medium',
            state === 'blocked' ? 'text-raid' : 'text-gold group-hover:text-gold-light',
            state === 'blocked' ? 'whitespace-normal' : 'shrink-0'
          )}
        >
          {state === 'copied' ? (
            <Check size={14} />
          ) : state === 'blocked' ? (
            <TriangleAlert size={14} />
          ) : (
            <Copy size={14} />
          )}
          {STATUS[state]}
        </span>
      </button>
      {/*
        The announcement, and it has to live OUTSIDE the button: a button's
        descendants are presentational, so a live region inside one is not
        reliably announced. It carries only what just happened and goes empty
        again at rest, so a copy is announced once instead of twice (a polite
        region announces text that appears, not text that is taken away).
      */}
      <span aria-live="polite" className="sr-only">
        {state === 'idle' ? '' : STATUS[state]}
      </span>
    </>
  );
}
