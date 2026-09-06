import { BookOpen } from 'lucide-react';
import { Card, CardBody, SectionHeader } from '@/components/ui';
import { GLOSSARY } from '@/config/commands';

/**
 * Nine words this site uses as if you already knew them.
 *
 * Same row shape as the page register directly above it, so the two read as
 * one reference block rather than two designs: the word in a narrow left
 * column, one plain line beside it. The 30% column and the gaps are PageRow's
 * numbers (components/commands/RegistryRows.tsx) on purpose, so the second
 * columns of the two blocks start on the same pixel. The list itself lives in
 * `config/commands.ts` GLOSSARY and every term in it is checked against the
 * copy that uses it by scripts/commands-page.test.mjs.
 */
export function Glossary() {
  return (
    <div>
      <SectionHeader
        title="Words used here"
        subtitle="The hall speaks as though you were raised in it. These are the words it never stops to explain."
        icon={<BookOpen size={22} />}
      />

      <Card>
        <CardBody>
          <dl>
            {GLOSSARY.map((term) => (
              <div
                key={term.id}
                className="flex flex-col gap-1.5 border-t border-rune/60 py-4 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-5"
              >
                <dt className="min-w-0 font-display text-sm tracking-wide text-gold-light sm:w-[30%] sm:shrink-0">
                  {term.term}
                </dt>
                <dd className="min-w-0 flex-1 text-sm leading-relaxed text-ash-dim">
                  {term.meaning}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
