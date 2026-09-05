# The Eilif modpack: minting, cutover, and the rules that bite

Two artifacts have to agree with each other and with the server, every time:

| Artifact | Where it lives | Who uses it |
|---|---|---|
| r2modman pack code | `MODPACK_PROFILE_CODE` in `config/server.ts`, shown on `/get-started` and `/mods` | Windows and Linux players, one click |
| Mac config bundle | `public/downloads/eilif-configs-pack-v<N>.zip`, linked by `CONFIG_BUNDLE_URL` in `app/get-started/page.tsx` | Macheim players, who install the mods by hand because Macheim cannot read a pack code |

Both are now generated from one source: `scripts/pack-templates/`. `scripts/mint-pack.mjs`
renders and mints the pack, `scripts/build-config-bundle.mjs` renders the same files
into the Mac zip. Run them with the same flags and the two cannot drift apart.

```bash
export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
node scripts/mint-pack.mjs --help
node scripts/build-config-bundle.mjs --help
```

## What is in the pack

The zip root holds `export.r2x` (which pins the seven mods) and `doorstop_config.ini`;
`config/` holds the seven `.cfg` files that go with them. Ten entries in all, counting
the `config/` directory record. A pack minted with `--no-vplus` has nine, because the
ValheimPlus entry and its cfg leave together (counted with `unzip -l` on both, 2026-09-05).

| Mod | Thunderstore | Pinned in v11 | Has a cfg in the pack |
|---|---|---|---|
| BepInExPack | `denikson/BepInExPack_Valheim` | 5.4.2333 | yes (`BepInEx.cfg`) |
| ValheimPlus (Grantapher fork) | `Grantapher/ValheimPlus_Grantapher_Temporary` | 9.17.1 | yes (server overrides most of it) **and droppable, see rule 6** |
| PlantEverything | `Advize/PlantEverything` | 1.20.0 | yes |
| GsValheimStatsClient | `Proudlock_Technology/GsValheimStatsClient` | 0.2.12 | yes (world + ingest URL) |
| EilifPaths | `Eilif/EilifPaths` | 1.4.0 | yes |
| EilifCompanionClient | `Eilif/EilifCompanionClient` | 0.2.0 | yes (ingest URL) |
| AzuCraftyBoxes | `Azumatt/AzuCraftyBoxes` | 1.8.15 | yes (unbinds Alt+O) |

`config/mods.ts` lists more than this: it also covers server-side mods (Eilif Companion,
Eilif Boards, ServersideQoL, WebMap, the stats emitter) that players never install. Only
the seven above belong in the pack.

Six of the seven are fixed. **ValheimPlus is the one the pack can be minted without**
(`--no-vplus`), because Grantapher 9.17.1 targets 0.221.10 and has no 1.0 build. That flag
drops its `export.r2x` entry **and** `config/valheim_plus.cfg` together; see rule 6.

Three files in this repo hold a version list for those seven, and they have to be edited
together: `MODS` in `scripts/mint-pack.mjs` (the renderer of record), `PACK_V12_PINS` in
`scripts/launch-preflight.mjs` (which checks the same Thunderstore endpoints from the
preflight side), and the player-facing list in `config/mods.ts`. If they disagree,
preflight can green-light a pin the minter refuses, or `/mods` can claim a version nobody
is running. Folding preflight's list into an `import { MODS }` is the obvious fix and is
not done yet.

## Six rules

**1. The listing index lags uploads by 40 to 80 minutes.** Thunderstore's package API
knows about a new version the instant it uploads, but mod managers resolve a profile code
against a pre-baked, gzipped `package-listing-index`, which is rebuilt on a schedule. A
code minted inside that window looks perfect on the package page and fails for every
player with "mod not found". `mint-pack.mjs` checks **both** and refuses to mint until the
index has caught up. Do not work around it; wait and re-run.

**2. A pack code carries no DLLs.** It is a list of Thunderstore package names and
versions (plus our cfgs). A mod installed as a local file exports only as a stub that
importers cannot resolve. That is why EilifPaths and EilifCompanionClient are published on
Thunderstore under the `Eilif` namespace: **publish the plugin first, wait for the index,
then mint.** The order is not negotiable. `plugins/eilif-companion-client/PACK.md` and each
`plugins/thunderstore/<pkg>/UPLOAD.md` cover the upload side.

As of 2026-09-04 the staged client build is **EilifCompanionClient 0.3.2**, not uploaded
(`plugins/thunderstore/EilifCompanionClient-<ver>/` is the source of truth for what is staged
right now, and it moves). Thunderstore's latest is still 0.2.0, which is what pack v11 pins.
EilifPaths is published at 1.4.0 and staged at **1.5.0**, the build that adds `[VPlusFallback]`. A re-mint that pins an unpublished version is refused until
that package is uploaded and the index rebuilds - that refusal is the tool working, not a bug.

**3. AzuCraftyBoxes moves in lockstep.** Its `Prevent Pulling Logic` hotkey setting is
client-side and *not* server-synced, so only the pack can unbind Alt+O fleet-wide (that
was the whole reason pack v11 exists). If the server's copy changes version, the pack pin
and the Mac bundle both change with it, or people lose chest crafting again and nobody
knows why.

**4. `World` in the stats cfg must match the server's world exactly.** `--world` writes it
into `config/net.cproudlock.gsvalheimstatsclient.cfg`. The ingest route drops client
payloads whose `world` does not match `GS_EXPECTED_WORLD`, so a typo here means silently
missing stats, not an error anyone sees. Rehearsal pack: `EilifRehearsal`. Launch pack:
whatever the 1.0 world is actually named.

**5. No tokens in the pack.** A pack code is public the moment it is posted in Discord, so
the `Token =` lines ship blank on purpose. The ingest token is server-side only.

**6. ValheimPlus is all-or-nothing, on both sides at once.** V+ `enforceMod = true` is a
version check in **both** directions: a server running V+ refuses every client without it,
and a client from a V+ pack is refused by a server without it. So `--no-vplus` and deleting
`BepInEx/plugins/ValheimPlus/` on the box are one decision, taken in one stopped window. The
minter cannot check the box, so it prints the reminder loudly instead, twice.

**Removing V+ turns nothing on.** Two switches replace it, they live on opposite sides of the
wire, and **both ship off**:

| Half | Where | How it is switched on |
|---|---|---|
| client | EilifPaths `[VPlusFallback] Enabled` | `--fallback on`, in this pack |
| server | Eilif Companion `[ServerFallback] Enabled` + `MaxPlayers` | by hand, in `BepInEx/config/media.blockspace.eilif.companion.cfg` on the box |

The server half is the player cap, and it is the one that gets forgotten, because nothing in
this repo can set it. BepInEx only **writes** `[ServerFallback]` into that cfg on the first
boot of a Companion build that has the code, so it cannot be edited in the same stopped
window as the DLL swap unless the whole file is uploaded by hand alongside the DLL. Skip it
and the cap sits at the vanilla 10 all night with no error anywhere.

`config/server.ts` `MAX_PLAYERS` must equal whatever the box actually enforces: **10** if
`[ServerFallback]` stays off, otherwise its `MaxPlayers` value (the plugin's own default is
20). Pass the minter `--cap <n>` and it prints that number in the publish checklist instead
of the rule.

### What actually leaves with ValheimPlus

Walked section by section against the live `valheim_plus.cfg` the crew has been playing.
The GO post has to name the middle group, so this is the inventory it is written from.

**Restored by `--fallback on`** (client side): infinite fireplace, oven, hot tub and shield
generator fuel; station build range 30m, attachment range 20m, no roof check; +30% gathering,
+30% picking, +30% loot amount; shared map exploration.

One caveat on that list: those patches run on whichever machine **owns** the object, and a
dedicated server owns the zones around world origin, where it has no EilifPaths. A fire or a
bush inside that box keeps vanilla behaviour. V+ did not have this problem because V+ was
installed on both sides. On a fresh wipe the first hall is often within a few zones of spawn,
so say it out loud rather than letting someone report it as a bug.

**Gone tonight, restored by nothing** (and mostly building-comfort, which is what a launch
night is made of):

- buildings take **weather damage** again (`noWeatherDamage`)
- no **area repair** (one hammer click repaired everything within 7.5m)
- dropped items **sink** instead of floating, and linger for less than the hour V+ gave them
- **grid snapping** and its LeftAlt / F6 / F7 keys
- **shouts and pings go back to vanilla range** instead of crossing the map, and whispers with
  them. Worth a moment: the whole crew is used to `/s` reaching everybody
- camera **zoom 100 and FOV 75** back to vanilla, comfort radius 20 back to vanilla
- **full resource refund** on deconstruct, and placement in spots vanilla refuses
- sleeping in an **unclaimed bed**, carts and boats shown on the map

**Candidates to fold into EilifPaths** if the crew misses them, in the order they are likely
to be missed: `noWeatherDamage`, area repair, `itemsFloatInWater`. All three are client-owned
work, so they belong in the same file as the rest of the fallback. That is a decision for
Charlie before the morning, not during it.

### The flags

```bash
node scripts/mint-pack.mjs --world <World> --paths 1.5.0 --no-vplus --fallback on ...
```

`--fallback on|off|none` writes `Enabled` in the rendered `net.eilif.paths.cfg`. Default is
`none`: no section at all, which is what EilifPaths 1.4.0 wrote and what reproduces published
pack v11 byte for byte. `off` writes the section with `Enabled = false`; `on` writes it true.

**`on` and `off` both require `--paths 1.5.0` or newer, and the render refuses otherwise.**
That section is 1.5.0 code; written against an older pin it is an orphaned BepInEx key, so
every restored comfort would be silently absent with no error at mint, at import or at boot.
It is the one failure this toolchain cannot see after the fact, which is why it is a hard
refusal rather than a warning. The writer header follows the section automatically (a cfg
carrying `[VPlusFallback]` could only have been written by a build that has it), so
`--paths-cfg-version` is no longer needed for this; pass it only when a real re-capture says
otherwise.

Use `--fallback on` **only** on a pack that also passes `--no-vplus`: both patch the same
methods, so with V+ present their effects stack and the ranges come out roughly double. The
minter warns about that pairing, and EilifPaths itself logs a warning at boot if it finds a
ValheimPlus DLL while `Enabled = true`.

**The pack pins only `Enabled`, on purpose.** EilifPaths 1.5.0 binds thirteen keys in that
section (`InfiniteFireplaceFuel`, `StationBuildRange`, `GatheringBonusPercent`,
`ShareExploration` and the rest), and their plugin defaults already are the values the V+ cfg
on the box was set to. BepInEx appends the missing twelve at those defaults on first run, so
shipping only the master switch is both correct and one fewer thing to keep in sync. If any
of them ever has to differ from its default, that is the point at which the whole section
gets re-captured from a real r2modman run and dropped into
`scripts/pack-templates/config/net.eilif.paths.cfg.tmpl`, with `--paths-cfg-version` moved to
match.

Related: `--ingest-url` exists but should almost never be used. The dashboard answers on two
hostnames and the shipped mod configs hard-code `valheim-dashboard.vercel.app`; repointing it
strands every player still on an older pack, because their cfg keeps posting to the old one.

## Re-minting: the launch-day sequence

Assume the four plugins have been rebuilt for Valheim 1.0 and the two Eilif client plugins
are uploaded to Thunderstore. The full morning around this, including who does which half,
is `docs/LAUNCH-WIPE.md` under "The launch-morning sequence".

If ValheimPlus is gone, add `--paths 1.5.0 --no-vplus --fallback on` to **every** command in
this section, including step 6's bundle rebuild. All three, every time: `--fallback` without
`--paths 1.5.0` is refused outright (rule 6), and `--no-vplus` without `--fallback on` mints a
pack that takes the comforts away and puts nothing back. The minter prints step 6's command
with the flags already in it, which is why copying it beats retyping it.

1. **Wait for the index.** Rehearse the pins first, which also tells you when the wait is
   over (this uploads nothing):

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client 0.3.2 --dry-run
   ```

   Re-run until every row reads `ok / ok`.

2. **Test mint.** Without `--publish` the script uploads, downloads the minted profile back
   and byte-compares every file, then prints a code labelled TEST.

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client 0.3.2
   ```

   "TEST" is a label in our terminal and nowhere else: the bytes uploaded are deliberately
   identical to what `--publish` would upload, so a TEST code is indistinguishable from a
   real one once it leaves the screen. That is on purpose (it is what makes the test
   meaningful) and it means a stray paste into Discord is unrecoverable. Do not give a TEST
   code to anyone.

   To rehearse the player-side import, mint one under a name that cannot collide with your
   own profile and delete it afterwards:

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client 0.3.2 \
     --profile-name 'Eilif TEST'
   ```

   Then in r2modman: Settings, Import/Export, Import profile, paste the code. It should land
   with all seven mods and the cfgs already filled in. Worth doing once before launch night;
   it is the only link in the chain the script cannot check for itself.

3. **Real mint.**

   ```bash
   node scripts/mint-pack.mjs --world <World> --companion-client 0.3.2 \
     --publish --version-label 'Pack v12 · Sep 9'
   ```

   `--publish` refuses without a version label, and refuses `--skip-index-check` outright.
   It writes a `receipt.json` next to the zip: keep it, it is the record of exactly what
   was pinned.

3b. **If the pack dropped a mod**, four more edits belong with it, and none of them are
   done by these scripts:

   - `config/server.ts` `MAX_PLAYERS` — the number the box actually enforces (rule 6), not
     a guess. The minter prints it if you pass `--cap <n>`.
   - `config/mods.ts` — delete the row, or `/mods` advertises a mod nobody has.
   - `app/get-started/page.tsx` — **the Mac path's hard-coded "install these seven" list**,
     twelve lines above `CONFIG_BUNDLE_URL`. It names ValheimPlus by hand. A Mac player who
     follows that page installs V+ and is then refused by the box, which is `enforceMod`
     working exactly as designed. Drop the name, and the word "seven" with it. (Deriving
     that list and its count from `config/mods.ts` filtered on the client-installed mods
     would make this one edit instead of three; not done yet.)
   - `PACK_V12_PINS` in `scripts/launch-preflight.mjs` — or pass preflight `--pins`, or it
     grades a pin the pack does not have.

4. **Paste the code.** In `config/server.ts`:

   ```ts
   export const MODPACK_PROFILE_CODE = '<code from step 3>';
   export const MODPACK_VERSION_LABEL = 'Pack v12 · Sep 9';
   ```

   Bump the label every single time. It is the only way a returning player can tell whether
   their pack is current.

5. **Bump `config/mods.ts`** for every mod whose version moved, so `/mods` stops claiming
   the old one.

6. **Rebuild the Mac bundle** with the same world and the same pins:

   ```bash
   node scripts/build-config-bundle.mjs --world <World> --companion-client 0.3.2 \
     --pack-number 12 --pack-date 'Sep 9, 2026'
   ```

   Copy the exact command the mint printed in step 3 rather than retyping it: it forwards
   the world, the ingest URL and every cfg header flag that mint actually used, which is
   what keeps the bundle and the pack identical. The script refuses to overwrite a bundle
   file that already exists (`--force` to mean it), so a rehearsal cannot quietly rewrite
   the live v11 zip.

   Then point `CONFIG_BUNDLE_URL` in `app/get-started/page.tsx` at
   `/downloads/eilif-configs-pack-v12.zip`. Leave the old zip in place until the new build
   is live so no link 404s mid-deploy.

7. **Deploy** (Charlie's call, CLI only):

   ```bash
   vercel deploy --prod --yes --scope charlie-9292s-projects
   ```

8. **Stop then Start the server** from the GTX panel, so it comes up on the same plugin
   builds the pack now hands out. A restart is not the same thing as Stop then Start for
   config changes.

9. **Tell the crew**, in Discord, in this order: the new code, the version label, and
   "r2modman: Settings, Import/Export, Update profile from code" for people who already
   have a profile. Mac players: re-download the config bundle from Get Started.

## Changing a setting without changing a version

Edit the template in `scripts/pack-templates/config/`, then re-mint and rebuild the bundle.
That is what pack v11 was: no Thunderstore upload, no listing lag, just a cfg change
(`Azumatt.AzuCraftyBoxes.cfg`, hotkey set to None) republished as a new code.

`scripts/mint-pack.test.mjs` pins the sha256 of every rendered file against pack v11 as
published, so an accidental edit fails `npm test` instead of silently shipping. When you
change a template **on purpose**, update those hashes in the same commit, and say in the
commit message which setting moved.

A template can also carry a `{{#NAME}}` ... `{{/NAME}}` block, each marker alone on its own
line. A kept block loses only its two marker lines, so a rendered file is byte-identical to
one written without the machinery; a dropped block takes its whole body with it. That is how
`--no-vplus` removes the ValheimPlus entry from `export.r2x` and how `--fallback none`
removes `[VPlusFallback]` from the paths cfg. An unbalanced or undeclared marker throws
rather than shipping as a literal, because BepInEx would read `{{#VPLUS}}` in a cfg as a
setting.

Two things the templates deliberately do not derive from the pins:

- **`doorstop_config.ini` and `BepInEx.cfg`** are verbatim. They have no version in them.
- **The `## Settings file was created by plugin X vN` header** in a cfg records the build
  that actually wrote the template body we ship, not the pin, so **no header moves when a
  pin moves** - bumping `--azu 1.9.0` while shipping the 1.8.15 capture would otherwise
  stamp a version that never touched the file. Today the companion client's header reads
  `v0.1.0` against a 0.2.0 pin (its settings schema has not changed since 0.1.0); the
  other four happen to equal their v11 pin.

  Bumping a pin whose cfg schema actually moved means **replacing the template**, not
  passing a flag: re-capture that cfg from a real r2modman run of the new build, drop it
  into `scripts/pack-templates/config/`, then pass the matching header flag
  (`--companion-cfg-version`, `--paths-cfg-version`, `--gs-cfg-version`,
  `--plant-cfg-version`, `--azu-cfg-version`) so the stamp matches the capture. Both
  scripts take the same flags; `--help` lists what each header currently says.

## Inspecting a code someone hands you

A profile code is just a stored file: `#r2modman\n` followed by base64 of the zip.

```bash
curl -sL -H 'User-Agent: eilif-pack-check' \
  https://thunderstore.io/api/experimental/legacyprofile/get/<code>/ \
  | tail -n +2 | base64 -d > profile.zip
unzip -o profile.zip -d unpacked
```

Then diff `unpacked/` against a `--dry-run` render, or point the minter straight at it:

```bash
node scripts/mint-pack.mjs --world <World> --compare-to ./unpacked --dry-run
```

Match the render to the pack you are comparing against, or every difference is your own
flags. Pack v11 and anything else minted before EilifPaths 1.5.0 needs nothing extra (the
defaults are v11's); a pack that carries `[VPlusFallback]` needs `--paths 1.5.0` plus
`--fallback on` or `--fallback off` to match which way its switch was set, and a pack minted
without ValheimPlus needs `--no-vplus`.

## What these scripts will not do

They do not edit `config/server.ts`, do not touch `config/mods.ts`, do not deploy, and do
not post to Discord. Minting is cheap and reversible; publishing a code is not, so that
half stays a human decision.
