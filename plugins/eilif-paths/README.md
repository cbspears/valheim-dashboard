# EilifPaths

A modern, drop-in replacement for the broken **Menthus "Useful Paths"** mod
(`Menthus-Useful_Paths` 1.0.5.0, 2021). Client-side BepInEx plugin for the Eilif Valheim server.

Players move faster and spend less stamina while on dirt paths, paved roads, and built floors —
exactly like the old mod — but detection uses the terrain API *current* Valheim actually uses, so
paths and roads work again.

Since **1.4.0** the stamina discount only covers *movement*. Tools and weapons cost vanilla stamina
on dirt paths and paved roads, and nothing at all on built floors (see
[Tool and weapon stamina](#tool-and-weapon-stamina-140)).

It also carries two unrelated quality-of-life patches: beds accept a fire much further away
(**1.2.0**, see [Bed fire range](#bed-fire-range-120)) and crafting-station upgrades attach from
much further out at *every* station (**1.3.0**, see
[Workstation attachment range](#workstation-attachment-range-130)).

Since **1.5.0** it also carries a dormant stand-in for the ValheimPlus comforts, for the day
ValheimPlus is not in the pack — infinite fuel, station build range, the gathering and picking
bonuses, shared map exploration. It ships **off** and applies no hooks at all until it is switched
on. See [ValheimPlus fallback](#valheimplus-fallback-150).

## Why the old mod broke

Useful Paths detected dirt/paved terrain with
`TerrainModifier.FindClosestModifierPieceInRange(pos, 6f)`. Modern Valheim no longer leaves
persistent per-hoe `TerrainModifier` pieces lying on the ground — terrain paint is baked into each
`Heightmap`'s `m_paintMask` texture. So that lookup returned null and only built floors (found via
`WearNTear`) still got a bonus. Dirt paths and paved roads silently did nothing.

## How EilifPaths detects the ground (polled every 0.4s, cheap)

1. **Built floors** — `Player.GetLastGroundCollider()` → `WearNTear.m_materialType`
   (`Wood` / `Stone` / `Iron` / `HardWood`). Unchanged from the old mod; still valid.
2. **Terrain paint** — `Heightmap.FindHeightmap(pos)`, then read the paint-mask pixel under the
   player (`WorldToVertexMask` + `GetPaintMask(x,y)`), matching the game's own `IsCleared()`
   sampling. The channels are defined by the game as:
   - `Heightmap.m_paintMaskDirt`  = **(1,0,0,1)** → red   → **Path** (hoe dirt path)
   - `Heightmap.m_paintMaskCultivated` = (0,1,0,1) → green → cultivated farmland (ignored)
   - `Heightmap.m_paintMaskPaved` = **(0,0,1,1)** → blue  → **PavedRoad** (paved road)

   So: **blue > 0.5 ⇒ PavedRoad, else red > 0.5 ⇒ Path.** Paved wins over dirt (a paved tile is
   painted blue over any dirt).

**LevelGround is not supported** — leveling ground only edits heights, it paints nothing and leaves
no persistent marker, so there's no reliable way to detect it. Dropped intentionally.

## Effect surface (same Harmony hooks as the old mod)

- `Player.GetJogSpeedFactor` postfix — multiply result by the surface's `movement`.
- `Player.GetRunSpeedFactor` postfix — multiply result by the surface's `movement`.
- `Player.UseStamina` prefix — multiply the stamina cost by the surface's `staminadrain`
  (movement) or `actionstamina` (tools and weapons, 1.4.0 — see below). Local player only.
- `Character.UpdateWalking` prefix/postfix — the jog/run factors don't affect *walking*
  (walk uses `m_walkSpeed` directly), so for the local player we **multiply** `m_walkSpeed` by
  `movement` and **restore it** in the postfix. We do not hard-set it: modern vanilla `m_walkSpeed`
  is ~5 (it was 1.6 in 2021, which is why the old mod's `m_walkSpeed = 1.6f * mult` would *slow*
  walking today). State is never permanently mutated and reverts cleanly off-path.
- `Bed.CheckFire` prefix (1.2.0) — re-runs the vanilla heat lookup with an extra radius; falls
  through to the untouched original on no-match or any error. See below.
- `StationExtension.Awake` postfix (1.3.0) — widens that instance's `m_maxStationDistance`, the one
  field every station-attachment distance check reads. See below.
- Nine prefix/finalizer pairs (1.4.0) that mark "a tool or weapon charge is being paid right now",
  applied individually at load so one unresolvable target can't take the plugin down. Full list and
  reasoning in `src/ToolStaminaPatch.cs`. See below.

Every one of the attribute-declared classes above is applied on its own at load (`CreateClassProcessor`
per class, not a bare `PatchAll`), and the tool/weapon hooks are applied after that unconditionally.
A bare `PatchAll` aborts the whole batch on the first unresolvable target, which could leave the
`UseStamina` prefix installed while the tool/weapon hooks never went on — i.e. tools silently keeping
the movement discount, the one outcome this version exists to prevent. Both counts are printed on the
boot line (see "Verifying in-game").

## Config (baked-in defaults, no pre-fill needed)

`net.eilif.paths.cfg`, sections named per surface, keys `movement` / `staminadrain` /
`actionstamina`:

| Surface   | movement | staminadrain | actionstamina |
|-----------|----------|--------------|---------------|
| Path      | 1.4      | 0.25         | 1             |
| PavedRoad | 1.4      | 0.25         | 1             |
| Wood      | 1.4      | 0.25         | 0             |
| Stone     | 1.4      | 0.25         | 0             |
| Iron      | 1.4      | 0.25         | 0             |
| HardWood  | 1.4      | 0.25         | 0             |

`movement` = speed multiplier (>1 faster). `staminadrain` = stamina-cost multiplier for ordinary
movement (running, jumping, swimming, dodging, being encumbered). `actionstamina` = stamina-cost
multiplier for tools and weapons (1 = vanilla, 0 = free).

Plus two non-surface sections: `[Bed] extraFireRange` = `8` and
`[Workstation] extraAttachmentRange` = `10` (see below), and the dormant
[`[VPlusFallback]`](#valheimplus-fallback-150) section.

## Tool and weapon stamina (1.4.0)

Up to 1.3.0 there was one multiplier for everything, so swinging an axe or holding a bow drawn on a
road was as cheap as running along it. 1.4.0 splits the two. `Player.UseStamina` sees every charge
but not *why* it is being paid, so the (closed, decompile-verified) set of vanilla methods that
charge tool/weapon stamina is wrapped: a Harmony **prefix** opens a context, a Harmony **finalizer**
closes it. A finalizer rather than a postfix, because it also runs on an early return or an
exception, so the context can never be left stuck open. It is a depth counter, not a flag, because
`Player.Repair` nests inside `Player.UpdatePlacement` and `Attack.FireProjectileBurst` nests inside
`Attack.Update`. While the depth is above zero the charge takes `actionstamina`; otherwise it takes
`staminadrain`.

Wrapped: `Attack.Update`, `Attack.FireProjectileBurst`, `Humanoid.BlockAttack`,
`Player.UpdatePlacement` (building, piece removal, **and** the hoe and cultivator — terrain work is
an ordinary piece placement), `Player.Repair`, `Player.UpdateAttackBowDraw`,
`Player.UpdateActionQueue` (crossbow reload), `FishingFloat.FixedUpdate`,
`SE_Harpooned.UpdateStatusEffect`. Deliberately not wrapped: `Attack.Start` and friends (they only
pre-check, they never charge), `Sadle.UpdateRiding` (that is the mount's own stamina), and
`SE_Stats.UpdateStatusEffect` (a generic status-effect drain, neither movement nor a tool, so it
keeps its old behaviour). `Character.HaveStamina` is **not** patched: with `actionstamina = 0` a
swing is free but still needs the vanilla amount in the bar to start, and `HaveStamina` also drives
the empty-bar flash, the projectile stop, fishing-line loss and harpoon release.

Each hook is applied on its own inside try/catch and logged, so a future game update that renames a
private method shows up as an error in `LogOutput.log` instead of silently handing the movement
discount back to tools. If any hook fails to apply, unclassified charges fall back to the larger of
the two multipliers — vanilla on paths and roads, `0.25` on floors.

## Bed fire range (1.2.0)

Vanilla requires a bed to be practically inside the fire before it will let you claim it or sleep.
Decompiled from `libs/assembly_valheim.dll` (game 0.221.12):

```csharp
private bool CheckFire(Player human)
{
    if (!EffectArea.IsPointInsideArea(base.transform.position, EffectArea.Type.Heat))
    {
        human.Message(MessageHud.MessageType.Center, "$msg_bednofire");
        return false;
    }
    return true;
}
```

and the API it calls:

```csharp
public static EffectArea IsPointInsideArea(Vector3 p, Type type, float radius = 0f)
{
    if (type == Type.Burning && radius.Equals(0.25f))
    {
        return GetBurningAreaPointPlus025(p);
    }
    int num = Physics.OverlapSphereNonAlloc(p, radius, m_tempColliders, s_characterMask);
    for (int i = 0; i < num; i++)
    {
        EffectArea component = m_tempColliders[i].GetComponent<EffectArea>();
        if ((bool)component && (component.m_type & type) != 0)
        {
            return component;
        }
    }
    return null;
}
```

`Bed.CheckFire` omits the radius, so `radius = 0` and the OverlapSphere degenerates into a point
test: the bed's origin has to fall inside the fireplace's own `Heat` trigger collider. EilifPaths
patches `Bed.CheckFire` with a Harmony **prefix** that re-runs the same call with a configurable
extra radius. Because the parameter simply widens the sphere, the patch is purely additive — it can
only accept more spots than vanilla, never fewer.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `[Bed]` | `extraFireRange` | `8` | Metres added on top of the fireplace's own heat area. `0` = vanilla. |

**Why 8 m.** The campfire's `Heat` collider radius lives in the prefab (Unity asset data), not in
`assembly_valheim.dll`, so it can't be quoted from a decompile — it is a small collider on the order
of a few metres. 8 m extra guarantees at least double the reach for any hearth whose heat collider
is 8 m or smaller (all of them are), and for a campfire in the 3–5 m range works out to roughly
2.5–3.5×. Every successful extended check logs the real numbers so the default can be retuned from
evidence:

```
[EilifPaths] bed fire check passed with +8m: heat source 'FireWarmth' at 6.42m, its own heat radius 4m.
```

The whole prefix is inside a `try/catch` and every non-match / error path returns control to the
untouched vanilla method (which shows its own `$msg_bednofire`), so bed interaction can't break.
The check is client-side, so it only affects the beds of players running the mod.

## Workstation attachment range (1.3.0)

Vanilla gives a station upgrade roughly 5 m to reach its station, so chests, anvils, tanning racks
and the rest end up crammed against the bench. ValheimPlus has a knob for this but it lives under
`[Workbench]`; this patch is generic and covers **every** crafting station.

### Why one hook covers both sides

Decompiled from `libs/assembly_valheim.dll` (game 0.221.12). There is exactly **one** distance value
in the game that gates station attachments, and it lives on the **extension**, not on the station:

```csharp
public class StationExtension : MonoBehaviour, Hoverable
{
    public CraftingStation m_craftingStation;
    public float m_maxStationDistance = 5f;
    ...
}
```

**Station side** — the station enumerating/counting its attachments, i.e. what raises its level:

```csharp
public static void FindExtensions(CraftingStation station, Vector3 pos, List<StationExtension> extensions)
{
    foreach (StationExtension allExtension in m_allExtensions)
    {
        if (Vector3.Distance(allExtension.transform.position, pos) < allExtension.m_maxStationDistance
            && allExtension.m_craftingStation.m_name == station.m_name
            && (allExtension.m_stack || !ExtensionInList(extensions, allExtension)))
        {
            extensions.Add(allExtension);
        }
    }
}
```

reached from `CraftingStation.GetExtensions()` → `GetExtentionCount()` → `GetLevel()`. Note what is
**not** there: `CraftingStation` has no distance constant of its own for attachments. Its own numbers
(`m_discoverRange` 4, `m_rangeBuild` 10, `m_useDistance` 2, `m_extraRangePerLevel`) govern discovery,
the build radius and the interact distance — none of them gate whether an extension attaches. **The
station side reads the extension's field.** That is why there is no second constant to patch in
tandem: one field, both sides.

**Extension side** — placement validity, from `Player.UpdatePlacementGhost()`:

```csharp
StationExtension component2 = component.GetComponent<StationExtension>();
if (component2 != null)
{
    CraftingStation craftingStation = component2.FindClosestStationInRange(point);
    if ((bool)craftingStation) { component2.StartConnectionEffect(craftingStation); }
    else { component2.StopConnectionEffect(); m_placementStatus = PlacementStatus.ExtensionMissingStation; }
    ...
}
```

and the instance methods it calls, which read the same field again:

```csharp
public List<CraftingStation> FindStationsInRange(Vector3 center)
{
    List<CraftingStation> list = new List<CraftingStation>();
    CraftingStation.FindStationsInRange(m_craftingStation.m_name, center, m_maxStationDistance, list);
    return list;
}

public CraftingStation FindClosestStationInRange(Vector3 center)
{
    return CraftingStation.FindClosestStationInRange(m_craftingStation.m_name, center, m_maxStationDistance);
}
```

### The hook

A Harmony **postfix on `StationExtension.Awake`** that *adds* the configured metres to that
instance's `m_maxStationDistance`. Every consumer above then sees the wider range, so placement
validity, the station's extension count/level and the connection beam all move together: a piece the
game lets you place is always a piece the station actually counts.

- **Per instance, never the prefab.** `Awake` runs once per spawned object and never on the shared
  prefab asset, so the bump cannot accumulate.
- **Generic.** It keys off `StationExtension`, not off any station name, so workbench, forge, black
  forge, galdr table, artisan table and anything a future update adds are covered with no list.
- **The placement ghost is covered.** `Player.SetupPlacementGhost()` does
  `Instantiate(selectedPrefab)` with `ZNetView.m_forceDisableInit = true`, so the ghost's `Awake`
  runs (its vanilla body early-returns because `GetZDO()` is null, which does not stop a postfix).
- **Additive, not absolute.** `m_maxStationDistance` is authored per prefab; a flat assignment would
  silently *shrink* any extension whose default is larger. Adding can only widen — the same
  "can only accept more" property the bed patch is built on.

| Section | Key | Default | Meaning |
|---|---|---|---|
| `[Workstation]` | `extraAttachmentRange` | `10` | Metres added on top of each attachment piece's own built-in distance (5 m for most). `0` = vanilla. |

Everything is inside a `try/catch`; on any failure the vanilla value is left untouched. Each distinct
extension prefab logs its real numbers once, so the default can be retuned from evidence:

```
[EilifPaths] workstation attachment 'piece_workbench_ext1': reach 5m -> 15m.
```

**ValheimPlus coexistence.** V+ patches the same method with a *prefix*
(`StationExtension_Awake_Patch`, `public static void Prefix(ref float ___m_maxStationDistance)`) that
**sets** the field to `Workbench.workbenchAttachmentRange` when its `[Workbench]` section is enabled.
Ours is a postfix, so it always runs after that assignment and adds on top of whatever V+ decided —
no ordering fight, no double-set. In the Eilif profile V+'s `[Workbench]` is `enabled = false`, so we
add to the vanilla per-prefab default.

**Out of scope, deliberately:** `CraftingStation.m_rangeBuild` / `m_extraRangePerLevel`, i.e. how far
from a workbench you may build at all. That is the separate "workbench range" knob (V+
`workbenchRange`), not an attachment's reach.

## ValheimPlus fallback (1.5.0)

ValheimPlus has no 1.0 build. If it is absent from the pack on launch day the crew loses infinite
fuel, the wide workbench range and the +30% gathering they have been playing with all along. This
section puts those back, in this plugin, **off by default**.

Config lives in `net.eilif.paths.cfg` under `[VPlusFallback]`:

| Key | Default | Mirrors | What it does |
|---|---|---|---|
| `Enabled` | `false` | — | Master switch. While false, **none** of the patch classes below are even applied. |
| `InfiniteFireplaceFuel` | `true` | `[FireSource]` fires + torches | Fires, hearths, braziers and torches never burn out. |
| `InfiniteOvenFuel` | `true` | `[Oven] infiniteFuel` | The stone oven's coal never runs down. |
| `InfiniteHotTubFuel` | `true` | `[HotTub] infiniteFuel` | The hot tub stays hot without wood. |
| `InfiniteShieldGeneratorFuel` | `true` | `[ShieldGenerator] infiniteFuel` | Ashlands shield generator never runs down. |
| `StationBuildRange` | `30` | `[Workbench] workbenchRange` | Build radius for every station (vanilla 10). Moves the no-monsters bubble with it. |
| `StationAttachmentRange` | `20` | `[Workbench] workbenchAttachmentRange` | Station↔upgrade reach **before** `[Workstation] extraAttachmentRange` is added on top. |
| `DisableStationRoofCheck` | `true` | `[Workbench] disableRoofCheck` | Stations work in the open. |
| `GatheringBonusPercent` | `30` | `[Gathering]` (all 18 materials) | Extra wood / stone / ore / scrap from trees, rocks and veins. |
| `PickableBonusPercent` | `30` | `[Pickable]` (all categories) | Extra berries, mushrooms, flint, cores, amber. |
| `LootDropBonusPercent` | `30` | `[LootDrop] lootDropAmountMultiplier` | Extra creature loot **amount**. |
| `ShareExploration` | `true` | `[Map] shareMapProgression` (live half) | Your map fills in around every online viking, not just you. |
| `ShareExplorationRadius` | `0` | `[Map] exploreRadius` | `0` = the game's own radius, which is already 100. |

Two implementation details that are invisible in play but worth knowing:

* **The oven and hot tub are topped up at vanilla's own "full" line**, `m_maxFuel - 1`, not the
  instant fuel dips below max. Both are tended by a 1 Hz `InvokeRepeating` tick and vanilla's own
  `UpdateFuel` already writes the fuel ZDO every one of those ticks, so refilling on every tick
  meant marking that ZDO dirty twice a second per lit station, forever. `m_maxFuel - 1` is exactly
  the level at which vanilla itself says "$msg_itsfull" and refuses more fuel, and both hover texts
  print `Mathf.Ceil(fuel)`, so a tank at 9.4/10 still reads **10/10**. One write per station roughly
  every 83 minutes instead of one a second, with nothing visible changed. The shield generator is
  event-driven rather than polled and gates its start on `fuel >= m_maxFuel`, so it is still topped
  right up to max.
* **`ShareExploration` skips anyone whose position is not public.** `ZNet.PlayerInfo` is a struct
  and vanilla only fills `m_position` when `m_publicPosition` is set, so an unfiltered loop would
  explore `Vector3.zero` — the world origin — for every player who has turned their position off.
  V+ loops that list unfiltered; this does not.

### The attachment-range arithmetic

This is the one number that is easy to get wrong, because two settings stack:

```
today, V+ alive:   5 (prefab) → V+ SETS 20 → EilifPaths ADDS 10  =  30 m
V+ gone, this on:  5 (prefab) → we SET 20  → EilifPaths ADDS 10  =  30 m
V+ gone, this off: 5 (prefab) →               EilifPaths ADDS 10  =  15 m
```

`StationAttachmentRange` **sets**, it does not add — that is what keeps the total identical to what
the crew has today. Set it to `0` to leave the prefab value alone and let `extraAttachmentRange` do
all the work.

### Three guards against double-applying

1. The config gate. With `Enabled = false` the `Patch_VPF_*` classes are skipped entirely, so no
   vanilla method carries a hook. The `Core patch classes: 6/6` boot line is deliberately unchanged
   by this feature — it is still the one-glance health check it always was.
2. A **hard refusal**. If ValheimPlus is present, the whole section refuses to apply even with
   `Enabled = true`, and logs a warning block naming what it found. Presence is decided two ways:
   * **the plugin folder**, matching a *normalised name prefix* rather than the literal
     `ValheimPlus.dll` — the crew's own build is already a fork
     (`ValheimPlus_Grantapher_Temporary.dll`), so an exact-name test would let a renamed 1.0 build
     through. This is the test that has to work at Awake time, because BepInEx loads ValheimPlus
     *after* this plugin and `Chainloader.PluginInfos` is not populated yet while we patch.
   * **the BepInEx plugin registry**, by GUID `org.bepinex.plugins.valheim_plus`, which survives any
     rename.
3. A **late re-check**, about 8 seconds into the session, asking the registry again. By then
   Chainloader has finished. If ValheimPlus turns up after all, every percentage bonus reverts to
   vanilla *immediately* (each one asks the gate on every call) and an `[Error]` block says so.
   This closes the one path to silent double-application: the "set" features (30 m range, 20 m
   attachment, infinite fuel) are idempotent because V+ sets them to the same values, but gathering,
   picking and loot are multiplicative and would otherwise become 1.3 × 1.3 = **1.69×** with nothing
   in the log to say so.

### What is deliberately NOT here

* **`[Chat]` shout / ping distance.** Charlie's call; vanilla shout range is the fallback.
* **`[Map] exploreRadius`.** A no-op: vanilla already declares `Minimap.m_exploreRadius = 100f`, the
  exact number V+ was set to.
* **`[Map] shareAllPins`.** Dead code in ValheimPlus 0.9.17.1 — its `Minimap.AddPin` postfix is gated
  on a `shareablePins` list that is created empty and never added to anywhere in the DLL. Pins are
  not being shared today, so there is nothing to replace.
* **The stored server-side map** half of `shareMapProgression`. It needs a `Minimap` instance on the
  server, which a headless dedicated server does not have. `ShareExploration` reproduces the half
  that does work: exploring around every player currently online.
* **The 10-player cap.** Genuinely server-side; it lives in Eilif Companion's `[ServerFallback]`.

### Not reproduced, and these ones are a real loss

The list above is the "nothing is lost" list. This one is not, and it is here so the coverage above
is not read as complete. The live `valheim_plus.cfg` has **17** sections at `enabled = true`. This
plugin covers 10, `[Chat]` is the disclosed skip above, and `[Hud]` sits at all-default values so it
loses nothing. That leaves **five enabled sections with real non-default settings that simply go
away with V+**:

| V+ section | Setting | What the crew loses |
|---|---|---|
| `[Bed]` | `sleepWithoutSpawn = true` | Sleeping in a bed you have not claimed. This is what makes group sleep work without everyone owning a bed. |
| `[Building]` | `enableAreaRepair = true`, `areaRepairRadius = 7.5` | One hammer swing repairs everything within 7.5 m instead of the single piece under the cursor. |
| `[Building]` | `noWeatherDamage = true` | Rain and water erosion start damaging structures again. |
| `[Building]` | `alwaysDropResources = true`, `alwaysDropExcludedResources = true` | Deconstructing returns full materials, including pieces the devs marked "do not drop". |
| `[Building]` | `noInvalidPlacementRestriction = true`, `maximumPlacementDistance = 12`, `pieceComfortRadius = 20` | Placing into other objects; build reach drops to vanilla `Player.m_maxPlaceDistance = 5`; comfort radius drops to vanilla `SE_Rested.c_ComfortRadius = 10`. |
| `[Camera]` | `cameraMaximumZoomDistance = 100`, `cameraBoatMaximumZoomDistance = 100`, `cameraFOV = 75` | Zoom drops to vanilla 6, FOV to vanilla 65. |
| `[Items]` | `itemsFloatInWater = true` | Dropped items sink again. |
| `[GridAlignment]` | `enabled = true` | LeftAlt snap-to-grid placement, F7 / F6 toggles. |

Ranked by what gets noticed first: **area repair**, **no weather damage**, **sleep-without-spawn**.
Each of those three is a small client-side patch of the same shape as the ones already in this file,
so a 1.5.1 could add them. None of it was built two days before launch on a guess about what
matters — it is Charlie's call.

One thing that looks like a loss and is not: `[Chat] forcedCase = true` on this server makes V+
**return early** out of its `Chat_AddInworldText` transpiler and leave vanilla's case conversion
alone. Shouts arrive uppercase today and will still arrive uppercase without V+. Nothing changes.

### Verifying

With the section on, the boot log carries one line per live feature plus a class count:

```
[EilifPaths] VPlusFallback patch classes: 12/12 applied.
[EilifPaths] VPlusFallback: fires and torches never burn out.
[EilifPaths] VPlusFallback: station build range 30m (vanilla 10).
[EilifPaths] VPlusFallback: gathering +30%.
```

With it off there are two different lines, and the difference matters:

```
[EilifPaths] VPlusFallback: disabled (ValheimPlus present).
```

means off *because* V+ is doing the job. Nothing is missing. But:

```
[Warning] [EilifPaths] VPlusFallback: OFF and no ValheimPlus installed. Infinite fuel, the 30m
station build range, no-roof crafting and the +30% gathering, picking and loot bonuses are NOT
active. Set [VPlusFallback] Enabled = true in net.eilif.paths.cfg to restore them.
```

means nothing at all is providing these. That is the state a launch-morning checklist has to catch,
so it is a **warning** naming the consequence rather than a bland "disabled" line. Grep for
`VPlusFallback: OFF and no ValheimPlus`.

There is also an `[Error]` block, `ValheimPlus IS loaded after all`, from the late re-check in guard
3. If that appears, the fallback and V+ were both live for a few seconds; the bonuses are already
back to vanilla, but the config still needs fixing.

## Coexistence guard

If the old `Menthus.bepinex.plugins.UsefulPaths` is still loaded, EilifPaths logs a loud warning
and cedes built floors to it (only adding the Path/PavedRoad detection the old mod can no longer do)
so bonuses don't double-stack. The proper fix is to disable Useful_Paths — see `PACK.md`.

## Build

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
./refresh-libs.sh          # re-copy game + BepInEx reference DLLs (after any Valheim patch)
dotnet build -c Release    # outputs dist/EilifPaths.dll
```

Reference DLLs in `libs/` are compile-time only (never shipped). Re-run `refresh-libs.sh` after a
Valheim patch. If Iron Gate ever renames `m_paintMask` / `GetPaintMask` / `m_materialType`, update
`src/EilifPathsPlugin.cs` accordingly.

## Install

Copy `dist/EilifPaths.dll` into the BepInEx `plugins/` folder (both the r2modman **Eilif** profile
and the manual game install are targeted for this server). See `PACK.md` for adding it to the pinned
pack as a local mod and removing the old Useful_Paths before the next pack export.

## Verifying in-game

On boot: `[EilifPaths] Eilif Paths v1.5.0 loaded. … Bed fire range: +8m. Workstation attachment
range: +10m. Core patch classes: 6/6 applied.`, followed by
`[EilifPaths] tool/weapon stamina hooks: 9/9 applied.` **Both counts are the line to check after any
Valheim update** — anything less than `6/6` or `9/9` means a target went missing, and the ERROR line
above it names which one. Then each surface change logs once at Info:

```
[EilifPaths] terrain: PavedRoad (x1.4 speed, x0.25 movement stamina, x1 tool stamina)
[EilifPaths] terrain: Path (x1.4 speed, x0.25 movement stamina, x1 tool stamina)
[EilifPaths] terrain: Wood (x1.4 speed, x0.25 movement stamina, x0 tool stamina)
[EilifPaths] terrain: None (vanilla speed/stamina)
```

If Path and PavedRoad look swapped (dirt logging as PavedRoad or vice-versa), the R/B channel
mapping is inverted for your build — swap the `c.b`/`c.r` checks in `UpdateGround`. Confidence in
the current mapping is high: the channel colors are read straight from the game's own
`Heightmap.m_paintMaskDirt/Paved` constants.
