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
              <h2 className="font-display text-base tracking-wide text-ash">Swear your oath &amp; bind your viking</h2>
            </div>
            <p className="text-sm leading-relaxed text-ash-dim">
              Your first oath is also how you <span className="font-semibold text-ash">bind your Discord to your viking</span>,
              so your deeds, photos, and title all gather under your name. Two steps, once.
            </p>

            {/* Step 1 — claim a private rune in Discord */}
            <div className="mt-4 flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-gold/20 font-mono text-xs font-bold text-gold-light">
                1
              </span>
              <div className="text-sm leading-relaxed text-ash-dim">
                <p>
                  <MessageSquare size={14} className="mr-1.5 inline align-text-bottom text-gold-dim" />
                  In Discord, tag the bot to claim your viking:
                </p>
                <p className="my-2">
                  <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
                    {DISCORD_BOT_HANDLE} I am YourVikingName
                  </span>
                </p>
                <p>
                  The bot replies in a <span className="font-semibold text-ash">private message</span> with a
                  one-time rune. Keep it to yourself — anyone who has it could bind your name to their viking.
                  (No message arrives? Open direct messages for this server, then ask again.)
                </p>
              </div>
            </div>

            {/* Step 2 — shout the rune in-game */}
            <div className="mt-4 flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-gold/20 font-mono text-xs font-bold text-gold-light">
                2
              </span>
              <div className="text-sm leading-relaxed text-ash-dim">
                <p>
                  Log in, then <span className="font-semibold text-ash">shout</span> the rune with your vow:
                </p>
                <p className="my-2">
                  <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
                    /s /oath YOURRUNE — your vow, one line
                  </span>
                </p>
                <p>
                  Whatever viking you are playing becomes yours. It must be a{' '}
                  <span className="font-semibold text-ash">shout</span> (<span className="font-mono text-xs">/s</span>) —
                  plain chat never leaves the campfire.
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-ash-dim">
              Already bound? Change your words anytime — shout{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                /s /oath your new vow
              </span>{' '}
              in-game, or from Discord just{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-gold-light">
                {DISCORD_BOT_HANDLE} oath — your new vow
              </span>
              {' '}— no name needed, it lands on your bound viking. Your latest oath replaces the last.
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
