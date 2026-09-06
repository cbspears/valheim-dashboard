import Link from 'next/link';
import { MessageCircle, Swords, Megaphone, Compass } from 'lucide-react';
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

/**
 * The register half of /resources: every command, every shout, every marker,
 * everything the hall says back, and what each page holds.
 *
 * Lifted out of app/commands/page.tsx on 2026-09-06 when Mods and Commands
 * became one page. The four groups render as h3 under this section's h2, which
 * is what keeps the merged page's outline honest: one h1, two halves, groups
 * inside them.
 *
 * It reads `config/commands.ts` and holds no copy of its own about what the
 * bot does. scripts/commands-page.test.mjs is the tripwire over both.
 */

const SECTION_ICONS: Record<string, React.ReactNode> = {
  'in-discord': <MessageCircle size={18} />,
  'in-the-game': <Swords size={18} />,
  'what-the-hall-says': <Megaphone size={18} />,
  'the-pages': <Compass size={18} />,
};

export function RegisterSections() {
  return (
    <div>
      <SectionHeader
        title="Commands"
        subtitle="Every word the hall answers to, and every word it says back. None of it costs anything but a shout."
        icon={<MessageCircle size={22} />}
      />

      <Card className="mb-9 border-l-2 border-l-gold">
        <CardBody className="space-y-2">
          <p className="text-sm leading-relaxed text-ash-dim">
            Two rites do most of the work, and the{' '}
            <Link
              href="/get-started"
              className="gold-ring rounded text-gold-light prose-link"
            >
              Get Started
            </Link>{' '}
            page walks you through both: swear your oath, and turn on your position. Everything
            below is what the hall can do once you have.
          </p>
          {/* Scoped to nothing, deliberately. This card sits above all four
              groups, and only one of them is Discord: the shouts go into game
              chat and the board markers are written on a sign, where there is
              no mention and no popup. What a Discord chip copies, and why, is
              said once, in the In Discord subtitle below. */}
          <p className="text-xs leading-relaxed text-muted">
            Click or tap any command below to copy it.
          </p>
        </CardBody>
      </Card>

      <div className="space-y-10">
        {COMMAND_SECTIONS.map((section) => (
          <Group key={section.id} section={section} />
        ))}
      </div>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        This register is generated from{' '}
        <span className="font-mono text-ash-dim">config/commands.ts</span>, and every entry in it
        names the code it came from. If something here is wrong, the code moved and the register did
        not.
      </p>
    </div>
  );
}

function Group({ section }: { section: CommandSection }) {
  return (
    <section id={section.id} className="scroll-mt-20">
      {/* Same shape as the mod categories on the half above: label, then its
          caption directly under it rather than a column away. */}
      <div className="mb-4">
        <div className="flex items-baseline gap-2.5">
          <span className="self-center text-gold-light">{SECTION_ICONS[section.id]}</span>
          <h3 className="font-display text-lg tracking-wide text-ash">{section.title}</h3>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted">{section.subtitle}</p>
      </div>

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
