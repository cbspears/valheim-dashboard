# Rebuild-at-1.0 procedure (server-side plugin)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore (`dotnet restore --source /dev/null`) succeeds in <1s — the
`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package is already in the local cache, so a
launch-day rebuild needs **no network access** for NuGet. Full build (`dotnet build -c Release`)
takes under 2s.

## Deploying **0.3.1** (built 2026-09-04, staged, NOT uploaded)

`dist/EilifCompanion.dll` is now **0.3.1**: both the `[EILIF_OATH]` and `[EILIF_CHAT]` captures moved
off the dead `Chat.RPC_ChatMessage` postfix onto the `Chat.OnNewChatMessage` **Prefix** that the
`/pin` capture already proves works here (audit voice-6 — this is what stops oaths being stored
SHOUT-UPPERCASED), and every Harmony patch class is now applied in its own try/catch with an
explicit count (audit plugins-6). **ValheimPlus `[Chat]` stays ENABLED** — it is what makes `/s`
shouts carry server-wide — and no server config changes: V+'s patch throws inside
`Chat.AddInworldText`, which `OnNewChatMessage` calls from its *body*, so our Prefix has already
written its marker line before the NRE fires. No config keys changed and no marker-line format
changed, so the log poller needs no matching edit. **The GTX host is Windows and a loaded plugin DLL is
file-locked**, so this swap only works inside a stopped window: **Panel Stop** → SFTP-upload
`dist/EilifCompanion.dll` over `<nest>/BepInEx/plugins/EilifCompanion/EilifCompanion.dll` (retrying
upload — the lock can linger a few seconds after the process exits) → **Panel Start** (Stop → Start,
never Restart) → then grep `LogOutput.log` for **`Eilif Companion 0.3.1`** (the version actually
loaded) and for **`[Eilif] patch classes applied: 2/2`** (both hooks on; anything else means read the
`[Eilif] could not apply <Class>: <message>` lines above it). Finally have someone shout
`/s /oath I will hold the north` and confirm a raw-case `[EILIF_OATH] <Name> | I will hold the north`
line appears — mixed case is the proof the new hook is live, since the old echo path could only ever
produce capitals. Fold this into the same stopped window as the 1.0 rebuild if one is coming.

## Launch-day sequence — do these BEFORE `refresh-libs.sh` (added 2026-09-04, audit plugins-9)

`refresh-libs.sh` copies the game DLLs out of the **local Steam client install**
(`~/snap/steam/.../Valheim/valheim_Data/Managed`). That install has `AutoUpdateBehavior 0`, i.e. it
only updates while Steam is running — so on launch day it is entirely possible to rebuild every
plugin against the **0.221.12** assemblies and ship them to a **1.0** server. Nothing in the build
catches that; the symptom is eight plugins that silently fail to load.

1. **Launch Steam and confirm Valheim shows the 1.0 build** before touching `refresh-libs.sh`.
   Let the download finish; check the build id in Steam → Valheim → Properties → Updates.
2. **Prove the server is on the same build.** SFTP-get the box's
   `valheim_server_Data/Managed/assembly_valheim.dll` and md5-compare it with the local
   `valheim_Data/Managed/assembly_valheim.dll`:

   ```bash
   md5sum ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
   # and the box's copy, fetched read-only:
   #   sshpass -e sftp ... <<< 'get <nest>/valheim_server_Data/Managed/assembly_valheim.dll /tmp/srv.dll'
   md5sum /tmp/srv.dll
   ```

   Client and dedicated-server builds are not always byte-identical across the whole Managed dir,
   but `assembly_valheim.dll` is the one this plugin compiles against — a mismatch there means the
   two are on different game builds and the rebuild is pointed at the wrong target. Stop and
   reconcile before compiling.
3. Only then run the build sequence below.

## Exact sequence, once the 1.0 game DLLs are live

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
cd plugins/eilif-companion
./refresh-libs.sh              # re-copies assembly_valheim.dll etc. from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifCompanion.dll (intended — that's the deployable artifact)
```


## Deploying a rebuilt server DLL (the DLL is file-locked while the server runs)

The GTX host is Windows: a loaded plugin DLL cannot be overwritten in place. The swap only works
inside a stopped window, and it must be the same window as the game update:

1. **Panel Stop.**
2. Upload every rebuilt server-side DLL over SFTP (retrying-upload pattern — the lock can linger a
   few seconds after the process exits).
3. Do the rest of the stopped-window work at the same time (world upload, `Start.bat` fields,
   `worlds_local` sweep, V+ / WebMap cfg edits) — see `docs/LAUNCH-WIPE.md`.
4. **Panel Start** (Stop → Start, never Restart).
5. `bash scripts/verify-restart.sh <World>` — the Valheim version line, the plugin list, and the
   plugin's own boot line are the proof it loaded against the new build. Then verify per
   `README.md` "What MUST be validated on the live server" — especially the `ChatMessage` RPC
   param order, which Iron Gate may have changed in 1.0, and the `[EILIF_KEY]` world-key lines.
6. **Only then re-mint the modpack.** Minting before the server is proven up means publishing a
   pack code that pins DLLs nobody has confirmed load.

## Gotchas confirmed during this warm-check

- **`dotnet build -o <other-dir>` still overwrites `dist/`.** The csproj's `CopyToDist` MSBuild
  target (`AfterTargets="Build"`) unconditionally copies `$(TargetPath)` into the project's own
  `dist/` regardless of `-o`. For a normal rebuild this is exactly what you want (dist/ IS the
  deployable artifact) — it only matters if you're doing a scratch/throwaway build and want to
  avoid touching the tracked file (in which case `git checkout -- dist/EilifCompanion.dll`
  afterward is the fix, not `-o`).
- **`System.ValueTuple` must never be used** (target is `net462`; BepInEx/Unity Mono ships no
  `System.ValueTuple` reference, so a tuple literal or tuple-typed field in the plugin's `Awake`
  path causes a **silent** plugin load failure — no exception surfaces, the plugin just never
  registers). This project's source (`src/*.cs`) does **not** currently reference tuples, so no
  action needed — but if you add one during a post-1.0 patch, don't. (The sibling `eilif-paths`
  plugin has a source-level comment on this same gotcha; it isn't otherwise written down here or
  in `eilif-companion-client`, hence this note.) **v0.2.1 adds a matching source comment** on the
  voice-pump state block in `src/EilifCompanionPlugin.cs` so the constraint is visible where the
  next edit is most likely to land.
- **Line pacing is config, not code (since v0.2.1).** The `Update()` pump speaks at most one queued
  line per `Voice.LineSpacingSeconds` (default 20, range 5–300) instead of draining the whole queue
  in one frame — center-screen messages used to overwrite each other when a poll returned 2–3 lines.
  Tunable live in `BepInEx/config/media.blockspace.eilif.companion.cfg` on the server, no rebuild
  needed; the queue holds the backlog, nothing is dropped. This is the plugin-side floor only —
  the dashboard/bot side owns the *semantic* gaps (ambient 30 min, deeds 10 min).
- Build-only warnings (`MSB3277` reference-conflict-resolution, ~30 lines) are expected and benign
  — they come from targeting `net462` via the `Microsoft.NETFramework.ReferenceAssemblies` package
  under a newer SDK, not from anything wrong with this project.
