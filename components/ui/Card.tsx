import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Card({
  children,
  className,
  glow = false,
}: {
  children: ReactNode;
  className?: string;
  /** subtle gold edge glow for "hero" cards */
  glow?: boolean;
}) {
  return (
    <div
      className={clsx(
        'card-surface relative overflow-hidden',
        glow && 'shadow-[0_0_30px_-12px_rgba(200,149,42,0.35)] border-gold-dim/60',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  action,
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rune px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        {icon && <span className="text-gold">{icon}</span>}
        <h3 className="font-display text-sm tracking-wide text-ash uppercase">{title}</h3>
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx('p-5', className)}>{children}</div>;
}
