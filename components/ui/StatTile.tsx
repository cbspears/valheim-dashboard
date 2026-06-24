import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export function StatTile({
  label,
  value,
  icon,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={clsx('card-surface flex flex-col gap-1 p-4', className)}>
      <div className="flex items-center gap-2 text-muted">
        {icon && <span className="text-gold-dim">{icon}</span>}
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-display text-2xl text-ash">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
