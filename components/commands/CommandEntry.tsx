import { CopyChip } from '@/components/get-started/CopyChip';
import type { DiscordCommand, GameShout } from '@/config/commands';

/**
 * One typed command: the exact text as a copy chip, who may use it, what
 * happens, and a worked example.
 *
 * Laid out as a stack on a phone and a two-column split from sm up, so nothing
 * is ever wider than the viewport. Every command string is font-mono and
 * allowed to break mid-token: a long boss name must wrap, never scroll the page.
 */
export function CommandEntry({ entry }: { entry: DiscordCommand | GameShout }) {
  const copyValue = entry.copy ?? entry.text;

  return (
    <li className="border-t border-rune/60 py-5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        {/* The command itself */}
        <div className="min-w-0 sm:w-[46%] sm:shrink-0">
          {copyValue ? (
            <CopyChip value={copyValue} label={entry.text} className="w-full sm:w-auto" />
          ) : (
            <span className="inline-flex max-w-full items-center rounded border border-gold-dim/40 bg-gold/10 px-2.5 py-1.5 font-mono text-xs font-semibold break-words text-gold-light">
              {entry.text}
            </span>
          )}

          {entry.also?.length ? (
            <p className="mt-2 text-xs text-muted">
              Also answers to{' '}
              {entry.also.map((alt, i) => (
                <span key={alt}>
                  {i > 0 ? ', ' : ''}
                  <span className="font-mono break-words text-ash-dim">{alt}</span>
                </span>
              ))}
              .
            </p>
          ) : null}

          <p className="mt-2 text-xs tracking-wide text-gold uppercase">{entry.who}</p>
        </div>

        {/* What it does */}
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm leading-relaxed text-ash-dim">{entry.what}</p>

          <p className="text-xs text-muted">
            <span className="text-ash-dim">Like this: </span>
            <span className="font-mono break-words text-ash">{entry.example}</span>
          </p>

          {entry.note && <p className="text-xs leading-relaxed text-muted">{entry.note}</p>}
        </div>
      </div>
    </li>
  );
}
