import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Compass,
  Package,
  Gamepad2,
  Download,
  Play,
  LogIn,
  MapPin,
  RefreshCcw,
  ChevronDown,
  Wrench,
  MessageCircle,
  ExternalLink,
  Ship,
  ShieldCheck,
  TriangleAlert,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import { Card, CardBody, SectionHeader } from '@/components/ui';
import { PageHeader } from '@/components/art/PageHeader';
import { CopyChip } from '@/components/get-started/CopyChip';
import { PlatformSwitch } from '@/components/get-started/PlatformSwitch';
import { ModChecklist } from '@/components/get-started/ModChecklist';
import { LaunchNotice } from '@/components/LaunchNotice';
import { checklistFrom, stepLabel, SERVER_INFO_TITLE, TOTAL_STEPS } from '@/lib/get-started';
import { CLIENT_MODS } from '@/config/mods';
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
  description: `New to ${SERVER_NAME}? Install the mods, then join. About 15 minutes, no experience needed. Then two things to do once you are in.`,
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
// ⚠️ When bumping: NEVER template this from the tag. Read the exact asset name
// off the release and curl it before shipping. The old pin here
// (Macheim_1.0.0_aarch64.dmg under tag v1.0.1) 404'd from the live page; the
// v1.0.1 release actually ships Macheim_1.0.1_aarch64.dmg. Verified 200 with
// `curl -sIL <url>` on 2026-09-05 (6,024,201 bytes, matches the GitHub API).
const MACHEIM_APPLE_SILICON_URL =
  'https://github.com/lofcgi/macheim/releases/download/v1.0.1/Macheim_1.0.1_aarch64.dmg';
const MACHEIM_ALL_URL = 'https://github.com/lofcgi/macheim/releases/latest';

// The pack's .cfg files, zipped, for the Mac path: Macheim cannot read an
// r2modman profile code, so a hand install gets none of the pack's settings.
// Re-cut this zip out of the pack export whenever the pack code is re-minted, and
// point this constant at the new file. The v14 zip stays on disk so no link 404s
// while the v15 build is going out.
const CONFIG_BUNDLE_URL = '/downloads/eilif-configs-pack-v16.zip';

// The mods a Mac player installs one at a time, read out of config/mods.ts
// so the page cannot fall behind the pack. See the CUTOVER ANCHOR note below.
const MAC_MODS = checklistFrom(CLIENT_MODS);

/* ── small presentational helpers ─────────────────────────────────────────── */

/**
 * One numbered step of the single spine.
 *
 * The eyebrow is the point: there is exactly one numbered sequence on this page
 * now, and every step says how far along it you are. `stepLabel` owns the
 * total, so the count cannot drift from the steps that exist.
 */
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
    <div className="flex gap-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold-dim/60 bg-gold/10 font-display text-lg text-gold-light tabular-nums">
        {n}
      </span>
      <div className="flex-1 space-y-2 pb-2 pt-0.5">
        <p className="text-xs uppercase tracking-wider text-muted">{stepLabel(n)}</p>
        <h3 className="flex items-center gap-2 font-display text-base tracking-wide text-ash">
          <span className="text-gold">{icon}</span>
          {title}
        </h3>
        <div className="space-y-2 text-sm leading-relaxed text-ash-dim">{children}</div>
      </div>
    </div>
  );
}

/**
 * The one thing on the spine that is not a step: work that runs *during* the
 * install rather than after it. It carries no number on purpose. A number would
 * promise "finish this before the next one", and the whole point of moving the
 * rune fetch here is that it happens while the mod manager is busy.
 */
function Meanwhile({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-gold-dim/60 bg-surface-raised/60 text-gold">
        <Sparkles size={17} />
      </span>
      <div className="flex-1 space-y-2 pb-2 pt-0.5">
        <p className="text-xs uppercase tracking-wider text-muted">{eyebrow}</p>
        <h3 className="flex items-center gap-2 font-display text-base tracking-wide text-ash">
          <span className="text-gold">
            <ScrollText size={16} />
          </span>
          {title}
        </h3>
        <div className="space-y-2 text-sm leading-relaxed text-ash-dim">{children}</div>
      </div>
    </div>
  );
}

/** The success condition for a step. Every step on the spine has one. */
function DoneWhen({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">You are done when {children}</p>;
}

function Trouble({ symptom, children }: { symptom: string; children: ReactNode }) {
  return (
    <div className="break-inside-avoid rounded-md border border-rune bg-surface-raised/30 p-4">
      <p className="flex items-start gap-2 font-medium text-ash">
        <TriangleAlert size={15} className="mt-0.5 shrink-0 text-gold" />
        {symptom}
      </p>
      <p className="mt-1.5 pl-[23px] text-sm leading-relaxed text-ash-dim">{children}</p>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="prose-link gold-ring inline-flex items-center gap-1 rounded font-medium text-gold-light"
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
      <CopyChip value={MODPACK_PROFILE_CODE} describe="the modpack code" />
      <span className="text-xs text-muted">{MODPACK_VERSION_LABEL}</span>
    </span>
  );
}

/**
 * One line of the update run.
 *
 * The number comes from the ordered list itself, never from a typed "1.", and
 * every line is ONE click. The old four-line version bundled three r2modman
 * buttons into a single line, which is where the duplicate profiles came from:
 * a reader skimming "Import / Update, Update existing profile, From code"
 * clicks the first thing that looks close enough and lands on Import new
 * profile.
 *
 * `note` is the grey half-line under a step: what the screen looks like at that
 * moment, or the mistake people make there. It is never a second instruction.
 */
function UpdateStep({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <li className="pl-1">
      <span>{children}</span>
      {note ? <span className="mt-1 block text-xs text-muted">{note}</span> : null}
    </li>
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

/* ── the shared middle of the spine ───────────────────────────────────────── */

/**
 * Steps 2 and 3 on the r2modman path, and the rune interlude, are word for word
 * the same on Windows and on Linux. Written once, rendered into both lists.
 */
function StepPointAtValheim() {
  return (
    <Step n={2} title="Point it at Valheim" icon={<Gamepad2 size={16} />}>
      <p>
        In r2modman, choose <span className="text-ash">Valheim</span> from the game list and click{' '}
        <span className="text-ash">Select game</span>. If it asks which store, pick{' '}
        <span className="text-ash">Steam</span>. That lands you on the profile screen. Stay there,
        the next step happens on it.
      </p>
      {/* The plan's wording was "the Eilif profile list"; the profile named
          Eilif does not exist until step 3, so this names what is actually on
          screen at the end of step 2. */}
      <DoneWhen>r2modman shows the Valheim profile list.</DoneWhen>
    </Step>
  );
}

function StepImportPack() {
  return (
    <Step n={3} title={`Import the ${SERVER_NAME} modpack`} icon={<Download size={16} />}>
      {MODPACK_PROFILE_CODE ? (
        <>
          <p>
            On the profile screen choose <span className="text-ash">Import / Update</span>, pick{' '}
            <span className="text-ash">Import new profile</span>, then{' '}
            <span className="text-ash">From code</span>. Paste this code and click{' '}
            <span className="text-ash">Continue</span>:
          </p>
          <div className="py-0.5">
            <PackCode />
          </div>
          <p className="text-xs text-muted">
            This is the current code. Use it now. When the pack changes, this code changes here too
            and we announce it in Discord.
          </p>
          <p>
            It lists the mods it is about to install. Click <span className="text-ash">Import</span>
            . When it asks for a profile name, type <span className="text-ash">{SERVER_NAME}</span>{' '}
            and click <span className="text-ash">Create</span>. That installs the whole pack at the
            exact right versions and pre-configures everything. Nothing to edit, and you are done
            here.
          </p>
          {/* The escape hatch that used to live inside the section heading,
              where it competed with the heading itself. */}
          <p className="text-xs text-muted">
            Prefer to install mods by hand? The{' '}
            <Link href="/resources#mods" className="prose-link text-gold-light">
              Resources page
            </Link>{' '}
            lists every one at the version the server runs.
          </p>
          {/* The only pointer on the page to the update run, which is folded
              away below the finish line. A returning player on a new pack code
              lands here, on step 3, and the button they need is the other one:
              Import new profile makes a second profile, Update existing keeps
              the one they have. Deleting this line stranded them. */}
          <p className="text-xs text-muted">
            Coming back to a newer pack code? Do not import it here. Use{' '}
            <a href="#update" className="prose-link gold-ring rounded text-gold-light">
              How to update your mods
            </a>{' '}
            below. It is a different button and it keeps you on one profile.
          </p>
        </>
      ) : (
        <p>
          In r2modman, search for and install each mod listed in{' '}
          <Link href="/resources#mods" className="prose-link text-gold-light">
            the mod list
          </Link>
          . The manager keeps the versions matched. A shared one-click code is coming soon.
        </p>
      )}
      {/* Outside the branch on purpose: both paths through this step end in the
          same place, and a success condition that only one of them states is a
          checkpoint the page does not really have. */}
      <DoneWhen>
        the profile {SERVER_NAME} shows <span className="text-ash-dim">Installed</span> with the mod
        list.
      </DoneWhen>
    </Step>
  );
}

/**
 * The rune fetch. It used to be the last thing on the page, after the join,
 * which asked a player to alt-tab out of a freshly loaded Valheim, mention a
 * bot, wait for a private message, and alt-tab back. It now runs in the dead
 * time while the mod manager downloads, so the two alt-tabs are zero.
 */
function RuneMeanwhile({ bot, during }: { bot: string; during: string }) {
  return (
    <Meanwhile eyebrow={`While ${during}`} title="Get your rune from Eilif">
      <p>
        While {during}, open Discord, type <span className="font-mono text-xs text-ash">@</span> and
        pick <span className="text-ash">{SERVER_NAME}</span>, then finish the line:
      </p>
      <p className="py-0.5">
        <span className="rounded bg-gold/15 px-2 py-1 font-mono text-xs font-semibold text-gold-light">
          I am YourVikingName
        </span>
      </p>
      <p>
        {SERVER_NAME} sends you a private message with a six-letter rune. Keep it open, you will
        shout it in a minute.
      </p>
      <p className="text-xs text-muted">
        Picking {SERVER_NAME} from the popup is what makes it a real mention. Typing the letters{' '}
        {bot} by hand looks the same but does nothing. Use your in-game name, spelled exactly as it
        appears.
      </p>
      <p className="text-xs text-muted">
        The sender shows as <span className="text-ash-dim">Valheim Server Bot</span>. That is{' '}
        {SERVER_NAME}. No message? Allow direct messages for this server and ask again.
      </p>
      <p className="text-xs text-muted">
        The rune is what ties your Discord to your viking, so your deeds, photos and title all
        gather under one name. Keep it to yourself.
      </p>
      <DoneWhen>the private message from {SERVER_NAME} with your six-letter rune is open.</DoneWhen>
    </Meanwhile>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

export default function GetStartedPage() {
  const discord = DISCORD_URL || null;
  const bot = DISCORD_BOT_HANDLE; // e.g. "@Eilif"

  /* Steps 1 to 4, three times. Everything from step 5 on is shared and lives
     in the children of <PlatformSwitch> below. */

  const windowsSteps = (
    <div className="space-y-6">
      <Step n={1} title="Install the mod manager" icon={<Package size={16} />}>
        <p>
          r2modman is the free app that installs and manages all the mods for you. It sets up
          BepInEx (the mod loader) too, so you never touch that by hand.
        </p>
        <div className="flex flex-wrap items-center gap-3 py-1.5">
          <a
            href={R2MODMAN_WINDOWS_URL}
            className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
          >
            <Download size={18} />
            Download for Windows
          </a>
          <Ext href={R2MODMAN_ALL_URL}>All downloads</Ext>
        </div>
        <p className="text-xs text-muted">
          The download starts right away. Run the installer, click through it, and open r2modman. It
          keeps itself updated from then on.
        </p>
        <p className="text-xs text-muted">
          If Windows SmartScreen warns on the installer, choose <em>More info, then Run anyway</em>.
        </p>
        {/* The fork, named on the default path. The chooser is the real control,
            but the default is a guess: a Mac reader who does not notice a rail
            of three buttons is otherwise handed a Windows .exe with nothing on
            screen telling them it is the wrong one. */}
        <p className="text-xs text-muted">
          There is no Mac version of r2modman. On a Mac, pick{' '}
          <span className="text-ash-dim">Mac</span> in the chooser and you get the Macheim path
          instead.
        </p>
        <DoneWhen>r2modman opens and shows its list of games.</DoneWhen>
      </Step>

      <StepPointAtValheim />
      <StepImportPack />
      <RuneMeanwhile bot={bot} during="the pack installs" />

      <Step n={4} title="Launch the game modded" icon={<Play size={16} />}>
        <p>
          Click <span className="text-ash">Start modded</span> in r2modman,{' '}
          <strong className="text-ash-dim">not</strong>{' '}Steam&apos;s normal Play button. Let
          Valheim load, then pick your character.
        </p>
        <DoneWhen>
          the Valheim main menu shows the BepInEx console text in the corner. If the menu looks
          completely normal, you launched vanilla.
        </DoneWhen>
      </Step>
    </div>
  );

  const linuxSteps = (
    <div className="space-y-6">
      <Step n={1} title="Install the mod manager" icon={<Package size={16} />}>
        <p>
          Valheim runs natively on Linux and on the Steam Deck. r2modman is the free app that
          installs and manages all the mods for you, and it sets up BepInEx (the mod loader) too.
        </p>
        <div className="flex flex-wrap items-center gap-3 py-1.5">
          <a
            href={R2MODMAN_LINUX_URL}
            className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
          >
            <Download size={18} />
            Download the AppImage
          </a>
          <Ext href={R2MODMAN_ALL_URL}>All downloads</Ext>
        </div>
        <p className="text-xs text-muted">
          Make it executable (right-click, Properties, Permissions, Allow executing, or{' '}
          <span className="font-mono text-xs">chmod +x</span>), then run it. On a Steam Deck, do all
          of this in Desktop Mode.
        </p>
        <DoneWhen>r2modman opens and shows its list of games.</DoneWhen>
      </Step>

      <StepPointAtValheim />
      <StepImportPack />
      <RuneMeanwhile bot={bot} during="the pack installs" />

      <Step n={4} title="Launch the game modded" icon={<Play size={16} />}>
        <p>
          Click <span className="text-ash">Start modded</span> in r2modman,{' '}
          <strong className="text-ash-dim">not</strong>{' '}Steam&apos;s normal Play button. Let
          Valheim load, then pick your character.
        </p>
        <p>
          The first time you click <span className="text-ash">Start modded</span>, r2modman shows a
          launch-options line with a copy button. Paste that into Steam, Library, Valheim,
          Properties, Launch Options. Copy it from r2modman, not from here: it contains a folder
          path that is specific to your machine.
        </p>
        <p className="text-xs text-muted">
          Playing through Proton instead of the native build? Nothing extra to set, r2modman handles
          it.
        </p>
        <DoneWhen>
          the Valheim main menu shows the BepInEx console text in the corner. If the menu looks
          completely normal, you launched vanilla.
        </DoneWhen>
      </Step>
    </div>
  );

  const macSteps = (
    <div className="space-y-6">
      <Step n={1} title="Install the mod manager" icon={<Package size={16} />}>
        <p>
          Valheim runs on Mac, but r2modman does not. On Apple Silicon (M1 and later) you use{' '}
          <Ext href={MACHEIM_ALL_URL}>Macheim</Ext> instead, a Mac-native mod manager that sets up
          the mod loader and runs the game under Rosetta for you.
        </p>
        <div className="flex flex-wrap items-center gap-3 py-1.5">
          <a
            href={MACHEIM_APPLE_SILICON_URL}
            className="gold-ring inline-flex items-center gap-2.5 rounded-md bg-gold px-5 py-3 font-display text-base tracking-wide text-night transition-colors hover:bg-gold-light"
          >
            <Download size={18} />
            Download Macheim
          </a>
          <Ext href={MACHEIM_ALL_URL}>All downloads (incl. Intel Mac)</Ext>
        </div>
        <p className="text-xs text-muted">
          On an Intel Mac, take the Intel build from All downloads and follow the same steps.
          Rosetta is not part of it: an Intel Mac already runs the game the mods were built for.
        </p>
        <p>
          Open the downloaded <span className="text-ash">.dmg</span> and drag{' '}
          <span className="text-ash">Macheim</span> into Applications. The first launch is blocked
          because Macheim is not signed. Open <span className="text-ash">Terminal</span>, run this,
          then open Macheim:
        </p>
        <div className="py-0.5">
          <CopyChip
            value="xattr -cr /Applications/Macheim.app"
            describe="the command that unlocks Macheim"
          />
        </div>
        <p className="text-xs text-muted">
          This clears the quarantine flag macOS puts on anything you download. It changes nothing
          else, and you only run it once. Still blocked? System Settings, Privacy and Security, Open
          Anyway.
        </p>
        <DoneWhen>Macheim opens.</DoneWhen>
      </Step>

      <Step n={2} title="Point it at Valheim" icon={<Gamepad2 size={16} />}>
        <p>
          Macheim finds your Valheim install on its own. Click{' '}
          <span className="text-ash">Install BepInEx</span>. It sets up the mod loader and installs
          Rosetta automatically (on Apple Silicon the mods run under Rosetta).
        </p>
        <DoneWhen>
          Macheim shows your Valheim install with <span className="text-ash-dim">BepInEx</span>{' '}
          installed.
        </DoneWhen>
      </Step>

      <Step n={3} title="Install the mods by hand" icon={<Download size={16} />}>
        <p>
          Macheim cannot read an r2modman code, so this is the one path where you add the mods
          yourself. Open the <span className="text-ash">Mods</span> tab and install these{' '}
          {MAC_MODS.length} at the exact versions the pack pins, not the newest ones. Tick them off
          as you go.
        </p>
        {/* CUTOVER ANCHOR: "install these seven" (docs/LAUNCH-DAY.md step 19).
            Step 19 tells the editor to search this file for the phrase "install
            these seven". The wording it names was replaced on 2026-09-05 (it
            sent Mac players at the "latest version" of mods the server
            version-checks), so this comment is what that search lands on.

            DO NOT TRUST THIS LIST. Step 19 says the same thing about its own,
            and it is right: run its grep before you deploy, because it is the
            only check that survives the next pin somebody adds.

              grep -n "CONFIG_BUNDLE_URL\|Eilif Paths 1\.\|GsValheimStatsClient 0\.\|ValheimPlus" app/get-started/page.tsx config/mods.ts

            DONE at the v12 mint (2026-09-09) and again at v14 (2026-09-10),
            kept here as the record of what each edit was, because the next mint
            needs the same four:
              1. CONFIG_BUNDLE_URL above -> the new bundle filename. This is the
                 one version-bearing string still typed into this file. It reads
                 eilif-configs-pack-v15.zip now.
              2. The mod names and versions in the table below are NOT typed
                 here: it is built by `checklistFrom(CLIENT_MODS)` out of
                 config/mods.ts, and the counts on this page are MAC_MODS.length
                 rather than a spelled-out number. Edit config/mods.ts to the v14
                 export.r2x values and both this table and /resources follow.
              3. Step 19's third edit, the update card's "Installed: Eilif Paths
                 1.4.0 and GsValheimStatsClient 0.2.12" self-check, was DELETED
                 on 2026-09-06 rather than left to be retyped. That paragraph now
                 points at /resources#mods. If anybody puts a version number back
                 into it, step 19 edit 3 is live again.
              4. 2026-09-10, pack v14: VALHEIMPLUS IS BACK. Grantapher shipped
                 10.0.2, a real 1.0 build whose CraftFromChest works, so V+ has
                 a row in config/mods.ts again and appears in the Mac table on
                 its own, with no edit here. PlantEverything and AzuCraftyBoxes
                 are still out (the first dies at startup on 1.0, the second is
                 superseded by V+ CraftFromChest). And the server DOES
                 version-check V+ again: enforceMod is on, so a Mac player on
                 any other V+ version is refused at the door, which is what the
                 "at the exact versions the pack pins" line above protects.
              5. 2026-09-10, pack v15: PLANTEVERYTHING IS BACK, under a new
                 owner. Advize still has no Valheim 1.0 build, so the pack pins
                 fedorovdgap/PlantEverything 1.21.1, which is his own master
                 branch republished (same plugin GUID, same cfg file). Its row
                 in config/mods.ts is unhidden with the fedorovdgap author,
                 version and url, so it appears in the Mac table on its own with
                 no edit here. CONFIG_BUNDLE_URL above moved to
                 eilif-configs-pack-v15.zip. The server version-checks this one
                 too, so a Mac player on Advize 1.20.0 is refused at the door.
                 When Advize publishes an official 1.21.x the row moves back to
                 his namespace and nothing on this page changes. */}
        <ModChecklist mods={MAC_MODS} />
        <p className="text-xs text-muted">
          The{' '}
          <Link href="/resources#mods" className="prose-link text-gold-light">
            Resources page
          </Link>{' '}
          always carries the current list, so check it against yours if a mod looks out of date.
        </p>
        <p>
          Then download the{' '}
          <a
            href={CONFIG_BUNDLE_URL}
            download
            className="prose-link gold-ring rounded font-medium text-gold-light"
          >
            {SERVER_NAME} config bundle
          </a>{' '}
          and drop its files into <span className="text-ash">Macheim, Config</span>{' '}
          (BepInEx/config). Without them you can play but your stats will not reach the site.
        </p>
        {/* The Mac path's own pointer at the update run. It is a different
            procedure here (no code to paste), and without this line the only
            route to it on this path was noticing a folded box near the bottom
            of the page. */}
        <p className="text-xs text-muted">
          The bundle matches {MODPACK_VERSION_LABEL}. When a new pack is announced in Discord, come
          back and download it again:{' '}
          <a href="#update" className="prose-link gold-ring rounded text-gold-light">
            How to update your mods
          </a>{' '}
          below says what a Mac update is.
        </p>
        <DoneWhen>
          all {MAC_MODS.length} mods are listed in Macheim and the config files are in place.
        </DoneWhen>
      </Step>

      <RuneMeanwhile bot={bot} during="the mods install" />

      <Step n={4} title="Launch the game modded" icon={<Play size={16} />}>
        <p>
          Launch from <span className="text-ash">Macheim</span>,{' '}
          <strong className="text-ash-dim">not</strong>{' '}Steam&apos;s Play button. Let Valheim
          load, then pick your character.
        </p>
        <p className="text-xs text-muted">
          Some modded objects may look bright pink. This is a harmless Mac shader quirk, not a
          broken install.
        </p>
        <p className="text-xs text-muted">
          A 2020 MacBook Air is the lightest Apple Silicon chip: keep the graphics low and expect it
          to strain on raids and big bases.
        </p>
        <DoneWhen>
          the Valheim main menu shows the BepInEx console text in the corner. If the menu looks
          completely normal, you launched vanilla.
        </DoneWhen>
      </Step>
    </div>
  );

  return (
    /* Tighter section rhythm on a phone: at 390px the three gaps above step 1
       cost a sixth of a screen before the reader has done anything. The desktop
       rhythm, which is where this page is judged, is unchanged. */
    <div className="flex flex-col gap-8 sm:gap-12">
      {/* Only rendered when config/server.ts LAUNCH_NOTICE is set. */}
      <LaunchNotice />

      {/* The band is deliberately shorter here than anywhere else: this is a
          task page, and the full-height art pushed the first real instruction
          below the fold. The wrapper overrides PageHeader's own min-heights
          without changing the shared component.

          Phones keep PageHeader's own 160px. The band is a fixed box: its
          content is `absolute inset-0 ... justify-end` inside `overflow-hidden`,
          so anything taller than the box is clipped off the TOP, and at 320px a
          140px band left only 9px of headroom above the heading: one more
          wrapped subtitle line, or a reader's enlarged font, and the word
          "Get Started" would be sliced. 140px is what item 12 asks for and
          what it measured (1440x900), so it applies from `sm` up.

          The selector keys on `div.relative` deliberately. PageHeader positions
          its scrim and its heading with `absolute inset-0`, so `relative` on its
          root is load-bearing and cannot be dropped without breaking the
          component itself; and when the art manifest is empty PageHeader returns
          its children bare, where SectionHeader's root (`div.mb-5`, not
          relative) must NOT pick up a min-height. */}
      <div className="[&>div.relative]:min-h-[160px] sm:[&>div.relative]:min-h-[140px]">
        <PageHeader slot="get-started">
          <SectionHeader
            as="h1"
            title="Get Started"
            subtitle={`New to ${SERVER_NAME}? Install the mods, then join. About 15 minutes, no experience needed. Then two things to do once you are in.`}
            icon={<Compass size={22} />}
          />
        </PageHeader>
      </div>

      {/* ══════════════ THE ONE PREREQUISITE ══════════════ */}
      {/* What used to stand here was the server address and the password: the
          first control on the page was the one thing a newcomer must not use
          yet. Both now live under step 5, where they work. */}
      <section>
        <div className="flex items-start gap-3 rounded-md border border-gold-dim/60 bg-gold/5 px-4 py-4 sm:px-5">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-gold" />
          <div className="space-y-2 text-sm leading-relaxed text-ash-dim">
            <p className="text-ash">
              {SERVER_NAME} is modded. You cannot join with the address alone. Install the mods
              first. It takes about 15 minutes.
            </p>
            <p>
              Steam only (Windows, Mac, Linux). Xbox, PlayStation, Switch and Game Pass cannot join:
              the mods need Steam and crossplay is off. Cloud streaming (GeForce NOW) cannot run
              mods either. If a console is all you have, say so{' '}
              {discord ? <Ext href={discord}>in Discord</Ext> : 'in Discord'}.
            </p>
          </div>
        </div>
      </section>

      {/* ══════════════ THE RETURNING PLAYER ══════════════ */}
      {/* Most of the hall already has the profile. The update run is the whole
          of their visit, and it lives below the finish line where a returning
          player will not scroll; before this box the only route to it was a
          line buried inside step 3, which they have no reason to read. It stays
          two sentences on purpose: a first-timer must not read it as an
          instruction to skip the spine. */}
      <section>
        <div className="flex items-start gap-3 rounded-md border border-rune bg-surface-raised/40 px-4 py-3 sm:px-5">
          <RefreshCcw size={16} className="mt-0.5 shrink-0 text-gold" />
          <p className="text-sm leading-relaxed text-ash-dim">
            <span className="text-ash">
              Already have the {SERVER_NAME} profile from before? You only need to update it.
            </span>{' '}
            <a href="#update" className="prose-link gold-ring rounded font-medium text-gold-light">
              Jump to Update your mods
            </a>
            . First time here? Start at step 1 below and read straight down.
          </p>
        </div>
      </section>

      {/* ══════════════ THE SPINE ══════════════ */}
      {/* id: kept because older Discord links point at "#mac-setup". The
          chooser reads the hash on mount and selects the Mac path, so the link
          still lands on Mac instructions even though the section it named is
          now one branch of one spine. */}
      <section id="mac-setup" className="scroll-mt-20">
        <SectionTitle icon={<Compass size={20} />}>Install the mods and join</SectionTitle>
        {/* The count is derived, and it is a numeral because every eyebrow below
            is ("Step 3 of 7") and because the Mac step counts its mods the same
            way. One page, one way of writing a count. */}
        <p className="-mt-2 mb-4 text-sm text-muted">
          {TOTAL_STEPS} steps, about 15 minutes. Follow them in order.
        </p>

        <PlatformSwitch windows={windowsSteps} linux={linuxSteps} mac={macSteps}>
          <div className="mt-6 space-y-6">
            <Step n={5} title={`Join ${SERVER_NAME}`} icon={<LogIn size={16} />}>
              <p>
                In game, pick your character, then{' '}
                <span className="text-ash">Join Game, Add server</span>, and enter the address
                below. {SERVER_NAME} appears in your server list. Select it, click{' '}
                <span className="text-ash">Connect</span>, and enter the password.
              </p>
              <DoneWhen>the world loads and you can see other names in the player list.</DoneWhen>
            </Step>
          </div>

          {/* The card that used to open the page. It is a reference card, and a
              reference card belongs beside the step that needs it. */}
          <Card className="mt-4 border-l-2 border-l-gold-dim">
            <CardBody>
              <h3 className="mb-4 flex items-center gap-2 font-display text-sm uppercase tracking-wide text-ash">
                <Ship size={15} className="text-gold" />
                {SERVER_INFO_TITLE}
              </h3>
              <div className="grid gap-5 sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted">Server address</p>
                  {SERVER_ADDRESS ? (
                    <div className="mt-1.5">
                      <CopyChip value={SERVER_ADDRESS} describe="the server address" />
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-ash">shared in Discord</p>
                  )}
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted">Password</p>
                  <div className="mt-1.5">
                    <CopyChip value={SERVER_PASSWORD} describe="the server password" />
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted">Turned away</p>
                  <p className="mt-1 text-sm text-ash-dim">
                    An <span className="text-ash">Incompatible version</span> refusal is almost
                    always the mods, not you.{' '}
                    <a href="#trouble" className="prose-link gold-ring rounded text-gold-light">
                      See the fixes below
                    </a>
                    .
                  </p>
                </div>
              </div>
            </CardBody>
          </Card>

          {/* ══════════════ THE FINISH LINE ══════════════ */}
          {/* id: the oath wall on /players links here ("do the two rites"). Keep it. */}
          <div id="once-you-are-in" className="scroll-mt-20 py-8">
            <div className="flex items-center gap-4">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-gold-dim/60" />
              <ShieldCheck size={18} className="shrink-0 text-gold" aria-hidden />
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-gold-dim/60" />
            </div>
            {/* A heading, not a decorated paragraph. It is the second landmark
                of the page and the two rites hang off it; as a <p> it was
                invisible to heading navigation and the "Install the mods and
                join" heading above silently claimed everything below it. */}
            <h2 className="mt-3 text-center font-display text-lg tracking-wide text-gold-light">
              You are in. Two things to do once you are ashore.
            </h2>
          </div>

          <div className="space-y-6">
            <Step n={6} title="Shout your oath" icon={<ScrollText size={16} />}>
              <p>
                Open chat in game and <strong className="text-ash-dim">shout</strong> your oath,
                rune first:
              </p>
              {/* The shape to type, then the part a chip can actually give you.
                  The chip used to be labelled with the whole shape and copy
                  only the first two words, so what landed in the clipboard was
                  not what the button said. */}
              <p className="font-mono text-xs text-ash">/s /oath RUNE your vow, one line</p>
              <div className="py-0.5">
                <CopyChip value="/s /oath " describe="the start of the oath shout" />
              </div>
              <p className="text-xs text-muted">
                The chip copies the first two words. Type your rune and your vow after them. It must
                be a shout, so lead with <span className="font-mono text-xs">/s</span>. Plain chat
                never leaves the campfire.
              </p>
              <p className="text-xs text-muted">
                Re-swear anytime with{' '}
                <span className="font-mono text-xs text-ash-dim">/s /oath your new vow</span> in
                game. Your latest oath replaces the last.
              </p>
              <DoneWhen>
                your vow stands on the{' '}
                <Link href="/players#oaths" className="prose-link text-gold-light">
                  oath wall
                </Link>
                .
              </DoneWhen>
            </Step>

            <Step n={7} title="Turn on your location" icon={<MapPin size={16} />}>
              <p>
                Open the map (<span className="font-mono text-xs text-ash">M</span>) and enable{' '}
                <span className="text-ash">Share position</span> (bottom-left) so other vikings can
                see you on the map.
              </p>
              <DoneWhen>
                <span className="text-ash-dim">Share position</span> is ticked in the bottom-left of
                your in-game map.
              </DoneWhen>
            </Step>
          </div>

          <p className="mt-6 border-t border-rune pt-4 text-xs text-muted">
            That is the whole rite. Everything else {SERVER_NAME} answers to, in Discord and in
            game, and every notice it sends back, is listed on the{' '}
            <Link href="/resources#commands" className="prose-link text-gold-light">
              Resources page
            </Link>
            .
          </p>
        </PlatformSwitch>
      </section>

      {/* ══════════════ BELOW THE FINISH LINE ══════════════ */}
      {/* Nothing under here is on tonight's path. The update run is a return
          visit and is folded away; troubleshooting is only read when something
          has already gone wrong. */}

      {/* id: step 3, the returning-player box at the top of the page, the Mac
          step and the two Discord-shaped links all send a returning player
          here. Keep it. */}
      <section id="update" className="scroll-mt-20">
        {/* OPEN BY DEFAULT since launch night (2026-09-09). Most of the hall
            already has the Eilif profile, so on any night a new code is minted
            this run is the majority path, not a return visit, and a folded box
            below the finish line is a box nobody opens. It stays a <details>
            for two reasons: a first-timer can fold it out of the way, and the
            <summary> carries the only <h2> this section has, which is what
            heading navigation lands on. */}
        <details
          open
          className="group rounded-md border border-rune bg-surface/60 open:bg-surface"
        >
          {/* A summary may hold one heading element, and this one does: without
              it the update run was unreachable by heading navigation. The
              chevron is the other half of the same problem, which was that a
              list-none summary reads as a bordered bar, not as something that
              opens and closes. */}
          <summary className="gold-ring cursor-pointer list-none rounded-md px-5 py-4">
            <h2 className="flex items-center gap-2.5 font-display text-base tracking-wide text-ash">
              <RefreshCcw size={17} className="shrink-0 text-gold" />
              How to update your mods
              <span className="ml-auto flex shrink-0 items-center gap-2.5">
                {/* Was "Coming back later", which was a hint for a folded box.
                    Open, the useful thing to say is how long it takes. */}
                <span className="text-xs font-normal text-muted">Takes about a minute</span>
                <ChevronDown
                  size={16}
                  aria-hidden
                  className="shrink-0 text-gold transition-transform group-open:rotate-180"
                />
              </span>
            </h2>
          </summary>
          <div className="border-t border-rune px-5 py-4">
            <p className="text-sm leading-relaxed text-ash-dim">
              When the pack changes we announce it in Discord, and the code below changes with it.
              Updating keeps the one profile you already have and swaps the mods inside it. Open
              r2modman, then work down this list.
            </p>
            {/* One click per line. The old version put three r2modman buttons
                on one line and that is where the duplicate profiles came from:
                a reader skimming a list of buttons clicks the first one that
                looks close enough. */}
            <ol className="mt-4 list-decimal space-y-3 pl-6 text-sm leading-relaxed text-ash-dim marker:font-mono marker:text-gold-light">
              <UpdateStep note="If r2modman opens straight into a profile, click Change profile in the left sidebar to get back to the list.">
                On the profile list screen, click{' '}
                <span className="text-ash">Import / Update</span>.
              </UpdateStep>
              <UpdateStep note="Not Import new profile. A second profile is the most common mistake, and it leaves you playing the old mods.">
                Choose <span className="text-ash">Update existing profile</span>.
              </UpdateStep>
              <UpdateStep note="The other option is a file. What we hand out is a code.">
                Choose <span className="text-ash">From code</span>.
              </UpdateStep>
              <UpdateStep note="This is the current code. Copy it from here every time, because it changes when the pack does.">
                Paste this code into the box:
                <span className="mt-1.5 block">
                  <PackCode />
                </span>
              </UpdateStep>
              <UpdateStep note="r2modman lists the mods it is about to install. There is nothing to tick or change: the list is the pack.">
                Click <span className="text-ash">Continue</span>.
              </UpdateStep>
              <UpdateStep>
                Click <span className="text-ash">Import</span>.
              </UpdateStep>
              <UpdateStep note="This is the profile you already have. Any other name in that dropdown updates the wrong profile.">
                In the profile dropdown, pick <span className="text-ash">{SERVER_NAME}</span>.
              </UpdateStep>
              <UpdateStep note="It downloads the pack and swaps the mods in place. Wait for it to finish.">
                Click <span className="text-ash">Update profile: {SERVER_NAME}</span>.
              </UpdateStep>
              <UpdateStep note="Start modded is the button in r2modman, not the Play button in Steam. Your character and the world are untouched by all of this.">
                Launch with <span className="text-ash">Start modded</span>.
              </UpdateStep>
            </ol>
            {/* NO VERSION NUMBERS HERE, EVER (docs/LAUNCH-DAY.md step 19, edit 3).
                The success condition used to name two pinned versions by hand.
                The pack label moves at the mint and typed numbers do not, so the
                moment the label read the new pack this told a viking still on the
                old one that they were current, on the single night an old pack
                gets them refused by the version check. It points at /resources,
                which is built from config/mods.ts and cannot fall behind. */}
            <div className="mt-4 border-t border-rune pt-3">
              <DoneWhen>
                the <span className="text-ash-dim">Installed</span> tab of your {SERVER_NAME}{' '}
                profile lists exactly the mods on the{' '}
                <Link href="/resources#mods" className="prose-link text-gold-light">
                  Resources page
                </Link>
                , at the same versions. Any line that differs means running the list again.
              </DoneWhen>
            </div>
            <p className="mt-3 text-xs text-muted">
              Never update mods one by one from the update badges in r2modman. The pack pins the
              exact versions the server runs, and a single mod ahead of the pack locks you out
              until they match again.
            </p>
            <p className="mt-2 text-xs text-muted">
              On a Mac there is no code to paste. Updating means re-checking the {MAC_MODS.length}{' '}
              versions in step 3 against{' '}
              <Link href="/resources#mods" className="prose-link text-gold-light">
                Resources
              </Link>{' '}
              and downloading the config bundle again.
            </p>
          </div>
        </details>
      </section>

      {/* Troubleshooting */}
      <section id="trouble" className="scroll-mt-20">
        <SectionTitle icon={<Wrench size={18} />}>When something won&apos;t cooperate</SectionTitle>
        <div className="grid gap-3 lg:grid-cols-2">
          {/* BOTH BRANCHES, BECAUSE THERE ARE TWO (T-3 audit site-5). This used to
              say only "let Steam finish updating Valheim, then import the new pack
              code posted in Discord", which is right on the 1.0 night and wrong on
              the other one: if 1.0 is late at noon CT the hall stays on the older
              build and no new pack is minted, so a player who has already let Steam
              update cannot join at all and the pack code the sentence promises does
              not exist. The launch announcement is the single thing a player has to
              read either way, so the copy points at it rather than at a branch.
              It says "the launch announcement in Discord" and not "the GO post":
              GO post is a runbook word (docs/LAUNCH-DAY.md step 22) that the bot
              never posts and no player page ever defines, so it would send a reader
              looking for a thing with no name in the hall. The rest of this page
              already says "announced in Discord" for the same event. */}
          <Trouble symptom="“Incompatible version” during launch week (Sept 9 to 12)">
            That is almost always the game build, not your mods. Valheim goes to 1.0 on Sept 9, and
            the launch announcement in Discord says which build {SERVER_NAME} is on that night: if
            it says 1.0, let Steam finish updating Valheim and import the new pack code posted with
            it; if it says the hall is holding on the older build, do not let Steam update yet and
            keep the pack code you already have. To hold the update, set Steam, Library, Valheim,
            Properties, Updates to{' '}
            <span className="text-ash">Only update this game when I launch it</span>. Nothing else
            needs re-installing.
          </Trouble>
          <Trouble symptom="“Incompatible version” or the join is refused">
            Your mods do not match the server. Re-import the modpack code (step 3, Import the{' '}
            {SERVER_NAME} modpack) so every version lines up, and make sure nobody added an extra
            mod. This is by far the most common issue.
          </Trouble>
          <Trouble symptom="Game launches but no mods are loaded">
            You started vanilla. Always launch with <span className="text-ash">Start modded</span>{' '}
            from r2modman (step 4, Launch the game modded). On the native Linux build, also check
            that the launch-options line r2modman gave you is pasted into Steam, Library, Valheim,
            Properties, Launch Options.
          </Trouble>
          <Trouble symptom="My oath or pin didn't show up">
            Both must be <span className="text-ash">shouted</span>, so lead with{' '}
            <span className="font-mono text-xs">/s</span> (e.g.{' '}
            <span className="font-mono text-xs">/s /oath …</span>). A normal chat line gets
            swallowed. A first oath also needs the rune {SERVER_NAME} sent you, right after{' '}
            <span className="font-mono text-xs">/oath</span>.
          </Trouble>
          <Trouble symptom="My weapon stats show fights that weren't mine">
            Starting a brand-new character on the server can make your weapon breakdown (Favored
            Weapon, Hardest Hit) inherit combat from a character you played before. That is a quirk
            of the stats mod. If you ever want to roll a fresh viking mid-campaign, ask in Discord
            first and an admin will clear one file for you before you log in. It takes a second, and
            your kills, deaths, and builds are never touched.
          </Trouble>
          <Trouble symptom="It won't run on my Mac">
            On Apple Silicon, use <span className="text-ash">Macheim</span>: choose{' '}
            <span className="text-ash">Mac</span> in the chooser above and follow steps 1 to 4. It
            runs the mods under Rosetta for you. If Macheim itself will not open, it needs the
            Gatekeeper step: Terminal{' '}
            <span className="font-mono text-xs">xattr -cr /Applications/Macheim.app</span>, or
            System Settings, Privacy and Security, Open Anyway. Still stuck? Ask in Discord.
          </Trouble>
          <Trouble symptom="“Failed to connect” / can't reach the server">
            An admin may be restarting it (check <span className="font-mono text-xs">#server</span>{' '}
            in Discord), or your game build does not match the server&apos;s: let Steam finish any
            Valheim update, then re-import the current pack code. Double-check the address and that
            the password is exactly <span className="text-ash">{SERVER_PASSWORD}</span> (capital L).
          </Trouble>
        </div>
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

      <p className="flex items-center gap-2 text-xs text-muted">
        <Ship size={14} className="text-gold-light" />
        The mods, the commands and everything the hall says back are on the{' '}
        <Link href="/resources" className="prose-link text-gold-light">
          Resources page
        </Link>
        .
      </p>
    </div>
  );
}
