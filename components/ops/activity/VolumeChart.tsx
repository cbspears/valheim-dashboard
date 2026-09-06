// Volume per bucket, plus the loudest bucket named in words.
//
// THE LOUDEST BUCKET EXCLUDES THE LAST BAR. The last bucket is the current,
// incomplete one, drawn muted right here so nobody compares it with the full
// ones. The first cut then crowned it anyway: at 14:53 UTC the 14:00 bar was
// muted and the readout beside it called 14:00 the loudest hour, on 53 minutes
// of data against 24 full ones. The page passes excludePartial to
// loudestBucket() and `partialCount` covers the case that leaves behind, where
// the only rows in the window are in that incomplete bucket.
//
// The chart follows the page's kind filter rather than carrying a second filter
// of its own: two filters that both narrow the same rows is a way to end up
// looking at a chart that does not match the feed under it.

import { Bars } from '@/components/ops/charts/Bars';
import { Explain } from '@/components/ops/Explain';
import { Panel } from './Panel';
import { ACTIVITY_GLOSSARY } from '@/lib/ops/glossary-activity';
import { BUCKET_TZ, formatCount, type Bucket } from '@/lib/ops/window';

export function VolumeChart({
  buckets,
  counts,
  loudest,
  partialCount,
  bucketNoun,
  windowText,
  filterText,
  total,
  truncated,
}: {
  buckets: Bucket[];
  counts: number[];
  loudest: { label: string; count: number } | null;
  /**
   * Rows in the current, incomplete bucket. It is excluded from `loudest` on
   * purpose (a partial hour cannot be compared with full ones), so this is what
   * lets the empty case say "only the current hour has rows" rather than the
   * false "nothing was written in this window".
   */
  partialCount: number;
  /** "hour" or "day". Used in the copy, so it is a word, not a duration. */
  bucketNoun: 'hour' | 'day';
  /** "last 24 h" or "last 7 d". */
  windowText: string;
  /** What the chart is counting, for example "everything" or "deaths". */
  filterText: string;
  total: number;
  truncated: boolean;
}) {
  const bars = buckets.map((b, i) => ({
    label: b.label,
    value: counts[i] ?? 0,
    hint: `${b.label} ${BUCKET_TZ}: ${counts[i] ?? 0} ${counts[i] === 1 ? 'row' : 'rows'}`,
    partial: i === buckets.length - 1,
  }));

  return (
    <Panel
      title={`Volume by ${bucketNoun}`}
      entry={ACTIVITY_GLOSSARY['volume-buckets']}
      note={
        <>
          {filterText}, {windowText}. Buckets are aligned in {BUCKET_TZ}; the last {bucketNoun} is
          still running and is drawn muted.
        </>
      }
    >
      <Bars
        bars={bars}
        label={`Rows per ${bucketNoun}, ${windowText}`}
        height={88}
        className="text-gold"
      />
      <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <span className="text-ash">
          <span className="font-display text-lg">{formatCount(total)}</span>{' '}
          <span className="text-muted">
            {total === 1 ? 'row' : 'rows'}, {windowText}
          </span>
        </span>
        {loudest ? (
          <span className="text-ash-dim">
            Loudest {bucketNoun}:{' '}
            <span className="font-medium text-gold-light">
              {bucketNoun === 'hour' ? `${loudest.label} ${BUCKET_TZ}` : `${loudest.label} (${BUCKET_TZ})`}
            </span>{' '}
            with {formatCount(loudest.count)} {loudest.count === 1 ? 'row' : 'rows'}
            <Explain entry={ACTIVITY_GLOSSARY['loudest-hour']} size="sm" className="ml-1" />
          </span>
        ) : partialCount > 0 ? (
          <span className="text-muted">
            No loudest {bucketNoun} yet: every row in this window is in the current, incomplete{' '}
            {bucketNoun}, which is not comparable with a full one.
          </span>
        ) : (
          <span className="text-muted">
            No loudest {bucketNoun}: nothing was written in this window.
          </span>
        )}
      </div>
      {truncated && (
        <p className="mt-3 rounded border border-raid/40 bg-raid/10 px-3 py-2 text-xs text-raid">
          The events read came back at its 2000 row ceiling, so this chart shows a clipped window.
          The oldest part of the window is missing, not empty.
        </p>
      )}
    </Panel>
  );
}
