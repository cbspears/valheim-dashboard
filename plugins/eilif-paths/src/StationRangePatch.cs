using System;
using System.Collections.Generic;
using System.Globalization;
using BepInEx.Configuration;
using HarmonyLib;

namespace EilifPaths
{
    /// <summary>
    /// Extends how far a crafting-station EXTENSION (upgrade/attachment) may sit from its station,
    /// for EVERY crafting station in the game: workbench, forge, black forge, galdr table, artisan
    /// table, and anything a future update adds. Client-side, configurable, purely additive.
    ///
    /// VERIFIED BY DECOMPILE (ilspycmd against libs/assembly_valheim.dll, game 0.221.12).
    ///
    /// There is exactly ONE distance value in the game that gates station attachments, and it lives
    /// on the EXTENSION, not on the station:
    ///
    ///   public class StationExtension : MonoBehaviour, Hoverable
    ///   {
    ///       public CraftingStation m_craftingStation;
    ///       public float m_maxStationDistance = 5f;
    ///       ...
    ///   }
    ///
    /// It is read from three places, and those three are the whole attachment system:
    ///
    /// (1) STATION SIDE - the station counting/enumerating its attachments (this is what raises the
    ///     station level, i.e. what "the upgrade counts" means):
    ///
    ///       public static void FindExtensions(CraftingStation station, Vector3 pos, List&lt;StationExtension&gt; extensions)
    ///       {
    ///           foreach (StationExtension allExtension in m_allExtensions)
    ///           {
    ///               if (Vector3.Distance(allExtension.transform.position, pos) &lt; allExtension.m_maxStationDistance
    ///                   &amp;&amp; allExtension.m_craftingStation.m_name == station.m_name
    ///                   &amp;&amp; (allExtension.m_stack || !ExtensionInList(extensions, allExtension)))
    ///               {
    ///                   extensions.Add(allExtension);
    ///               }
    ///           }
    ///       }
    ///
    ///     called from CraftingStation.GetExtensions():
    ///
    ///       private List&lt;StationExtension&gt; GetExtensions()
    ///       {
    ///           if (m_updateExtensionTimer &gt;= 2f)
    ///           {
    ///               m_updateExtensionTimer = 0f;
    ///               m_attachedExtensions.Clear();
    ///               StationExtension.FindExtensions(this, base.transform.position, m_attachedExtensions);
    ///               m_buildRange = m_rangeBuild + (float)GetExtentionCount(checkExtensions: false) * m_extraRangePerLevel;
    ///               ...
    ///           }
    ///           return m_attachedExtensions;
    ///       }
    ///
    ///       public int GetLevel(bool checkExtensions = true) =&gt; 1 + GetExtentionCount(checkExtensions);
    ///
    ///     NOTE what is NOT there: CraftingStation has no distance constant of its own for this.
    ///     Its own numbers - m_discoverRange (4), m_rangeBuild (10), m_useDistance (2),
    ///     m_extraRangePerLevel - govern discovery, the build radius and the interact distance, none
    ///     of which gate whether an extension attaches. The station side reads the EXTENSION's
    ///     m_maxStationDistance. So there is no second constant to patch in tandem: one field gates
    ///     both sides, which is why the hook below is a single patch.
    ///
    /// (2) EXTENSION SIDE - placement validity, from Player.UpdatePlacementGhost():
    ///
    ///       StationExtension component2 = component.GetComponent&lt;StationExtension&gt;();
    ///       if (component2 != null)
    ///       {
    ///           CraftingStation craftingStation = component2.FindClosestStationInRange(point);
    ///           if ((bool)craftingStation) { component2.StartConnectionEffect(craftingStation); }
    ///           else { component2.StopConnectionEffect(); m_placementStatus = PlacementStatus.ExtensionMissingStation; }
    ///           if (component2.OtherExtensionInRange(component.m_spaceRequirement)) { m_placementStatus = PlacementStatus.MoreSpace; }
    ///       }
    ///
    ///     and the instance methods it uses, which again read the same field:
    ///
    ///       public List&lt;CraftingStation&gt; FindStationsInRange(Vector3 center)
    ///       {
    ///           List&lt;CraftingStation&gt; list = new List&lt;CraftingStation&gt;();
    ///           CraftingStation.FindStationsInRange(m_craftingStation.m_name, center, m_maxStationDistance, list);
    ///           return list;
    ///       }
    ///
    ///       public CraftingStation FindClosestStationInRange(Vector3 center)
    ///       {
    ///           return CraftingStation.FindClosestStationInRange(m_craftingStation.m_name, center, m_maxStationDistance);
    ///       }
    ///
    /// (3) the connection beam effect (PokeEffect -&gt; FindClosestStationInRange), cosmetic, and it
    ///     follows the same field so the beam keeps matching what actually counts.
    ///
    /// THE HOOK: a Harmony POSTFIX on StationExtension.Awake that ADDS the configured metres to that
    /// instance's m_maxStationDistance. One hook, and by construction every consumer above sees the
    /// wider range - placement validity, the station's extension count / level, and the beam all move
    /// together, so a piece you are allowed to place is always a piece the station actually counts.
    /// It is per-INSTANCE (Awake runs once per spawned object, never on the shared prefab asset), so
    /// it cannot accumulate, and it is generic: it keys off StationExtension, not off any particular
    /// station name, so every station type present or future is covered with no per-station list.
    ///
    /// The placement ghost is covered too. Player.SetupPlacementGhost() does
    /// Instantiate(selectedPrefab) with ZNetView.m_forceDisableInit = true, so the ghost's
    /// StationExtension.Awake runs (and early-returns from the vanilla body because GetZDO() is null,
    /// which does not stop a postfix). The ghost is therefore bumped as well and the green/red
    /// placement feedback agrees with the placed result.
    ///
    /// WHY ADDITIVE, not absolute: m_maxStationDistance is authored per prefab. Setting it flat would
    /// silently SHRINK any extension whose prefab default is larger than the flat value. Adding can
    /// only ever widen, never narrow, which is the same "purely additive, can only accept more"
    /// property the bed patch was built on.
    ///
    /// COEXISTENCE WITH VALHEIMPLUS: V+ patches the same method with a PREFIX
    /// (StationExtension_Awake_Patch, "public static void Prefix(ref float ___m_maxStationDistance)")
    /// that SETS the field to Workbench.workbenchAttachmentRange when its [Workbench] section is
    /// enabled. Because ours is a postfix, we always run after that assignment and add on top of it,
    /// whatever V+ decided - no fight over ordering, no double-set. In the Eilif profile V+'s
    /// [Workbench] section is currently "enabled = false", so the vanilla per-prefab default is what
    /// we add to.
    ///
    /// OUT OF SCOPE (deliberately): CraftingStation.m_rangeBuild / m_extraRangePerLevel, i.e. how far
    /// from a workbench you may build at all. That is the separate "workbench range" knob (V+
    /// workbenchRange) and is not what an attachment's reach means.
    ///
    /// SAFETY: the whole postfix is inside a try/catch and does nothing on any failure, leaving the
    /// vanilla value in place. A zero / negative / non-finite setting disables the patch entirely.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file - see the warning above BindSurface(...) in
    /// EilifPathsPlugin.cs. The game's net462 Mono runtime ships no ValueTuple and a reference to it
    /// makes the plugin fail to load SILENTLY.
    /// </summary>
    internal static class StationRange
    {
        internal const float DefaultExtraRange = 10f;

        internal static ConfigEntry<float> ExtraRange;

        // Prefabs already reported at Info, so the one-line-per-station-type diagnostic below cannot
        // turn into log spam when dozens of extensions stream in as the player moves. Bounded by the
        // number of distinct extension prefabs in the game (about a dozen).
        private static readonly HashSet<string> Reported = new HashSet<string>();

        internal static void Bind(ConfigFile config)
        {
            ExtraRange = config.Bind("Workstation", "extraAttachmentRange", DefaultExtraRange,
                "Extra metres of reach between a crafting station and its upgrades/attachments, for " +
                "EVERY station (workbench, forge, black forge, galdr table, artisan table, ...). Added " +
                "on top of each attachment piece's own built-in distance, which is 5 m for most of " +
                "them, so the default 10 gives about 15 m. Applies to both halves of the rule at once: " +
                "where the game lets you place the attachment, and whether the station counts it " +
                "towards its level. 0 = vanilla. Client-side; it only affects your own placement and " +
                "your own crafting UI.");
        }

        internal static string Describe()
        {
            float v = ExtraRange != null ? ExtraRange.Value : 0f;
            return IsActive(v)
                ? "+" + v.ToString("0.##", CultureInfo.InvariantCulture) + "m"
                : "vanilla";
        }

        // Guard against 0, negatives, NaN and infinities in a hand-edited cfg.
        internal static bool IsActive(float v)
        {
            return v > 0f && !float.IsNaN(v) && !float.IsInfinity(v);
        }

        /// <summary>
        /// Diagnostic, at most once per distinct extension prefab: reports the prefab's own built-in
        /// distance and the widened one, so the chosen extraAttachmentRange can be checked against
        /// real numbers in LogOutput.log and retuned from evidence.
        /// </summary>
        internal static void LogOnce(string prefabName, float baseRange, float newRange)
        {
            try
            {
                if (EilifPathsPlugin.Log == null) return;
                string key = prefabName ?? "?";
                if (Reported.Contains(key)) return;
                Reported.Add(key);
                EilifPathsPlugin.Log.LogInfo(
                    "[EilifPaths] workstation attachment '" + key + "': reach " +
                    baseRange.ToString("0.##", CultureInfo.InvariantCulture) + "m -> " +
                    newRange.ToString("0.##", CultureInfo.InvariantCulture) + "m.");
            }
            catch { /* diagnostics must never affect the patch */ }
        }
    }

    /// <summary>
    /// Postfix on the private Unity message <c>StationExtension.Awake()</c>. Widens this instance's
    /// <c>m_maxStationDistance</c>; on any error it leaves the vanilla value untouched.
    /// </summary>
    [HarmonyPatch(typeof(StationExtension), "Awake")]
    internal static class Patch_StationExtension_Awake
    {
        private static void Postfix(StationExtension __instance)
        {
            try
            {
                ConfigEntry<float> cfg = StationRange.ExtraRange;
                if (cfg == null) return;                    // config not bound yet -> vanilla
                float extra = cfg.Value;
                if (!StationRange.IsActive(extra)) return;  // 0 / negative / NaN -> vanilla
                if (__instance == null) return;             // nothing to widen -> vanilla

                float baseRange = __instance.m_maxStationDistance;
                if (float.IsNaN(baseRange) || float.IsInfinity(baseRange)) return;

                float widened = baseRange + extra;
                __instance.m_maxStationDistance = widened;

                StationRange.LogOnce(CleanName(__instance.name), baseRange, widened);
            }
            catch (Exception ex)
            {
                try
                {
                    if (EilifPathsPlugin.Log != null)
                        EilifPathsPlugin.Log.LogWarning(
                            "[EilifPaths] workstation attachment range failed, using vanilla: " + ex.Message);
                }
                catch { /* logging must never throw out of a patch */ }
            }
        }

        // Instantiated objects are named "piece_workbench_ext1(Clone)" - trim the suffix for the log.
        private static string CleanName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "?";
            int i = name.IndexOf("(Clone)", StringComparison.Ordinal);
            return i > 0 ? name.Substring(0, i) : name;
        }
    }
}
