import type { ReactNode } from 'react';

/**
 * Norse-flavored empty state. Use when a table/feed has no rows yet —
 * the dashboard should still feel alive and intentional with no data.
 */
export function EmptyState({
  icon,
  title,
  message,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-rune-bright">{icon}</div>}
      <p className="font-display text-base text-ash-dim">{title}</p>
      {message && <p className="max-w-sm text-sm text-muted">{message}</p>}
    </div>
  );
}
