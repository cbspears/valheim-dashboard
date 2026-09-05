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

Since **1.5.0** it also carries a **dormant ValheimPlus fallback** (`[VPlusFallback]`, ships
`Enabled = false`, applies no hooks at all until switched on): infinite fuel, station build range,
the +30% gathering / picking / loot bonuses and shared map exploration. That is the pack-v12
question, not a normal-day one — see **C** below and `README.md`.

Three jobs for the next pack export: **(A) add EilifPaths as a local mod**,
**(B) disable/remove Useful_Paths** so bonuses don't double-apply, and **(C) decide whether the
ValheimPlus fallback ships on or off.**

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
   - **Version:** `1.5.0`
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

## C. The ValheimPlus fallback — on or off for pack v12

If ValheimPlus **ships in pack v12**, leave `[VPlusFallback] Enabled = false`. Nothing to do: the
section applies no patches, and EilifPaths would refuse to apply them anyway while a
`ValheimPlus.dll` sits in the profile.

If ValheimPlus is **dropped from pack v12** (it has no 1.0 build), the crew loses infinite fuel,
30 m workbench range and +30% gathering the moment they load in. To hand those back, ship a
`net.eilif.paths.cfg` in the pack with:

```ini
[VPlusFallback]
Enabled = true
```

and leave every other key at its default — the defaults are already the live server's V+ numbers.
Confirm on the first launch that the boot log reads
`[EilifPaths] VPlusFallback patch classes: 12/12 applied.` followed by the per-feature lines.

**The minter already does this for you.** `scripts/pack-templates/config/net.eilif.paths.cfg.tmpl`
carries a `{{#FALLBACK}} [VPlusFallback] Enabled = {{PATHS_FALLBACK_ENABLED}} {{/FALLBACK}}` block,
and `scripts/mint-pack.mjs` takes `--no-vplus --fallback on --paths-cfg-version 1.5.0`. It refuses
`--fallback on` against a pin older than 1.5.0 rather than writing an inert switch. Verify with a
dry run that the rendered cfg really carries `[VPlusFallback] Enabled = true` before minting; there
is nothing left to hand-edit in the template.

### What dropping V+ still costs, even with the fallback on

Three items are **not restored and are not a loss**, by design: `[Map] exploreRadius` (vanilla is
already 100, the same number V+ used), `[Map] shareAllPins` (dead code in V+ 0.9.17.1 — its
pin-sharing hook is gated on a list that is never populated, so pins are not being shared today),
and the 10-player cap (genuinely server-side; it lives in Eilif Companion's `[ServerFallback]`).

But five **enabled** V+ sections with real non-default settings are simply gone, and this is the
part that is easy to read past. Full table with the exact keys is in `README.md` under
[Not reproduced, and these ones are a real loss]; the short version:

| V+ section | Gone with V+ |
|---|---|
| `[Bed] sleepWithoutSpawn` | sleeping in a bed you have not claimed (group sleep) |
| `[Building] enableAreaRepair` + `areaRepairRadius = 7.5` | one hammer swing repairing a 7.5 m radius |
| `[Building] noWeatherDamage` | rain and water erosion stop being harmless |
| `[Building] alwaysDropResources` (+ excluded) | full material return on deconstruct |
| `[Building]` placement | build reach 12 → vanilla 5, comfort radius 20 → vanilla 10, no free-placement |
| `[Camera]` | zoom 100 → vanilla 6, FOV 75 → vanilla 65 |
| `[Items] itemsFloatInWater` | dropped items sink again |
| `[GridAlignment]` | LeftAlt snap-to-grid, F7 / F6 |

Ranked by what gets noticed first: **area repair**, **no weather damage**, **sleep-without-spawn**.
Each is a small client-side patch of the same shape as the ones already shipped, so a 1.5.1 could
add them; none was built two days before launch on a guess. Charlie's call.

Not a loss despite looking like one: `[Chat] forcedCase = true` makes V+ *return early* out of its
case transpiler, so shouts arrive uppercase today and will still arrive uppercase without V+.

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
see `[EilifPaths] Eilif Paths v1.5.0 loaded. … Bed fire range: +8m. Workstation attachment range: +10m.
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
