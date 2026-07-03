import { OATH_CHARTER } from '@/config/oath';

// The charter, rendered as a carved stone tablet / illuminated charter:
// generous display headings, a rune divider, numbered clauses.
export function Charter() {
  const { title, preamble, clauses, closing } = OATH_CHARTER;

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-gold-dim/50 bg-gradient-to-b from-surface-raised/60 to-surface shadow-[0_0_40px_-16px_rgba(200,149,42,0.4)]">
      {/* engraved edge glow */}
      <div className="pointer-events-none absolute inset-0 rounded-[var(--radius-card)] ring-1 ring-inset ring-gold/5" />

      <div className="relative px-6 py-10 sm:px-12 sm:py-14">
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.35em] text-gold-dim">Session Zero</p>
          <h1 className="heading-engraved mt-3 text-3xl text-gold-light sm:text-4xl">{title}</h1>
        </div>

        <hr className="rune-divider mx-auto mt-6 max-w-sm" />

        <p className="mx-auto mt-6 max-w-2xl text-center text-[15px] italic leading-relaxed text-ash-dim sm:text-base">
          {preamble}
        </p>

        <ol className="mx-auto mt-10 max-w-2xl space-y-7">
          {clauses.map((clause, i) => (
            <li key={clause.title} className="flex gap-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-base text-gold-light">
                {i + 1}
              </span>
              <div className="min-w-0">
                <h2 className="font-display text-lg tracking-wide text-ash">{clause.title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-ash-dim">{clause.text}</p>
              </div>
            </li>
          ))}
        </ol>

        <hr className="rune-divider mx-auto mt-10 max-w-sm" />

        <p className="mx-auto mt-6 max-w-xl text-center font-display text-base tracking-wide text-gold-light sm:text-lg">
          {closing}
        </p>
      </div>
    </div>
  );
}
