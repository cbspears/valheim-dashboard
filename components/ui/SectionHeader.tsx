import type { ReactNode } from 'react';

export function SectionHeader({
  title,
  subtitle,
  icon,
  action,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          {icon && <span className="text-gold">{icon}</span>}
          <div>
            <h2 className="heading-engraved text-xl text-ash sm:text-2xl">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <hr className="rune-divider mt-3" />
    </div>
  );
}
