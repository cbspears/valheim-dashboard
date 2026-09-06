import { Card, CardHeader, CardBody } from '@/components/ui';
import { ScrollText } from 'lucide-react';
import { shortDate } from '@/lib/format';
import type { BossTelling } from '@/lib/types';
import {
  apocryphalTelling,
  byline,
  otherTellings,
  pickTelling,
  splitParagraphs,
  wantsStoryteller,
} from './tellings';

/**
 * The war-room's saga slot.
 *
 * One telling is on show (the chosen one, else the newest) with a byline. Below
 * it, in order: the version a telling vote ruled against, under its own
 * heading, and then everything else folded into a collapsed list. With no
 * telling rows at all it falls back to `bosses.retelling`, which is what the
 * page rendered before db/2026-09-06_boss_tellings.sql existed and what it
 * still renders on a database where that migration has not been applied.
 *
 * EVERY telling is player-written text rendered as PLAIN PARAGRAPHS: React
 * escapes a text node, so no markdown, no HTML and no link survives into the
 * page. Nothing here uses dangerouslySetInnerHTML, and nothing here should.
 */
export function BossTellings({
  tellings,
  fallback,
  notes,
  storyteller = null,
  killedAt = null,
  officeKnown = false,
  officeSince = null,
}: {
  tellings: BossTelling[];
  /** bosses.retelling, still written by the Skald on every kill. */
  fallback: string | null;
  /** bosses.notes, the oldest fallback of all. */
  notes: string | null;
  /** The Storyteller of Eilif's character name, when the office is held. */
  storyteller?: string | null;
  /** bosses.killed_at, for the "still untold" line's clock. */
  killedAt?: string | null;
  /**
   * Whether this hall has an office roll at all. FALSE by default, which is
   * what keeps the untold line off a war room running without
   * db/2026-09-06_offices.sql: see wantsStoryteller.
   */
  officeKnown?: boolean;
  /** offices.since for the open term, so the clock matches the bot's nudge. */
  officeSince?: string | null;
}) {
  const shown = pickTelling(tellings);
  const apocryphal = apocryphalTelling(tellings, shown);
  const others = otherTellings(tellings, shown, apocryphal);
  const paragraphs = shown ? splitParagraphs(shown.text) : splitParagraphs(fallback);
  const untold = wantsStoryteller({ tellings, killedAt, officeKnown, officeSince });

  // The card is titled for what is actually in it: a viking's account of the
  // fight is not the Skald's retelling.
  const title = !shown || shown.source === 'skald' ? "The Skald's Retelling" : 'The Retelling';

  return (
    <Card>
      <CardHeader title={title} icon={<ScrollText size={16} />} />
      <CardBody>
        {paragraphs.length > 0 ? (
          <figure>
            {paragraphs.map((p, i) => (
              <p
                key={i}
                className={`text-sm italic leading-relaxed text-ash-dim${i > 0 ? ' mt-3' : ''}`}
              >
                {p}
              </p>
            ))}
            <figcaption className="mt-3 text-xs uppercase tracking-wider text-gold-dim">
              {shown ? byline(shown) : 'The Skald'}
            </figcaption>
          </figure>
        ) : notes ? (
          <p className="text-sm italic leading-relaxed text-ash-dim">{notes}</p>
        ) : (
          <p className="text-sm text-muted">The Skald has not yet set this battle to words.</p>
        )}

        {/* Long untold, and still the machine's words. A statement about the
            record rather than about anyone who did or did not write it. */}
        {untold && (
          <p className="mt-4 border-l-2 border-gold-dim/40 pl-3 text-sm italic text-muted">
            The Skald&apos;s draft stands, for want of a storyteller.
          </p>
        )}

        {apocryphal && (
          <div className="mt-5 border-t border-rune pt-4">
            <h4 className="font-display text-xs uppercase tracking-wider text-gold-dim">
              The apocryphal version
            </h4>
            <p className="mt-1 text-xs text-muted">
              The telling the hall voted against. It is kept, because the version that lost is
              still part of the night.
            </p>
            <figure className="mt-3">
              {splitParagraphs(apocryphal.text).map((p, i) => (
                <p
                  key={i}
                  className={`text-sm italic leading-relaxed text-ash-dim${i > 0 ? ' mt-3' : ''}`}
                >
                  {p}
                </p>
              ))}
              <figcaption className="mt-2 text-xs uppercase tracking-wider text-gold-dim">
                {byline(apocryphal)} &middot; {shortDate(apocryphal.created_at)}
              </figcaption>
            </figure>
          </div>
        )}

        {others.length > 0 && (
          <details className="mt-5 border-t border-rune pt-4">
            <summary className="gold-ring cursor-pointer text-xs uppercase tracking-wider text-muted transition-colors hover:text-gold-light">
              Other tellings ({others.length})
            </summary>
            <div className="mt-4 flex flex-col gap-5">
              {others.map((t) => (
                <figure key={t.id}>
                  {splitParagraphs(t.text).map((p, i) => (
                    <p
                      key={i}
                      className={`text-sm italic leading-relaxed text-ash-dim${i > 0 ? ' mt-3' : ''}`}
                    >
                      {p}
                    </p>
                  ))}
                  <figcaption className="mt-2 text-xs uppercase tracking-wider text-gold-dim">
                    {byline(t)} &middot; {shortDate(t.created_at)}
                  </figcaption>
                </figure>
              ))}
            </div>
          </details>
        )}

        {storyteller && (
          <p className="mt-5 border-t border-rune pt-3 text-xs uppercase tracking-wider text-muted">
            Storyteller: <span className="text-gold-dim">{storyteller}</span>
          </p>
        )}
      </CardBody>
    </Card>
  );
}
