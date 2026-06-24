import { clsx } from 'clsx';

export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        online ? 'bg-online-glow online-pulse' : 'bg-offline',
        className
      )}
      aria-label={online ? 'online' : 'offline'}
    />
  );
}
