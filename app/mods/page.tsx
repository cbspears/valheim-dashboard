import type { Metadata } from 'next';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  Boxes,
  Compass,
  Download,
  ExternalLink,
  Gem,
  HelpCircle,
  Scale,
  Scroll,
  Server,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  Card,
  CardBody,
  SectionHeader,
  Badge,
  EmptyState,
} from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { MODS, MOD_CATEGORIES, type Mod, type ModCategory } from '@/config/mods';
import { MODPACK_PROFILE_CODE } from '@/config/server';
import { CopyChip } from '@/components/get-started/CopyChip';

// Static page — reads only the curated mod config, no live DB.
export const metadata: Metadata = {
  title: 'Mods',
  description: 'Every mod running on The Fractured Realms, and which ones you must install to join.',
};

const CATEGORY_META: Record<
  ModCategory,
  { icon: LucideIcon; blurb: string }
> = {
  Core: {
    icon: Boxes,
    blurb: 'The core stack. Required to join the server.',
  },
  QoL: {
    icon: Wrench,
    blurb: 'Small comforts that smooth the long nights and lighten the pack.',
  },
  Content: {
    icon: Gem,
    blurb: 'Fresh loot, trinkets, and new reasons to go down into the dark.',
  },
  Balance: {
    icon: Scale,
    blurb: 'Tuning the realm so no path to glory is left behind.',
  },
};

function ModCard({ mod }: { mod: Mod }) {
  return (
    <Card
      className={clsx(
        'flex h-full flex-col transition-colors hover:border-rune-bright',
        mod.category === 'Core' && !mod.tentative && 'border-l-2 border-l-gold-dim',
        mod.tentative && 'border-dashed opacity-90'
      )}
    >
      <CardBody className="flex flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <h4 className="font-display text-base leading-snug tracking-wide text-ash">
            {mod.name}
          </h4>
          {mod.version ? (
            <Badge tone="neutral" className="shrink-0 font-mono">
              v{mod.version}
            </Badge>
          ) : (
            <Badge tone="neutral" className="shrink-0">
              latest
            </Badge>
          )}
        </div>

        <p className="-mt-1 text-xs text-muted">by {mod.author}</p>

        <p className="flex-1 text-sm leading-relaxed text-ash-dim">
          {mod.description}
        </p>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-rune pt-3">
          {mod.clientRequired ? (
            <Badge tone="gold">
              <Download size={11} />
              Client
            </Badge>
          ) : (
            <Badge tone="neutral">
              <Server size={11} />
              Server-only
            </Badge>
          )}

          {mod.tentative && (
            <Badge tone="neutral" className="text-muted">
              <HelpCircle size={11} />
              Considering
            </Badge>
          )}

          {mod.url && (
            <a
              href={mod.url}
              target="_blank"
              rel="noopener noreferrer"
              className="gold-ring inline-flex items-center gap-1 rounded text-xs font-medium text-gold-light transition-colors hover:underline"
            >
              View on Thunderstore
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export default function ModsPage() {
  const clientCount = MODS.filter((m) => m.clientRequired).length;

  return (
    <div>
      <PageHeader slot="mods">
        <SectionHeader
          title="The Mods"
          subtitle={
            MODPACK_PROFILE_CODE
              ? 'Install every mod marked Client before you can join. The one-click pack code below does it for you.'
              : 'Install every mod marked Client before you can join.'
          }
          icon={<Scroll size={22} />}
          action={
            <div className="hidden items-center gap-2 sm:flex">
              <Badge tone="gold">{clientCount} client</Badge>
              <Badge tone="neutral">{MODS.length} total</Badge>
            </div>
          }
        />
      </PageHeader>

      {/* Legend / install note */}
      <Card className="mb-9 border-l-2 border-l-gold">
        <CardBody className="flex items-start gap-3.5">
          <span className="mt-0.5 shrink-0 text-gold">
            <ShieldAlert size={20} />
          </span>
          <div className="min-w-0">
            <p className="mb-2 font-display text-base leading-snug tracking-wide text-gold-light sm:text-lg">
              Install every mod marked Client before you can join.
            </p>
            <p className="text-sm leading-relaxed text-ash-dim">
              Mods marked{' '}
              <Badge tone="gold" className="mx-0.5 align-middle">
                <Download size={11} />
                Client
              </Badge>{' '}
              must be installed on your own machine, matching the versions below, ideally
              through a mod manager like r2modman. Mods marked{' '}
              <Badge tone="neutral" className="mx-0.5 align-middle">
                <Server size={11} />
                Server-only
              </Badge>{' '}
              run on the server itself, so there is nothing for you to install.{' '}
              <Link
                href="/get-started"
                className="gold-ring inline-flex items-center gap-1 rounded font-medium text-gold-light hover:underline"
              >
                <Compass size={13} className="align-middle" />
                New here? Get started →
              </Link>
              {MODPACK_PROFILE_CODE ? (
                <>
                  <br />
                  <span className="mt-2 inline-block">
                    Or skip the list entirely: the one-click Eilif modpack installs every
                    client mod, pre-configured. r2modman → Import profile → From code:{' '}
                    <CopyChip value={MODPACK_PROFILE_CODE} />
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </CardBody>
      </Card>

      {MODS.length === 0 ? (
        <EmptyState
          icon={<Scroll size={28} />}
          title="No mods listed yet"
          message="The realm runs vanilla for now. Mods will appear here once the jarl installs them."
        />
      ) : (
        <div className="space-y-10">
          {MOD_CATEGORIES.map((category) => {
            const mods = MODS.filter((m) => m.category === category);
            if (mods.length === 0) return null;

            const { icon: CatIcon, blurb } = CATEGORY_META[category];

            return (
              <section key={category}>
                <div className="mb-4 flex items-baseline gap-2.5">
                  <span className="self-center text-gold-light">
                    <CatIcon size={17} />
                  </span>
                  <h3 className="font-display text-lg tracking-wide text-ash">
                    {category}
                  </h3>
                  <span className="text-xs text-muted">
                    {mods.length} {mods.length === 1 ? 'mod' : 'mods'}
                  </span>
                  <span className="ml-auto hidden text-xs text-muted sm:block">
                    {blurb}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {mods.map((mod) => (
                    <ModCard key={mod.name} mod={mod} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
