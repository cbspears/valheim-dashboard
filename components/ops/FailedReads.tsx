// "These tables did not answer." The one sentence that separates a quiet hall
// from a blind cockpit.
//
// WHY IT EXISTS. postgrest-js resolves rather than throws when a query fails, so
// a revoked grant, a renamed column, a statement timeout and a 5xx all arrive as
// `{ data: null, error }` and land in a page as an empty array. Every panel then
// renders its empty state honestly and the page as a whole tells a lie: "nothing
// fired in the last 24 h", "the queue is empty", "every title is settled". At
// 21:00 on launch night that reads as calm.
//
// The tabs that load through `readTracker` (lib/ops/client.ts) know which reads
// failed by name, and this is how they say so: one card, at the top, above the
// numbers it invalidates, naming the tables so the reader knows exactly which
// panels below to distrust rather than distrusting all of them.
//
// It renders nothing at all when nothing failed, so a page can mount it
// unconditionally.
//
// SERVER COMPONENT. Props in, markup out.

import { AlertTriangle } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';

export interface FailedReadsProps {
  /** Table names that did not come back. Empty renders nothing. */
  failed: string[];
  /** How many reads the page issued in total, for "2 of 10". */
  total: number;
}

export function FailedReads({ failed, total }: FailedReadsProps) {
  if (failed.length === 0) return null;
  const many = failed.length !== 1;
  return (
    <Card className="border-l-2 border-l-raid/70">
      <CardBody className="flex items-start gap-3 text-sm">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-raid" />
        <div className="min-w-0">
          <p className="font-medium text-ash">
            {failed.length} of {total} reads on this page did not come back.
          </p>
          <p className="mt-1 text-ash-dim">
            The database refused or timed out on{' '}
            <span className="font-mono text-xs text-ash">{failed.join(', ')}</span>.{' '}
            {many ? 'Those tables' : 'That table'} contributed no rows to anything below, so every
            count, chart and empty panel that depends on {many ? 'them' : 'it'} is missing data
            rather than reporting a quiet window. Read the numbers below as a floor, not a total.
          </p>
          <p className="mt-1.5 text-xs text-muted">
            A read fails this way without throwing, so nothing else on the page will mention it.
            Check the Supabase project status and the service-role grants, then this page&apos;s own
            cost line at the foot for how long the reads took before giving up.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
