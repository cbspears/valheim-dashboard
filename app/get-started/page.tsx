import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Compass,
  Package,
  Download,
  Anchor,
  Monitor,
  Laptop,
  Terminal,
  MapPin,
  UserRound,
  Bed,
  Sailboat,
  RefreshCcw,
  Wrench,
  MessageCircle,
  ExternalLink,
  ListChecks,
  Ship,
  TriangleAlert,
} from 'lucide-react';
import { Card, CardBody, SectionHeader, Badge } from '@/components/ui';
import {
  SERVER_NAME,
  SERVER_ADDRESS,
  DISCORD_URL,
  MODPACK_PROFILE_CODE,
} from '@/config/server';
import { CLIENT_MODS } from '@/config/mods';

export const metadata: Metadata = {
  title: 'Get Started',
  description: `New to ${SERVER_NAME}? Install the mods and join the server — step by step, for Windows, Mac, and Linux.`,
};

const R2MODMAN_URL = 'https://thunderstore.io/c/valheim/p/ebkr/r2modman/';

/* ── small presentational helpers ─────────────────────────────────────────── */

function Step({
  n,
  title,
  icon,
  children,
}: {
  n: number;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardBody className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-base text-gold-light tabular-nums">
            {n}
          </span>
          <h3 className="flex items-center gap-2 font-display text-base tracking-wide text-ash">
            <span className="text-gold">{icon}</span>
            {title}
          </h3>
        </div>
        <div className="flex flex-1 flex-col gap-2 text-sm leading-relaxed text-ash-dim">
          {children}
        </div>
      </CardBody>
    </Card>
  );
}

function Platform({
  icon,
  name,
  difficulty,
  tone,
  children,
}: {
  icon: ReactNode;
  name: string;
  difficulty: string;
  tone: 'online' | 'gold' | 'raid';
  children: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardBody className="flex flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 font-display text-base text-ash">
            <span className="text-gold-light">{icon}</span>
            {name}
          </h4>
          <Badge tone={tone}>{difficulty}</Badge>
        </div>
        <div className="space-y-2 text-sm leading-relaxed text-ash-dim">{children}</div>
      </CardBody>
    </Card>
  );
}

function Tip({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-gold-light">{icon}</span>
      <span className="text-sm leading-relaxed text-ash-dim">
        <span className="font-medium text-ash">{title}</span> — {children}
      </span>
    </li>
  );
}

function Trouble({ symptom, children }: { symptom: string; children: ReactNode }) {
  return (
    <div className="border-t border-rune/60 py-3 first:border-t-0 first:pt-0">
      <p className="flex items-start gap-2 font-medium text-ash">
        <TriangleAlert size={15} className="mt-0.5 shrink-0 text-gold" />
        {symptom}
      </p>
      <p className="mt-1 pl-[23px] text-sm leading-relaxed text-ash-dim">{children}</p>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="gold-ring inline-flex items-center gap-1 rounded font-medium text-gold-light hover:underline"
    >
      {children}
      <ExternalLink size={12} />
    </a>
  );
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-2 font-display text-lg tracking-wide text-ash">
      <span className="text-gold">{icon}</span>
      {children}
    </h2>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

export default function GetStartedPage() {
  const discord = DISCORD_URL || null;

  return (
    <div className="flex flex-col gap-12">
      <SectionHeader
        title="Get Started"
        subtitle={`New to ${SERVER_NAME}? Three steps to install the mods and join the server — about 15 minutes, no experience needed.`}
        icon={<Compass size={22} />}
      />

      {/* ── Connect at a glance ─────────────────────────────────────────── */}
      <Card className="border-l-2 border-l-gold-dim">
        <CardBody className="grid gap-5 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">Server address</p>
            <p className="mt-1 font-mono text-sm text-ash">
              {SERVER_ADDRESS || 'shared in Discord'}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">Password</p>
            <p className="mt-1 text-sm text-ash">
              {discord ? (
                <Ext href={discord}>ask in Discord</Ext>
              ) : (
                'ask in Discord (kept off this public page)'
              )}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">You must install</p>
            <p className="mt-1 text-sm text-ash">
              {CLIENT_MODS.length} client mod{CLIENT_MODS.length === 1 ? '' : 's'} (below) — exact
              versions
            </p>
          </div>
        </CardBody>
      </Card>

      {/* ── Three-step path ─────────────────────────────────────────────── */}
      <section>
        <SectionTitle icon={<Ship size={18} />}>The three steps</SectionTitle>
        <p className="mb-5 max-w-3xl text-sm leading-relaxed text-muted">
          The trick is to <strong className="text-ash-dim">not install mods by hand</strong>. A free
          mod manager grabs the loader, every mod, and the exact versions for you, and keeps your
          modded copy separate from vanilla. Same three steps on Windows, Mac, and Linux —
          platform-specific notes are further down.
        </p>

        <div className="grid gap-4 lg:grid-cols-3">
          <Step n={1} title="Install a mod manager" icon={<Package size={16} />}>
            <p>
              Download <Ext href={R2MODMAN_URL}>r2modman</Ext> (free; Windows, Mac, Linux) — the
              Thunderstore Mod Manager is the same tool if you prefer it. Open it and choose{' '}
              <span className="text-ash">Valheim</span> from the game list.
            </p>
            <p className="text-xs text-muted">
              It installs BepInEx (the mod loader) for you — you never set that up by hand.
            </p>
          </Step>

          <Step n={2} title="Add the mods" icon={<Download size={16} />}>
            {MODPACK_PROFILE_CODE ? (
              <p>
                In r2modman choose <span className="text-ash">Import / Update → Import code</span>{' '}
                and paste:
                <code className="mt-1 block rounded bg-surface-raised px-2 py-1 font-mono text-xs text-gold-light">
                  {MODPACK_PROFILE_CODE}
                </code>
                That installs the whole pack at the right versions in one go. Done.
              </p>
            ) : (
              <>
                <p>
                  Inside r2modman, search for and install each of the{' '}
                  {CLIENT_MODS.length} mods listed in{' '}
                  <a href="#client-mods" className="text-gold-light hover:underline">
                    What you install
                  </a>{' '}
                  below.
                </p>
                <p className="text-xs text-muted">
                  Soon there&apos;ll be a single shared code that installs them all at once — until
                  then, add the three individually (the manager keeps the versions right).
                </p>
              </>
            )}
          </Step>

          <Step n={3} title="Launch & connect" icon={<Anchor size={16} />}>
            <p>
              Click <span className="text-ash">Start modded</span> in r2modman (not Steam&apos;s
              normal Play button). In game:{' '}
              <span className="text-ash">Start Game → pick your character → Join Game → Join by IP</span>.
            </p>
            <p>
              Enter{' '}
              <span className="font-mono text-ash">{SERVER_ADDRESS || 'the server address'}</span>{' '}
              and the password. Welcome to {SERVER_NAME}. 🛡️
            </p>
          </Step>
        </div>
      </section>

      {/* ── Required client mods ────────────────────────────────────────── */}
      <section id="client-mods" className="scroll-mt-20">
        <SectionTitle icon={<Download size={18} />}>What you install (client mods)</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CLIENT_MODS.map((m) => (
            <Card key={m.name}>
              <CardBody className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-display text-sm text-ash">{m.name}</h4>
                  {m.version && (
                    <Badge tone="neutral" className="shrink-0 font-mono">
                      v{m.version}
                    </Badge>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted">{m.description}</p>
                {m.url && (
                  <span className="mt-1">
                    <Ext href={m.url}>Thunderstore</Ext>
                  </span>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
        <p className="mt-3 text-sm text-muted">
          Everything else runs on the server — see{' '}
          <Link href="/mods" className="gold-ring rounded font-medium text-gold-light hover:underline">
            the full mod list
          </Link>
          . Match versions exactly: a mismatch is the #1 reason a join is refused.
        </p>
      </section>

      {/* ── First-login best practices (moved up — the happy path) ──────── */}
      <section>
        <SectionTitle icon={<ListChecks size={18} />}>
          You&apos;re in — your first night
        </SectionTitle>
        <Card>
          <CardBody>
            <ul className="grid gap-4 sm:grid-cols-2">
              <Tip icon={<MapPin size={16} />} title="Turn on your location">
                Open the map (<span className="font-mono text-xs">M</span>) and enable{' '}
                <span className="text-ash">Share position</span> (bottom-left) so the warband can
                see each other and rally.
              </Tip>
              <Tip icon={<UserRound size={16} />} title="Use a clear character name">
                It&apos;s how you show up in the{' '}
                <Link href="/players" className="text-gold-light hover:underline">
                  leaderboards
                </Link>{' '}
                and Discord recaps. Make it recognizable.
              </Tip>
              <Tip icon={<Bed size={16} />} title="Claim a bed early">
                Build a bed and sleep in it to set your spawn — dying back at the start is a long row
                home.
              </Tip>
              <Tip icon={<Sailboat size={16} />} title="Don't sail ahead of the longship">
                Progression is boss-gated — the whole point of the Cozy Canon. Stay with the fleet;
                don&apos;t rush biomes the group hasn&apos;t unlocked.
              </Tip>
              <Tip icon={<RefreshCcw size={16} />} title="Don't auto-update mods">
                Let the group update together and keep versions pinned. A solo update will lock you
                out until everyone matches.
              </Tip>
              <Tip icon={<MessageCircle size={16} />} title="Live in Discord">
                Boss raids, base coords, and &quot;is the server up?&quot; all happen there. The
                server restarts every few hours — a brief drop is normal.
              </Tip>
            </ul>
          </CardBody>
        </Card>
      </section>

      {/* ── Platform notes ──────────────────────────────────────────────── */}
      <section>
        <SectionTitle icon={<Monitor size={18} />}>Notes for your platform</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-3">
          <Platform icon={<Monitor size={17} />} name="Windows" difficulty="Easiest" tone="online">
            <p>The smooth path. Install r2modman&apos;s Windows app, pick Valheim, add the mods, Start modded.</p>
            <p className="text-xs text-muted">
              If Windows SmartScreen warns on the installer, choose <em>More info → Run anyway</em>.
            </p>
          </Platform>

          <Platform icon={<Terminal size={17} />} name="Linux / Steam Deck" difficulty="Doable" tone="gold">
            <p>
              Valheim runs natively. Use the r2modman AppImage, then in Steam set the game&apos;s launch
              options so the loader hooks in:
            </p>
            <code className="block rounded bg-surface-raised px-2 py-1 font-mono text-[11px] text-gold-light">
              WINEDLLOVERRIDES=&quot;winhttp=n,b&quot; %command%
            </code>
            <p className="text-xs text-muted">
              On Steam Deck, do this in Desktop Mode. r2modman&apos;s Valheim instructions cover the
              exact steps.
            </p>
          </Platform>

          <Platform icon={<Laptop size={17} />} name="Mac" difficulty="Tricky" tone="raid">
            <p>
              <strong className="text-ash-dim">Valheim has no native Mac version</strong>, so there&apos;s
              an extra hop. Run the Windows build through{' '}
              <Ext href="https://www.codeweavers.com/crossover">CrossOver</Ext> or{' '}
              <Ext href="https://getwhisky.app/">Whisky</Ext> (both wrap Windows games on macOS),
              then install r2modman inside that environment.
            </p>
            <p className="text-xs text-muted">
              Cloud streaming (GeForce NOW) <em>can&apos;t</em> run mods. On an Apple-Silicon Mac the
              easiest answer is often borrowing a Windows/Linux PC — ask in Discord and we&apos;ll
              help you get set up.
            </p>
          </Platform>
        </div>
      </section>

      {/* ── Manual install (advanced) ───────────────────────────────────── */}
      <Card>
        <CardBody className="flex items-start gap-3.5">
          <span className="mt-0.5 shrink-0 text-gold">
            <Wrench size={18} />
          </span>
          <div className="text-sm leading-relaxed text-ash-dim">
            <p className="font-medium text-ash">Prefer to do it by hand?</p>
            <p className="mt-1">
              Advanced only: install the{' '}
              <Ext href="https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/">
                BepInEx pack
              </Ext>{' '}
              into your Valheim folder, then drop each mod&apos;s files into{' '}
              <span className="font-mono text-xs">BepInEx/plugins</span>. A manager is strongly
              recommended instead — version-matching by hand is exactly what trips people up.
            </p>
          </div>
        </CardBody>
      </Card>

      {/* ── Troubleshooting ─────────────────────────────────────────────── */}
      <section>
        <SectionTitle icon={<Wrench size={18} />}>When something won&apos;t cooperate</SectionTitle>
        <Card>
          <CardBody>
            <Trouble symptom="“Incompatible version” or the join is refused">
              Your mods don&apos;t match the server. Make sure every client mod is the{' '}
              <em>exact</em> version listed above (or re-import the shared modpack code) and that
              nobody added an extra mod. This is by far the most common issue.
            </Trouble>
            <Trouble symptom="Game launches but no mods are loaded">
              You started vanilla. Always launch with <span className="text-ash">Start modded</span>{' '}
              from r2modman. On Linux/Proton, double-check the{' '}
              <span className="font-mono text-xs">WINEDLLOVERRIDES</span> launch option is set.
            </Trouble>
            <Trouble symptom="It won't run on my Mac">
              There&apos;s no native Mac client — you need CrossOver or Whisky (see the Mac card
              above), or a Windows/Linux machine. Ask in Discord and we&apos;ll walk you through it.
            </Trouble>
            <Trouble symptom="“Failed to connect” / can't reach the server">
              The server may be mid-restart (it cycles every few hours) — wait a minute and retry.
              Otherwise double-check the address and that you&apos;ve got the current password.
            </Trouble>
            <Trouble symptom="Crash on launch or a black screen">
              Usually a stray or mismatched mod. Reset to just the required list (or the shared
              profile) and relaunch. Still stuck? Drop your r2modman log in Discord.
            </Trouble>
          </CardBody>
        </Card>
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <MessageCircle size={15} className="text-gold-light" />
          Still stuck?{' '}
          {discord ? (
            <Ext href={discord}>Ask in Discord</Ext>
          ) : (
            <span>Ask in Discord — someone will get you sailing.</span>
          )}
        </p>
      </section>
    </div>
  );
}
