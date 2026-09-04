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
import { LaunchNotice } from '@/components/LaunchNotice';
import {
  SERVER_NAME,
  SERVER_ADDRESS,
  SERVER_PASSWORD,
  DISCORD_URL,
  DISCORD_BOT_HANDLE,
  MODPACK_PROFILE_CODE,
  MODPACK_VERSION_LABEL,
} from '@/config/server';

export const metadata: Metadata = {
  title: 'Get Started',
  description: `New to ${SERVER_NAME}? Log on and install the mods in five steps, then the rituals that put you on the map.`,
};

// Direct installer links so nobody has to navigate a GitHub releases page.
// Bump R2MODMAN_VERSION when a new release lands (r2modman self-updates after
// the first install, so a slightly stale pin here is harmless).
const R2MODMAN_VERSION = '3.2.19';
const R2MODMAN_WINDOWS_URL = `https://github.com/ebkr/r2modmanPlus/releases/download/v${R2MODMAN_VERSION}/r2modman-Setup-${R2MODMAN_VERSION}.exe`;
const R2MODMAN_LINUX_URL = `https://github.com/ebkr/r2modmanPlus/releases/download/v${R2MODMAN_VERSION}/r2modman-${R2MODMAN_VERSION}.AppImage`;
const R2MODMAN_ALL_URL = 'https://github.com/ebkr/r2modmanPlus/releases/latest';

// Macheim — the macOS-native Valheim mod manager. r2modman has no Mac build, and
// on Apple Silicon Macheim runs the game under Rosetta so the x64 mod loader can
// hook in. Direct .dmg so Mac players skip the GitHub releases page.
// ⚠️ When bumping: the asset FILENAME version trails the release TAG (a Tauri
// build quirk — tag v1.0.1 ships Macheim_1.0.0_aarch64.dmg), so copy the exact
// asset URL off the release rather than templating it from the tag.
const MACHEIM_APPLE_SILICON_URL =
  'https://github.com/lofcgi/macheim/releases/download/v1.0.1/Macheim_1.0.0_aarch64.dmg';
const MACHEIM_ALL_URL = 'https://github.com/lofcgi/macheim/releases/latest';

// The pack's seven .cfg files, zipped, for the Mac path: Macheim cannot read an
// r2modman profile code, so a hand install gets none of the pack's settings.
// Re-cut this zip out of the pack export whenever the pack code is re-minted.
const CONFIG_BUNDLE_URL = '/downloads/eilif-configs-pack-v11.zip';

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

/**
 * The modpack code with its version label. The label is the whole point: a bare
 * UUID tells a returning player nothing about whether they are current.
 */
function PackCode() {
  if (!MODPACK_PROFILE_CODE) {
    return <span className="text-ash">shared in Discord</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 align-middle">
      <CopyChip value={MODPACK_PROFILE_CODE} />
      <span className="text-xs text-muted">{MODPACK_VERSION_LABEL}</span>
    </span>
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
      {/* Only rendered when config/server.ts LAUNCH_NOTICE is set. */}
      <LaunchNotice />

      <PageHeader slot="get-started">
        <SectionHeader
          title="Get Started"
          subtitle={`New to ${SERVER_NAME}? Log on and install the mods in five steps. About 15 minutes, no experience needed. Then the three things to do once you're in.`}
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
                Steam only (Windows, Mac, Linux).{' '}
                <span className="text-ash-dim">
                  Xbox, PlayStation, Switch and Game Pass can&apos;t join: the mods need Steam and
                  crossplay is off.
                </span>
              </p>
            </div>
          </CardBody>
        </Card>
      </section>

      {/* ══════════════ SECTION B — QUICK START ══════════════ */}
      <section>
        <SectionTitle icon={<Compass size={20} />}>
          Quick start: install the mods &amp; log on{' '}
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
                  r2modman is the free app that installs and manages all the mods for you, on
                  Windows and Linux. There&apos;s no Mac version.
                </p>
                <div className="flex flex-wrap items-center gap-3 py-1.5">
                  <a
                    href={R2MODMAN_WINDOWS_URL}
                    className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
                  >
                    <Download size={18} />
                    Download for Windows
                  </a>
                  <a
                    href={R2MODMAN_LINUX_URL}
                    className="gold-ring inline-flex items-center gap-1.5 rounded-md border border-gold-dim/60 bg-gold/10 px-3.5 py-2 text-sm font-medium text-gold-light transition-colors hover:bg-gold/20"
                  >
                    <Download size={14} />
                    Linux (.AppImage)
                  </a>
                </div>
                <p className="text-xs text-muted">
                  The download starts right away. Run the installer, click through it, and open
                  r2modman. It keeps itself updated from then on. No Mac version — on a Mac, use
                  the Apple Silicon setup below instead.{' '}
                  <Ext href={R2MODMAN_ALL_URL}>All downloads</Ext>
                </p>
                <p className="text-xs text-muted">
                  It sets up BepInEx (the mod loader) for you, so you never touch that by hand.
                </p>
              </Step>

              <Step n={2} title="Point it at Valheim" icon={<Gamepad2 size={16} />}>
                <p>
                  In r2modman, choose <span className="text-ash">Valheim</span> from the game list
                  and click <span className="text-ash">Select game</span>. If it asks which store,
                  pick <span className="text-ash">Steam</span>. That lands you on the profile
                  screen. Stay there, the next step happens on it.
                </p>
              </Step>

              <Step n={3} title={`Import the ${SERVER_NAME} modpack`} icon={<Download size={16} />}>
                {MODPACK_PROFILE_CODE ? (
                  <>
                    <p>
                      On the profile screen choose <span className="text-ash">Import / Update</span>,
                      pick <span className="text-ash">Import new profile</span>, then{' '}
                      <span className="text-ash">From code</span>. Paste this code and click{' '}
                      <span className="text-ash">Continue</span>:
                    </p>
                    <div className="py-0.5">
                      <PackCode />
                    </div>
                    <p>
                      It lists the mods it is about to install. Click{' '}
                      <span className="text-ash">Import</span>. When it asks for a profile name,
                      type <span className="text-ash">Eilif</span> and click{' '}
                      <span className="text-ash">Create</span>. That installs the whole pack at the
                      exact right versions and pre-configures everything. Nothing to edit, and
                      you&apos;re done here.
                    </p>
                    <p className="text-xs text-muted">
                      Updating to a newer pack code later? Use{' '}
                      <span className="text-ash">How to update your mods</span> further down this
                      page. It is a different button, and it keeps you on one profile.
                    </p>
                  </>
                ) : (
                  <p>
                    In r2modman, search for and install each mod listed in{' '}
                    <Link href="/mods" className="text-gold-light hover:underline">
                      the mod list
                    </Link>
                    . The manager keeps the versions matched. A shared one-click code is coming
                    soon.
                  </p>
                )}
              </Step>

              <Step n={4} title="Launch the game modded" icon={<Play size={16} />}>
                <p>
                  Click <span className="text-ash">Start modded</span> in r2modman,{' '}
                  <strong className="text-ash-dim">not</strong>
                  {' '}Steam&apos;s normal Play button. Let Valheim load, then pick your character.
                </p>
              </Step>

              <Step n={5} title={`Join ${SERVER_NAME}`} icon={<LogIn size={16} />}>
                <p>
                  In game, pick your character, then{' '}
                  <span className="text-ash">Join Game → Add server</span> and enter this address:
                </p>
                <div className="py-0.5">
                  {SERVER_ADDRESS ? (
                    <CopyChip value={SERVER_ADDRESS} />
                  ) : (
                    <span className="text-ash">the address shared in Discord</span>
                  )}
                </div>
                <p>
                  {SERVER_NAME} appears in your server list. Select it, click{' '}
                  <span className="text-ash">Connect</span>, and enter the password:
                </p>
                <div className="py-0.5">
                  <CopyChip value={SERVER_PASSWORD} />
                </div>
                <p>Welcome to {SERVER_NAME}. 🛡️</p>
              </Step>
            </ol>
          </CardBody>
        </Card>
      </section>

      {/* ══════════════ SECTION B2 — MAC (APPLE SILICON) ══════════════ */}
      <section>
        <SectionTitle icon={<Laptop size={20} />}>On a Mac? Apple Silicon setup</SectionTitle>

        <Card className="border-l-2 border-l-gold-dim">
          <CardBody>
            <p className="text-sm leading-relaxed text-ash-dim">
              Valheim runs on Mac, but r2modman doesn&apos;t. On Apple Silicon (M1 and later) you
              use <Ext href={MACHEIM_ALL_URL}>Macheim</Ext> instead — a Mac-native mod manager that
              sets up the mod loader and runs the game under Rosetta for you. About 15 minutes.
            </p>

            <div className="flex flex-wrap items-center gap-3 py-3">
              <a
                href={MACHEIM_APPLE_SILICON_URL}
                className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
              >
                <Download size={18} />
                Download Macheim (Apple Silicon)
              </a>
              <Ext href={MACHEIM_ALL_URL}>All downloads (incl. Intel Mac)</Ext>
            </div>

            <ol className="mt-1 space-y-2.5 text-sm leading-relaxed text-ash-dim">
              <li>
                <span className="font-mono text-xs text-gold-light">1.</span> Open the downloaded{' '}
                <span className="text-ash">.dmg</span> and drag{' '}
                <span className="text-ash">Macheim</span> into Applications.
              </li>
              <li>
                <span className="font-mono text-xs text-gold-light">2.</span> The first launch is
                blocked because Macheim isn&apos;t signed. Open{' '}
                <span className="text-ash">Terminal</span>, run this, then open Macheim:
                <span className="mt-1.5 block">
                  <CopyChip value="xattr -cr /Applications/Macheim.app" />
                </span>
                <span className="mt-1 block text-xs text-muted">
                  Still blocked? System Settings → Privacy &amp; Security → Open Anyway.
                </span>
              </li>
              <li>
                <span className="font-mono text-xs text-gold-light">3.</span> Macheim finds your
                Valheim install. Click <span className="text-ash">Install BepInEx</span> — it sets
                up the mod loader and installs Rosetta automatically (on Apple Silicon the mods run
                under Rosetta).
              </li>
              <li>
                <span className="font-mono text-xs text-gold-light">4.</span> Add the mods.
                Macheim can&apos;t read r2modman codes. Open the{' '}
                <span className="text-ash">Mods</span> tab and install these seven, latest version:
                <span className="mt-1 block text-ash">
                  BepInExPack Valheim, ValheimPlus (Grantapher), PlantEverything, AzuCraftyBoxes,
                  GsValheimStatsClient, Eilif Paths, Eilif Companion Client
                </span>
                <span className="mt-2 block">
                  Then download the{' '}
                  <a
                    href={CONFIG_BUNDLE_URL}
                    download
                    className="gold-ring rounded font-medium text-gold-light hover:underline"
                  >
                    {SERVER_NAME} config bundle
                  </a>{' '}
                  and drop its files into <span className="text-ash">Macheim → Config</span>{' '}
                  (BepInEx/config). Without them you can play but your stats won&apos;t reach the
                  site.
                </span>
                <span className="mt-1 block text-xs text-muted">
                  The bundle matches {MODPACK_VERSION_LABEL}. When a new pack code is announced in
                  Discord, come back and download it again.
                </span>
              </li>
              <li>
                <span className="font-mono text-xs text-gold-light">5.</span> Launch from{' '}
                <span className="text-ash">Macheim</span> (not Steam&apos;s Play button), pick your
                character, then <span className="text-ash">Join Game → Add server</span> with the
                address and password from the top of this page.
              </li>
            </ol>

            <div className="mt-4 space-y-1.5">
              <p className="text-xs text-muted">
                Some modded objects may look bright pink — a harmless Mac shader quirk, not a
                broken install.
              </p>
              <p className="text-xs text-muted">
                A 2020 MacBook Air is the lightest Apple Silicon chip: keep the graphics low and
                expect it to strain on raids and big bases.
              </p>
            </div>
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
          Once you&apos;re in, do these two things!
        </SectionTitle>

        <Card>
          <CardBody>
            <ol className="space-y-6">
              <Step
                n={1}
                title="Swear your oath and bind your viking"
                icon={<ScrollText size={16} />}
              >
                <p>
                  One rite, three moves. It puts your vow on the wall and ties your Discord to your
                  viking, so your deeds, photos and title all gather under one name.
                </p>
                <ol className="space-y-3">
                  <li>
                    <span className="font-mono text-xs text-gold-light">1.</span> In Discord, type{' '}
                    <span className="font-mono text-xs text-ash">@</span> and pick{' '}
                    <span className="text-ash">{SERVER_NAME}</span> from the popup that appears,
                    then finish the line:
                    <span className="mt-1.5 block">
                      <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
                        I am YourVikingName
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      Picking {SERVER_NAME} from the popup is what makes it a real mention. Typing
                      the letters {bot} by hand looks the same but does nothing. Use your in-game
                      name, spelled exactly as it appears.
                    </span>
                  </li>
                  <li>
                    <span className="font-mono text-xs text-gold-light">2.</span> {SERVER_NAME}{' '}
                    sends you a private message with a 6-letter rune. Keep it to yourself.
                    <span className="mt-1 block text-xs text-muted">
                      The sender shows as <span className="text-ash-dim">Valheim Server Bot</span>.
                      That is {SERVER_NAME}. No message? Allow direct messages for this server and
                      ask again.
                    </span>
                  </li>
                  <li>
                    <span className="font-mono text-xs text-gold-light">3.</span> In game, open chat
                    and <strong className="text-ash-dim">shout</strong> it, rune first:
                    <span className="mt-1.5 block">
                      <CopyChip value="/s /oath " label="/s /oath RUNE your vow, one line" />
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      It must be a shout, so lead with{' '}
                      <span className="font-mono text-xs">/s</span>. Plain chat never leaves the
                      campfire.
                    </span>
                  </li>
                </ol>
                <p className="text-xs text-muted">
                  Re-swear anytime with{' '}
                  <span className="font-mono text-xs text-ash-dim">/s /oath your new vow</span> in
                  game. Your latest oath replaces the last. Read the charter and see who&apos;s
                  sworn on the{' '}
                  <Link href="/oath" className="text-gold-light hover:underline">
                    Oath page
                  </Link>
                  .
                </p>
              </Step>

              <Step n={2} title="Turn on your location" icon={<MapPin size={16} />}>
                <p>
                  Open the map (<span className="font-mono text-xs text-ash">M</span>) and enable{' '}
                  <span className="text-ash">Share position</span> (bottom-left) so the warband can
                  find you in the world.
                </p>
              </Step>
            </ol>
          </CardBody>
        </Card>

        {/* Updating the pack */}
        <div className="mt-6">
          <Card className="border-l-2 border-l-gold">
            <CardBody>
              <div className="mb-3 flex items-center gap-2">
                <RefreshCcw size={18} className="text-gold" />
                <h2 className="font-display text-base tracking-wide text-ash">
                  How to update your mods
                </h2>
              </div>
              <p className="text-sm leading-relaxed text-ash-dim">
                Every so often we announce a mod update in Discord. A new code is posted on launch
                day because the world changes.{' '}
                <span className="font-semibold text-ash">To update your mods and modpack, do
                this</span> (takes about a minute):
              </p>
              <ol className="mt-3 space-y-1.5 text-sm leading-relaxed text-ash-dim">
                <li>
                  <span className="font-mono text-xs text-gold-light">1.</span> Open r2modman. If
                  you land inside a profile, go back to the profile list.
                </li>
                <li>
                  <span className="font-mono text-xs text-gold-light">2.</span> Choose{' '}
                  <span className="text-ash">Import / Update → Update existing profile → From code</span>.
                </li>
                <li>
                  <span className="font-mono text-xs text-gold-light">3.</span> Paste the current
                  code, click <span className="text-ash">Continue</span>, then{' '}
                  <span className="text-ash">Import</span>: <PackCode />
                </li>
                <li>
                  <span className="font-mono text-xs text-gold-light">4.</span> Pick{' '}
                  <span className="text-ash">Eilif</span> in the dropdown and click{' '}
                  <span className="text-ash">Update profile: Eilif</span>. Wait for it to finish,
                  then <span className="text-ash">Start modded</span> as usual.
                </li>
              </ol>
              <p className="mt-3 text-xs text-muted">
                Not sure whether you are current? In r2modman open your{' '}
                <span className="text-ash-dim">Eilif</span> profile and look at{' '}
                <span className="text-ash-dim">Installed</span>: Eilif Paths 1.4.0 and
                GsValheimStatsClient 0.2.12 means you are on {MODPACK_VERSION_LABEL}.
              </p>
              <p className="mt-3 text-xs text-muted">
                Never update mods one by one from r2modman&apos;s own &quot;update available&quot;
                badges. The pack pins the exact versions the server runs, and a solo update can
                lock you out until versions match again.
              </p>
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
              Valheim runs natively. Download the r2modman AppImage and make it executable
              (right-click → Properties → Permissions → Allow executing, or{' '}
              <span className="font-mono text-[11px]">chmod +x</span>), then run it and import the
              code exactly as above.
            </p>
            <p>
              The first time you click <span className="text-ash">Start modded</span>, r2modman
              shows a launch-options line with a copy button. Paste that into Steam → Library →
              Valheim → Properties → Launch Options. Copy it from r2modman, not from here: it
              contains a folder path that is specific to your machine.
            </p>
            <p className="text-xs text-muted">
              Playing through Proton instead of the native build? Nothing extra to set, r2modman
              handles it. On Steam Deck, do all of this in Desktop Mode.
            </p>
          </Platform>

          <Platform icon={<Laptop size={17} />} name="Mac" difficulty="Tricky" tone="raid">
            <p>
              Valheim runs on Mac, but r2modman doesn&apos;t. On Apple Silicon (M1 and later), use{' '}
              <Ext href={MACHEIM_ALL_URL}>Macheim</Ext> — the one-click download and full
              walkthrough are in the <span className="text-ash">Apple Silicon setup</span> section
              above.
            </p>
            <p className="text-xs text-muted">
              Cloud streaming (GeForce NOW) <em>can&apos;t</em> run mods. A 2020 MacBook Air will
              run it but strain on raids, so keep the graphics low.
            </p>
          </Platform>
        </div>
      </section>


      {/* Troubleshooting */}
      <section>
        <SectionTitle icon={<Wrench size={18} />}>When something won&apos;t cooperate</SectionTitle>
        <Card>
          <CardBody>
            <Trouble symptom="“Incompatible version” during launch week (Sept 9 to 12)">
              That almost always means the game version, not the mods. Check the notice at the top
              of this page before re-installing anything.
            </Trouble>
            <Trouble symptom="“Incompatible version” or the join is refused">
              Your mods don&apos;t match the server. Re-import the modpack code (step 3) so every
              version lines up, and make sure nobody added an extra mod. This is by far the most
              common issue.
            </Trouble>
            <Trouble symptom="Game launches but no mods are loaded">
              You started vanilla. Always launch with <span className="text-ash">Start modded</span>{' '}
              from r2modman. On the native Linux build, also check that the launch-options line
              r2modman gave you is pasted into Steam → Library → Valheim → Properties → Launch
              Options.
            </Trouble>
            <Trouble symptom="My oath or pin didn't show up">
              Both must be <span className="text-ash">shouted</span>, so lead with{' '}
              <span className="font-mono text-xs">/s</span> (e.g.{' '}
              <span className="font-mono text-xs">/s /oath …</span>). A normal chat line gets
              swallowed. A first oath also needs the rune {SERVER_NAME} sent you, right after{' '}
              <span className="font-mono text-xs">/oath</span>.
            </Trouble>
            <Trouble symptom="My weapon stats show fights that weren't mine">
              Starting a brand-new character on the server can make your weapon breakdown
              (Favored Weapon, Hardest Hit) inherit combat from a character you played before. That
              is a quirk of the stats mod. If you ever want to roll a fresh viking mid-campaign, ask in
              Discord first and an admin will clear one file for you before you log in. It takes a
              second, and your kills, deaths, and builds are never touched.
            </Trouble>
            <Trouble symptom="It won't run on my Mac">
              On Apple Silicon, use <span className="text-ash">Macheim</span> (see the Apple Silicon
              setup section) — it runs the mods under Rosetta for you. If Macheim itself won&apos;t
              open, it needs the Gatekeeper step: Terminal{' '}
              <span className="font-mono text-xs">xattr -cr /Applications/Macheim.app</span>, or
              System Settings → Privacy &amp; Security → Open Anyway. Still stuck? Ask in Discord.
            </Trouble>
            <Trouble symptom="“Failed to connect” / can't reach the server">
              An admin may be restarting it (check{' '}
              <span className="font-mono text-xs">#server</span> in Discord), or your game version
              does not match the server (see the notice at the top of this page). Double-check the
              address and that the password is exactly{' '}
              <span className="text-ash">{SERVER_PASSWORD}</span> (capital L).
            </Trouble>
          </CardBody>
        </Card>
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <MessageCircle size={15} className="text-gold-light" />
          Still stuck?{' '}
          {discord ? (
            <Ext href={discord}>Ask in Discord</Ext>
          ) : (
            <span>Ask in Discord. Someone will get you sailing.</span>
          )}
        </p>
      </section>
    </div>
  );
}
