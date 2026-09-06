import Link from 'next/link';
import { ChevronDown, MessageCircle, Swords, Megaphone, Signpost } from 'lucide-react';
import { Card, CardBody, SectionHeader, Badge } from '@/components/ui';
import { CommandEntry } from '@/components/commands/CommandEntry';
import { NotificationRow } from '@/components/commands/RegistryRows';
import {
  COMMAND_SECTIONS,
  type CommandSection,
  type DiscordCommand,
  type GameShout,
  type Notification,
  type RegistryEntry,
} from '@/config/commands';

/**
 * The register half of /resources: every command, every shout, every marker,
 * and everything the hall says back.
 *
 * Lifted out of app/commands/page.tsx on 2026-09-06 when Mods and Commands
 * became one page, and restacked the same day. Two things changed:
 *
 *   1. THE PAGES GROUP IS NOT HERE ANY MORE. It opens the page instead
 *      (components/resources/PageGuide.tsx), because it is the one thing on
 *      this page a first-timer wants and it used to sit at the very bottom of
 *      the longest page on the site. The register still carries it as a
 *      section, so the tripwire still walks it; this half skips it by id and
 *      the page draws it once, up top.
 *   2. EACH GROUP IS A DISCLOSURE, the first open and the rest closed. Fully
 *      expanded, the four groups were about eight thousand pixels of continuous
 *      reference between a reader and the end of the page. Collapsed, the whole
 *      register is a short list of headings you open one at a time, which is
 *      what a register is for.
 *
 * It reads `config/commands.ts` and holds no copy of its own about what the bot
 * does. scripts/commands-page.test.mjs is the tripwire over both.
 */

const SECTION_ICONS: Record<string, React.ReactNode> = {
  'in-discord': <MessageCircle size={18} />,
  'in-the-game': <Swords size={18} />,
  'what-the-hall-says': <Megaphone size={18} />,
};

/** Drawn at the top of the page instead, so the register half skips it. */
const LIFTED_TO_THE_TOP = 'the-pages';

export const REGISTER_GROUPS: CommandSection[] = COMMAND_SECTIONS.filter(
  (s) => s.id !== LIFTED_TO_THE_TOP
);

export function RegisterSections() {
  return (
    <div>
      <SectionHeader
        title="Commands"
        subtitle="Every word the hall answers to, and every word it says back. None of it costs anything but a shout."
        icon={<MessageCircle size={22} />}
      />

      <Card className="mb-6 border-l-2 border-l-gold">
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
          {/* Scoped to nothing, deliberately. This card sits above all three
              groups, and only one of them is Discord: the shouts go into game
              chat and the board markers are written on a sign. What a Discord
              chip copies, and why, is said once, in the In Discord subtitle. */}
          <p className="text-xs leading-relaxed text-muted">
            Open a group to read it. Click or tap any command inside to copy it.
          </p>
        </CardBody>
      </Card>

      <div className="space-y-3">
        {REGISTER_GROUPS.map((section, i) => (
          <Group key={section.id} section={section} open={i === 0} />
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

/**
 * One group of the register, behind a disclosure.
 *
 * The id rides on the <details> rather than a wrapper, so a jump link lands on
 * the summary whether the group is open or shut. `open` is a plain HTML
 * attribute here, not state: a disclosure a reader opens stays open on its own,
 * so this component ships no JavaScript of its own. (The page as a whole is not
 * JavaScript free: every CommandEntry renders a CopyChip, which is a client
 * component, so /resources does hydrate.)
 *
 * THE TARGET HIGHLIGHT IS A RING, NOT A BORDER, and that is load bearing. A
 * chip pointing into a shut group lands on its summary with the group still
 * shut, so the landing needs to be visible. `.card-surface` in app/globals.css
 * is declared OUTSIDE any cascade layer while every Tailwind utility lives
 * inside `@layer utilities`, and an unlayered declaration beats a layered one
 * whatever the specificity, so its `border: 1px solid var(--color-rune)`
 * silently wins over any `target:border-*`. A ring is a box-shadow, which
 * card-surface does not set, so it lands.
 */
function Group({ section, open }: { section: CommandSection; open: boolean }) {
  // Partitioned with a loop rather than two filters so the sign markers keep
  // the order the register gives them and nothing is walked twice.
  const shouts: RegistryEntry[] = [];
  const signs: RegistryEntry[] = [];
  for (const entry of section.entries) {
    if (entry.kind === 'in-game' && entry.how === 'sign') {
      signs.push(entry);
    } else {
      shouts.push(entry);
    }
  }

  return (
    <details
      id={section.id}
      open={open}
      className="card-surface group scroll-mt-20 overflow-hidden target:ring-2 target:ring-gold-dim"
    >
      <summary className="gold-ring cursor-pointer list-none px-5 py-4 transition-colors hover:bg-surface-raised/60 [&::-webkit-details-marker]:hidden">
        {/* A heading is the one element a <summary> may hold besides phrasing
            content, which is what keeps the outline honest: h2 for the half,
            h3 for each group inside it. */}
        <h3 className="flex items-center gap-2.5 font-display text-lg tracking-wide text-ash">
          <span className="shrink-0 text-gold-light">{SECTION_ICONS[section.id]}</span>
          <span className="min-w-0 flex-1">{section.title}</span>
          <Badge tone="neutral" className="shrink-0 font-sans text-xs">
            {countLabel(section, shouts, signs)}
          </Badge>
          <ChevronDown
            size={16}
            className="shrink-0 text-muted transition-transform group-open:rotate-180"
          />
        </h3>
      </summary>

      <div className="border-t border-rune px-5 py-5">
        <p className="mb-5 text-sm leading-relaxed text-muted">{section.subtitle}</p>

        <ul>
          {shouts.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>

        {signs.length > 0 && (
          <div className="mt-8">
            {/* The markers are in this group because a sign is an in game
                thing, but writing one is not shouting, so they get their own
                label inside it rather than a fifth group of their own. */}
            <div className="mb-3 flex items-baseline gap-2.5">
              <span className="self-center text-gold-light">
                <Signpost size={16} />
              </span>
              <h4 className="font-display text-base tracking-wide text-ash">
                Boards you write on a sign
              </h4>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-muted">
              Nothing is typed into chat for these. The marker is the whole text of a plain wooden
              sign, and the hall reads it off the world itself.
            </p>
            <Card>
              <CardBody>
                <ul>
                  {signs.map((entry) => (
                    <Row key={entry.id} entry={entry} />
                  ))}
                </ul>
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * What a shut group is counting, so the number on it means something.
 *
 * Two groups hold one kind of thing each and one does not: "In the game" holds
 * six shouted commands and four board markers, and the badge used to call all
 * ten of them commands, four lines above a sub-block whose own copy reads
 * "Nothing is typed into chat for these". Signs are counted separately when a
 * group has any.
 */
function countLabel(section: CommandSection, shouts: RegistryEntry[], signs: RegistryEntry[]) {
  const noun = section.entries[0]?.kind === 'notification' ? 'notice' : 'command';
  const spoken = `${shouts.length} ${plural(noun, shouts.length)}`;
  return signs.length > 0 ? `${spoken}, ${signs.length} ${plural('sign', signs.length)}` : spoken;
}

const plural = (word: string, n: number) => (n === 1 ? word : `${word}s`);

function Row({ entry }: { entry: RegistryEntry }) {
  switch (entry.kind) {
    case 'discord':
    case 'in-game':
      return <CommandEntry entry={entry as DiscordCommand | GameShout} />;
    case 'notification':
      return <NotificationRow entry={entry as Notification} />;
    case 'page':
      // Drawn at the top of the page by components/resources/PageGuide.tsx.
      return null;
  }
}
