import { clsx } from 'clsx';
import type { HealthState } from '@/lib/ops/health';
import type { Severity } from '@/lib/ops/consistency';

const STATE_STYLES: Record<HealthState, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'bg-online/10 text-online-glow border-online/40' },
  degraded: { label: 'Degraded', cls: 'bg-raid/10 text-raid border-raid/40' },
  stale: { label: 'Stale', cls: 'bg-death/10 text-death border-death/40' },
  disabled: { label: 'Disabled', cls: 'bg-surface-raised text-muted border-rune' },
  unknown: { label: 'Unknown', cls: 'bg-frost/10 text-frost border-frost/40' },
};

export function StateChip({ state }: { state: HealthState }) {
  const s = STATE_STYLES[state];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide',
        s.cls,
      )}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  );
}

const SEVERITY_STYLES: Record<Severity, { label: string; cls: string }> = {
  critical: { label: 'Critical', cls: 'bg-death/10 text-death border-death/40' },
  warn: { label: 'Warning', cls: 'bg-raid/10 text-raid border-raid/40' },
  info: { label: 'Info', cls: 'bg-frost/10 text-frost border-frost/40' },
};

export function SeverityChip({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLES[severity];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide',
        s.cls,
      )}
    >
      {s.label}
    </span>
  );
}
