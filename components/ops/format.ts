// Small pure formatting helpers shared by the cockpit's server table and its
// client controls. Kept dependency-free so either side can import it.

/** "12s ago" / "5m ago" / "2h ago" / "3d ago". */
export function timeAgoShort(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** Compact age from a seconds value: "42s" / "5m" / "2h" / "—" for null. */
export function ageLabel(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** "every ~2m" cadence label from a seconds value (0 → live). */
export function cadenceLabel(sec: number): string {
  if (sec <= 0) return 'live';
  if (sec < 90) return `~${sec}s`;
  if (sec < 90 * 60) return `~${Math.round(sec / 60)}m`;
  return `~${Math.round(sec / 3600)}h`;
}
