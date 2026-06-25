import { formatDistanceToNow, format } from 'date-fns';

/** "5 minutes ago" — safe on null. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '—';
  }
}

/** "Jun 24, 2026" — safe on null. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'MMM d, yyyy');
  } catch {
    return '—';
  }
}

/** Minutes -> "42h 10m" / "10m". */
export function formatPlaytime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Live session length from joined_at to now. */
export function liveSessionLength(joinedAt: string | null | undefined): string {
  if (!joinedAt) return '—';
  const mins = Math.max(0, Math.round((Date.now() - new Date(joinedAt).getTime()) / 60000));
  return formatPlaytime(mins);
}

/** 1842 -> "1,842". */
export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString('en-US');
}

/** Distance in meters -> "84.2 km" / "920 m". */
export function formatDistance(meters: number | null | undefined): string {
  if (!meters || meters <= 0) return '0 m';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** 31.9 -> "31.9%" (drops a trailing ".0"). */
export function formatPercent(pct: number | null | undefined): string {
  if (!pct || pct <= 0) return '0%';
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
