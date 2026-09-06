using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// A modern, drop-in replacement for the broken Menthus "Useful Paths" mod
    /// (Thunderstore Menthus-Useful_Paths 1.0.5.0, 2021).
    ///
    /// EFFECT (identical surface to the old mod): while the local player stands on a
    /// recognised surface, jog/run speed is multiplied up and stamina drain is multiplied
    /// down. Walking speed gets the same movement multiplier. All multipliers are
    /// per-surface and configurable, and revert instantly the moment you step off.
    ///
    /// WHY THE OLD MOD BROKE: it detected dirt paths / paved roads via
    /// <c>TerrainModifier.FindClosestModifierPieceInRange(pos, 6f)</c>. Modern Valheim no
    /// longer leaves persistent per-hoe TerrainModifier pieces on the ground — terrain paint
    /// is baked into each Heightmap's <c>m_paintMask</c> texture (dirt = R, cultivated = G,
    /// paved = B). So the old lookup returned null for paths/roads and only built floors
    /// (detected via WearNTear) still worked. This mod reads the paint mask directly.
    ///
    /// DETECTION (polled every 0.4s, cheap):
    ///   1. Built floors: GetLastGroundCollider() -> WearNTear.m_materialType
    ///      (Wood / Stone / Iron / HardWood) — unchanged from the old mod, still valid.
    ///   2. Terrain paint: Heightmap.FindHeightmap(pos) -> read m_paintMask pixel.
    ///        blue  channel > 0.5  => PavedRoad  (Heightmap.m_paintMaskPaved = 0,0,1,1)
    ///        red   channel > 0.5  => Path       (Heightmap.m_paintMaskDirt  = 1,0,0,1)
    ///        green channel        => cultivated farmland (not a road; treated as None)
    ///   LevelGround (hoe "level ground") is NOT detectable: leveling only edits heights, it
    ///   paints nothing and leaves no persistent piece, so there is no reliable signal to key
    ///   off. It is intentionally dropped (see README / final report).
    ///
    /// ALSO (since 1.2.0): a bed's "you need a fire nearby" check gets extra reach, configurable
    /// under [Bed] extraFireRange. See src/BedFirePatch.cs for the decompiled vanilla method and
    /// the reasoning behind the default.
    ///
    /// ALSO (since 1.3.0): crafting-station upgrades/attachments may sit further from their station,
    /// for EVERY station type, configurable under [Workstation] extraAttachmentRange. See
    /// src/StationRangePatch.cs for the decompile and why one hook covers both sides of the rule.
    ///
    /// ALSO (since 1.4.0): the stamina discount is SPLIT IN TWO. 'staminadrain' now applies only to
    /// ordinary movement (running, jumping, swimming, dodging, being encumbered, sneaking), while
    /// tools and weapons — attacks, blocking, bow draw, building, hoe/cultivator work, repairs,
    /// fishing, harpooning — use the new per-surface 'actionstamina': vanilla cost on dirt paths and
    /// paved roads, free on built floors. See src/ToolStaminaPatch.cs for the call-site survey and
    /// how a charge is told apart from a movement charge.
    /// </summary>
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class EilifPathsPlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "net.eilif.paths";
        public const string PluginName = "Eilif Paths";
        public const string PluginVersion = "1.5.0";

        // GUID of the old Menthus mod — if it is still loaded we must not double-apply.
        private const string OldModGuid = "Menthus.bepinex.plugins.UsefulPaths";

        internal static ManualLogSource Log;

        private const float GroundCheckRate = 0.4f;

        public enum PathType { None, Path, PavedRoad, Wood, Stone, Iron, HardWood }

        // Movement + stamina multipliers, keyed by surface. Set once in Awake from config.
        internal static readonly Dictionary<PathType, ConfigEntry<float>> Movement =
            new Dictionary<PathType, ConfigEntry<float>>();
        internal static readonly Dictionary<PathType, ConfigEntry<float>> StaminaDrain =
            new Dictionary<PathType, ConfigEntry<float>>();
        internal static readonly Dictionary<PathType, ConfigEntry<float>> ActionStamina =
            new Dictionary<PathType, ConfigEntry<float>>();

        // The surface the local player is currently standing on (written on the 0.4s timer,
        // read by the Harmony patches). volatile-ish: single writer (main thread), single reader.
        internal static PathType Current { get; private set; } = PathType.None;

        // When the deprecated Useful_Paths mod is also loaded, it still (correctly) boosts
        // built floors via WearNTear. To avoid stacking, we then cede floors to it and only
        // add the Path / PavedRoad detection it can no longer do.
        internal static bool OldModPresent { get; private set; }

        // Owner-chosen defaults. movement = speed multiplier, staminadrain = MOVEMENT stamina-cost
        // multiplier, actionstamina = TOOL/WEAPON stamina-cost multiplier.
        // (all surfaces 1.4 speed and 0.25 movement drain; tools cost vanilla on Path/PavedRoad and
        // nothing on built floors)
        // NOTE: deliberately NOT a tuple/collection field initializer — the plugin class must not
        // reference System.ValueTuple (not shipped with the game's net462 runtime; a static field
        // initializer using it makes the whole class fail to instantiate under BepInEx).
        private void BindSurface(PathType type, float move, float stam, float action)
        {
            string section = type.ToString();
            Movement[type] = Config.Bind(section, "movement", move,
                "Speed multiplier while on " + section + " (1.0 = vanilla, >1 = faster).");
            StaminaDrain[type] = Config.Bind(section, "staminadrain", stam,
                "Stamina-cost multiplier for ordinary movement while on " + section + ": running, " +
                "jumping, swimming, dodging, being encumbered (1.0 = vanilla, <1 = drains less).");
            ActionStamina[type] = Config.Bind(section, "actionstamina", action,
                "Stamina-cost multiplier for tools and weapons while on " + section + ": attacks, " +
                "blocking, bow draw, building, hoe and cultivator terrain work, repairs, fishing. " +
                "1 = vanilla cost, 0 = free.");
        }

        private void Awake()
        {
            Log = Logger;

            BindSurface(PathType.Path,      1.4f, 0.25f, 1f);
            BindSurface(PathType.PavedRoad, 1.4f, 0.25f, 1f);
            BindSurface(PathType.Wood,      1.4f, 0.25f, 0f);
            BindSurface(PathType.Stone,     1.4f, 0.25f, 0f);
            BindSurface(PathType.Iron,      1.4f, 0.25f, 0f);
            BindSurface(PathType.HardWood,  1.4f, 0.25f, 0f);

            // [Bed] extraFireRange — widened "bed needs a fire nearby" check (see BedFirePatch.cs).
            BedFire.Bind(Config);

            // [Workstation] extraAttachmentRange — widened station<->upgrade reach for every
            // crafting station (see StationRangePatch.cs).
            StationRange.Bind(Config);

            // [VPlusFallback] — the stand-in for the ValheimPlus comforts (infinite fuel, station
            // range, gathering/picking/loot bonuses, shared map exploration) for the day V+ is not
            // in the pack. Ships OFF. Bound BEFORE Harmony runs because Refuse() decides, once,
            // whether any of those patch classes may touch anything (see src/VPlusFallbackPatch.cs).
            VPlusFallback.Bind(Config);
            VPlusFallback.Refuse();

            OldModPresent = Chainloader.PluginInfos != null &&
                            Chainloader.PluginInfos.ContainsKey(OldModGuid);
            if (OldModPresent)
            {
                Log.LogWarning("========================================================================");
                Log.LogWarning("[EilifPaths] The OLD 'Useful_Paths' (Menthus.bepinex.plugins.UsefulPaths)");
                Log.LogWarning("[EilifPaths] mod is ALSO loaded. It is superseded by EilifPaths and its");
                Log.LogWarning("[EilifPaths] path/road detection is broken on current Valheim. To avoid");
                Log.LogWarning("[EilifPaths] DOUBLE-APPLYING bonuses on built floors, EilifPaths is ceding");
                Log.LogWarning("[EilifPaths] Wood/Stone/Iron/HardWood floors to the old mod and handling");
                Log.LogWarning("[EilifPaths] ONLY dirt Path + PavedRoad here. >>> Please DISABLE Useful_Paths");
                Log.LogWarning("[EilifPaths] in the r2modman UI (and re-export the pack) for correct values.");
                Log.LogWarning("========================================================================");
            }

            InvokeRepeating(nameof(UpdateGround), 0f, GroundCheckRate);

            Harmony harmony = new Harmony(PluginGuid);
            // Each attribute-declared patch class is applied ON ITS OWN. A bare PatchAll() aborts the
            // whole batch on the first unresolvable target, and the order it walks the classes in is
            // not defined: if it died AFTER Patch_UseStamina had gone on but BEFORE ToolStamina.Apply
            // ran, every tool/weapon charge would silently keep the movement discount — exactly the
            // failure this version exists to prevent. Isolating each class (and always reaching
            // ToolStamina.Apply below) makes that unreachable.
            // The [VPlusFallback] classes (named Patch_VPF_*) are counted and applied SEPARATELY,
            // and are not applied at all while that section is off. That keeps two properties worth
            // having: the "Core patch classes: 6/6" line below stays the same number it has always
            // been — it is the one-glance post-update health check, and it must not move because a
            // dormant feature was added — and a disabled fallback leaves absolutely no hook on any
            // vanilla method, rather than a dozen hooks that early-return.
            //
            // The DENOMINATOR is a fixed roster (ExpectedCoreClasses below), never a count of the
            // classes that happened to enumerate. AccessTools.GetTypesFromAssembly swallows a
            // ReflectionTypeLoadException and hands back only the types that LOADED, and a patch
            // class fails to load when a game type in its own signature is gone — so a boot that
            // had lost Patch_UseStamina used to print a perfectly healthy "5/5". Now it reads 5/6
            // and names the missing one.
            var applied = new HashSet<string>(StringComparer.Ordinal);
            bool fallbackOn = VPlusFallback.Active;
            foreach (Type t in AccessTools.GetTypesFromAssembly(typeof(EilifPathsPlugin).Assembly))
            {
                string cname = "?";
                try
                {
                    if (t == null) continue;
                    cname = t.Name;
                    if (t.GetCustomAttributes(typeof(HarmonyPatch), true).Length == 0) continue;
                    bool isFallback = cname.StartsWith("Patch_VPF_", StringComparison.Ordinal);
                    if (isFallback && !fallbackOn) continue;
                    // ROSTER INVARIANT: "applied" means Patch() returned without throwing. That is
                    // exact today because no patch class in this plugin has a [HarmonyPrepare]
                    // method (verified: `grep -rn 'Prepare' plugins/*/src/*.cs` finds none).
                    // PatchClassProcessor.Patch() returns null WITHOUT throwing when a Prepare()
                    // returns false, so if anyone ever adds one, switch this to
                    //   var done = harmony.CreateClassProcessor(t).Patch();
                    //   if (done != null && done.Count > 0) applied.Add(name);
                    // or the count silently reads healthy for a class that was skipped.
                    harmony.CreateClassProcessor(t).Patch();
                    applied.Add(cname);
                }
                catch (Exception ex)
                {
                    Log.LogError("[EilifPaths] could not apply patch class " + cname + ": " +
                                 ex.Message + " -> " + FeatureOf(cname) + ".");
                }
            }
            if (fallbackOn)
            {
                Log.LogInfo("[EilifPaths] VPlusFallback patch classes: " +
                            CountApplied(applied, ExpectedFallbackClasses) + "/" +
                            ExpectedFallbackClasses.Length + " applied.");
                ReportMissing(applied, ExpectedFallbackClasses);
            }

            // Tool/weapon context hooks are applied one by one (not by attribute) so a single
            // unresolvable target cannot take the rest of the plugin down with it. This ALWAYS runs,
            // whatever happened above.
            ToolStamina.Apply(harmony);

            // One line per enabled fallback feature, or 'VPlusFallback: disabled'.
            VPlusFallback.Report();

            Log.LogInfo($"[EilifPaths] {PluginName} v{PluginVersion} loaded. Surfaces (speed / movement " +
                        "stamina / tool stamina): " +
                        "Path x" + F(Movement[PathType.Path]) + "/x" + F(StaminaDrain[PathType.Path]) + "/x" + F(ActionStamina[PathType.Path]) + ", " +
                        "PavedRoad x" + F(Movement[PathType.PavedRoad]) + "/x" + F(StaminaDrain[PathType.PavedRoad]) + "/x" + F(ActionStamina[PathType.PavedRoad]) + ", " +
                        "floors x" + F(Movement[PathType.Wood]) + "/x" + F(StaminaDrain[PathType.Wood]) + "/x" + F(ActionStamina[PathType.Wood]) +
                        ". Polling every " + GroundCheckRate.ToString("0.0", CultureInfo.InvariantCulture) + "s. " +
                        "Bed fire range: " + BedFire.Describe() + ". " +
                        "Workstation attachment range: " + StationRange.Describe() + ". " +
                        "Core patch classes: " + CountApplied(applied, ExpectedCoreClasses) + "/" +
                        ExpectedCoreClasses.Length + " applied.");
            ReportMissing(applied, ExpectedCoreClasses);
        }

        // ---- The patch roster (v1.5.0, audit plugins-1.0) --------------------------------------
        // The list the "Core patch classes: N/M" health line is measured against. M must never be
        // derived from what loaded (see the comment at the apply loop).
        private static readonly string[] ExpectedCoreClasses =
        {
            "Patch_GetJogSpeedFactor",
            "Patch_GetRunSpeedFactor",
            "Patch_UseStamina",
            "Patch_UpdateWalking",
            "Patch_Bed_CheckFire",
            "Patch_StationExtension_Awake",
        };

        // Applied only while [VPlusFallback] is on; counted separately for the same reason.
        private static readonly string[] ExpectedFallbackClasses =
        {
            "Patch_VPF_Fireplace_Awake",
            "Patch_VPF_CookingStation_UpdateCooking",
            "Patch_VPF_Smelter_UpdateSmelter",
            "Patch_VPF_ShieldGenerator_Start",
            "Patch_VPF_ShieldGenerator_OnProjectileHit",
            "Patch_VPF_ShieldGenerator_RPC_Attack",
            "Patch_VPF_CraftingStation_Start",
            "Patch_VPF_CraftingStation_CheckUsable",
            "Patch_VPF_StationExtension_Awake",
            "Patch_VPF_DropTable_GetDropList",
            "Patch_VPF_Pickable_RPC_Pick",
            "Patch_VPF_CharacterDrop_GenerateDropList",
        };

        /// <summary>What each roster entry buys, named on the failure line so a boot log says what
        /// actually stopped working rather than only which class name was involved.</summary>
        private static string FeatureOf(string patchClass)
        {
            switch (patchClass)
            {
                case "Patch_GetJogSpeedFactor": return "the jog-speed bonus on paths, roads and floors";
                case "Patch_GetRunSpeedFactor": return "the run-speed bonus on paths, roads and floors";
                case "Patch_UseStamina": return "the ENTIRE stamina discount (movement and tools alike)";
                case "Patch_UpdateWalking": return "the walking-speed bonus (jog and run are unaffected)";
                case "Patch_Bed_CheckFire": return "the widened bed 'needs a fire nearby' reach";
                case "Patch_StationExtension_Awake": return "the extra crafting-station attachment reach";
                case "Patch_VPF_Fireplace_Awake": return "infinite fireplace and torch fuel";
                case "Patch_VPF_CookingStation_UpdateCooking": return "infinite oven fuel";
                case "Patch_VPF_Smelter_UpdateSmelter": return "infinite hot tub fuel";
                case "Patch_VPF_ShieldGenerator_Start":
                case "Patch_VPF_ShieldGenerator_OnProjectileHit":
                case "Patch_VPF_ShieldGenerator_RPC_Attack": return "one of the three shield-generator refuel points";
                case "Patch_VPF_CraftingStation_Start": return "the 30m station build range and its no-spawn bubble";
                case "Patch_VPF_CraftingStation_CheckUsable": return "no-roof crafting";
                case "Patch_VPF_StationExtension_Awake": return "the V+ station attachment range (the [Workstation] bonus still applies)";
                case "Patch_VPF_DropTable_GetDropList": return "the gathering bonus on trees, rocks and ore";
                case "Patch_VPF_Pickable_RPC_Pick": return "the picking bonus on berries, mushrooms and cores";
                case "Patch_VPF_CharacterDrop_GenerateDropList": return "the creature loot-amount bonus";
                default: return "an unnamed feature";
            }
        }

        private static int CountApplied(HashSet<string> applied, string[] roster)
        {
            int n = 0;
            for (int i = 0; i < roster.Length; i++)
                if (applied.Contains(roster[i])) n++;
            return n;
        }

        /// <summary>
        /// One ERROR line per roster entry that did not go on. This is the only signal there is for
        /// a class the runtime dropped BEFORE the loop could see it — no exception, nothing else in
        /// the log, and until now a clean-looking count.
        /// </summary>
        private static void ReportMissing(HashSet<string> applied, string[] roster)
        {
            for (int i = 0; i < roster.Length; i++)
            {
                if (applied.Contains(roster[i])) continue;
                Log?.LogError("[EilifPaths] MISSING patch class " + roster[i] + " - " + FeatureOf(roster[i]) +
                             " is not active. Re-check that method against this game build with " +
                             "ilspycmd and rebuild.");
            }
        }

        private static string F(ConfigEntry<float> c) => c.Value.ToString("0.##", CultureInfo.InvariantCulture);

        /// <summary>
        /// 0.4s poll: work out which surface the local player is on and update <see cref="Current"/>.
        /// Logs exactly once per surface CHANGE at Info level so the owner can verify in one session.
        /// </summary>
        private void UpdateGround()
        {
            // InvokeRepeating keeps calling this on its timer whatever happens inside, so an
            // unguarded throw here is an exception every 0.4s for the rest of the session AND
            // leaves Current stuck on whatever surface it last saw. One catch, and the surface
            // falls back to None (vanilla speed and stamina) rather than to a stale value.
            //
            // The line is RATE LIMITED (audit plugins-1.0 round 2). This poll fires 150 times a
            // minute, so an unlimited warning here just trades an exception flood for a warning
            // flood in the player's own log. Same 60s-with-a-count shape the Companion and the
            // Client use for their Update pumps.
            try { UpdateGroundCore(); }
            catch (Exception ex)
            {
                try
                {
                    SetCurrent(PathType.None);
                    DateTime now = DateTime.UtcNow;
                    if ((now - _groundFaultLastUtc).TotalSeconds < GroundFaultCooldownSeconds)
                    {
                        _groundFaultSuppressed++;
                    }
                    else
                    {
                        int suppressed = _groundFaultSuppressed;
                        _groundFaultSuppressed = 0;
                        _groundFaultLastUtc = now;
                        if (Log != null) Log.LogWarning("[EilifPaths] ground poll failed: " + ex.Message +
                                                        (suppressed > 0 ? " (+" + suppressed + " more in the last minute)" : "") +
                                                        " (surface reset to None, i.e. vanilla speed and stamina).");
                    }
                }
                catch { /* logging must never throw out of the poll */ }
            }
        }

        // Ground-poll fault throttle. DateTime.MinValue so the FIRST failure always reports.
        private const double GroundFaultCooldownSeconds = 60d;
        private DateTime _groundFaultLastUtc = DateTime.MinValue;
        private int _groundFaultSuppressed;

        private void UpdateGroundCore()
        {
            // This tick never runs nested inside a wrapped tool/weapon method, so the context depth
            // must be zero here. If it is not, something leaked — clear it (see ToolStaminaPatch.cs).
            ToolStamina.SanityReset();

            // [VPlusFallback] ShareExploration rides this same 0.4s poll (its own 2s accumulator
            // inside), so the fallback needs no timer of its own. No-op while the section is off.
            VPlusFallback.Tick(GroundCheckRate);

            var player = Player.m_localPlayer;
            if (player == null) { SetCurrent(PathType.None); return; }

            PathType detected = PathType.None;

            // 1) Built floors via WearNTear material (unchanged from the old mod).
            //    If the old mod is present it already handles these, so we skip to avoid stacking.
            if (!OldModPresent)
            {
                try
                {
                    Collider col = player.GetLastGroundCollider();
                    if (col != null)
                    {
                        WearNTear wnt = col.GetComponentInParent<WearNTear>();
                        if (wnt != null)
                        {
                            switch (wnt.m_materialType)
                            {
                                case WearNTear.MaterialType.Wood:     detected = PathType.Wood;     break;
                                case WearNTear.MaterialType.Stone:    detected = PathType.Stone;    break;
                                case WearNTear.MaterialType.Iron:     detected = PathType.Iron;     break;
                                case WearNTear.MaterialType.HardWood: detected = PathType.HardWood; break;
                            }
                        }
                    }
                }
                catch (Exception ex) { Log.LogWarning($"[EilifPaths] floor check failed: {ex.Message}"); }
            }

            // 2) Terrain paint via the current Heightmap paint mask (the modern API).
            if (detected == PathType.None)
            {
                try
                {
                    Vector3 pos = player.transform.position;
                    Heightmap hm = Heightmap.FindHeightmap(pos);
                    if (hm != null)
                    {
                        // Match the game's own IsCleared() sampling: shift by -0.5 on x/z, convert to
                        // mask-vertex coords, then read the paint pixel. GetPaintMask(x,y) is bounds-safe.
                        Vector3 wp = pos; wp.x -= 0.5f; wp.z -= 0.5f;
                        hm.WorldToVertexMask(wp, out int x, out int y);
                        Color c = hm.GetPaintMask(x, y);
                        if (c.b > 0.5f) detected = PathType.PavedRoad; // Heightmap.m_paintMaskPaved (0,0,1,1)
                        else if (c.r > 0.5f) detected = PathType.Path; // Heightmap.m_paintMaskDirt  (1,0,0,1)
                        // green (cultivated farmland) intentionally ignored -> None
                    }
                }
                catch (Exception ex) { Log.LogWarning($"[EilifPaths] paint check failed: {ex.Message}"); }
            }

            SetCurrent(detected);
        }

        private static void SetCurrent(PathType t)
        {
            if (t == Current) return;
            Current = t;
            if (t == PathType.None)
            {
                Log.LogInfo("[EilifPaths] terrain: None (vanilla speed/stamina)");
            }
            else
            {
                float mv = Mult(Movement, t), st = Mult(StaminaDrain, t), ac = Mult(ActionStamina, t);
                Log.LogInfo($"[EilifPaths] terrain: {t} (x{mv.ToString("0.##", CultureInfo.InvariantCulture)} speed, " +
                            $"x{st.ToString("0.##", CultureInfo.InvariantCulture)} movement stamina, " +
                            $"x{ac.ToString("0.##", CultureInfo.InvariantCulture)} tool stamina)");
            }
        }

        /// <summary>
        /// Look a multiplier up without ever being able to throw. These are read from inside Harmony
        /// patch bodies that sit on Player.UseStamina and Character.UpdateWalking — code Valheim
        /// runs several times a frame — and Harmony does NOT swallow an exception out of a patch: it
        /// propagates straight into the game. A missing dictionary key here would therefore be a
        /// hard movement break, not a lost bonus. 1.0 = vanilla is always the safe answer.
        /// </summary>
        private static float Mult(Dictionary<PathType, ConfigEntry<float>> table, PathType surface)
        {
            if (surface == PathType.None || table == null) return 1f;
            ConfigEntry<float> entry;
            if (!table.TryGetValue(surface, out entry) || entry == null) return 1f;
            float v = entry.Value;
            if (float.IsNaN(v) || float.IsInfinity(v) || v < 0f) return 1f;
            return v;
        }

        internal static float MoveMult() => Mult(Movement, Current);
        /// <summary>Movement stamina multiplier for the current surface ('staminadrain').</summary>
        internal static float StamMult() => Mult(StaminaDrain, Current);
        /// <summary>Tool/weapon stamina multiplier for the current surface ('actionstamina').</summary>
        internal static float ActionMult() => Mult(ActionStamina, Current);

        /// <summary>
        /// The multiplier for the stamina charge being paid RIGHT NOW: 'actionstamina' while a wrapped
        /// tool/weapon method is on the stack, 'staminadrain' otherwise. If a tool/weapon hook failed to
        /// apply (degraded), an unclassified charge takes the LARGER of the two instead — vanilla on
        /// paths and roads, 0.25 on floors — so a missed tool charge can never keep the movement
        /// discount and nothing can become unexpectedly free.
        /// </summary>
        internal static float CostMult()
        {
            if (Current == PathType.None) return 1f;
            if (ToolStamina.Active) return ActionMult();
            if (ToolStamina.Degraded) return Mathf.Max(ActionMult(), StamMult());
            return StamMult();
        }
    }

    // --- Harmony patches (same surface the old mod used) ---

    // Jog speed factor: multiply the vanilla result while on a surface.
    //
    // TRY/CATCH ON A THREE-LINE BODY IS NOT PARANOIA HERE. Harmony re-throws whatever a patch body
    // throws into the ORIGINAL method, so an exception in this postfix is an exception inside
    // Player.GetJogSpeedFactor, several times a frame, for as long as the surface stays set. The
    // catch costs nothing when nothing is wrong and turns the worst case into "the bonus did not
    // apply this frame". Same for every other body in this file.
    [HarmonyPatch(typeof(Player), "GetJogSpeedFactor")]
    internal static class Patch_GetJogSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            try
            {
                if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                    __result *= EilifPathsPlugin.MoveMult();
            }
            catch { /* leave __result at the vanilla value */ }
        }
    }

    // Run speed factor: multiply the vanilla result while on a surface.
    [HarmonyPatch(typeof(Player), "GetRunSpeedFactor")]
    internal static class Patch_GetRunSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            try
            {
                if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                    __result *= EilifPathsPlugin.MoveMult();
            }
            catch { /* leave __result at the vanilla value */ }
        }
    }

    // Stamina drain: scale the cost while on a surface. Movement charges take the surface's
    // 'staminadrain'; tool and weapon charges take its 'actionstamina' (see src/ToolStaminaPatch.cs
    // for how the two are told apart). Runs BEFORE vanilla's own 'v *= Game.m_staminaRate', which is
    // where the scaling belongs.
    [HarmonyPatch(typeof(Player), "UseStamina")]
    internal static class Patch_UseStamina
    {
        private static void Prefix(Player __instance, ref float v)
        {
            try
            {
                // Only the local player: this is a client-side comfort mod, and no vanilla code path
                // calls UseStamina on someone else's Player object.
                if (__instance == null || __instance != Player.m_localPlayer) return;
                if (EilifPathsPlugin.Current == EilifPathsPlugin.PathType.None) return;
                v *= EilifPathsPlugin.CostMult();
            }
            catch { /* any failure here leaves v untouched, i.e. vanilla stamina */ }
        }
    }

    // Walk speed: the jog/run factors above don't touch walking (Character.UpdateWalking sets
    // speed = m_walkSpeed directly when walking). Modern vanilla m_walkSpeed is ~5 (it was 1.6
    // in 2021 — the old mod hard-set "1.6f * mult", which today would SLOW walking). Instead we
    // MULTIPLY the current value for the local player only, then restore it in the FINALIZER so
    // character state is never permanently mutated and reverts cleanly off-path — including when
    // the original method throws, which is why it is a finalizer and not a postfix.
    [HarmonyPatch(typeof(Character), "UpdateWalking")]
    internal static class Patch_UpdateWalking
    {
        // __state is assigned FIRST and unconditionally, so every path THROUGH THIS PREFIX leaves the
        // finalizer either a real captured speed or the NaN sentinel. It does NOT cover the case
        // where this prefix never runs at all — see the finalizer's guard for that one.
        private static void Prefix(Character __instance, out float __state)
        {
            __state = float.NaN; // sentinel: nothing to restore
            try
            {
                if (__instance == null) return;
                __state = __instance.m_walkSpeed;
                if (__instance != Player.m_localPlayer) return;
                if (EilifPathsPlugin.Current == EilifPathsPlugin.PathType.None) return;
                __instance.m_walkSpeed *= EilifPathsPlugin.MoveMult();
            }
            catch { /* vanilla walk speed; the finalizer still restores whatever was captured */ }
        }

        // FINALIZER, NOT POSTFIX (v1.5.0). m_walkSpeed is real, shared character state that this
        // prefix temporarily multiplies, and a postfix is SKIPPED when the original method throws.
        // Character.UpdateWalking throwing once with a postfix restore would have left the local
        // player permanently walking at 1.4x — and the next tick would multiply the multiplied
        // value again. A finalizer runs on both paths and returns void, so the original exception
        // is still rethrown untouched. Same convention as ToolStaminaPatch.ScopeFinalizer.
        //
        // THE GUARD IS `> 0f`, NOT JUST `!IsNaN` (audit plugins-1.0 round 2). Verified by decompiling
        // the exact 0Harmony this plugin references: HarmonyManipulator.WriteFinalizers opens its
        // try block at Body.Instructions[0], i.e. ABOVE the prefixes, and its catch handler calls
        // every finalizer. So a THIRD-PARTY prefix on Character.UpdateWalking that throws before
        // ours runs still lands here — with __state left at the zero-initialised local, never at the
        // NaN sentinel, because our prefix never executed to write it. Restoring that zero would
        // pin the local player's walk speed at 0 for the session (vanilla m_walkSpeed is 5) and it
        // would not self-heal: the next tick captures 0, multiplies 0, restores 0. A genuine
        // captured speed is always positive, and restoring a zero or a negative would be a no-op or
        // worse, so "not a positive number" is exactly the set of values with nothing to restore.
        private static void Finalizer(Character __instance, float __state)
        {
            try
            {
                if (__instance == null) return;
                if (float.IsNaN(__state) || __state <= 0f) return; // sentinel, or a prefix that never ran
                __instance.m_walkSpeed = __state;
            }
            catch { /* a patch body must never throw into game code */ }
        }
    }
}
