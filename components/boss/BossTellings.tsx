import { Card, CardHeader, CardBody } from '@/components/ui';
import { ScrollText } from 'lucide-react';
import { shortDate } from '@/lib/format';
import type { BossTelling } from '@/lib/types';
import { byline, otherTellings, pickTelling, splitParagraphs } from './tellings';

/**
 * The war-room's saga slot.
 *
 * One telling is on show (the chosen one, else the newest) with a byline, and
 * the rest are folded into a collapsed list underneath. With no telling rows at
 * all it falls back to `bosses.retelling`, which is what the page rendered
 * before db/2026-09-06_boss_tellings.sql existed and what it still renders on a
 * database where that migration has not been applied.
 *
 * EVERY telling is player-written text rendered as PLAIN PARAGRAPHS: React
 * escapes a text node, so no markdown, no HTML and no link survives into the
 * page. Nothing here uses dangerouslySetInnerHTML, and nothing here should.
 */
export function BossTellings({
  tellings,
  fallback,
  notes,
}: {
  tellings: BossTelling[];
  /** bosses.retelling, still written by the Skald on every kill. */
  fallback: string | null;
  /** bosses.notes, the oldest fallback of all. */
  notes: string | null;
}) {
  const shown = pickTelling(tellings);
  const others = otherTellings(tellings, shown);
  const paragraphs = shown ? splitParagraphs(shown.text) : splitParagraphs(fallback);

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
      </CardBody>
    </Card>
  );
}
