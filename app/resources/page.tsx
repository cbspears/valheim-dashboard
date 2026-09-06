import type { Metadata } from 'next';
import { clsx } from 'clsx';
import { Wrench } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { ModsSection } from '@/components/mods/ModsSection';
import { RegisterSections } from '@/components/commands/RegisterSections';
import { COMMAND_SECTIONS } from '@/config/commands';
import { SERVER_NAME } from '@/config/server';

// FULLY STATIC, and deliberately carrying no `revalidate`. Both halves of this
// page are TypeScript config compiled into the build (`config/mods.ts` and
// `config/commands.ts`), not a query: there is no database read here and no
// clock after which its content could differ, so an ISR window would only buy a
// re-render of the same bytes. A copy fix ships with the next deploy, the way
// the Get Started page's does. Next reports it as ○ (Static).
//
// The two pages this replaced, /mods and /commands, are 308s in next.config.ts
// pointing at #mods and #commands below, so every bookmark and every older
// Discord link still lands on the right half.
//
// STILL POINTING AT THE OLD ADDRESSES (2026-09-06): app/get-started/page.tsx
// links /mods three times and /commands once, and calls them "the Mods page"
// and "the Commands page". The links work, through the 308, but the nav offers
// neither tab any more, so the labels promise something a reader cannot find.
// That file belongs to the Get Started track; re-point it at /resources#mods
// and /resources#commands and rename the labels.
export const metadata: Metadata = {
  title: 'Resources',
  description: `The modpack and the register for ${SERVER_NAME}: every mod, which of them you install, every command you can use in Discord and in game, and everything the hall says back.`,
};

/**
 * The jump chips: both halves of the page, then the four groups inside the
 * register.
 *
 * Commands is in the row for the same reason Mods is. It is an h2, it is the
 * other half of the page, and it is where `/commands` lands after its 308, so
 * a reader who arrived that way needs a chip that names where they are. The
 * two halves are marked `half` and carry the brighter border, which is what
 * keeps the row readable as two tops and their children rather than six
 * equals.
 */
const JUMP_LINKS = [
  { href: '#mods', label: 'Mods', half: true },
  { href: '#commands', label: 'Commands', half: true },
  ...COMMAND_SECTIONS.map((s) => ({ href: `#${s.id}`, label: s.title, half: false })),
];

export default function ResourcesPage() {
  return (
    <div>
      <PageHeader slot="mods">
        <SectionHeader
          as="h1"
          title="Resources"
          subtitle="What to install, what to type, and what the hall will say back to you."
          icon={<Wrench size={22} />}
        />
      </PageHeader>

      {/* Jump links. A phone gets a wrapped row of chips rather than a rail, so
          the header never has to scroll sideways. py-2 on a 20px line keeps
          every chip a comfortable target on a touch screen. */}
      <nav aria-label="Sections of this page" className="mb-9 flex flex-wrap gap-2">
        {JUMP_LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className={clsx(
              'gold-ring rounded-md border bg-surface-raised px-3 py-2 text-xs transition-colors hover:border-gold-dim hover:text-ash',
              l.half
                ? 'border-gold-dim/60 font-semibold text-ash'
                : 'border-rune font-medium text-ash-dim'
            )}
          >
            {l.label}
          </a>
        ))}
      </nav>

      <div className="space-y-14">
        <section id="mods" className="scroll-mt-20">
          <ModsSection />
        </section>

        <section id="commands" className="scroll-mt-20">
          <RegisterSections />
        </section>
      </div>
    </div>
  );
}
