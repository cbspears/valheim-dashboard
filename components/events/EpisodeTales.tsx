import { Feather } from 'lucide-react';
import type { EpisodeTale } from '@/lib/episodes';
import { splitTaleParagraphs } from '@/lib/tales';

/**
 * The Storyteller's tales of one night, inside that night's episode card.
 *
 * Sits BELOW the generated blurb and above the participant chips: the machine
 * says what happened, the Storyteller says what it was like, and the chips and
 * counts stay at the bottom of the card where they were. A night nobody wrote
 * about renders nothing at all, which is every night before
 * db/2026-09-06_tales.sql is applied.
 *
 * EVERY WORD HERE IS PLAYER-WRITTEN TEXT RENDERED AS PLAIN PARAGRAPHS: React
 * escapes a text node, so no markdown, no HTML and no link survives into the
 * page. Nothing here uses dangerouslySetInnerHTML, and nothing here should.
 */
export function EpisodeTales({ tales }: { tales: EpisodeTale[] }) {
  if (!tales || tales.length === 0) return null;

  return (
    <div className="mt-4 border-t border-rune/60 pt-3.5">
      <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-gold-dim">
        <Feather size={12} />
        As the Storyteller tells it
      </h4>

      <div className="mt-3 flex flex-col gap-4">
        {tales.map((t, i) => (
          <figure key={t.id ?? `${t.createdAt}-${i}`}>
            <p className="font-display text-base text-gold-light">{t.title}</p>
            {splitTaleParagraphs(t.text).map((p, j) => (
              <p
                key={j}
                // whitespace-pre-line, because splitTaleParagraphs breaks on
                // BLANK lines and the bot deliberately keeps single ones. A
                // Discord writer who presses Enter once between two lines of a
                // recap has written two lines; the browser's default
                // white-space would collapse them into one run-on sentence.
                className={`whitespace-pre-line text-sm leading-relaxed text-ash-dim${j === 0 ? ' mt-1.5' : ' mt-2.5'}`}
              >
                {p}
              </p>
            ))}
            <figcaption className="mt-2 text-xs uppercase tracking-wider text-muted">
              Told by <span className="text-gold-dim">{t.by}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
