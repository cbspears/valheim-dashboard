import { clsx } from 'clsx';
import type { ReactNode } from 'react';

type Tone = 'gold' | 'online' | 'offline' | 'death' | 'raid' | 'frost' | 'neutral';

const TONES: Record<Tone, string> = {
  gold: 'bg-gold/10 text-gold-light border-gold-dim/50',
  online: 'bg-online/10 text-online-glow border-online/40',
  offline: 'bg-offline/10 text-muted border-rune',
  death: 'bg-death/10 text-death border-death/40',
  raid: 'bg-raid/10 text-raid border-raid/40',
  frost: 'bg-frost/10 text-frost border-frost/40',
  neutral: 'bg-surface-raised text-ash-dim border-rune',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
