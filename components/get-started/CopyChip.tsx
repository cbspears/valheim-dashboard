'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * A styled, copy-pasteable code chip. Click anywhere on it to copy the raw
 * `value` to the clipboard. Used on the Get Started page for the modpack code,
 * the server address, and the in-game commands.
 */
export function CopyChip({
  value,
  label,
  className,
}: {
  value: string;
  /** what shows on the chip, if different from the copied value */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the text is selectable as a fallback */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Click to copy"
      className={clsx(
        'gold-ring group inline-flex max-w-full items-center gap-2 rounded border border-gold-dim/40 bg-gold/10 px-2.5 py-1.5 text-left font-mono text-xs font-semibold text-gold-light transition-colors hover:border-gold-dim hover:bg-gold/15',
        className
      )}
    >
      <span className="min-w-0 break-all">{label ?? value}</span>
      <span className="shrink-0 text-gold-dim group-hover:text-gold-light">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </span>
    </button>
  );
}
