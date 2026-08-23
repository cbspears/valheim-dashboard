import Link from 'next/link';
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
    return (
      <p className="py-8 text-center text-sm text-muted">
        No marks yet. Be the first to swear the oath.
      </p>
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
