import type { Metadata } from 'next';
import { ScrollText, PenLine } from 'lucide-react';
import { SectionHeader, Card, CardBody } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { SignatureWall } from '@/components/oath/SignatureWall';
import { getOaths } from '@/lib/data';
import { SERVER_NAME, DISCORD_BOT_HANDLE } from '@/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Oath',
  description: `How to swear your oath and bind your viking — and the wall of every vow sworn in ${SERVER_NAME}.`,
};

export default async function OathPage() {
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
            title="Swear Your Oath to Odin"
            subtitle={`${count} ${count === 1 ? 'viking has' : 'vikings have'} sworn.`}
            icon={<PenLine size={22} />}
          />
        </PageHeader>

        {/* Swear & bind — compact, at the top */}
        <Card className="mb-6 border-l-2 border-l-gold">
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2">
              <ScrollText size={18} className="text-gold" />
              <h2 className="font-display text-base tracking-wide text-ash">
                Swear your oath &amp; bind your viking{' '}<span className="font-body text-xs font-normal tracking-normal text-muted">(oath + Discord account link guide)</span>
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-ash-dim">
              Two steps, once — your first oath also binds your Discord to your viking, so your
              deeds, photos, and title gather under one name.
            </p>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-relaxed text-ash-dim">
              <span className="flex h-5 w-5 flex-none translate-y-0.5 items-center justify-center rounded-full bg-gold/20 font-mono text-xs font-bold text-gold-light">
                1
              </span>
              <span>In Discord:</span>
              <span className="rounded bg-gold/15 px-2 py-0.5 font-mono text-xs font-semibold text-gold-light">
                {DISCORD_BOT_HANDLE} I am YourVikingName
              </span>
              <span>
                — the bot DMs you a one-time rune. Keep it private. (No DM? Allow direct messages
                for this server and ask again.)
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-relaxed text-ash-dim">
              <span className="flex h-5 w-5 flex-none translate-y-0.5 items-center justify-center rounded-full bg-gold/20 font-mono text-xs font-bold text-gold-light">
                2
              </span>
              <span>
                In game, <span className="font-semibold text-ash">shout</span> it:
              </span>
              <span className="rounded bg-gold/15 px-2 py-0.5 font-mono text-xs font-semibold text-gold-light">
                /s /oath YOURRUNE — your vow, one line
              </span>
              <span>
                — it must be a shout (<span className="font-mono text-xs">/s</span>); plain chat
                never leaves the campfire.
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Re-swear anytime:{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gold-light">
                /s /oath your new vow
              </span>{' '}
              in-game, or{' '}
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gold-light">
                {DISCORD_BOT_HANDLE} oath — your new vow
              </span>{' '}
              in Discord. Your latest oath replaces the last.
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
