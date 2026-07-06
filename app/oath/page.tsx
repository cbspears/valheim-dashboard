import type { Metadata } from 'next';
import { ScrollText, PenLine, MessageSquare } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { Charter } from '@/components/oath/Charter';
import { SignatureWall } from '@/components/oath/SignatureWall';
import { getOaths } from '@/lib/data';
import { SERVER_NAME, DISCORD_BOT_HANDLE } from '@/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Oath',
  description: `The charter every viking swears before sailing with ${SERVER_NAME} — and the wall of those who have.`,
};

export default async function OathPage() {
  const oaths = await getOaths();
  const count = oaths.length;
  // Signature wall reads newest-first; getOaths() returns oldest-first.
  const signatures = [...oaths].reverse();

  return (
    <div className="space-y-10">
      {/* The charter — carved stone tablet */}
      <Charter />

      {/* The signature wall */}
      <section>
        <PageHeader slot="oath" prominent>
          <SectionHeader
            title="The Signature Wall"
            subtitle={`${count} ${count === 1 ? 'viking has' : 'vikings have'} sworn.`}
            icon={<PenLine size={22} />}
          />
        </PageHeader>

        {/* How to swear — gold-accented explainer (mirrors the Map/Gallery idiom) */}
        <Card className="mb-6 border-l-2 border-l-gold">
          <CardBody>
            <div className="mb-3 flex items-center gap-2">
              <ScrollText size={18} className="text-gold" />
              <h2 className="font-display text-base tracking-wide text-ash">Swear your oath</h2>
            </div>
            <p className="text-sm leading-relaxed text-ash-dim">
              <MessageSquare size={14} className="mr-1.5 inline align-text-bottom text-gold-dim" />
              Post in Discord and tag the bot, using this format:
            </p>
            <p className="my-3">
              <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
                {DISCORD_BOT_HANDLE} oath — YourVikingName: your oath, one line
              </span>
            </p>
            <p className="text-sm leading-relaxed text-ash-dim">
              Give your <span className="font-semibold text-ash">in-game name</span>, not your
              Discord handle — the two rarely match, and the name is how the mark lands on the right
              viking&apos;s page. Spell it as it appears in-game. Swear again anytime to change your
              words; your latest oath replaces the last.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ash-dim">
              You can also swear without leaving the game — shout it:{' '}
              <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
                /s /oath your vow, one line
              </span>
              {'. '}It must be a shout — plain chat never leaves the campfire.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SignatureWall oaths={signatures} />
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
