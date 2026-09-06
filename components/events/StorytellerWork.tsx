import Link from 'next/link';
import { Feather, Swords } from 'lucide-react';
import { Card, EmptyState } from '@/components/ui';
import { splitTaleParagraphs, taleDayLabel, type StorytellerEntry } from '@/lib/tales';
import { bossPath } from '@/lib/slug';

/**
 * Everything a viking has written into the record: the Storyteller's tales of a
 * night, and the vikings' own tellings of a boss falling, in one column with
 * the newest at the top.
 *
 * The two card shapes are deliberately close but not identical. A tale carries
 * its own name and the night it is about; a telling carries the forsaken it is
 * about and a link to that war room, and says so when it is the telling the war
 * room actually shows.
 *
 * EVERY WORD HERE IS PLAYER-WRITTEN TEXT RENDERED AS PLAIN PARAGRAPHS: React
 * escapes a text node, so no markdown, no HTML and no link survives into the
 * page. Nothing here uses dangerouslySetInnerHTML, and nothing here should.
 */
export function StorytellerWork({ entries }: { entries: StorytellerEntry[] }) {
  if (!entries || entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Feather size={28} />}
          title="No tale has been written yet."
          message="The Storyteller's quill is dry."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.map((e) => (e.kind === 'tale' ? <TaleCard key={e.id} e={e} /> : <TellingCard key={e.id} e={e} />))}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <>
      {splitTaleParagraphs(text).map((p, i) => (
        <p
          key={i}
          // whitespace-pre-line for the reason EpisodeTales.tsx carries it: a
          // single line break is the writer's, and the default white-space
          // would throw it away.
          className={`whitespace-pre-line text-sm leading-relaxed text-ash-dim${i > 0 ? ' mt-2.5' : ' mt-2'}`}
        >
          {p}
        </p>
      ))}
    </>
  );
}

function Byline({ by }: { by: string }) {
  return (
    <figcaption className="mt-3 text-xs uppercase tracking-wider text-muted">
      Told by <span className="text-gold-dim">{by}</span>
    </figcaption>
  );
}

function TaleCard({ e }: { e: Extract<StorytellerEntry, { kind: 'tale' }> }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] font-medium uppercase tracking-[0.18em] text-gold-dim">
        <span className="inline-flex items-center gap-1.5">
          <Feather size={12} />
          A tale of the hall
        </span>
        <span className="text-rune-bright">·</span>
        <span className="text-muted normal-case tracking-normal">{taleDayLabel(e.day)}</span>
      </div>

      <figure>
        <h3 className="mt-1.5 font-display text-xl text-gold-light">{e.title}</h3>
        <Prose text={e.text} />
        <Byline by={e.by} />
      </figure>
    </Card>
  );
}

function TellingCard({ e }: { e: Extract<StorytellerEntry, { kind: 'telling' }> }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] font-medium uppercase tracking-[0.18em] text-gold-dim">
        <span className="inline-flex items-center gap-1.5">
          <Swords size={12} />
          A telling of a fall
        </span>
        {e.kept && (
          <>
            <span className="text-rune-bright">·</span>
            {/* "kept" is the word the war room and the bot both use for the
                telling that stands, so the three surfaces read the same. */}
            <span className="text-gold-light">Kept</span>
          </>
        )}
      </div>

      <figure>
        <h3 className="mt-1.5 font-display text-xl text-gold-light">
          {e.boss ? (
            <Link
              href={bossPath(e.boss)}
              className="gold-ring rounded-sm transition-colors hover:text-gold-light"
            >
              The fall of {e.boss}
            </Link>
          ) : (
            'The fall of a forsaken one'
          )}
        </h3>
        <Prose text={e.text} />
        <Byline by={e.by} />
      </figure>
    </Card>
  );
}
