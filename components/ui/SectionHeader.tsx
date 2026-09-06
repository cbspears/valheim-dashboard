import type { ReactNode } from 'react';

export function SectionHeader({
  title,
  subtitle,
  icon,
  action,
  as = 'h2',
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
  /**
   * Heading level. Every route needs exactly one `h1`, so the top-of-page
   * header on each page passes `as="h1"` and everything below it keeps the
   * default `h2`. Nothing else about the header changes: same font, same size,
   * same engraving — this is a document-outline fix, not a visual one.
   */
  as?: 'h1' | 'h2';
}) {
  const Heading = as;
  return (
    <div className="mb-5">
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          {icon && <span className="text-gold">{icon}</span>}
          <div>
            <Heading className="heading-engraved text-xl text-ash sm:text-2xl">{title}</Heading>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <hr className="rune-divider mt-3" />
    </div>
  );
}
