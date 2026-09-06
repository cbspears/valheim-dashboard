import { clsx } from 'clsx';

export type JumpLink = {
  href: string;
  label: string;
  /** the groups inside a section, indented under it on a wide screen */
  children?: { href: string; label: string }[];
};

/**
 * The wayfinder for a page that is thousands of pixels long.
 *
 * ON A WIDE SCREEN it is a rail: a sticky column of links pinned under the
 * site header, so a reader ten thousand pixels down can still move. The header
 * is 64px and sticky itself (components/NavBar.tsx `h-16`), so the rail sits at
 * top-20 and every target carries scroll-mt-20 to match.
 *
 * ON A PHONE it collapses to the wrapped row of chips this page has always had.
 * The rail is not sticky there and never scrolls sideways: a horizontal
 * scroller inside a 390px page is the one thing this site has never shipped.
 * `min-h-11` is the touch target, 44px, set as a floor rather than inferred
 * from padding: text-xs is a 16px line, so the py-2.5 that used to carry this
 * alone measured 38px. It clears WCAG 2.2 SC 2.5.8's 24px either way, but the
 * plan asked for 44 and 44 is what a thumb wants.
 *
 * The register's groups live behind disclosures, so a chip pointing into one
 * lands on its summary rather than inside it. MEASURED in Chromium 147: the
 * browser does NOT open the disclosure on the way, so the reader lands on the
 * heading they asked for with one click left to make. That is why the id sits
 * on the <details> and not on something inside it: an id inside a shut
 * disclosure is an id nothing can scroll to. The group draws a gold ring while
 * it is the target, so it is obvious which heading was landed on (a ring and
 * not a border: see the note in RegisterSections.tsx on the unlayered
 * `.card-surface`, which eats any `target:border-*`).
 */
export function JumpList({ links }: { links: JumpLink[] }) {
  const flat = links.flatMap((l) => [l, ...(l.children ?? [])]);

  return (
    <nav aria-label="Sections of this page" className="mb-9 lg:sticky lg:top-20 lg:mb-0">
      <p className="mb-3 hidden text-xs tracking-wide text-muted uppercase lg:block">
        On this page
      </p>

      {/* A phone gets every link as one flat wrapped row: the nesting is a
          wide-screen affordance and a second level of chips would only cost a
          line. */}
      <ul className="flex flex-wrap gap-2 lg:hidden">
        {flat.map((l) => (
          <li key={l.href}>
            <a
              href={l.href}
              className="gold-ring flex min-h-11 items-center rounded-md border border-rune bg-surface-raised px-3 py-2.5 text-xs font-medium text-ash-dim transition-colors hover:border-gold-dim hover:text-ash"
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>

      <ul className="hidden border-l border-rune lg:block">
        {links.map((l) => (
          <li key={l.href}>
            <RailLink href={l.href} label={l.label} />
            {l.children?.length ? (
              <ul>
                {l.children.map((c) => (
                  <li key={c.href}>
                    <RailLink href={c.href} label={c.label} nested />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function RailLink({
  href,
  label,
  nested = false,
}: {
  href: string;
  label: string;
  nested?: boolean;
}) {
  return (
    <a
      href={href}
      className={clsx(
        'gold-ring -ml-px block border-l py-2 transition-colors hover:border-l-gold hover:text-gold-light',
        nested
          ? 'border-l-transparent pl-6 text-xs text-muted'
          : 'border-l-rune-bright pl-4 text-sm text-ash-dim'
      )}
    >
      {label}
    </a>
  );
}
