// A label with its caption attached: hover for the short version, click for the
// full one.
//
// WHY THIS EXISTS ON TOP OF <Explain/>. The owner asked for "drop down or hover
// menus". A popover that opens on hover is the wrong shape for the full panel:
// it cannot be reached by keyboard, it steals focus from whatever is under it,
// and it flickers when the pointer crosses a table cell. So the two behaviours
// are split. Hovering a term shows the browser's own tooltip, which is the one
// tooltip on the page that never gets in the way and works on every element.
// Clicking the info button opens the real panel with all five fields.
//
// The tooltip text is the first sentence of `what`, not the whole field: a
// native tooltip has no scroll and a 600 character one is unreadable.
//
// SERVER COMPONENT. It renders text plus <Explain/>, which is the only client
// piece. Thirty of these on the overview cost one client component, not thirty.

import { clsx } from 'clsx';
import { Explain } from './Explain';
import type { GlossaryEntry } from '@/lib/ops/glossary';

/** First sentence of the field, capped, for a native title attribute. */
export function shortHint(entry: GlossaryEntry, maxLen = 180): string {
  const first = entry.what.split(/(?<=\.)\s/)[0] ?? entry.what;
  const text = first.length > maxLen ? `${first.slice(0, maxLen - 1).trimEnd()}…` : first;
  return `${entry.title}: ${text}`;
}

export interface ExplainTermProps {
  /** The caption. Pass GLOSSARY['<id>']. */
  entry: GlossaryEntry;
  /**
   * The visible label. Defaults to the entry's own title, which is how it is
   * spelled everywhere else on the page.
   */
  children?: React.ReactNode;
  /** Trigger size, forwarded to <Explain/>. 'md' beside a section heading. */
  size?: 'sm' | 'md';
  /** Preferred panel edge, forwarded to <Explain/>. */
  align?: 'start' | 'end';
  /**
   * Dotted underline under the label, so it reads as a term that has a
   * definition. Off inside table headers, where every cell would get one.
   */
  underline?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
  /** Extra classes for the label itself, for size and colour at the call site. */
  labelClassName?: string;
}

export function ExplainTerm({
  entry,
  children,
  size = 'sm',
  align = 'start',
  underline = false,
  className,
  labelClassName,
}: ExplainTermProps) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <span
        title={shortHint(entry)}
        className={clsx(
          underline && 'decoration-rune-bright underline decoration-dotted underline-offset-4',
          labelClassName,
        )}
      >
        {children ?? entry.title}
      </span>
      <Explain entry={entry} size={size} align={align} />
    </span>
  );
}
