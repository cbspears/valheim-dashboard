import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollText, PenLine, ExternalLink } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { SignatureWall } from '@/components/oath/SignatureWall';
import { getOaths } from '@/lib/data';
import { SERVER_NAME, DISCORD_URL } from '@/config/server';

// SIXTY SECONDS OF ISR (2026-09-06). An oath is sworn once, in game, and the
// wall is otherwise unchanging. A new signature joins it within the minute.
export const revalidate = 60;

export const metadata: Metadata = {
  title: 'The Oath Wall',
  description: `Every vow sworn in ${SERVER_NAME}, and how to swear yours.`,
};

export default async function OathPage() {
  // Empty until the permanent invite is set (config/server.ts). The one
  // instruction on this page that sends a reader somewhere else sends them to
  // Discord, so it carries the exit the moment there is one to carry.
  const discord = DISCORD_URL || null;
  const oaths = await getOaths();
  const count = oaths.length;
  // Signature wall reads newest-first; getOaths() returns oldest-first.
  const signatures = [...oaths].reverse();

  return (
    <div className="space-y-10">
      {/* The Charter ("Oath of Eilif" tablet) is PARKED — Charlie 2026-08-23,
          may return later. Component + config/oath.ts kept intact. */}

      <section>
        <PageHeader slot="oath" prominent>
          <SectionHeader
            as="h1"
            title="The Oath Wall"
            subtitle={
              count === 0
                ? 'No marks yet. The wall waits for the first vow spoken in the hall.'
                : `${count} ${count === 1 ? 'viking has' : 'vikings have'} sworn. Every vow as it was spoken, newest first.`
            }
            icon={<PenLine size={22} />}
          />
        </PageHeader>

        {/* How to swear — three lines and a link. The full rite used to be
            printed here as well as on Get Started, and the two copies had
            already drifted apart ("One rite, three moves" against "One rite,
            three moves, once"). Get Started is the model register and owns the
            procedure; this page holds the wall. */}
        <Card className="mb-6 border-l-2 border-l-gold">
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2">
              <ScrollText size={18} className="text-gold" />
              <h2 className="font-display text-base tracking-wide text-ash">
                How to swear, and how to link your Discord
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-ash-dim">
              Swearing an oath also binds your Discord to your viking, so your deeds, photos and
              title gather under one name.
            </p>
            <p className="text-sm leading-relaxed text-ash-dim">
              Ask {SERVER_NAME}{' '}
              {discord ? (
                <a
                  href={discord}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gold-ring inline-flex items-center gap-1 rounded font-medium text-gold-light prose-link"
                >
                  in Discord
                  <ExternalLink size={12} />
                </a>
              ) : (
                'in Discord'
              )}
              , shout the rune it sends back, and your vow is carved here.
            </p>
            <p className="text-sm leading-relaxed text-ash-dim">
              Full walkthrough on{' '}
              <Link
                href="/get-started"
                className="gold-ring rounded font-medium text-gold-light prose-link"
              >
                Get Started
              </Link>
              .
            </p>
            <p className="text-xs leading-relaxed text-muted">
              Re-swear anytime in game with{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                /s /oath your new vow
              </span>
              . Your latest oath replaces the last.
            </p>
          </CardBody>
        </Card>

        {/* The oaths themselves */}
        <Card>
          <CardBody>
            <SignatureWall oaths={signatures} />
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
