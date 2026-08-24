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
        public const string PluginVersion = "1.4.0";

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
            int classesApplied = 0, classesTotal = 0;
            foreach (Type t in AccessTools.GetTypesFromAssembly(typeof(EilifPathsPlugin).Assembly))
            {
                try
                {
                    if (t.GetCustomAttributes(typeof(HarmonyPatch), true).Length == 0) continue;
                    classesTotal++;
                    harmony.CreateClassProcessor(t).Patch();
                    classesApplied++;
                }
                catch (Exception ex)
                {
                    Log.LogError("[EilifPaths] could not apply patch class " +
                                 (t != null ? t.Name : "?") + ": " + ex.Message);
                }
            }

            // Tool/weapon context hooks are applied one by one (not by attribute) so a single
            // unresolvable target cannot take the rest of the plugin down with it. This ALWAYS runs,
            // whatever happened above.
            ToolStamina.Apply(harmony);

            Log.LogInfo($"[EilifPaths] {PluginName} v{PluginVersion} loaded. Surfaces (speed / movement " +
                        "stamina / tool stamina): " +
                        "Path x" + F(Movement[PathType.Path]) + "/x" + F(StaminaDrain[PathType.Path]) + "/x" + F(ActionStamina[PathType.Path]) + ", " +
                        "PavedRoad x" + F(Movement[PathType.PavedRoad]) + "/x" + F(StaminaDrain[PathType.PavedRoad]) + "/x" + F(ActionStamina[PathType.PavedRoad]) + ", " +
                        "floors x" + F(Movement[PathType.Wood]) + "/x" + F(StaminaDrain[PathType.Wood]) + "/x" + F(ActionStamina[PathType.Wood]) +
                        ". Polling every " + GroundCheckRate.ToString("0.0", CultureInfo.InvariantCulture) + "s. " +
                        "Bed fire range: " + BedFire.Describe() + ". " +
                        "Workstation attachment range: " + StationRange.Describe() + ". " +
                        "Core patch classes: " + classesApplied + "/" + classesTotal + " applied.");
        }

        private static string F(ConfigEntry<float> c) => c.Value.ToString("0.##", CultureInfo.InvariantCulture);

        /// <summary>
        /// 0.4s poll: work out which surface the local player is on and update <see cref="Current"/>.
        /// Logs exactly once per surface CHANGE at Info level so the owner can verify in one session.
        /// </summary>
        private void UpdateGround()
        {
            // This tick never runs nested inside a wrapped tool/weapon method, so the context depth
            // must be zero here. If it is not, something leaked — clear it (see ToolStaminaPatch.cs).
            ToolStamina.SanityReset();

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
                float mv = Movement[t].Value, st = StaminaDrain[t].Value, ac = ActionStamina[t].Value;
                Log.LogInfo($"[EilifPaths] terrain: {t} (x{mv.ToString("0.##", CultureInfo.InvariantCulture)} speed, " +
                            $"x{st.ToString("0.##", CultureInfo.InvariantCulture)} movement stamina, " +
                            $"x{ac.ToString("0.##", CultureInfo.InvariantCulture)} tool stamina)");
            }
        }

        internal static float MoveMult() =>
            Current == PathType.None ? 1f : Movement[Current].Value;
        /// <summary>Movement stamina multiplier for the current surface ('staminadrain').</summary>
        internal static float StamMult() =>
            Current == PathType.None ? 1f : StaminaDrain[Current].Value;
        /// <summary>Tool/weapon stamina multiplier for the current surface ('actionstamina').</summary>
        internal static float ActionMult() =>
            Current == PathType.None ? 1f : ActionStamina[Current].Value;

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
    [HarmonyPatch(typeof(Player), "GetJogSpeedFactor")]
    internal static class Patch_GetJogSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                __result *= EilifPathsPlugin.MoveMult();
        }
    }

    // Run speed factor: multiply the vanilla result while on a surface.
    [HarmonyPatch(typeof(Player), "GetRunSpeedFactor")]
    internal static class Patch_GetRunSpeedFactor
    {
        private static void Postfix(ref float __result)
        {
            if (EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
                __result *= EilifPathsPlugin.MoveMult();
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
    // MULTIPLY the current value for the local player only, then restore it in the postfix so
    // character state is never permanently mutated and reverts cleanly off-path.
    [HarmonyPatch(typeof(Character), "UpdateWalking")]
    internal static class Patch_UpdateWalking
    {
        private static void Prefix(Character __instance, out float __state)
        {
            __state = __instance != null ? __instance.m_walkSpeed : 0f;
            if (__instance != null && __instance == Player.m_localPlayer &&
                EilifPathsPlugin.Current != EilifPathsPlugin.PathType.None)
            {
                __instance.m_walkSpeed *= EilifPathsPlugin.MoveMult();
            }
        }

        private static void Postfix(Character __instance, float __state)
        {
            if (__instance != null)
                __instance.m_walkSpeed = __state;
        }
    }
}
