// Titles about to change hands.
//
// The living-title engine is run twice over the same roster: once with each
// viking's persisted `current_title` as the hysteresis incumbent, which is
// exactly what /api/titles returns and therefore what the bot compares against,
// and once with every incumbent stripped, which is the raw standings.
//
// The difference between the two runs is the whole point of this panel:
//   flipping   the engine disagrees with the incumbent even WITH the stickiness
//              bonus applied, and it is a change the announcer is willing to
//              make. It still has to clear two-pass confirmation, the 24 h
//              tenure and the 3-a-day budget, so it is a post that MAY be
//              coming, not one that is overdue.
//   held       the viking wears an EARNED title and the engine now offers a
//              placeholder. Since 2026-09-10 that demotion is refused outright,
//              so this row is deliberate and permanent, not a stuck write.
//   contested  hysteresis is the only thing holding the title. Nothing will be
//              announced, and no other surface on the site shows this at all.
//   seed       no incumbent recorded. The bot writes it silently the first time.

import { Crown, ArrowRight } from 'lucide-react';
import type { TitleContest } from '@/lib/ops/horizon';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { HorizonCard, Chip, Nothing, NotReported, type Tone } from './Panel';

const KIND_COPY: Record<TitleContest['kind'], { label: string; tone: Tone; blurb: string }> = {
  flipping: {
    label: 'may change',
    tone: 'gold',
    blurb:
      'The engine offers this. It is announced only after the same offer stands two passes 15 min apart, the current title is a day old, and the hall has proclamations left today.',
  },
  held: {
    label: 'held',
    tone: 'muted',
    blurb:
      'An earned title is never taken back to a placeholder. Nothing is announced and nothing is written, however long this stands.',
  },
  contested: {
    label: 'contested',
    tone: 'warn',
    blurb: 'Hysteresis is holding the title. Nothing is announced yet.',
  },
  seed: {
    label: 'first title',
    tone: 'muted',
    blurb: 'No incumbent recorded. The bot writes this one silently, with no announcement.',
  },
};

export function TitlesPanel({
  contests,
  rosterSize,
  titlesIntervalMs,
  publicReadOk,
  cacheSec,
}: {
  contests: TitleContest[];
  rosterSize: number;
  /** The bot's TITLES_INTERVAL_MS, when it has reported one. */
  titlesIntervalMs: number | null;
  /** False when the public read path returned nothing at all. See data.ts. */
  publicReadOk: boolean;
  /** How long the roster behind this panel may sit behind the database. */
  cacheSec: number;
}) {
  const cadence = titlesIntervalMs
    ? `every ${Math.round(titlesIntervalMs / 60000)} min`
    : 'every 10 min by default';

  return (
    <HorizonCard
      title="Titles about to change hands"
      entry={HORIZON_GLOSSARY['title-contest']}
      icon={<Crown size={15} />}
      aside={rosterSize === 0 && !publicReadOk ? 'not readable' : `${rosterSize} vikings`}
    >
      {rosterSize === 0 && !publicReadOk ? (
        <NotReported
          what="No roster came back, and neither did the seeded reference tables."
          why="A settled hall and an unreadable one are the same picture, so this card says neither."
        />
      ) : rosterSize === 0 ? (
        <Nothing>
          No viking rows. After the launch wipe that is correct until the first join; at any other
          time the players read is worth checking.
        </Nothing>
      ) : contests.length === 0 ? (
        <Nothing>
          Every title is settled: the engine agrees with the hall on all {rosterSize} vikings, and no
          rival is close enough for hysteresis to be doing the work.
        </Nothing>
      ) : (
        <>
          <ol className="divide-y divide-rune/60">
            {contests.map((c) => {
              const copy = KIND_COPY[c.kind];
              return (
                <li key={c.name} className="py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="text-sm text-ash">{c.name}</span>
                    <Chip tone={copy.tone}>{copy.label}</Chip>
                    {c.source && <span className="text-xs text-muted">{c.source}</span>}
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <span className="text-muted">{c.incumbent ?? 'no title yet'}</span>
                    <ArrowRight size={11} className="text-muted" aria-hidden="true" />
                    <span className="text-ash-dim">
                      {c.kind === 'contested' ? c.raw : (c.stable ?? 'none')}
                    </span>
                    {c.kind === 'contested' && (
                      <span className="text-muted">if the incumbent bonus is removed</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{copy.blurb}</p>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-muted">
            The bot polls /api/titles {cadence}, but titles are deliberately sticky since
            2026-09-10: at most 3 proclamations a rolling 24 h, an earned title is never demoted to
            a placeholder, a placeholder swap is recorded silently, and any announced change waits
            for the same offer twice 15 min apart plus a day of tenure. So a disagreement listed
            here is usually the policy working, not a stuck loop. The roster behind this card is
            cached for {cacheSec} s, so it can read that far behind the database.
          </p>
        </>
      )}
    </HorizonCard>
  );
}
