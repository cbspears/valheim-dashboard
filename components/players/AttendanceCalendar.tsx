'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { VikingLink } from '@/components/ui';

/** Minimal serialized session shape handed down from the server page. */
export interface AttendanceSession {
  character_name: string | null;
  joined_at: string;
  duration_minutes: number | null;
}

const WEEKS = 10;
const DAYS = WEEKS * 7;
const TZ = 'America/Chicago';

// Central-time calendar key ("2026-06-27") for a given instant. Bucketing an
// evening UTC session by its CT date so late nights land on the right day.
const KEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function ctKey(d: Date): string {
  return KEY_FMT.format(d);
}

// Weekday index (0=Sun..6=Sat) of an instant, in CT.
const WD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const WD_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
function ctWeekday(d: Date): number {
  return WD_INDEX[WD_FMT.format(d)] ?? 0;
}

const LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const MONTH_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short' });

interface DayCell {
  key: string;
  date: Date;
  hours: number;
  vikings: number;
  inFuture: boolean;
}

/** Anchor each day at ~noon CT so day-arithmetic never drifts across midnight on DST edges. */
function noonUtcFor(offsetDays: number, base: number): Date {
  return new Date(base + offsetDays * 86_400_000);
}

export function AttendanceCalendar({
  sessions,
  lockedTo,
}: {
  sessions: AttendanceSession[];
  /** Pin the grid to a single viking and hide the chip selector (viking pages). */
  lockedTo?: string;
}) {
  const vikings = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.character_name) set.add(s.character_name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const [chosen, setChosen] = useState<string | null>(null); // null = all vikings
  const selected = lockedTo ?? chosen; // lockedTo wins and can't be changed
  const setSelected = setChosen;

  const { columns, todayKey, hoursByKey } = useMemo(() => {
    // Bucket sessions → per-day hours + distinct vikings (respecting the filter).
    const hoursByKey = new Map<string, number>();
    const vikingSetByKey = new Map<string, Set<string>>();
    for (const s of sessions) {
      if (selected && s.character_name !== selected) continue;
      const key = ctKey(new Date(s.joined_at));
      const hrs = (s.duration_minutes ?? 0) / 60;
      hoursByKey.set(key, (hoursByKey.get(key) ?? 0) + hrs);
      if (s.character_name) {
        let set = vikingSetByKey.get(key);
        if (!set) vikingSetByKey.set(key, (set = new Set()));
        set.add(s.character_name);
      }
    }
    const vikingsByKey = new Map<string, number>();
    for (const [k, set] of vikingSetByKey) vikingsByKey.set(k, set.size);

    // Build the 10×7 grid ending on the Saturday of the current week.
    const now = new Date();
    // Base anchor at noon-ish CT of "today", then walk backward.
    const todayNoon = new Date(`${ctKey(now)}T12:00:00Z`).getTime();
    const todayWd = ctWeekday(now);
    const endSat = todayNoon + (6 - todayWd) * 86_400_000; // Saturday ending this week
    const gridStart = endSat - (DAYS - 1) * 86_400_000;
    const todayKey = ctKey(now);

    const cells: DayCell[] = [];
    for (let i = 0; i < DAYS; i++) {
      const date = noonUtcFor(i, gridStart);
      const key = ctKey(date);
      cells.push({
        key,
        date,
        hours: hoursByKey.get(key) ?? 0,
        vikings: vikingsByKey.get(key) ?? 0,
        inFuture: key > todayKey,
      });
    }
    // Columns = weeks (7 cells each, row 0=Sun..6=Sat).
    const columns: DayCell[][] = [];
    for (let c = 0; c < WEEKS; c++) columns.push(cells.slice(c * 7, c * 7 + 7));

    return { columns, todayKey, hoursByKey, vikingsByKey };
  }, [sessions, selected]);

  // Intensity scale (4 gold steps) from the busiest day currently shown.
  const maxHours = useMemo(() => {
    let m = 0;
    for (const col of columns) for (const cell of col) if (cell.hours > m) m = cell.hours;
    return m;
  }, [columns]);

  function levelFor(hours: number): number {
    if (hours <= 0) return 0;
    if (maxHours <= 0) return 1;
    return Math.min(4, Math.max(1, Math.ceil((hours / maxHours) * 4)));
  }

  // Streaks (consecutive CT days with any play) for the current view.
  const { current, longest } = useMemo(
    () => streaks(hoursByKey, todayKey),
    [hoursByKey, todayKey]
  );

  // Record-holder across all vikings (only meaningful in the "all" view).
  const champion = useMemo(() => {
    if (selected) return null;
    let best: { name: string; len: number } | null = null;
    for (const v of vikings) {
      const perDay = new Map<string, number>();
      for (const s of sessions) {
        if (s.character_name !== v) continue;
        const key = ctKey(new Date(s.joined_at));
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
      }
      const { longest } = streaks(perDay, todayKey);
      if (!best || longest > best.len) best = { name: v, len: longest };
    }
    return best && best.len > 0 ? best : null;
  }, [sessions, vikings, selected, todayKey]);

  const single = selected != null;

  const LEVEL_STYLE = [
    { backgroundColor: 'transparent' }, // 0 handled via border
    { backgroundColor: 'rgba(200,149,42,0.20)' },
    { backgroundColor: 'rgba(200,149,42,0.42)' },
    { backgroundColor: 'rgba(200,149,42,0.66)' },
    { backgroundColor: 'rgba(232,184,75,0.92)' },
  ];

  // Month labels above the columns (shown where the month changes).
  const monthLabels = columns.map((col, i) => {
    const m = MONTH_FMT.format(col[0].date);
    const prev = i > 0 ? MONTH_FMT.format(columns[i - 1][0].date) : null;
    return m !== prev ? m : '';
  });

  const weekdayRows = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

  return (
    <div className="card-surface p-5">
      {/* View selector — hidden when the grid is pinned to one viking */}
      {!lockedTo && (
        <div className="mb-5 flex flex-wrap gap-2">
          <Chip active={!single} onClick={() => setSelected(null)}>
            All vikings
          </Chip>
          {vikings.map((v) => (
            <Chip key={v} active={selected === v} onClick={() => setSelected(v)}>
              {v}
            </Chip>
          ))}
        </div>
      )}

      {/* Grid */}
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-2">
          {/* month row */}
          <div className="flex pl-9">
            {monthLabels.map((m, i) => (
              <div
                key={i}
                className="w-[18px] shrink-0 font-display text-[10px] uppercase tracking-wide text-muted"
              >
                {m}
              </div>
            ))}
          </div>

          <div className="flex gap-[3px]">
            {/* weekday labels */}
            <div className="mr-1 flex w-8 shrink-0 flex-col gap-[3px]">
              {weekdayRows.map((w, i) => (
                <div
                  key={i}
                  className="flex h-[15px] items-center justify-end pr-1 text-[9px] leading-none text-muted"
                >
                  {w}
                </div>
              ))}
            </div>

            {columns.map((col, ci) => (
              <div key={ci} className="flex flex-col gap-[3px]">
                {col.map((cell) => {
                  if (cell.inFuture) {
                    return <div key={cell.key} className="h-[15px] w-[15px]" />;
                  }
                  const level = levelFor(cell.hours);
                  const isToday = cell.key === todayKey;
                  return (
                    <div key={cell.key} className="group relative">
                      <div
                        className={clsx(
                          'h-[15px] w-[15px] rounded-[3px] transition-colors',
                          level === 0 && 'border border-rune/70',
                          isToday && 'ring-1 ring-gold-light/70'
                        )}
                        style={level > 0 ? LEVEL_STYLE[level] : undefined}
                      />
                      {/* Tooltip */}
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-rune bg-pitch/95 px-2.5 py-1.5 text-left shadow-lg backdrop-blur-sm group-hover:block">
                        <div className="font-display text-xs text-gold-light">
                          {LABEL_FMT.format(cell.date)}
                        </div>
                        <div className="text-[11px] text-ash-dim">
                          {cell.hours <= 0
                            ? 'No one at the hearth'
                            : single
                              ? `${cell.hours.toFixed(1)} hours`
                              : `${cell.hours.toFixed(1)} viking-hours · ${cell.vikings} viking${cell.vikings === 1 ? '' : 's'}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend + streaks */}
      <div className="mt-5 flex flex-col gap-3 border-t border-rune/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-4 text-xs text-ash-dim">
          <span>
            <span className="text-muted">Current streak: </span>
            <span className="font-display text-gold-light">
              {current} {current === 1 ? 'night' : 'nights'}
            </span>
          </span>
          <span>
            <span className="text-muted">Longest streak: </span>
            <span className="font-display text-gold-light">
              {longest} {longest === 1 ? 'night' : 'nights'}
            </span>
            {single && selected ? (
              <span className="text-muted">
                {' '}
                ·{' '}
                <VikingLink
                  name={selected}
                  className="gold-ring rounded-sm transition-colors hover:text-gold-light"
                />
              </span>
            ) : null}
          </span>
          {champion && (
            <span className="text-muted">
              Most faithful:{' '}
              <VikingLink
                name={champion.name}
                className="gold-ring rounded-sm font-display text-ash-dim transition-colors hover:text-gold-light"
              />{' '}
              ({champion.len} in a row)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <span>less</span>
          <div className="h-[13px] w-[13px] rounded-[3px] border border-rune/70" />
          {[1, 2, 3, 4].map((l) => (
            <div key={l} className="h-[13px] w-[13px] rounded-[3px]" style={LEVEL_STYLE[l]} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}

/** Consecutive-day streaks over a set of played days. `current` counts back from today. */
function streaks(playedByKey: Map<string, number>, todayKey: string) {
  const days = [...playedByKey.entries()]
    .filter(([, v]) => v > 0)
    .map(([k]) => k)
    .sort();
  if (days.length === 0) return { current: 0, longest: 0 };

  const played = new Set(days);

  // Longest run anywhere.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (nextKey(days[i - 1]) === days[i]) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  // Current run counting back from today (or yesterday if today is quiet).
  let current = 0;
  let cursor = played.has(todayKey) ? todayKey : prevKey(todayKey);
  if (played.has(cursor)) {
    while (played.has(cursor)) {
      current++;
      cursor = prevKey(cursor);
    }
  }
  return { current, longest };
}

function shift(key: string, delta: number): string {
  const ms = new Date(`${key}T12:00:00Z`).getTime() + delta * 86_400_000;
  return KEY_FMT.format(new Date(ms));
}
function nextKey(key: string) {
  return shift(key, 1);
}
function prevKey(key: string) {
  return shift(key, -1);
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'gold-ring rounded-full border px-3 py-1 font-display text-xs tracking-wide transition-colors',
        active
          ? 'border-gold-dim bg-gold/15 text-gold-light'
          : 'border-rune bg-surface-raised/40 text-ash-dim hover:border-rune-bright hover:text-ash'
      )}
    >
      {children}
    </button>
  );
}
