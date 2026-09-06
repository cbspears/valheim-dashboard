import Link from 'next/link';
import { PenLine } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { vikingPath } from '@/lib/slug';
import type { Oath } from '@/lib/types';
import { shortDate } from '@/lib/format';

// One carved signature. Exact matches link to the viking's page; fuzzy matches
// render as a plain gold name; unmatched names carry a quiet note so the viking
// knows the mark hasn't landed on a roster viking yet.
function Signature({ oath }: { oath: Oath }) {
  const name = oath.character_name?.trim() || oath.discord_name || 'A nameless viking';
  const isExact = oath.match_status === 'exact' && oath.character_name;

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {isExact ? (
          <Link
            href={vikingPath(oath.character_name as string)}
            className="gold-ring rounded font-display text-xl tracking-wide text-gold-light hover:text-gold hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="font-display text-xl tracking-wide text-gold-light">{name}</span>
        )}

        {oath.match_status === 'unmatched' && (
          <span className="text-xs italic text-muted">awaiting the carver&apos;s hand</span>
        )}
      </div>

      <p className="mt-1.5 text-[15px] italic leading-relaxed text-ash-dim">
        &ldquo;{oath.oath_text}&rdquo;
      </p>

      <p className="mt-1.5 text-xs text-muted">
        {oath.discord_name && <span>{oath.discord_name} · </span>}
        sworn {shortDate(oath.sworn_at)}
      </p>
    </li>
  );
}

export function SignatureWall({ oaths }: { oaths: Oath[] }) {
  if (oaths.length === 0) {
    // After the wipe this IS the page, so it gets the house empty state rather
    // than a grey line: a title, something to do, and somewhere to do it. It
    // also no longer opens with the same three words as the page subtitle
    // 300px above it ("No marks yet"), which is one thought said twice.
    return (
      <EmptyState
        icon={<PenLine size={28} />}
        title="No oaths sworn yet"
        message="Be the first: shout your oath in game and it is carved here under your name."
        action={
          <Link
            href="/get-started#once-you-are-in"
            className="gold-ring rounded-md font-display text-sm text-gold-light transition-colors hover:text-gold"
          >
            How to swear your oath
          </Link>
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-rune">
      {oaths.map((o) => (
        <Signature key={o.id} oath={o} />
      ))}
    </ul>
  );
}
