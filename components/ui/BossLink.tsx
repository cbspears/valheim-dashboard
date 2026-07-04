import Link from 'next/link';
import type { ReactNode } from 'react';
import { bossPath } from '@/lib/slug';

/**
 * Sitewide treatment for a forsaken boss's name wherever it renders: a link
 * to its `/boss/[slug]` war-room. Same quiet gold-on-hover treatment as
 * `VikingLink` — see globals.css `gold-ring`. Renders plain text when there's
 * no name (or the name couldn't be resolved to a known boss — see
 * `matchBossName` in lib/slug.ts for names that arrive as raw prefab tokens).
 */
export function BossLink({
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
      href={bossPath(trimmed)}
      className={className ?? 'gold-ring rounded-sm transition-colors hover:text-gold-light'}
    >
      {children ?? trimmed}
    </Link>
  );
}
