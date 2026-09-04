import { formatDistanceToNow } from 'date-fns';

// The community's timezone — event times are shown in Central regardless of
// where the server renders (Vercel runs in UTC). Intl handles the conversion
// deterministically, so server and client agree (no hydration mismatch).
const EVENT_TZ = 'America/Chicago';

/** "5 minutes ago" — safe on null. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '—';
  }
}

/**
 * "Jun 24, 2026" — safe on null. Dated in Central, like every other date on the
 * site: Vercel renders in UTC, and a 9 PM CT boss kill is already the next day
 * there, so a naive format would put the evening's deeds on tomorrow's date.
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
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

/** ISO -> "Sat, Jun 27 · 7:00 PM CT". */
export function formatEventWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
    return `${day} · ${time} CT`;
  } catch {
    return '—';
  }
}

/** Forward-looking countdown chip: "in 40 min" / "tomorrow" / "in 5 days". Timezone-independent (pure duration). */
export function eventCountdown(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'happening now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days <= 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

/**
 * Which calendar day (in Central) a moment falls on, as a plain day number so
 * two moments can be compared. "en-CA" formats as YYYY-MM-DD, which parses
 * cleanly; Date.UTC then flattens it to a day index. Exported so the Chronicle
 * can group by the same day the Episodes do — and so a server render and a
 * browser render agree.
 */
export function centralDayIndex(d: Date): number {
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(d)
    .split('-')
    .map(Number);
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
}

/**
 * "2026-08-27" — the Central calendar day a moment falls on, as a stable key.
 * Returns 'unknown' for a missing or unparseable timestamp.
 */
export function centralDayKey(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Hour of the day (0-23) in Central. */
function centralHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: EVENT_TZ,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d)
  );
}

/**
 * Countdown for the nav's next-gathering pill: same job as `eventCountdown`,
 * but it counts calendar days rather than 24-hour blocks, so a gathering this
 * evening reads "tonight" and one the next morning reads "tomorrow" — the way
 * a person would say it. Days are judged in Central, matching every other
 * event time on the site. `now` is injectable so the pill can recompute on the
 * client after mount (and so this is testable).
 */
export function gatheringCountdown(
  iso: string | null | undefined,
  now: number = Date.now()
): string {
  if (!iso) return '';
  const start = new Date(iso);
  const ms = start.getTime() - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'happening now';

  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;

  const dayGap = centralDayIndex(start) - centralDayIndex(new Date(now));
  if (dayGap <= 0) return centralHour(start) >= 17 ? 'tonight' : 'later today';
  if (dayGap === 1) return 'tomorrow';
  if (dayGap < 14) return `in ${dayGap} days`;
  return `in ${Math.round(dayGap / 7)} weeks`;
}

/** True once a gathering is a day out or nearer — the pill glows harder then. */
export function isGatheringImminent(
  iso: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return false;
  return ms < 86_400_000;
}

/** 31.9 -> "31.9%" (drops a trailing ".0"). */
export function formatPercent(pct: number | null | undefined): string {
  if (!pct || pct <= 0) return '0%';
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
