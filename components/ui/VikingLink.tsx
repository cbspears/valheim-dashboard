import Link from 'next/link';
import type { ReactNode } from 'react';
import { vikingPath } from '@/lib/slug';

/**
 * Sitewide treatment for a viking's name wherever it renders: a link to their
 * `/viking/[slug]` page that reads like plain text until you touch it — no
 * default browser blue/underline, just the gold accent on hover/focus that the
 * rest of the design system uses (see `gold-ring` in globals.css). Renders
 * plain text (no anchor) when there's no name to link to, so callers never
 * need to guard against null/empty character names themselves.
 */
export function VikingLink({
  name,
  className,
  children,
}: {
  name: string | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const trimmed = name?.trim();
  if (!trimmed) return <>{children ?? name ?? ''}</>;

  return (
    <Link
      href={vikingPath(trimmed)}
      className={className ?? 'gold-ring rounded-sm transition-colors hover:text-gold-light'}
    >
      {children ?? trimmed}
    </Link>
  );
}
