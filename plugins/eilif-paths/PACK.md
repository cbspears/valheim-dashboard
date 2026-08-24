# Adding EilifPaths to the pinned r2modman pack (and removing the old Useful_Paths)

`EilifPaths.dll` is a **local custom DLL** — a modern replacement for the broken Thunderstore
mod **Menthus-Useful_Paths**. It gives the same speed / stamina bonuses on dirt paths, paved
roads, and built floors, but detects terrain the way *current* Valheim actually stores it
(Heightmap paint mask), so paths and roads work again. Since **1.2.0** it also extends the bed's
"needs a fire nearby" check by 8 m (`[Bed] extraFireRange`, `0` = vanilla), and since **1.3.0** it
extends the station↔upgrade attachment reach by 10 m at **every** crafting station
(`[Workstation] extraAttachmentRange`, `0` = vanilla). Since **1.4.0** the stamina discount applies
to movement only: tools and weapons cost vanilla stamina on dirt paths and paved roads and nothing
on built floors (`actionstamina`, below).

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
   - **Version:** `1.4.0`
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

| Surface   | movement | staminadrain | actionstamina |
|-----------|----------|--------------|---------------|
| Path      | 1.4      | 0.25         | 1             |
| PavedRoad | 1.4      | 0.25         | 1             |
| Wood      | 1.4      | 0.25         | 0             |
| Stone     | 1.4      | 0.25         | 0             |
| Iron      | 1.4      | 0.25         | 0             |
| HardWood  | 1.4      | 0.25         | 0             |

`movement` = speed multiplier (>1 faster). `staminadrain` = stamina-cost multiplier for ordinary
movement — running, jumping, swimming, dodging, being encumbered (<1 cheaper). `actionstamina` =
stamina-cost multiplier for tools and weapons — attacks, blocking, bow draw, building, hoe and
cultivator work, repairs, fishing (`1` = vanilla cost, `0` = free). BepInEx writes `net.eilif.paths.cfg` (sections `[Path]`, `[PavedRoad]`, …) on first launch if you
ever want to tweak per-surface; the defaults above ship with the DLL so the pack needs no pre-fill.

Two more sections, both optional and both picked up with their defaults by an existing
`net.eilif.paths.cfg` at the next launch (no pre-fill needed):

- `[Bed] extraFireRange` (default `8`): metres of extra reach for the bed's "needs a fire nearby"
  check, on top of the fireplace's own heat area. `0` restores vanilla.
- `[Workstation] extraAttachmentRange` (default `10`): metres of extra reach between a crafting
  station and its upgrades/attachments, on top of each attachment piece's own built-in distance
  (5 m for most), so about 15 m in practice. Applies to **every** station — workbench, forge, black
  forge, galdr table, artisan table — and to both halves of the rule at once (where the game lets
  you place the piece, and whether the station counts it towards its level). `0` restores vanilla.

  ⚠️ **ValheimPlus interaction:** V+'s equivalent knob is `[Workbench] workbenchAttachmentRange`,
  and V+ **sets** the field (a Harmony prefix) where EilifPaths **adds** to it (a postfix, so it
  always runs second). If someone enables V+'s `[Workbench]` section, the effective reach becomes
  `workbenchAttachmentRange + extraAttachmentRange`. In the pinned Eilif profile that section is
  `enabled = false`, so today it is just vanilla + 10.

**LevelGround is intentionally not supported.** Hoe "level ground" only edits terrain height — it
paints nothing and leaves no persistent marker in modern Valheim — so there's no reliable signal to
detect it. (The old mod's LevelGround config did nothing useful on current Valheim either.)

## Re-export the pack

1. **Profile → Export → Export as code** (or "Export as file" for a `.r2z`).
2. Share the new code / file. Players **Import** it → they get EilifPaths automatically and no
   longer get the dead Useful_Paths.

## Sanity check before sharing

Launch Valheim once from the profile, join the server, and watch `LogOutput.log`. On boot you should
see `[EilifPaths] Eilif Paths v1.4.0 loaded. … Bed fire range: +8m. Workstation attachment range: +10m.
Core patch classes: 6/6 applied.` and `[EilifPaths] tool/weapon stamina hooks: 9/9 applied.` Anything
less than `6/6` or `9/9` means a hook went missing — the ERROR line above it names which one, and the
stamina split is running degraded until it is fixed.
Then walk onto a hoe path / paved road / wooden floor — each surface change logs exactly once, e.g.:

```
[EilifPaths] terrain: PavedRoad (x1.4 speed, x0.25 movement stamina, x1 tool stamina)
[EilifPaths] terrain: Path (x1.4 speed, x0.25 movement stamina, x1 tool stamina)
[EilifPaths] terrain: None (vanilla speed/stamina)
```

Swing an axe on a paved road (vanilla stamina cost) and then on a wooden floor (no cost at all) to
check the 1.4.0 split. Note that the server-side ServersideQoL tops building and farming stamina
back up, so use a weapon, a bow or fishing to see the difference clearly.

Then walk up to a workbench and place an upgrade (chest / anvils / tanning rack) well beyond the
usual hugging distance — it should turn green and, once placed, raise the station level. The first
time each attachment prefab spawns it logs its real numbers once:

```
[EilifPaths] workstation attachment 'piece_workbench_ext1': reach 5m -> 15m.
```

If you also see the `OLD 'Useful_Paths' ... is ALSO loaded` warning block, you haven't disabled the
old mod yet — do step B.

## Notes

- **Local disk only.** If your r2modman profile lives on the NAS, build/copy on local disk
  (repo memory: NAS can't symlink). The DLL itself is fine anywhere once copied in.
- **After a Valheim patch:** rebuild the DLL (`./refresh-libs.sh` + `dotnet build -c Release`),
  re-import the new `dist/EilifPaths.dll` over the old one in the profile, re-export.
