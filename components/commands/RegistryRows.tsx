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
      {/* h4: the group this sits in ("What the hall says") is an h3 on
          /resources, the same way a mod card's name is an h4 under its
          category. Nothing about the type changes. */}
      <h4 className="font-display text-sm tracking-wide text-ash">{entry.text}</h4>
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
      <dt className="text-xs tracking-wide text-gold uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed break-words text-ash-dim">{children}</dd>
    </div>
  );
}

/**
 * Whether a page of the register has an address a reader can be sent to.
 *
 * Only the fixed routes do; the dynamic ones (`/viking/<name>`, `/boss/<name>`)
 * are reached from inside another page. Exported because the page guide reads
 * it too, and a second copy of this rule would let the rows and the guide
 * disagree about what can be clicked.
 */
export function isLinkablePage(entry: SitePage): boolean {
  return entry.text.includes('<') === false;
}

/**
 * Whether a page of the register is a door: its own route, reachable by typing
 * it.
 *
 * Narrower than `isLinkablePage`, and the difference is the oath wall. Since
 * 2026-09-06 it is `/players#oaths`, a section of the Vikings page: a reader
 * can be sent straight to it, so the row links, but it is not a page and the
 * guide's subtitle must not count it as one. An anchor is a room inside a door,
 * the same as the two dynamic templates.
 */
export function isDoorPage(entry: SitePage): boolean {
  return isLinkablePage(entry) && entry.text.includes('#') === false;
}

/** One page of this site: its path, and one line on what it holds. */
export function PageRow({ entry }: { entry: SitePage }) {
  const linkable = isLinkablePage(entry);

  return (
    <li className="border-t border-rune/60 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-5">
        <div className="min-w-0 sm:w-[30%] sm:shrink-0">
          {linkable ? (
            <Link
              href={entry.text}
              className="prose-link font-mono text-xs break-words text-gold-light"
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
