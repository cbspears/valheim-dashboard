// Two things with dates on them that come from outside the pipeline: the
// gatherings Discord holds, and the claim codes that expire on their own.

import { CalendarDays, KeyRound, Users } from 'lucide-react';
import { formatCountdownSec, untilSecFrom, ageSecFrom, formatAgeSec } from '@/lib/ops/window';
import { stampInZone, LAUNCH_TZ } from '@/lib/ops/horizon';
import type { UpcomingEvent } from '@/lib/types';
import type { ClaimRow } from '@/app/admin/ops/horizon/data';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Chip, Nothing, NotReported } from './Panel';

export function GatheringsPanel({
  gatherings,
  nowMs,
  publicReadOk,
}: {
  gatherings: UpcomingEvent[];
  nowMs: number;
  /**
   * False when the seeded reference tables came back empty too, i.e. the public
   * read path is broken. `getUpcomingEvents` swallows its own errors and returns
   * [], so without this flag a failed read and an empty calendar are the same
   * picture. See app/admin/ops/horizon/data.ts.
   */
  publicReadOk: boolean;
}) {
  return (
    <HorizonCard
      title="Scheduled gatherings"
      entry={HORIZON_GLOSSARY['gathering']}
      icon={<CalendarDays size={15} />}
      aside={
        gatherings.length === 0 && !publicReadOk ? 'not readable' : `${gatherings.length} on the calendar`
      }
    >
      {gatherings.length === 0 && !publicReadOk ? (
        <NotReported
          what="The public read path returned nothing at all, so the calendar could not be read."
          why="Not the same as an empty calendar: the seeded reference tables came back empty too."
        />
      ) : gatherings.length === 0 ? (
        <Nothing>
          Nothing scheduled. Rows arrive here from Discord through the bot&apos;s events-sync loop,
          which is gated on EVENTS_SYNC=1.
        </Nothing>
      ) : (
        <ol className="divide-y divide-rune/60">
          {gatherings.map((g) => {
            const sec = untilSecFrom(nowMs, g.next_at);
            const demo = !g.discord_event_id;
            return (
              <li key={g.id} className="py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 text-sm text-ash">{g.name}</span>
                  <span className="shrink-0 text-sm tabular-nums text-gold">
                    {formatCountdownSec(sec)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                  <span>
                    {stampInZone(Date.parse(g.next_at), LAUNCH_TZ)} {LAUNCH_TZ}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} aria-hidden="true" />
                    {g.user_count} interested
                  </span>
                  {g.recurrence && <Chip>{g.recurrence}</Chip>}
                  {g.status !== 'scheduled' && <Chip tone="gold">{g.status}</Chip>}
                  {demo && <Chip tone="warn">no discord id, seeded row</Chip>}
                  <span>mirrored {formatAgeSec(ageSecFrom(nowMs, g.updated_at))}</span>
                </div>
                {demo && (
                  <p className="mt-1 text-xs text-raid">
                    A row with no discord_event_id is a seeded demo row. It should not survive the
                    launch wipe.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </HorizonCard>
  );
}

export function ExpiringClaimsPanel({
  claims,
  nowMs,
  urgentMs,
}: {
  /** Null when the identity_claims read failed; [] when it read fine and found nothing. */
  claims: ClaimRow[] | null;
  nowMs: number;
  /** Inside this many ms of expiry, a claim is called out rather than listed. */
  urgentMs: number;
}) {
  const rows = claims ?? [];
  const urgent = rows.filter((c) => {
    const sec = untilSecFrom(nowMs, c.expires_at);
    return sec !== null && sec * 1000 <= urgentMs;
  });

  return (
    <HorizonCard
      title="Claim codes about to expire"
      entry={HORIZON_GLOSSARY['expiring-claims']}
      icon={<KeyRound size={15} />}
      aside={claims === null ? 'not readable' : `${rows.length} open, next 7 d`}
    >
      {claims === null ? (
        <NotReported
          what="The identity_claims read failed, so open claims cannot be listed."
          why="An empty list is not being shown for this, because an empty list would read as good news."
        />
      ) : rows.length === 0 ? (
        <Nothing>
          No open claim codes. A claim normally lives minutes: minted in Discord, consumed by the
          in-game shout in the same sitting.
        </Nothing>
      ) : (
        <>
          {urgent.length > 0 && (
            <p className="mb-3 text-xs text-raid">
              {urgent.length} expire{urgent.length === 1 ? 's' : ''} within 24 h. An expired claim
              means the player starts the link over.
            </p>
          )}
          <ol className="divide-y divide-rune/60">
            {rows.map((c, i) => {
              const sec = untilSecFrom(nowMs, c.expires_at);
              const soon = sec !== null && sec * 1000 <= urgentMs;
              return (
                // Keyed by position, NOT by the code: a React key is serialised
                // into the page, so keying off the credential would put the raw
                // value back in the HTML that the masking exists to keep it out
                // of. The list is server-rendered once and never reordered.
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                  <span className="font-mono text-xs text-ash-dim">{c.codeMasked}</span>
                  <span className="text-xs text-muted">
                    {c.requested_name ?? 'no name given'}
                    {c.discord_username ? ` for ${c.discord_username}` : ''}
                  </span>
                  <span
                    className={`ml-auto text-xs tabular-nums ${soon ? 'text-raid' : 'text-ash-dim'}`}
                  >
                    expires {formatCountdownSec(sec)}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-muted">
            Codes are masked after the first two characters, in the loader rather than in this
            markup, so the whole value never reaches the page at all. An unconsumed code is a live
            credential and not an identifier: whoever shouts it in game first gets the link, which
            is why the bot only ever delivers one by DM. Nothing here needs the whole code, and this
            page gets screenshotted. The full value is in identity_claims for the service role.
          </p>
        </>
      )}
    </HorizonCard>
  );
}
