import { ExternalLink } from 'lucide-react';
import type { ChecklistMod } from '@/lib/get-started';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

/**
 * The hand-install list, as a checklist a player can tick off.
 *
 * This is the one place on the site where somebody transcribes seven version
 * numbers into another program, and picking the newest instead of the pinned
 * one produces the "Incompatible version" this page's troubleshooting calls the
 * most common failure. So the versions are a column, not a clause in a
 * sentence, each with its own link, and the boxes are real checkboxes: seven
 * installs is more than anyone holds in their head.
 *
 * Rows come from `config/mods.ts` by way of `checklistFrom`, never typed here.
 */
export function ModChecklist({ mods }: { mods: ChecklistMod[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-rune">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          The {mods.length} mods to install by hand, each at the version the modpack pins
        </caption>
        <thead>
          <tr className="border-b border-rune bg-surface-raised/40 text-left text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="w-9 px-2 py-2">
              <span className="sr-only">Installed</span>
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Mod
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Version
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Where
            </th>
          </tr>
        </thead>
        <tbody>
          {mods.map((m) => {
            const id = `mod-${slug(m.name)}`;
            return (
              <tr key={m.name} className="border-b border-rune/60 last:border-b-0">
                <td className="px-2 py-2.5 align-top">
                  <input id={id} type="checkbox" className="gold-ring mt-0.5 h-4 w-4 accent-gold" />
                </td>
                <th scope="row" className="px-2 py-2.5 text-left align-top font-normal">
                  <label htmlFor={id} className="cursor-pointer text-ash">
                    {m.name}
                  </label>
                </th>
                <td className="whitespace-nowrap px-2 py-2.5 align-top font-mono text-xs font-semibold text-gold-light">
                  {m.version}
                </td>
                <td className="px-2 py-2.5 text-right align-top">
                  {m.url ? (
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="prose-link gold-ring inline-flex items-center gap-1 rounded text-xs font-medium text-gold-light"
                    >
                      Thunderstore
                      <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span className="text-xs text-muted">in the pack</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
