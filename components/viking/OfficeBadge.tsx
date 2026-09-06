import { ScrollText } from 'lucide-react';

/**
 * The office a viking holds, or held, shown BESIDE the epithet rather than in
 * place of it. An epithet is what a viking did; an office is what the hall
 * asked them to do, and the page should say both.
 *
 * Renders nothing without a label, so a page can hand it the result of
 * officeLabelFor and not branch.
 */
export function OfficeBadge({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-gold-dim/40 bg-pitch/70 px-2.5 py-0.5 align-middle text-xs font-medium text-gold-dim"
      title="An office of the hall"
    >
      <ScrollText size={12} />
      {label}
    </span>
  );
}
