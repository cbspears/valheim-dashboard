import type { Metadata } from 'next';
import Link from 'next/link';
import { Terminal, MessageCircle, Swords, Megaphone, Compass } from 'lucide-react';
import { Card, CardBody, SectionHeader } from '@/components/ui';
import { CommandEntry } from '@/components/commands/CommandEntry';
import { NotificationRow, PageRow } from '@/components/commands/RegistryRows';
import {
  COMMAND_SECTIONS,
  type CommandSection,
  type DiscordCommand,
  type GameShout,
  type Notification,
  type SitePage,
} from '@/config/commands';
import { SERVER_NAME } from '@/config/server';

// FULLY STATIC, and deliberately carrying no `revalidate`. The register is a
// TypeScript config file compiled into the build, not a query: there is no
// database read on this page and no clock after which its content could differ,
// so an ISR window would only buy a re-render of the same bytes. A copy fix
// ships the way `config/mods.ts` and the Get Started page's do, with the next
// deploy. Next reports it as ○ (Static), same as /mods and /get-started.
export const metadata: Metadata = {
  title: 'Commands',
  description: `Every command you can use in Discord and in game on ${SERVER_NAME}, every notice the hall sends back, and what each page holds.`,
};

const SECTION_ICONS: Record<string, React.ReactNode> = {
  'in-discord': <MessageCircle size={20} />,
  'in-the-game': <Swords size={20} />,
  'what-the-hall-says': <Megaphone size={20} />,
  'the-pages': <Compass size={20} />,
};

export default function CommandsPage() {
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader
          title="Commands"
          subtitle="Every word the hall answers to, and every word it says back. None of it costs anything but a shout."
          icon={<Terminal size={22} />}
        />

        {/* Jump links. A phone gets a wrapped row of chips rather than a rail,
            so the header never has to scroll sideways. */}
        <nav aria-label="Sections of this page" className="mb-6 flex flex-wrap gap-2">
          {COMMAND_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="gold-ring rounded-md border border-rune bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-ash-dim transition-colors hover:border-gold-dim hover:text-ash"
            >
              {s.title}
            </a>
          ))}
        </nav>

        <Card className="border-l-2 border-l-gold">
          <CardBody className="space-y-2">
            <p className="text-sm leading-relaxed text-ash-dim">
              Two rites do most of the work, and the{' '}
              <Link href="/get-started" className="text-gold-light hover:underline">
                Get Started
              </Link>{' '}
              page walks you through both: swear your oath, and turn on your position. Everything
              below is what the hall can do once you have.
            </p>
            <p className="text-xs leading-relaxed text-muted">
              In Discord, type the <span className="font-mono text-ash-dim">@</span> and pick{' '}
              <span className="text-ash-dim">{SERVER_NAME}</span> out of the popup, then add the
              rest of the line. Typing the letters by hand looks the same and does nothing. Tap any
              command below to copy the part that goes after the mention.
            </p>
          </CardBody>
        </Card>
      </section>

      {COMMAND_SECTIONS.map((section) => (
        <Section key={section.id} section={section} />
      ))}

      <p className="text-xs leading-relaxed text-muted">
        This register is generated from{' '}
        <span className="font-mono text-ash-dim">config/commands.ts</span>, and every entry in it
        names the code it came from. If something here is wrong, the code moved and the register did
        not.
      </p>
    </div>
  );
}

function Section({ section }: { section: CommandSection }) {
  return (
    <section id={section.id} className="scroll-mt-20">
      <SectionHeader
        title={section.title}
        subtitle={section.subtitle}
        icon={SECTION_ICONS[section.id]}
      />
      <Card>
        <CardBody>
          <ul>
            {section.entries.map((entry) => {
              switch (entry.kind) {
                case 'discord':
                case 'in-game':
                  return (
                    <CommandEntry key={entry.id} entry={entry as DiscordCommand | GameShout} />
                  );
                case 'notification':
                  return <NotificationRow key={entry.id} entry={entry as Notification} />;
                case 'page':
                  return <PageRow key={entry.id} entry={entry as SitePage} />;
              }
            })}
          </ul>
        </CardBody>
      </Card>
    </section>
  );
}
