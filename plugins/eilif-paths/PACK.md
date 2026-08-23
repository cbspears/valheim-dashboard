# Adding EilifPaths to the pinned r2modman pack (and removing the old Useful_Paths)

`EilifPaths.dll` is a **local custom DLL** — a modern replacement for the broken Thunderstore
mod **Menthus-Useful_Paths**. It gives the same speed / stamina bonuses on dirt paths, paved
roads, and built floors, but detects terrain the way *current* Valheim actually stores it
(Heightmap paint mask), so paths and roads work again.

Two jobs for the next pack export: **(A) add EilifPaths as a local mod**, and
**(B) disable/remove Useful_Paths** so bonuses don't double-apply.

## Files you need

- `dist/EilifPaths.dll` (built by `dotnet build -c Release` in this folder)
- No config file is required — the owner's chosen defaults are baked in (see below).

## A. Import EilifPaths as a local mod

1. Open r2modman / Thunderstore Mod Manager → select the **Eilif** profile (the one with
   ValheimPlus, GsValheimStatsClient, EilifCompanionClient, etc.).
2. **Settings → Import local mod** (under "Profile"/"Locations" depending on version).
3. Choose `dist/EilifPaths.dll`. When prompted:
   - **Name:** `EilifPaths`
   - **Author:** `BlockspaceMedia` (or any — local mods aren't namespaced on Thunderstore)
   - **Version:** `1.1.0`
   The manager copies the DLL into `<profile>/BepInEx/plugins/EilifPaths/`.
4. **Enable** it, keep BepInEx + the other Eilif mods enabled.

## B. Remove the old Useful_Paths (IMPORTANT — do this before exporting)

Both mods touch the same jog/run/stamina hooks, so running them together **double-applies** the
bonus on built floors. EilifPaths detects this at launch and logs a loud warning (and cedes floors
to the old mod to limit the damage), but the correct fix is to turn the old one off:

- In the r2modman mod list, find **Useful_Paths** (Menthus) → click **Disable** (or the trash icon
  to remove it entirely). The manager updates `mods.yml` and moves the plugin out of the load path
  for you — do this in the UI, don't hand-edit `mods.yml`.
- Then **re-export** the profile. The old mod will no longer be part of the pack.

> Do NOT just delete the `Menthus-Useful_Paths` folder on disk — it's an online-sourced mod, and
> r2modman may re-download it on the next sync. Use the UI Disable/Remove button instead.

## The baked-in defaults (no config needed)

| Surface   | movement | staminadrain |
|-----------|----------|--------------|
| Path      | 1.25     | 0            |
| PavedRoad | 1.25     | 0            |
| Wood      | 1.25     | 0            |
| Stone     | 1.25     | 0            |
| Iron      | 1.25     | 0            |
| HardWood  | 1.25     | 0            |

`movement` = speed multiplier (>1 faster). `staminadrain` = stamina-cost multiplier (<1 cheaper).
BepInEx writes `net.eilif.paths.cfg` (sections `[Path]`, `[PavedRoad]`, …) on first launch if you
ever want to tweak per-surface; the defaults above ship with the DLL so the pack needs no pre-fill.

**LevelGround is intentionally not supported.** Hoe "level ground" only edits terrain height — it
paints nothing and leaves no persistent marker in modern Valheim — so there's no reliable signal to
detect it. (The old mod's LevelGround config did nothing useful on current Valheim either.)

## Re-export the pack

1. **Profile → Export → Export as code** (or "Export as file" for a `.r2z`).
2. Share the new code / file. Players **Import** it → they get EilifPaths automatically and no
   longer get the dead Useful_Paths.

## Sanity check before sharing

Launch Valheim once from the profile, join the server, and watch `LogOutput.log`. On boot you should
see `[EilifPaths] Eilif Paths v1.0.0 loaded.`. Then walk onto a hoe path / paved road / wooden
floor — each surface change logs exactly once, e.g.:

```
[EilifPaths] terrain: PavedRoad (x1.75 speed, x0 stamina)
[EilifPaths] terrain: Path (x1.5 speed, x0 stamina)
[EilifPaths] terrain: None (vanilla speed/stamina)
```

If you also see the `OLD 'Useful_Paths' ... is ALSO loaded` warning block, you haven't disabled the
old mod yet — do step B.

## Notes

- **Local disk only.** If your r2modman profile lives on the NAS, build/copy on local disk
  (repo memory: NAS can't symlink). The DLL itself is fine anywhere once copied in.
- **After a Valheim patch:** rebuild the DLL (`./refresh-libs.sh` + `dotnet build -c Release`),
  re-import the new `dist/EilifPaths.dll` over the old one in the profile, re-export.
