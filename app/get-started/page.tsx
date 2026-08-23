import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Compass,
  Anchor,
  Package,
  Gamepad2,
  Download,
  Play,
  LogIn,
  Monitor,
  Laptop,
  Terminal,
  MapPin,
  UserRound,
  RefreshCcw,
  Wrench,
  MessageCircle,
  ExternalLink,
  Ship,
  TriangleAlert,
  ScrollText,
} from 'lucide-react';
import { Card, CardBody, SectionHeader, Badge } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { CopyChip } from '@/components/get-started/CopyChip';
import {
  SERVER_NAME,
  SERVER_ADDRESS,
  SERVER_PASSWORD,
  DISCORD_URL,
  DISCORD_BOT_HANDLE,
  MODPACK_PROFILE_CODE,
} from '@/config/server';

export const metadata: Metadata = {
  title: 'Get Started',
  description: `New to ${SERVER_NAME}? Log on and install the mods in five steps, then the rituals that put you on the map.`,
};

const R2MODMAN_DOWNLOAD_URL = 'https://github.com/ebkr/r2modmanPlus/releases/latest';

/* ── small presentational helpers ─────────────────────────────────────────── */

/** One big numbered step in a vertical "follow me" list. */
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
    <li className="flex gap-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-lg text-gold-light tabular-nums">
        {n}
      </span>
      <div className="flex-1 space-y-2 pb-2 pt-1.5">
        <h3 className="flex items-center gap-2 font-display text-base tracking-wide text-ash">
          <span className="text-gold">{icon}</span>
          {title}
        </h3>
        <div className="space-y-2 text-sm leading-relaxed text-ash-dim">{children}</div>
      </div>
    </li>
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
  const bot = DISCORD_BOT_HANDLE; // e.g. "@Eilif"

  return (
    <div className="flex flex-col gap-12">
      <PageHeader slot="get-started">
        <SectionHeader
          title="Get Started"
          subtitle={`New to ${SERVER_NAME}? Log on and install the mods in five steps — about 15 minutes, no experience needed. Then the three things to do once you're in.`}
          icon={<Compass size={22} />}
        />
      </PageHeader>

      {/* ══════════════ SECTION A — SERVER INFO ══════════════ */}
      <section>
        <SectionTitle icon={<Ship size={20} />}>Server info</SectionTitle>

        {/* Connect at a glance */}
        <Card className="mb-6 border-l-2 border-l-gold-dim">
          <CardBody className="grid gap-5 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted">Server address</p>
              {SERVER_ADDRESS ? (
                <div className="mt-1.5">
                  <CopyChip value={SERVER_ADDRESS} />
                </div>
              ) : (
                <p className="mt-1 text-sm text-ash">shared in Discord</p>
              )}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted">Password</p>
              <div className="mt-1.5">
                <CopyChip value={SERVER_PASSWORD} />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted">How to connect</p>
              <p className="mt-1 text-sm text-ash">
                Steam PC only — <span className="text-ash-dim">crossplay is off</span>
              </p>
            </div>
          </CardBody>
        </Card>
      </section>

      {/* ══════════════ SECTION B — QUICK START ══════════════ */}
      <section>
        <SectionTitle icon={<Compass size={20} />}>
          Quick start — install the mods &amp; log on{' '}
          <span className="font-body text-xs font-normal tracking-normal text-muted">
            (prefer to install mods by hand? see the{' '}
            <Link href="/mods" className="text-gold-light hover:underline">
              Mods page
            </Link>
            )
          </span>
        </SectionTitle>

        <Card>
          <CardBody>
            <ol className="space-y-6">
              <Step n={1} title="Install the mod manager" icon={<Package size={16} />}>
                <p>
                  r2modman is the free app that installs and manages all the mods for you — Windows
                  and Linux. There&apos;s no Mac version.
                </p>
                <div className="py-1.5">
                  <a
                    href={R2MODMAN_DOWNLOAD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
                  >
                    <Download size={18} />
                    Download r2modman
                    <ExternalLink size={13} className="opacity-70" />
                  </a>
                </div>
                <p className="text-xs text-muted">
                  On that page: Windows → run <span className="text-ash">r2modman Setup ….exe</span> ·
                  Linux → the <span className="text-ash">.AppImage</span> · No Mac version — Mac
                  players see the notes further down. Then open r2modman once installed.
                </p>
                <p className="text-xs text-muted">
                  It sets up BepInEx (the mod loader) for you — you never touch that by hand.
                </p>
              </Step>

              <Step n={2} title="Point it at Valheim" icon={<Gamepad2 size={16} />}>
                <p>
                  In r2modman, choose <span className="text-ash">Valheim</span> from the game list,
                  then pick <span className="text-ash">Default</span> to create your profile.
                </p>
              </Step>

              <Step n={3} title={`Import the ${SERVER_NAME} modpack`} icon={<Download size={16} />}>
                {MODPACK_PROFILE_CODE ? (
                  <>
                    <p>
                      Choose{' '}
                      <span className="text-ash">Import / Update → Import code</span>, paste this
                      code, and click <span className="text-ash">Import</span>:
                    </p>
                    <div className="py-0.5">
                      <CopyChip value={MODPACK_PROFILE_CODE} />
                    </div>
                    <p>
                      That installs the whole pack at the exact right versions and pre-configures
                      everything. Nothing to edit — you&apos;re done here.
                    </p>
                  </>
                ) : (
                  <p>
                    In r2modman, search for and install each mod listed in{' '}
                    <Link href="/mods" className="text-gold-light hover:underline">
                      the mod list
                    </Link>
                    . The manager keeps the versions matched — a shared one-click code is coming
                    soon.
                  </p>
                )}
              </Step>

              <Step n={4} title="Launch the game modded" icon={<Play size={16} />}>
                <p>
                  Click <span className="text-ash">Start modded</span> in r2modman —{' '}
                  <strong className="text-ash-dim">not</strong> Steam&apos;s normal Play button. Let
                  Valheim load, then pick your character.
                </p>
              </Step>

              <Step n={5} title={`Join ${SERVER_NAME}`} icon={<LogIn size={16} />}>
                <p>
                  In game: <span className="text-ash">Join Game → Join by IP</span> (or find it in
                  the server browser) and enter the address:
                </p>
                <div className="py-0.5">
                  {SERVER_ADDRESS ? (
                    <CopyChip value={SERVER_ADDRESS} />
                  ) : (
                    <span className="text-ash">the address shared in Discord</span>
                  )}
                </div>
                <p>Enter the password:</p>
                <div className="py-0.5">
                  <CopyChip value={SERVER_PASSWORD} />
                </div>
                <p>…and welcome to {SERVER_NAME}. 🛡️</p>
              </Step>
            </ol>
          </CardBody>
        </Card>
      </section>

      {/* ══════════════ VISUAL BREAK ══════════════ */}
      <div className="flex items-center gap-4" aria-hidden="true">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-gold-dim/50" />
        <Anchor size={18} className="text-gold-dim" />
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-gold-dim/50" />
      </div>

      {/* ══════════════ PART TWO — NOW THAT YOU'RE ASHORE ══════════════ */}
      <section>
        <SectionTitle icon={<ScrollText size={20} />}>
          Once you&apos;re in, do these three things!
        </SectionTitle>

        <Card>
          <CardBody>
            <ol className="space-y-6">
              <Step n={1} title="Swear the Oath" icon={<ScrollText size={16} />}>
                <p>
                  Every age begins with a vow. In-game you must{' '}
                  <strong className="text-ash-dim">shout</strong> it — open chat, lead with{' '}
                  <span className="font-mono text-xs text-ash">/s</span>:
                </p>
                <div className="py-0.5">
                  <CopyChip value="/s /oath " label="/s /oath <your vow, one line>" />
                </div>
                <p>Or swear it in Discord instead:</p>
                <div className="py-0.5">
                  <CopyChip
                    value={`${bot} oath — `}
                    label={`${bot} oath — YourVikingName: your vow`}
                  />
                </div>
                <p className="text-xs text-muted">
                  Read the charter and see who&apos;s sworn on the{' '}
                  <Link href="/oath" className="text-gold-light hover:underline">
                    Oath page
                  </Link>
                  .
                </p>
              </Step>

              <Step n={2} title="Link your name to the saga" icon={<UserRound size={16} />}>
                <p>
                  Tell the bot which viking is you, so the photos you post and your stats gather on
                  your own saga page. In Discord:
                </p>
                <div className="py-0.5">
                  <CopyChip value={`${bot} I am `} label={`${bot} I am <YourCharacterName>`} />
                </div>
                <p className="text-xs text-muted">
                  Use your <span className="text-ash-dim">in-game name</span>, spelled exactly as it
                  appears — that&apos;s how the link lands on the right viking.
                </p>
              </Step>

              <Step n={3} title="Turn on your location" icon={<MapPin size={16} />}>
                <p>
                  Open the map (<span className="font-mono text-xs text-ash">M</span>) and enable{' '}
                  <span className="text-ash">Share position</span> (bottom-left) so the warband can
                  find you in the world.
                </p>
              </Step>
            </ol>
          </CardBody>
        </Card>

        {/* Mod updates */}
        <div className="mt-6">
          <Card>
            <CardBody className="flex items-start gap-3.5">
              <span className="mt-0.5 shrink-0 text-gold">
                <RefreshCcw size={18} />
              </span>
              <div className="text-sm leading-relaxed text-ash-dim">
                <p className="font-medium text-ash">Mod updates</p>
                <p className="mt-1">
                  Your pack is pinned to the exact versions the server runs, and r2modman never
                  updates it on its own — an &quot;update available&quot; badge is safe to ignore.
                  When the server updates, a new pack code lands in Discord: re-import it and
                  you&apos;re current. Updating a mod solo can lock you out until versions match
                  again.
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ══════════════ REFERENCE — platform notes, manual, troubleshooting ══════════════ */}
      <section>
        <SectionTitle icon={<Monitor size={18} />}>Notes for your platform</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-3">
          <Platform icon={<Monitor size={17} />} name="Windows" difficulty="Easiest" tone="online">
            <p>
              The smooth path. Install r2modman&apos;s Windows app, pick Valheim, import the code,
              Start modded.
            </p>
            <p className="text-xs text-muted">
              If Windows SmartScreen warns on the installer, choose <em>More info → Run anyway</em>.
            </p>
          </Platform>

          <Platform
            icon={<Terminal size={17} />}
            name="Linux / Steam Deck"
            difficulty="Doable"
            tone="gold"
          >
            <p>
              Valheim runs natively. Use the r2modman AppImage, then in Steam set the game&apos;s
              launch options so the loader hooks in:
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
              <strong className="text-ash-dim">Valheim has no native Mac version</strong>, so
              there&apos;s an extra hop. Run the Windows build through{' '}
              <Ext href="https://www.codeweavers.com/crossover">CrossOver</Ext> or{' '}
              <Ext href="https://getwhisky.app/">Whisky</Ext>, then install r2modman inside that
              environment.
            </p>
            <p className="text-xs text-muted">
              Cloud streaming (GeForce NOW) <em>can&apos;t</em> run mods. On Apple Silicon the easiest
              answer is often borrowing a Windows/Linux PC — ask in Discord and we&apos;ll help.
            </p>
          </Platform>
        </div>
      </section>


      {/* Troubleshooting */}
      <section>
        <SectionTitle icon={<Wrench size={18} />}>When something won&apos;t cooperate</SectionTitle>
        <Card>
          <CardBody>
            <Trouble symptom="“Incompatible version” or the join is refused">
              Your mods don&apos;t match the server. Re-import the modpack code (step 3) so every
              version lines up, and make sure nobody added an extra mod. This is by far the most
              common issue.
            </Trouble>
            <Trouble symptom="Game launches but no mods are loaded">
              You started vanilla. Always launch with <span className="text-ash">Start modded</span>{' '}
              from r2modman. On Linux/Proton, double-check the{' '}
              <span className="font-mono text-xs">WINEDLLOVERRIDES</span> launch option is set.
            </Trouble>
            <Trouble symptom="My oath or pin didn't show up">
              Both must be <span className="text-ash">shouted</span> — lead with{' '}
              <span className="font-mono text-xs">/s</span> (e.g.{' '}
              <span className="font-mono text-xs">/s /oath …</span>). A normal chat line gets
              swallowed. Or use the Discord form instead.
            </Trouble>
            <Trouble symptom="My weapon stats show fights that weren't mine">
              Starting a brand-new character on the server can make your weapon breakdown
              (Favored Weapon, Hardest Hit) inherit combat from a character you played before — a
              quirk of the stats mod. If you ever want to roll a fresh viking mid-campaign, ask in
              Discord first and an admin will clear one file for you before you log in. It takes a
              second, and your kills, deaths, and builds are never touched.
            </Trouble>
            <Trouble symptom="It won't run on my Mac">
              There&apos;s no native Mac client — you need CrossOver or Whisky (see the Mac card
              above), or a Windows/Linux machine. Ask in Discord and we&apos;ll walk you through it.
            </Trouble>
            <Trouble symptom="“Failed to connect” / can't reach the server">
              The server may be mid-restart (it cycles every few hours) — wait a minute and retry.
              Otherwise double-check the address and that you&apos;ve got the current password.
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
