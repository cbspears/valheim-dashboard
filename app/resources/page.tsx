import type { Metadata } from 'next';
import { Wrench } from 'lucide-react';
import { SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { ModsSection } from '@/components/mods/ModsSection';
import { PageGuide } from '@/components/resources/PageGuide';
import { Glossary } from '@/components/resources/Glossary';
import { JumpList, type JumpLink } from '@/components/resources/JumpList';
import { RegisterSections, REGISTER_GROUPS } from '@/components/commands/RegisterSections';
import { COMMAND_SECTIONS } from '@/config/commands';
import { SERVER_NAME } from '@/config/server';

// FULLY STATIC, and deliberately carrying no `revalidate`. Every section of
// this page is TypeScript config compiled into the build (`config/mods.ts` and
// `config/commands.ts`), not a query: there is no database read here and no
// clock after which its content could differ, so an ISR window would only buy a
// re-render of the same bytes. A copy fix ships with the next deploy, the way
// the Get Started page's does. Next reports it as ○ (Static).
//
// The two pages this replaced, /mods and /commands, are 308s in next.config.ts
// pointing at #mods and #commands below, so every bookmark and every older
// Discord link still lands on the right half.
//
// THE ORDER IS NEWEST PLAYER FIRST (UX review 2026-09-06, proposal 3). The page
// used to be two long reference documents stapled together, with the one thing
// a first-timer wanted, a one-line description of every page of the site, at
// the very bottom of the longest page on the site. It now reads:
//
//   1. What each page is for   orientation, from SITE_PAGES
//   2. Words used here         the nine words the copy never stops to explain
//   3. The modpack             what you install, and the pack code
//   4. Commands                the register, one disclosure per group
//
// Everything that links in here now names the real address: app/get-started
// points at /resources#mods four times and /resources#commands once, and
// components/home/FirstRunBand.tsx at /resources#mods. Nothing under app or
// components links at the two retired routes any more (section 5 of
// scripts/commands-page.test.mjs fails the build if anything starts), so the
// 308s in next.config.ts exist for bookmarks and older Discord links only.
export const metadata: Metadata = {
  title: 'Resources',
  description: `What every page of ${SERVER_NAME} holds, the words we use, the modpack and which of it you install, and every command you can use in Discord and in game.`,
};

/**
 * The jump list, in the order the page runs.
 *
 * Both halves that own a redirect are top level entries carrying the anchors
 * the 308s point at: `/mods` lands on #mods and `/commands` on #commands, so a
 * reader who arrived that way sees where they are. The register's own groups
 * hang under Commands, because each of them is a disclosure inside it.
 *
 * Built from COMMAND_SECTIONS rather than a second list of headings, the same
 * way the register itself is, so a group added to the config appears here
 * without anyone remembering to add it.
 */
// Read out of the register rather than typed twice, so the anchor and the
// group it names can never drift apart.
const PAGES_ANCHOR = COMMAND_SECTIONS.find((s) => s.id === 'the-pages')?.id ?? 'the-pages';

const JUMP_LINKS: JumpLink[] = [
  { href: `#${PAGES_ANCHOR}`, label: 'What each page is for' },
  { href: '#words', label: 'Words used here' },
  { href: '#mods', label: 'The modpack' },
  {
    href: '#commands',
    label: 'Commands',
    children: REGISTER_GROUPS.map((s) => ({ href: `#${s.id}`, label: s.title })),
  },
];

export default function ResourcesPage() {
  return (
    <div>
      <PageHeader slot="mods">
        <SectionHeader
          as="h1"
          title="Resources"
          subtitle="What each page holds, what to install, what to type, and what the hall will say back to you."
          icon={<Wrench size={22} />}
        />
      </PageHeader>

      {/* PC first. On a wide screen the wayfinder is a 260px rail that stays
          put while ten thousand pixels of reference scroll past it; `items-start`
          is what stops it stretching to the content column's height and killing
          the sticky. Below lg the grid collapses and the rail becomes the
          wrapped row of chips this page has always had, above the content. */}
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-10">
        <JumpList links={JUMP_LINKS} />

        <div className="min-w-0 space-y-14">
          <section id={PAGES_ANCHOR} className="scroll-mt-20">
            <PageGuide />
          </section>

          <section id="words" className="scroll-mt-20">
            <Glossary />
          </section>

          <section id="mods" className="scroll-mt-20">
            <ModsSection />
          </section>

          <section id="commands" className="scroll-mt-20">
            <RegisterSections />
          </section>
        </div>
      </div>
    </div>
  );
}
