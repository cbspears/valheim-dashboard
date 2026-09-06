import Link from 'next/link';
import type { Notification, SitePage } from '@/config/commands';

/**
 * One thing the hall says without being asked: where it lands, what sets it
 * off, and how often.
 *
 * Deliberately NOT a <table>. Three real columns of prose cannot be made to
 * fit 390px without either a horizontal scroller or a font nobody can read, so
 * the labels ride with their values in a stack on a phone and the row becomes a
 * grid only from sm up.
 */
export function NotificationRow({ entry }: { entry: Notification }) {
  return (
    <li className="border-t border-rune/60 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <h3 className="font-display text-sm tracking-wide text-ash">{entry.text}</h3>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Field label="Where">{entry.where}</Field>
        <Field label="What sets it off">{entry.trigger}</Field>
        <Field label="How often">{entry.cadence}</Field>
      </dl>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-wide text-gold-dim uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed break-words text-ash-dim">{children}</dd>
    </div>
  );
}

/** One page of this site: its path, and one line on what it holds. */
export function PageRow({ entry }: { entry: SitePage }) {
  // Only the fixed routes are linkable; the dynamic ones are reached from
  // inside another page and have no single address to send anyone to.
  const linkable = !entry.text.includes('<');

  return (
    <li className="border-t border-rune/60 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-5">
        <div className="min-w-0 sm:w-[30%] sm:shrink-0">
          {linkable ? (
            <Link
              href={entry.text}
              className="font-mono text-xs break-words text-gold-light hover:underline"
            >
              {entry.text}
            </Link>
          ) : (
            <span className="font-mono text-xs break-words text-ash">{entry.text}</span>
          )}
          <span className="ml-2 text-xs text-muted">{entry.label}</span>
        </div>
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-ash-dim">{entry.what}</p>
      </div>
    </li>
  );
}
