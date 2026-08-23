# Rebuild-at-1.0 procedure (server-side plugin)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore (`dotnet restore --source /dev/null`) succeeds in <1s — the
`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package is already in the local cache, so a
launch-day rebuild needs **no network access** for NuGet. Full build (`dotnet build -c Release`)
takes under 2s.

## Exact sequence, once the 1.0 game DLLs are live

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
cd plugins/eilif-companion
./refresh-libs.sh              # re-copies assembly_valheim.dll etc. from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifCompanion.dll (intended — that's the deployable artifact)
```

Then deploy:
1. SFTP `dist/EilifCompanion.dll` into the server's `BepInEx/plugins/` (see project runbook for
   host/creds — GTXGaming panel).
2. Restart the server from the GTXGaming panel.
3. Verify per README.md "What MUST be validated on the live server" (esp. the `ChatMessage` RPC
   param order — Iron Gate may have changed it in 1.0).

**⚠️ GTX server status note (as of the 2026-08-20 readiness review):** the game server has been
down since 08-15 with no liveness detection wired up. Confirm the server is actually reachable
before assuming step 2/3 above will work — see the tracker's readiness review before the 1.0 boot.

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
