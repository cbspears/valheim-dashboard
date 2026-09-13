# Mac install path review, 2026-09-13 (pack v19)

Scope: the Macheim path on `/get-started`, the `eilif-configs-pack-v19.zip` bundle, and each
pinned client mod as it behaves on macOS. Everything below was checked against live sources on
2026-09-13. Nothing was run on a Mac; the "could not verify" list at the bottom says what that
leaves open.

**Verdict: works with the edits below, with one standing risk we cannot close from here.**

The mods are fine on macOS. The config bundle is correct, and its instructions are correct. The
loader is the soft spot: **Macheim's last release is 2026-09-06, three days before Valheim 1.0,
and its own README says Valheim 1.0 compatibility is not guaranteed.** Nobody has confirmed a
1.0.12 install on a Mac. Four things on the page were stale or wrong and have been edited; see
"Edits made".

---

## Findings

| # | Checked | Result | Evidence |
|---|---|---|---|
| 1 | Latest Macheim release | **v1.1.0, published 2026-09-06T09:47:36Z.** The page pinned v1.0.1 (2026-04-10). Assets: `Macheim_1.1.0_aarch64.dmg` (5,761,104 B), `Macheim_1.1.0_x64.dmg` (6,298,812 B), plus `.app.tar.gz` for both. | `https://api.github.com/repos/lofcgi/macheim/releases`; both dmg URLs `curl -sIL` → HTTP 200, sizes match the API |
| 2 | Is v1.0.1 worth staying on? | **No.** v1.0.1 predates commit "Fix config editor loading and saving" (2026-09-04) and "Fix installed mods search crashing on author field mismatch" (2026-09-06). The config editor is the exact Config view step 3 sends every Mac player to, and the installed-mod search is how they check versions. | commit list on `main`, `https://api.github.com/repos/lofcgi/macheim/commits` |
| 3 | Does Macheim claim Valheim 1.0.x support? | **No, and it disclaims it.** README: "Future Valheim 1.0 compatibility is not guaranteed." `RELEASE-1.1.0.md`: "Valheim 1.0 and Windows friends: no future-version or end-to-end multiplayer [verification]". The v1.1.0 shader patch is hard-pinned to Valheim **0.221.12** / Unity 6000.0.61f1 and self-skips on anything else. No open issue mentions 1.0. Last commit anywhere: 2026-09-06. | `https://github.com/lofcgi/macheim` README, `RELEASE-1.1.0.md` at tag v1.1.0, `/issues?state=all` (6 issues, none about 1.0) |
| 4 | Is Macheim dead? | **No, but it is behind.** PR #12 ("Add mod updating") opened 2026-09-12. It is maintained, it just has not shipped since 1.0 landed. | `https://github.com/lofcgi/macheim/pulls` |
| 5 | Does a macOS Valheim build exist, on 1.0.12? | **Yes.** Steam lists `platforms: {windows, mac, linux}`, mac minimum "MacOS 11 or later". The macOS depot 892973 was rebuilt for 1.0 (public manifest 4.57 GB vs the `default_pre1_0` mac manifest at 1.64 GB), and the `public` branch buildid is 25253764 / 2026-09-11, which is 1.0.12. | `store.steampowered.com/api/appdetails?appids=892970`; `api.steamcmd.net/v1/info/892970` |
| 6 | Is there a better Mac manager now? | **r2modman still has no Mac build** (v3.2.19, 2026-08-21: `.exe`, `.AppImage`, `.deb`, `.rpm`, `.pacman`, `.flatpak`, `.tar.gz`, zero `.dmg`), and Thunderstore Mod Manager is Overwolf/Windows only. So the page's premise holds. One alternative surfaced: **`Zard-Studios/r2modmac` v1.0.5 (2026-09-12)**, a native Mac manager shipping real dmgs and claiming pack-code import. Untested for Valheim's Rosetta requirement. Not a recommendation, a thing to pilot. | `https://github.com/ebkr/r2modmanPlus/releases`; `https://github.com/Zard-Studios/r2modmac` |
| 7 | What BepInEx does Macheim install? | **The same package the pack pins, at whatever is newest.** `bepinex_installer.rs:10` hard-codes `denikson-BepInExPack_Valheim` and takes `versions.first()`. Today that resolves to **5.4.2350**, published 2026-09-09, which is exactly the pack pin. So 5.4.2350 vs "Macheim's bundled version" is a non-question: Macheim bundles nothing and downloads ours. | `src-tauri/src/services/bepinex_installer.rs` at tag v1.1.0; `https://thunderstore.io/api/experimental/package/denikson/BepInExPack_Valheim/` (latest 5.4.2350, 2026-09-09) |
| 8 | The Windows-shaped doorstop problem | **Handled by Macheim, not by us.** It lays out `<Valheim>/BepInEx/{core,plugins,patchers,config}` plus `libdoorstop.dylib` (or `doorstop_libs/`), `run_bepinex.sh` and `doorstop_config.ini`, `xattr`-strips quarantine from every dylib, and at launch bypasses the shell script entirely: `arch -x86_64 env DOORSTOP_ENABLED=1 DOORSTOP_TARGET_ASSEMBLY=… DYLD_INSERT_LIBRARIES=libdoorstop.dylib <valheim.app executable> -console`, run in Terminal.app. No `winhttp.dll` anywhere. | `bepinex_installer.rs`, `launcher.rs:79-161` at tag v1.1.0 |
| 9 | **Is `BepInEx.cfg` in our bundle safe to drop over Macheim's?** | **Yes.** The one macOS-critical edit Macheim makes is `[Preloader.Entrypoint] Type = Application` → `Type = GameObject` (`patch_bepinex_config`). Our bundle's `BepInEx.cfg` already ships `Type = GameObject` (it comes from denikson's Valheim pack, which sets it). Overwriting is a no-op on the key that matters. | `bepinex_installer.rs` `patch_bepinex_config`; bundle `BepInEx.cfg` `[Preloader.Entrypoint]` block |
| 10 | Is `Macheim -> Config` really `BepInEx/config/`? | **Yes.** `config_editor.rs:42` lists `*.cfg` in `game_root/BepInEx/config`. Profiles are stored out of tree in `~/Library/Application Support/com.macheim/profiles/<name>/BepInEx/{plugins,patchers,config,plugins_disabled}` and **copied in and out of the game root on switch** (`SYNC_DIRS` includes `config`), so the active profile's cfgs always are the game-root ones. The bundle README and the page are both correct. | `config_editor.rs`, `profile_manager.rs` at tag v1.1.0 |
| 11 | Bundle contents vs pack v19 | **Byte-for-byte correct.** A dry-run rebuild at the v19 pins (`--paths 1.7.1 --companion-client 0.4.5 --vplus 10.1.1 --bepinex 5.4.2350 --unshamed 1.0.2 --plant 1.21.2 --no-azu --fallback off`) produces the same file list and the same byte sizes as the shipped zip, including `org.bepinex.plugins.valheim_plus.cfg` (the V+ 10.x name, not `valheim_plus.cfg`). | `node scripts/build-config-bundle.mjs … --dry-run` vs `public/downloads/eilif-configs-pack-v19.zip` |
| 12 | Does the page tell Mac players to copy every cfg? | **Yes, generically and correctly**: "download the config bundle and drop its files into Macheim, Config (BepInEx/config)". That covers the Companion Client cfg and the Unshamed cfg without naming either, and the zip's own README names all of them. Nothing missing. | `app/get-started/page.tsx` step 3; bundle `README.txt` |
| 13 | ValheimPlus 10.1.1 on macOS | **No Windows-only bits.** The Thunderstore package is one managed DLL, `BepInEx/plugins/ValheimPlus.dll`; the only native reference in it is `mscoree.dll`, the standard managed-PE stub every .NET assembly carries. The fork's README has Windows and Linux/Unix install sections only because those describe the standalone BepInEx zips, not the Thunderstore package. `INSTALL.md:31` defers Unix users to BepInExPack's own Linux/macOS section. 10.1.1 is current and is the build for 1.0.12 (the 10.1.0 notes give the matrix: Valheim 1.0.12 n-40 + BepInExPack 5.4.2350 + V+ 0.10.1.x, "anything else ⛔️"). | package download + `strings`; `https://github.com/Grantapher/ValheimPlus` INSTALL.md/README.md |
| 14 | PlantEverything 1.21.2 on macOS | Managed DLL, no macOS notes either way, no native deps. **1.21.2 is also the current Thunderstore latest**, so the pin and the newest agree and there is no version trap here. Note the page's CUTOVER ANCHOR comment still describes the mod as `fedorovdgap`'s fork; that is a stale comment, the config row is back on `Advize` and the page renders it correctly. | `https://thunderstore.io/api/experimental/package/Advize/PlantEverything/` |
| 15 | GsValheimStatsClient 0.2.12 path handling | **macOS-safe.** The DLL builds its one file path from BepInEx's own `Paths.ConfigPath` via `Path.Combine` (`get_ConfigPath`, `Combine` in the metadata), and the only file API it uses is `File.Exists` / `File.ReadAllLines` on `<config>/net.cproudlock.gsvalheimstatsclient.<world>.weapons.tsv`. No hard-coded separators, no `Environment.SpecialFolder`, no drive letters. Stats leave over HTTP POST, not the filesystem. | `strings` over `GsValheimStatsClient.dll` 0.2.12; its README ("edit `BepInEx/config/net.cproudlock.gsvalheimstatsclient.cfg`") |
| 16 | Unshamed 1.0.2 on macOS | Client-side Harmony patch on `Achievements.CanGetAchievements`, nothing OS-specific. Steam achievements are account-level and platform-agnostic; no source, including the 1.0.10/1.0.12 notes and Azumatt's README, treats macOS differently. The blocker Unshamed lifts is the modded/cheat flag, not the OS. | `https://thunderstore.io/c/valheim/p/Azumatt/Unshamed/` |
| 17 | The two Eilif plugins on macOS | **Clean.** Both target `net462` managed, reference only BepInEx / 0Harmony / assembly_valheim / UnityEngine as compile-time-only, and ship a single DLL. No `DllImport`, no `kernel32`/`user32`, no Windows Registry, no `Environment.SpecialFolder`, no backslash paths (the only `\\` in either tree is JSON string escaping in `EilifMapTrackerPlugin.cs:515`). The one filesystem read is `BepInEx.Paths.PluginPath` + `Directory.GetFiles` in `VPlusFallbackPatch.cs:313-315`, which is platform-neutral (its `DetectInPluginRegistry` is the BepInEx plugin registry, not the Windows one). Every Harmony patch targets a Valheim game class (Player, Character, Inventory, Piece, WearNTear, …). Network goes through `HttpClient` with `ServicePointManager.SecurityProtocol \|= Tls12`, which Mono on macOS honours. | `plugins/eilif-paths/src`, `plugins/eilif-companion-client/src`, both `.csproj` |
| 18 | Any Mac player on the server? | **No evidence in the repo.** Every `mac`/`macheim`/`macos` hit across `docs/`, `config/`, `lib/`, `scripts/`, `services/`, `db/` and `pilot-staging/` is about the install path or the bundle build, never about a person. The only mention of a physical Mac is `docs/SPEC-2026-07-05-angler-milestones.md:4`, pointing at Charlie's own Obsidian vault. The Mac path looks speculative rather than in use. | `grep -ri` across the repo |

---

## Problems found on the page, and what was done

### 1. The download button was five months stale (**fixed**)

`MACHEIM_APPLE_SILICON_URL` pointed at `v1.0.1/Macheim_1.0.1_aarch64.dmg`, published 2026-04-10.
v1.1.0 shipped 2026-09-06. Worse than "old": v1.0.1 is on the wrong side of the 2026-09-04 config
editor fix, and the Config view is load-bearing on this path. Bumped to
`v1.1.0/Macheim_1.1.0_aarch64.dmg`, verified 200 at 5,761,104 bytes before shipping, per the
warning comment already in the file.

The Intel copy ("take the Intel build from All downloads") stays correct and names no filename,
which is right: upstream's own v1.0.1 notes tell Intel readers to download `x86_64.dmg`, and no
such asset has ever existed. The file is `Macheim_<ver>_x64.dmg`. Noted in the comment.

### 2. The Gatekeeper step was backwards, and said something untrue (**fixed**)

The page said Macheim "is not signed" and made `xattr -cr` the required first move, with Open
Anyway as the fallback. As of v1.1.0 the app is **ad-hoc signed but not Apple-notarised**, and
upstream's instruction is the other way round: try System Settings, Privacy and Security, Open
Anyway first, and only reach for `xattr -cr` if macOS calls the app damaged and offers no Open
Anyway. Teaching a player to strip quarantine as step one, on an unsigned-looking download, is
also the wrong habit. Reordered, and the same reorder applied to the "It won't run on my Mac"
troubleshooting entry so the two do not contradict each other.

### 3. The checklist tells Mac players to install BepInEx twice (**fixed in copy**)

`MAC_MODS` is `checklistFrom(CLIENT_MODS)` and `BepInExPack Valheim` is a `clientRequired` row, so
it renders as a checklist line with a Thunderstore link, under a heading that says "Open the Mods
tab and install these N". On the r2modman paths that is right. On this path step 2 already
installed it, and Macheim's Install BepInEx button downloads the same Thunderstore package into
the game folder with the macOS entrypoint patch applied. A player who follows the table literally
would lay the Windows-shaped pack over the macOS loader.

Fixed in copy, not at source: the table stays derived (per `docs/PACK.md` and the CUTOVER ANCHOR,
that is deliberate), and a short line under it now says the loader row is the step-2 one, is a
version check here, and must not be installed again from the Mods tab.

### 4. Nothing on the page admitted the loader is untested on 1.0 (**fixed**)

Added a one-line caveat to step 2 pointing failures at Discord rather than at improvisation. This
is the honest statement of finding 3 in the table, and it is the difference between a Mac player
filing a report and a Mac player hand-installing DLLs until the version check refuses them.

### 5. Mac-only launch detail was missing (**added**)

Step 4's success condition is the shared one ("BepInEx console text in the corner"). On macOS,
Play Modded opens **Terminal.app** and runs the game from it; that window is the loader and
closing it ends the session. Added as a muted line so nobody tidies it away mid-raid.

---

## Standing risks, not fixed here

- **Macheim has never been run against Valheim 1.0.12 by anyone we can cite.** This is the whole
  Mac path's single point of failure and no amount of copy fixes it. Someone has to try it.
- **Unshamed drift.** The pack pins **1.0.2**; Thunderstore's latest is **1.0.4**, published
  2026-09-13. Macheim's mod install takes an explicit version argument (`install_mod(version)`),
  so the pin is reachable in principle, but a one-click install from the browser gets the newest.
  Unshamed is not server-enforced, so this locks nobody out, it just means the Mac player is not
  running what the pack says. Every other pin (V+ 10.1.1, PlantEverything 1.21.2,
  GsValheimStatsClient 0.2.12, both Eilif plugins) currently equals Thunderstore's latest, so
  Unshamed is the only live version trap on this path today.
- **Possible BepInEx downgrade via dependency resolution.** `GsValheimStatsClient 0.2.12` and
  `EilifPaths 1.7.1` still declare `denikson-BepInExPack_Valheim-5.4.2333` as their dependency,
  while everything else declares 5.4.2350. Macheim's resolver matches the exact dependency version
  and only skips packages already in its installed set (`dependency_resolver.rs:88`,
  `:105-110`). Whether the Install BepInEx button registers `denikson-BepInExPack_Valheim` in that
  installed set is not determinable from the source alone. If it does not, the first mod installed
  would pull 5.4.2333 over 5.4.2350. Cheap to check on a Mac: install the mods, then read the
  version Macheim reports for BepInEx.
- **Profiles.** If a Mac player has more than one Macheim profile, the config bundle must be
  dropped in while the right profile is active, because switching copies `config` in and out of
  the game root. The page does not mention profiles at all. Left alone, since the page also never
  tells anyone to make a second one.
- **Bundle cosmetic.** `net.eilif.companionclient.cfg` in the v19 zip still carries the header
  `## Settings file was created by plugin Eilif Companion Client v0.1.0` while the pin is 0.4.5.
  BepInEx rewrites that header on first run, so it is harmless, but it comes from
  `scripts/pack-templates/config/net.eilif.companionclient.cfg.tmpl` and will keep reappearing.
- **Stale comments in `page.tsx`.** The `CONFIG_BUNDLE_URL` comment still talks about "the v14 zip"
  and "the v15 build going out", and CUTOVER ANCHOR note 5 still describes PlantEverything as
  `fedorovdgap`'s fork. Neither renders. Left as-is to keep this edit minimal, but they will
  mislead whoever mints v20.

---

## Could not be verified without a Mac

Everything here is a source-and-API reading. None of it is a run.

1. That Macheim v1.1.0 detects a Valheim 1.0.12 install at all, or that Install BepInEx succeeds
   against it.
2. That the modded game actually launches and loads the plugins on 1.0.12, i.e. that
   `arch -x86_64` + `DYLD_INSERT_LIBRARIES` still hooks the 1.0 Unity build.
3. That the server's version check passes for a Mac client (V+ and PlantEverything both have
   `enforceMod` on), and therefore that a Mac player can actually join.
4. Whether Macheim's Mods tab exposes a version picker, or only installs the newest. The Rust API
   takes a version; the UI was not read.
5. Whether Install BepInEx registers in the installed-mods set, which is what decides the 5.4.2333
   downgrade risk above.
6. That the config editor actually renders our seven cfgs, in particular the 202 KB
   `org.bepinex.plugins.valheim_plus.cfg`.
7. That GsValheimStatsClient and the Companion Client actually POST from a Mac client, i.e. that
   Mono's TLS on macOS completes the handshake to the Vercel ingest endpoint.
8. That Steam achievements are granted on the macOS build with Unshamed active.
9. The pink-shader claim in step 4, which predates this review and was not re-checked. Macheim
   v1.1.0 ships a shader compatibility catalog, but it is pinned to Valheim 0.221.12 and to two
   mods we do not run, so it does nothing for us either way.
10. Whether the BepInEx console output is legible in the Terminal window Macheim opens (the bundle
    sets `ForceBepInExTTYDriver = true`, which is the Unix path, but that was not seen running).
