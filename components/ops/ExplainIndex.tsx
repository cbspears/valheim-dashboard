'use client';

// The glossary, all of it, at the foot of the overview.
//
// WHY A SECOND WAY TO READ THE SAME TEXT. <Explain/> puts a caption next to the
// number it belongs to, which is right when you already know which number you
// are looking at. It is useless for the other half of the job: "what was the
// thing called that goes stale after twenty minutes", or reading every
// consistency check once before launch night so none of them is a surprise at
// 21:00. This is that half. Same entries, same five fields, reachable without
// hunting for the button that owns them.
//
// IT IS A CLIENT COMPONENT FOR ONE REASON: the filter box. A hundred-odd entries
// is more than anybody scrolls, and typing three letters is faster than reading
// five headings. Nothing else here needs the browser.
//
// It imports the registry rather than taking it as a prop, so the glossary text
// travels to the browser exactly once instead of once per entry in the server
// payload.
//
// IT COVERS ALL FIVE TABS, not just this one. The three v2 tabs each wrote their
// captions into a private module while the tracks ran in parallel; those were
// folded into lib/ops/glossary.ts at integration, so the categories below now
// include one heading per tab and the sentence under the title is true. Before
// the fold it was short by 48 entries, all of them on the tabs carrying most of
// the numbers.
//
// Entries are collapsed by default, as native <details>. No animation and no
// accordion state to get wrong. The full text of every entry is in the markup
// whether or not it is open, which is what makes the filter box above able to
// search it, and what lets a browser that auto-expands <details> on find-in-page
// reach inside a closed one.

import { useMemo, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { glossaryByCategory, type GlossaryEntry } from '@/lib/ops/glossary';

/** Fields the filter searches. The id is in here so "check:" narrows to checks. */
function haystack(e: GlossaryEntry): string {
  return `${e.id} ${e.title} ${e.what} ${e.why} ${e.healthy} ${e.whenRed}`.toLowerCase();
}

export function ExplainIndex() {
  const groups = useMemo(() => glossaryByCategory(), []);
  const total = useMemo(() => groups.reduce((n, g) => n + g.entries.length, 0), [groups]);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return groups;
    return groups
      .map((g) => ({ ...g, entries: g.entries.filter((e) => haystack(e).includes(needle)) }))
      .filter((g) => g.entries.length > 0);
  }, [groups, needle]);

  const shown = filtered.reduce((n, g) => n + g.entries.length, 0);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <BookOpen size={18} className="text-gold" />
        <h2 className="font-display text-sm tracking-wide text-ash uppercase">Glossary</h2>
        <span className="text-xs text-muted">
          {total} entries, covering all five tabs. Every component, check, watchdog target and
          measurement the cockpit puts on a page.
        </span>
      </div>

      <div className="card-surface relative overflow-hidden">
        <div className="border-b border-rune p-4">
          <label htmlFor="glossary-filter" className="sr-only">
            Filter the glossary
          </label>
          <div className="flex items-center gap-2 rounded-md border border-rune bg-surface px-3 py-2 focus-within:border-gold-dim">
            <Search size={15} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              id="glossary-filter"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, table, symptom, or id (try: stale, voice, check:)"
              className="w-full bg-transparent text-sm text-ash placeholder:text-muted focus:outline-none"
            />
          </div>
          <p aria-live="polite" className="mt-2 text-xs text-muted">
            {needle
              ? `${shown} of ${total} entries match "${query.trim()}".`
              : 'Open an entry for what it measures, why it matters, what healthy looks like, and what to do when it is not.'}
          </p>
        </div>

        {filtered.length === 0 ? (
          <p className="p-5 text-sm text-ash-dim">
            Nothing matches that. Clear the filter to see all {total} entries.
          </p>
        ) : (
          <div className="divide-y divide-rune/50">
            {filtered.map((group) => (
              <div key={group.id} className="p-4">
                <h3 className="text-xs font-semibold tracking-wider text-ash uppercase">
                  {group.label}{' '}
                  <span className="font-normal text-muted normal-case">
                    ({group.entries.length})
                  </span>
                </h3>
                <p className="mt-0.5 mb-2 text-xs text-muted">{group.blurb}</p>
                <ul className="space-y-0.5">
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <details className="group rounded border border-transparent open:border-rune open:bg-surface-raised">
                        <summary className="cursor-pointer list-none px-2 py-1.5 text-sm text-ash-dim marker:content-none hover:text-ash">
                          <span className="mr-1.5 inline-block text-muted transition group-open:rotate-90">
                            ›
                          </span>
                          {entry.title}
                          <span className="ml-2 font-mono text-xs text-muted">{entry.id}</span>
                        </summary>
                        <dl className="space-y-2 px-2 pt-1 pb-3 pl-6 text-xs leading-relaxed">
                          <Field term="What it measures" text={entry.what} />
                          <Field term="Why it matters" text={entry.why} />
                          <Field term="Healthy" text={entry.healthy} tone="good" />
                          <Field term="When it is not" text={entry.whenRed} tone="bad" />
                          {entry.link && (
                            <dd>
                              <a
                                href={entry.link.href}
                                target={entry.link.href.startsWith('http') ? '_blank' : undefined}
                                rel={entry.link.href.startsWith('http') ? 'noreferrer' : undefined}
                                className="text-gold transition hover:text-gold"
                              >
                                {entry.link.label}
                              </a>
                            </dd>
                          )}
                        </dl>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ term, text, tone }: { term: string; text: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <dt
        className={
          tone === 'good'
            ? 'text-xs font-semibold tracking-wider text-online-glow uppercase'
            : tone === 'bad'
              ? 'text-xs font-semibold tracking-wider text-raid uppercase'
              : 'text-xs font-semibold tracking-wider text-muted uppercase'
        }
      >
        {term}
      </dt>
      <dd className="text-ash-dim">{text}</dd>
    </div>
  );
}
