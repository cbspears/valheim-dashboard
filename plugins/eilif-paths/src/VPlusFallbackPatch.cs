using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace EilifPaths
{
    /// <summary>
    /// CLIENT-SIDE stand-in for the ValheimPlus comforts the crew would lose if V+ has no 1.0 build.
    /// Everything here ships OFF (<c>[VPlusFallback] Enabled = false</c>) and is meant to be switched
    /// on only once ValheimPlus is actually gone from the pack.
    ///
    /// WHY THESE LIVE ON THE CLIENT. Valheim computes an object's behaviour on whichever machine OWNS
    /// that object's ZDO, and for a fireplace you lit, a tree you felled, a bush you picked or a
    /// workbench you built, that machine is your own game — not the dedicated server. The server never
    /// runs Fireplace.UpdateFireplace, never rolls a drop table, never places a station extension.
    /// That is why the whole of this file ships in the pack rather than on the box; the one V+ setting
    /// that genuinely is server-side (the 10-player cap) is in Eilif Companion's [ServerFallback]
    /// instead.
    ///
    /// SCOPE — mirrored from the live server's valheim_plus.cfg, section by section:
    ///
    ///   [FireSource] fires/torches       -> InfiniteFireplaceFuel
    ///   [Oven] infiniteFuel              -> InfiniteOvenFuel
    ///   [HotTub] infiniteFuel            -> InfiniteHotTubFuel
    ///   [ShieldGenerator] infiniteFuel   -> InfiniteShieldGeneratorFuel
    ///   [Workbench] workbenchRange 30    -> StationBuildRange
    ///   [Workbench] workbenchAttachmentRange 20 -> StationAttachmentRange
    ///   [Workbench] disableRoofCheck     -> DisableStationRoofCheck
    ///   [Gathering] every material 30    -> GatheringBonusPercent
    ///   [Pickable] every category 30     -> PickableBonusPercent
    ///   [LootDrop] lootDropAmountMultiplier 30 -> LootDropBonusPercent
    ///   [Map] shareMapProgression        -> ShareExploration (see the note on that key)
    ///
    /// DELIBERATELY NOT MIRRORED, with reasons that are worth keeping:
    ///
    ///   * [Chat] shoutDistance / pingDistance — Charlie's call; vanilla shout range is the fallback.
    ///   * [Gathering] dropChance — the live cfg has it at 0, i.e. V+ already does nothing with it.
    ///   * [LootDrop] lootDropChanceMultiplier — also 0 in the live cfg.
    ///   * [Map] exploreRadius = 100 — this is a NO-OP. Vanilla 0.221.12 declares
    ///     `public float m_exploreRadius = 100f;` on Minimap, and V+ simply passes its own 100 in
    ///     place of that field. Setting it to 100 changes nothing, so nothing is lost when V+ goes.
    ///   * [Map] shareAllPins — DEAD CODE in ValheimPlus 0.9.17.1. Its Minimap.AddPin postfix is
    ///     gated on `shareablePins.Contains(__result.m_type)`, and `shareablePins` is declared as
    ///     `new List&lt;PinType&gt;()` and never added to anywhere in the assembly (two references in
    ///     the whole DLL: the declaration and that Contains call). Pins are not being shared today,
    ///     so there is nothing to replace. If the crew wants pin sharing it is a NEW feature, not a
    ///     fallback, and it needs its own design.
    ///
    /// NOT REPRODUCED, AND THESE ONES ARE A REAL LOSS. The live valheim_plus.cfg has 17 sections at
    /// enabled = true. This file covers 10 of them, [Chat] is the disclosed skip above, and [Hud] is
    /// at all-default values so it loses nothing. That leaves FIVE enabled sections with real
    /// non-default settings that simply go away with V+, and they are listed here so nobody reads the
    /// coverage above as complete:
    ///
    ///   * [Bed] sleepWithoutSpawn = true. Sleep in a bed you have not claimed. This is what makes
    ///     group sleep work without everyone owning a bed.
    ///   * [Building] enableAreaRepair = true, areaRepairRadius = 7.5. One hammer swing repairs
    ///     everything within 7.5 m instead of the single piece under the cursor.
    ///   * [Building] noWeatherDamage = true. Rain and water erosion stop damaging structures.
    ///   * [Building] alwaysDropResources = true, alwaysDropExcludedResources = true. Deconstructing
    ///     returns full materials, including pieces the devs marked "do not drop".
    ///   * [Building] noInvalidPlacementRestriction = true, maximumPlacementDistance = 12
    ///     (Player.m_maxPlaceDistance is 5 in vanilla), pieceComfortRadius = 20
    ///     (SE_Rested.c_ComfortRadius is 10 in vanilla).
    ///   * [Camera] cameraMaximumZoomDistance = 100 and cameraBoatMaximumZoomDistance = 100
    ///     (vanilla 6), cameraFOV = 75 (vanilla 65).
    ///   * [Items] itemsFloatInWater = true. Dropped items float instead of sinking.
    ///   * [GridAlignment] enabled = true. LeftAlt snap-to-grid placement, F7 / F6 to toggle.
    ///
    /// Ranked by what the crew notices first: area repair, no weather damage, sleep-without-spawn.
    /// Each of the first three is a small client-side patch of the same shape as the ones in this
    /// file, so a 1.5.1 could add them. None of it was built two days before launch on a guess about
    /// what matters. It is Charlie's call, and it is written up in README.md and PACK.md as well.
    ///
    /// One thing that is NOT a loss, despite looking like one: [Chat] forcedCase = true on this
    /// server means V+ RETURNS EARLY out of its Chat_AddInworldText transpiler and leaves vanilla's
    /// case conversion alone. Shouts already arrive uppercase today, and will still arrive uppercase
    /// without V+. Nothing changes.
    ///
    /// NO DOUBLE-APPLY. Three guards, because "30% gathering" applied twice is 69%, not 30%:
    ///   1. the config gate: everything below early-returns when Enabled is false, and the patch
    ///      classes are then never applied at all, so the patched methods keep vanilla IL;
    ///   2. <see cref="Refuse"/>: if ValheimPlus is present the whole section refuses to apply even
    ///      when Enabled is true, and says so loudly in the log;
    ///   3. <see cref="Recheck"/>: the same question asked again a few seconds into the session,
    ///      because guard 2 can only see what is on disk under a recognisable name.
    /// See <see cref="DetectValheimPlus"/> for how presence is decided and why it takes two tests.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see the comment above BindSurface(...) in
    /// EilifPathsPlugin.cs. The game's net462 Mono runtime ships no ValueTuple and a reference to it
    /// makes the plugin fail to load SILENTLY.
    /// </summary>
    internal static class VPlusFallback
    {
        internal const string Section = "VPlusFallback";

        // ValheimPlus identifies itself two ways, and BOTH are checked (see DetectValheimPlus):
        // its BepInEx GUID, which a fork keeps, and its DLL name, which a fork may not.
        private const string ValheimPlusGuid = "org.bepinex.plugins.valheim_plus";
        private const string ValheimPlusDllPrefix = "valheimplus";

        // ValheimPlus's own default for [Workbench] workbenchAttachmentRange, and the value on the
        // live server. Vanilla StationExtension prefabs carry 5 m.
        internal const float VanillaAttachmentRange = 5f;

        internal static ConfigEntry<bool> Enabled;
        internal static ConfigEntry<bool> InfiniteFireplaceFuel;
        internal static ConfigEntry<bool> InfiniteOvenFuel;
        internal static ConfigEntry<bool> InfiniteHotTubFuel;
        internal static ConfigEntry<bool> InfiniteShieldGeneratorFuel;
        internal static ConfigEntry<float> StationBuildRange;
        internal static ConfigEntry<float> StationAttachmentRange;
        internal static ConfigEntry<bool> DisableStationRoofCheck;
        internal static ConfigEntry<float> GatheringBonusPercent;
        internal static ConfigEntry<float> PickableBonusPercent;
        internal static ConfigEntry<float> LootDropBonusPercent;
        internal static ConfigEntry<bool> ShareExploration;
        internal static ConfigEntry<float> ShareExplorationRadius;

        internal static bool ValheimPlusPresent { get; private set; }

        /// <summary>What actually matched, for the log. Null while no ValheimPlus has been seen.</summary>
        internal static string ValheimPlusEvidence { get; private set; }

        internal static void Bind(ConfigFile config)
        {
            Enabled = config.Bind(Section, "Enabled", false,
                "Master switch for the ValheimPlus stand-in features. Ships OFF. Turn it on ONLY when " +
                "ValheimPlus is not in the pack: with V+ installed these would stack on top of it and " +
                "double every multiplier. Nothing in this section does anything while it is false.");

            InfiniteFireplaceFuel = config.Bind(Section, "InfiniteFireplaceFuel", true,
                "Campfires, hearths, bonfires, standing and wall torches, braziers never burn out. " +
                "Mirrors ValheimPlus [FireSource] fires = true / torches = true. Needs Enabled = true.");
            InfiniteOvenFuel = config.Bind(Section, "InfiniteOvenFuel", true,
                "The stone oven never burns through its coal. Mirrors ValheimPlus [Oven] infiniteFuel. " +
                "Needs Enabled = true.");
            InfiniteHotTubFuel = config.Bind(Section, "InfiniteHotTubFuel", true,
                "The hot tub stays hot without wood. Mirrors ValheimPlus [HotTub] infiniteFuel. Needs " +
                "Enabled = true.");
            InfiniteShieldGeneratorFuel = config.Bind(Section, "InfiniteShieldGeneratorFuel", true,
                "The Ashlands shield generator never runs down. Mirrors ValheimPlus [ShieldGenerator] " +
                "infiniteFuel. Needs Enabled = true.");

            StationBuildRange = config.Bind(Section, "StationBuildRange", 30f,
                "How far from a crafting station you may build, in metres, for every station type. " +
                "Vanilla is 10. Mirrors ValheimPlus [Workbench] workbenchRange = 30. This also moves " +
                "the station's no-monsters-spawn area to match, exactly as V+ did. 0 = leave vanilla " +
                "alone. Needs Enabled = true.");
            StationAttachmentRange = config.Bind(Section, "StationAttachmentRange", 20f,
                "How far a station upgrade may sit from its station BEFORE the [Workstation] " +
                "extraAttachmentRange bonus is added on top. Vanilla prefabs carry 5. Mirrors " +
                "ValheimPlus [Workbench] workbenchAttachmentRange = 20, so with the shipped " +
                "extraAttachmentRange of 10 the total is 30 m, the same reach the crew has today with " +
                "V+ installed. 0 = leave the prefab value alone and let extraAttachmentRange do all the " +
                "work. Needs Enabled = true.");
            DisableStationRoofCheck = config.Bind(Section, "DisableStationRoofCheck", true,
                "Crafting stations work in the open, no roof needed. Mirrors ValheimPlus [Workbench] " +
                "disableRoofCheck. Needs Enabled = true.");

            GatheringBonusPercent = config.Bind(Section, "GatheringBonusPercent", 30f,
                "Extra percent of wood, stone, ore, scrap and the other gathered materials from trees, " +
                "rocks and ore veins. 30 = 30% more, and a fractional bonus is rolled per item, so 30% " +
                "means each item has a 30% chance of a second one. Mirrors ValheimPlus [Gathering] with " +
                "every material at 30, and covers the SAME material list V+ covered, nothing wider. " +
                "0 = vanilla. Needs Enabled = true.");
            PickableBonusPercent = config.Bind(Section, "PickableBonusPercent", 30f,
                "Extra percent from anything you pick by hand: berries, mushrooms, carrots, thistle, " +
                "flint, stone, surtling cores, amber. Mirrors ValheimPlus [Pickable] with every category " +
                "at 30. Quest items (dragon eggs, withered bones, goblin totems) are excluded, as they " +
                "were in V+. 0 = vanilla. Needs Enabled = true.");
            LootDropBonusPercent = config.Bind(Section, "LootDropBonusPercent", 30f,
                "Extra percent on the amount of loot a killed creature drops. Mirrors ValheimPlus " +
                "[LootDrop] lootDropAmountMultiplier = 30. NOTE this does very little on small drops: " +
                "V+ truncates, so a 1-to-2 drop stays 1-to-2. Kept identical on purpose. 0 = vanilla. " +
                "Needs Enabled = true.");

            ShareExploration = config.Bind(Section, "ShareExploration", true,
                "Your map fills in around every other viking who is online and showing their position, " +
                "not just around you. Mirrors the half of ValheimPlus [Map] shareMapProgression that " +
                "actually runs on a dedicated server. It does NOT restore V+'s stored server-side map: " +
                "that half needs a Minimap on the server, which a headless box does not have. Needs " +
                "Enabled = true.");
            ShareExplorationRadius = config.Bind(Section, "ShareExplorationRadius", 0f,
                "Metres of map revealed around each other player. 0 = use the game's own radius, which " +
                "is 100 in 0.221.12 and identical to what ValheimPlus [Map] exploreRadius was set to.");
        }

        /// <summary>
        /// Looks for a ValheimPlus install. Returns true when the whole section must be skipped.
        /// Called once, before any patch class is applied.
        /// </summary>
        internal static bool Refuse()
        {
            ValheimPlusEvidence = DetectValheimPlus();
            ValheimPlusPresent = ValheimPlusEvidence != null;
            if (!ValheimPlusPresent) return false;

            var log = EilifPathsPlugin.Log;
            if (log == null) return true;

            if (Enabled == null || !Enabled.Value)
            {
                // The normal, correct configuration while V+ still ships. Say what matched anyway,
                // so a FALSE positive (some other mod whose file name starts with "valheimplus")
                // is one grep away rather than an invisible reason the comforts went missing.
                log.LogInfo("[EilifPaths] VPlusFallback: ValheimPlus detected (" + ValheimPlusEvidence +
                            "); the section is off, which is correct while V+ provides these itself.");
                return true;
            }

            log.LogWarning("========================================================================");
            log.LogWarning("[EilifPaths] [VPlusFallback] Enabled=true but ValheimPlus is STILL installed");
            log.LogWarning("[EilifPaths] in this profile (" + ValheimPlusEvidence + "). These features");
            log.LogWarning("[EilifPaths] exist only to replace V+ when it is ABSENT. Running both would");
            log.LogWarning("[EilifPaths] stack fuel, range and gathering bonuses on top of each other.");
            log.LogWarning("[EilifPaths] REFUSING to apply. Either remove ValheimPlus from the pack, or");
            log.LogWarning("[EilifPaths] set [VPlusFallback] Enabled=false.");
            log.LogWarning("========================================================================");
            return true;
        }

        /// <summary>
        /// Two independent tests, because either one alone has a hole.
        ///
        /// 1. THE PLUGIN FOLDER, by file name. This is the one that works at Awake time, which is
        ///    when it has to: BepInEx loads ValheimPlus AFTER us on the live server, so the plugin
        ///    registry is not populated yet while we patch. It matches on a NORMALISED prefix rather
        ///    than the exact string "ValheimPlus.dll", because the crew's own build is already a fork
        ///    ("ValheimPlus_Grantapher_Temporary") and a 1.0 build may well be another.
        ///
        /// 2. THE BEPINEX PLUGIN REGISTRY, by GUID. A fork keeps the GUID even when it renames the
        ///    file, so this closes the hole test 1 leaves. It is useless during our own Awake and is
        ///    therefore re-run once from <see cref="Recheck"/> a few seconds into the session, by
        ///    which time Chainloader has finished.
        ///
        /// Returns a short human-readable description of what matched, or null for "not present".
        /// </summary>
        private static string DetectValheimPlus()
        {
            string byRegistry = DetectInPluginRegistry();
            if (byRegistry != null) return byRegistry;

            try
            {
                string dir = Paths.PluginPath;
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return null;
                string[] files = Directory.GetFiles(dir, "*.dll", SearchOption.AllDirectories);
                if (files == null) return null;
                for (int i = 0; i < files.Length; i++)
                {
                    string name = Path.GetFileNameWithoutExtension(files[i]);
                    if (Normalise(name).StartsWith(ValheimPlusDllPrefix, StringComparison.Ordinal))
                        return Path.GetFileName(files[i]);
                }
                return null;
            }
            catch (Exception ex)
            {
                if (EilifPathsPlugin.Log != null)
                    EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusFallback: could not scan the plugin " +
                                                    "folder for ValheimPlus (" + ex.Message + "); assuming absent.");
                return null;
            }
        }

        private static string DetectInPluginRegistry()
        {
            try
            {
                var infos = Chainloader.PluginInfos;
                if (infos == null) return null;
                if (infos.ContainsKey(ValheimPlusGuid)) return "plugin GUID " + ValheimPlusGuid;
                return null;
            }
            catch { return null; }
        }

        /// <summary>Lowercase, letters and digits only, so "ValheimPlus_Grantapher_Temporary" reduces
        /// to "valheimplusgrantaphertemporary" and still matches the prefix.</summary>
        private static string Normalise(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            var sb = new System.Text.StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c >= 'A' && c <= 'Z') sb.Append((char)(c + 32));
                else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
            }
            return sb.ToString();
        }

        // ---- The late re-check ---------------------------------------------------------------
        //
        // Awake can only see the plugin FOLDER. If a 1.0 ValheimPlus ships under a file name the
        // prefix test misses, the folder scan says "absent", we apply, and V+ applies too: the three
        // multiplicative bonuses (gathering, picking, loot) would then be 1.3 x 1.3 = 1.69 with
        // nothing in the log to say so. So the registry test is run ONCE more a few seconds in, when
        // Chainloader has finished loading every plugin and the GUID is visible.
        //
        // A late flip genuinely neutralises the features that matter: every one of them asks Active
        // (through On / Pct / Metres) on EVERY call, so from that moment the percentage bonuses are
        // vanilla again. The handful of "set" effects already applied to spawned objects stay put,
        // and that is harmless: V+ sets those to the SAME values (30 m build range, 20 m attachment
        // range, infinite fuel true), so they are idempotent rather than cumulative.

        private const float RecheckDelaySeconds = 8f;
        private static float _recheckAccum;
        private static bool _recheckDone;

        internal static void Recheck(float dt)
        {
            if (_recheckDone) return;
            if (ValheimPlusPresent) { _recheckDone = true; return; }

            _recheckAccum += dt;
            if (_recheckAccum < RecheckDelaySeconds) return;
            _recheckDone = true;

            string evidence = DetectInPluginRegistry();
            if (evidence == null) return;

            ValheimPlusEvidence = evidence;
            ValheimPlusPresent = true;

            if (Enabled == null || !Enabled.Value) return;

            var log = EilifPathsPlugin.Log;
            if (log == null) return;
            log.LogError("========================================================================");
            log.LogError("[EilifPaths] ValheimPlus IS loaded after all (" + evidence + ") but its DLL");
            log.LogError("[EilifPaths] file name did not look like ValheimPlus, so [VPlusFallback] had");
            log.LogError("[EilifPaths] already applied. Every percentage bonus is switched back to");
            log.LogError("[EilifPaths] vanilla NOW so gathering, picking and loot cannot double up.");
            log.LogError("[EilifPaths] Set [VPlusFallback] Enabled=false, or drop ValheimPlus.");
            log.LogError("========================================================================");
        }

        /// <summary>Master gate every patch below asks first. Cheap, never throws.</summary>
        internal static bool Active
        {
            get
            {
                try { return Enabled != null && Enabled.Value && !ValheimPlusPresent; }
                catch { return false; }
            }
        }

        internal static bool On(ConfigEntry<bool> entry)
        {
            return Active && entry != null && entry.Value;
        }

        /// <summary>A percent knob is live only when the section is on and the value is a usable number.</summary>
        internal static bool Pct(ConfigEntry<float> entry, out float percent)
        {
            percent = 0f;
            if (!Active || entry == null) return false;
            float v = entry.Value;
            if (v == 0f || float.IsNaN(v) || float.IsInfinity(v)) return false;
            percent = v;
            return true;
        }

        internal static bool Metres(ConfigEntry<float> entry, out float metres)
        {
            metres = 0f;
            if (!Active || entry == null) return false;
            float v = entry.Value;
            if (!(v > 0f) || float.IsNaN(v) || float.IsInfinity(v)) return false;
            metres = v;
            return true;
        }

        // ---- ValheimPlus's arithmetic, reproduced -------------------------------------------

        /// <summary>
        /// ValheimPlus Helper.applyModifierValue, verbatim:
        ///   <c>return (value &lt;= -100f) ? 0f : (targetValue + targetValue / 100f * value);</c>
        /// </summary>
        internal static float ApplyPercent(float target, float percent)
        {
            if (percent <= -100f) return 0f;
            return target + target / 100f * percent;
        }

        /// <summary>
        /// ValheimPlus Helper.applyModifierValueWithChance: take the whole part, then roll the
        /// fractional part as the chance of one more. V+ writes it as
        ///   <c>num2 + ((num - num2) &gt; 1.0 - new Random().NextDouble() ? 1 : 0)</c>
        /// which is "chance = the fraction". We keep the RULE and change only the RNG: V+ constructs
        /// a fresh <c>System.Random</c> per call, and on Mono that is seeded from Environment.TickCount,
        /// so several rolls inside the same millisecond — exactly what felling one tree does — reuse
        /// the same seed and come out correlated. UnityEngine.Random is the game's own generator, is
        /// main-thread only (every caller here is), and has no such tie.
        /// </summary>
        internal static int ApplyPercentWithChance(float target, float percent)
        {
            float scaled = ApplyPercent(target, percent);
            if (scaled <= 0f) return 0;
            int whole = (int)Math.Floor(scaled);
            float fraction = scaled - whole;
            if (fraction > 0f && UnityEngine.Random.value < fraction) whole++;
            return whole;
        }

        // ---- Diagnostics --------------------------------------------------------------------

        private static readonly List<string> Applied = new List<string>();
        private static readonly HashSet<string> ReportedOnce = new HashSet<string>();

        internal static void Note(string line)
        {
            Applied.Add(line);
        }

        internal static void Warn(string line)
        {
            try
            {
                if (EilifPathsPlugin.Log != null)
                    EilifPathsPlugin.Log.LogWarning("[EilifPaths] VPlusFallback: " + line);
            }
            catch { }
        }

        /// <summary>At most one line per distinct key, so a per-instance diagnostic cannot spam.</summary>
        internal static void InfoOnce(string key, string line)
        {
            try
            {
                if (EilifPathsPlugin.Log == null) return;
                if (ReportedOnce.Contains(key)) return;
                ReportedOnce.Add(key);
                EilifPathsPlugin.Log.LogInfo("[EilifPaths] VPlusFallback: " + line);
            }
            catch { }
        }

        internal static string F(float v) => v.ToString("0.##", CultureInfo.InvariantCulture);

        /// <summary>Builds the enabled-feature list. Called once, after patching, from Awake.</summary>
        internal static void Report()
        {
            var log = EilifPathsPlugin.Log;
            if (log == null) return;

            if (!Active)
            {
                if (ValheimPlusPresent)
                {
                    // Off BECAUSE ValheimPlus is here to do the job. Nothing is missing.
                    log.LogInfo("[EilifPaths] VPlusFallback: disabled (ValheimPlus present).");
                    return;
                }

                // Off with NOTHING providing these. This is the state that costs the crew the
                // comforts without saying so, so it is a warning with the consequence spelled out
                // rather than a bland "disabled" line. Greppable on purpose.
                log.LogWarning("[EilifPaths] VPlusFallback: OFF and no ValheimPlus installed. Infinite " +
                               "fuel, the 30m station build range, no-roof crafting and the +30% " +
                               "gathering, picking and loot bonuses are NOT active. Set " +
                               "[VPlusFallback] Enabled = true in net.eilif.paths.cfg to restore them.");
                return;
            }

            if (On(InfiniteFireplaceFuel)) Note("fires and torches never burn out.");
            if (On(InfiniteOvenFuel)) Note("oven fuel never runs down.");
            if (On(InfiniteHotTubFuel)) Note("hot tub fuel never runs down.");
            if (On(InfiniteShieldGeneratorFuel)) Note("shield generator fuel never runs down.");

            float m;
            if (Metres(StationBuildRange, out m))
                Note("station build range " + F(m) + "m (vanilla 10).");
            if (Metres(StationAttachmentRange, out m))
                Note("station attachment range set to " + F(m) + "m before [Workstation] " +
                     "extraAttachmentRange of " + StationRange.Describe() + " is added on top.");
            if (On(DisableStationRoofCheck)) Note("stations work without a roof.");

            float p;
            if (Pct(GatheringBonusPercent, out p)) Note("gathering +" + F(p) + "%.");
            if (Pct(PickableBonusPercent, out p)) Note("picking +" + F(p) + "%.");
            if (Pct(LootDropBonusPercent, out p)) Note("creature loot amount +" + F(p) + "%.");
            if (On(ShareExploration)) Note("map fills in around every online viking.");

            if (Applied.Count == 0)
            {
                log.LogInfo("[EilifPaths] VPlusFallback: on, but every individual feature is off.");
                return;
            }
            foreach (string line in Applied)
                log.LogInfo("[EilifPaths] VPlusFallback: " + line);
        }

        // ---- Shared reflection handles ------------------------------------------------------
        //
        // Every one of these is a PRIVATE vanilla member. ValheimPlus compiles against a publicised
        // assembly_valheim and can just touch them; we compile against the shipped one, so they go
        // through AccessTools. Each is resolved once, and a null result degrades that one feature to
        // vanilla with a warning instead of throwing inside a patch.

        private static bool _nviewRefsTried;
        internal static AccessTools.FieldRef<CookingStation, ZNetView> CookingStationNView;
        internal static AccessTools.FieldRef<Smelter, ZNetView> SmelterNView;
        internal static AccessTools.FieldRef<ShieldGenerator, ZNetView> ShieldGeneratorNView;

        internal static void ResolveNViewRefs()
        {
            if (_nviewRefsTried) return;
            _nviewRefsTried = true;
            try { CookingStationNView = AccessTools.FieldRefAccess<CookingStation, ZNetView>("m_nview"); }
            catch (Exception ex) { Warn("CookingStation.m_nview not reachable (" + ex.Message + "); oven fuel stays vanilla."); }
            try { SmelterNView = AccessTools.FieldRefAccess<Smelter, ZNetView>("m_nview"); }
            catch (Exception ex) { Warn("Smelter.m_nview not reachable (" + ex.Message + "); hot tub fuel stays vanilla."); }
            try { ShieldGeneratorNView = AccessTools.FieldRefAccess<ShieldGenerator, ZNetView>("m_nview"); }
            catch (Exception ex) { Warn("ShieldGenerator.m_nview not reachable (" + ex.Message + "); shield fuel stays vanilla."); }
        }

        /// <summary>
        /// Tops a fuel-burning piece back up to full by writing its ZDO directly. All four fuel
        /// consumers keep the same state in the same place — vanilla's own SetFuel bodies are
        /// <c>m_nview.GetZDO().Set(ZDOVars.s_fuel, fuel)</c> — but SetFuel itself is private on every
        /// one of them, so we write the field they write. Owner only: a ZDO write from a non-owner is
        /// local and gets stomped by the next sync.
        ///
        /// <paramref name="topUpBelow"/> is the level under which we bother writing. Event-driven
        /// callers pass <paramref name="maxFuel"/> (refill the moment anything is spent); the two
        /// callers that sit on a 1 Hz tick pass <see cref="PeriodicTopUpLevel"/> instead — see the
        /// note there for why that matters.
        /// </summary>
        internal static void FillFuel(ZNetView nview, float maxFuel, float topUpBelow, string diagKey, string diagText)
        {
            if (nview == null || !nview.IsValid() || !nview.IsOwner()) return;
            ZDO zdo = nview.GetZDO();
            if (zdo == null) return;
            if (zdo.GetFloat(ZDOVars.s_fuel) >= topUpBelow) return;
            zdo.Set(ZDOVars.s_fuel, maxFuel);
            InfoOnce(diagKey, diagText);
        }

        /// <summary>
        /// The refill line for a station tended from a once-per-second tick (the oven and the hot
        /// tub). VERIFIED BY DECOMPILE, and it is not an arbitrary fudge: vanilla's own "this tank is
        /// full, you cannot add more" test is <c>GetFuel() &gt; (float)(m_maxFuel - 1)</c>, in both
        /// CookingStation.OnAddFuelSwitch and Smelter.OnAddFuel, and both hover texts print
        /// <c>Mathf.Ceil(fuel)</c> out of m_maxFuel. So anything above maxFuel-1 both READS as a full
        /// tank to the player and REFUSES more fuel, exactly as an infinite one should.
        ///
        /// WHY NOT JUST "below max". Because the write is not free. Vanilla's UpdateFuel already
        /// calls SetFuel every tick, and every tick our prefix saw fuel a hair under max and wrote it
        /// back, so an owner with a lit oven marked that ZDO dirty twice a second, forever, per
        /// station. ValheimPlus paid none of that (it filled the tank once in Awake), so this was a
        /// cost the fallback added rather than restored. At maxFuel-1 the oven's m_secPerFuel of 5000
        /// means one write roughly every 83 minutes per station instead of one a second, with no
        /// visible difference at all: Mathf.Ceil of anything in (9, 10] is still 10.
        ///
        /// The Max() floor is for a hypothetical one-unit tank, where maxFuel-1 would be 0 and the
        /// piece would only be refilled once it had already gone out.
        /// </summary>
        internal static float PeriodicTopUpLevel(float maxFuel)
        {
            float level = maxFuel - 1f;
            float half = maxFuel * 0.5f;
            return level < half ? half : level;
        }

        // ---- [Map] ShareExploration ----------------------------------------------------------
        //
        // VERIFIED BY DECOMPILE. Vanilla only ever reveals map around YOU:
        //
        //   private void UpdateExplore(float dt, Player player)
        //   {
        //       m_exploreTimer += Time.deltaTime;
        //       if (m_exploreTimer > m_exploreInterval)   // m_exploreInterval = 2f
        //       {
        //           m_exploreTimer = 0f;
        //           Explore(player.transform.position, m_exploreRadius);   // m_exploreRadius = 100f
        //       }
        //   }
        //
        // ValheimPlus's Minimap.UpdateExplore prefix (ChangeMapBehavior) adds, when shareMapProgression
        // is on, one Explore call per entry of ZNet.instance.m_players — the list every client already
        // receives, carrying each player's m_position when their position is public. That loop is
        // entirely client-side: no server support, no custom RPC, no stored map. It is the half of
        // shareMapProgression that works against a dedicated server, and it is what this reproduces.
        //
        // We drive it from the plugin's own 0.4s poll rather than by patching UpdateExplore, because
        // the vanilla method resets its timer in the middle of the body and a prefix cannot see which
        // side of that reset it is on without duplicating the timer. Our own 2s accumulator matches
        // m_exploreInterval and is trivially auditable.

        private static float _exploreAccum;
        private static bool _exploreTried;
        private static MethodInfo _exploreMethod;
        private static readonly object[] _exploreArgs = new object[2];
        private static AccessTools.FieldRef<ZNet, List<ZNet.PlayerInfo>> _playersRef;

        internal static void Tick(float dt)
        {
            // Runs regardless of ShareExploration: it is the anti-double-apply re-check, not a map
            // feature. One-shot, and free after it has fired.
            Recheck(dt);

            if (!On(ShareExploration)) return;

            _exploreAccum += dt;
            if (_exploreAccum < 2f) return;
            _exploreAccum = 0f;

            try
            {
                Minimap map = Minimap.instance;
                if (map == null || Player.m_localPlayer == null) return;
                ZNet net = ZNet.instance;
                if (net == null) return;

                if (!_exploreTried)
                {
                    _exploreTried = true;
                    _exploreMethod = AccessTools.Method(typeof(Minimap), "Explore",
                        new Type[] { typeof(Vector3), typeof(float) });
                    if (_exploreMethod == null)
                        Warn("Minimap.Explore(Vector3, float) not found; ShareExploration is inert.");
                    try { _playersRef = AccessTools.FieldRefAccess<ZNet, List<ZNet.PlayerInfo>>("m_players"); }
                    catch (Exception ex)
                    {
                        Warn("ZNet.m_players not reachable (" + ex.Message + "); ShareExploration is inert.");
                    }
                }
                if (_exploreMethod == null || _playersRef == null) return;

                List<ZNet.PlayerInfo> players = _playersRef(net);
                if (players == null || players.Count == 0) return;

                float radius = map.m_exploreRadius;
                if (ShareExplorationRadius != null && ShareExplorationRadius.Value > 0f)
                    radius = ShareExplorationRadius.Value;
                if (!(radius > 0f) || float.IsNaN(radius) || float.IsInfinity(radius)) return;

                Vector3 mine = Player.m_localPlayer.transform.position;
                for (int i = 0; i < players.Count; i++)
                {
                    // Position sharing is opt-out per player, and ZNet only FILLS m_position when the
                    // player has it public:
                    //   item.m_publicPosition = pkg.ReadBool();
                    //   if (item.m_publicPosition) { item.m_position = pkg.ReadVector3(); }
                    // PlayerInfo is a struct built with default(PlayerInfo), so a player who has
                    // turned their position off carries Vector3.zero, i.e. WORLD ORIGIN. Exploring
                    // there would quietly reveal spawn for everyone every 2s and would break the
                    // privacy setting rather than respect it, so skip them. (ValheimPlus loops the
                    // same list unfiltered; this is a deliberate, small improvement on it.)
                    if (!players[i].m_publicPosition) continue;

                    Vector3 pos = players[i].m_position;
                    // Vanilla already explores around us every 2s; skip anyone standing on top of us
                    // so we do not pay for the same pixel loop twice.
                    if ((pos - mine).sqrMagnitude < 1f) continue;
                    _exploreArgs[0] = pos;
                    _exploreArgs[1] = radius;
                    _exploreMethod.Invoke(map, _exploreArgs);
                }
            }
            catch (Exception ex)
            {
                Warn("ShareExploration pass failed (" + ex.Message + "); turning it off for this session.");
                _exploreMethod = null;
                _playersRef = null;
            }
        }
    }

    // =========================================================================================
    // [FireSource] — fires and torches
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. Fireplace already has the switch built in; nothing needs faking:
    ///
    ///   public bool m_infiniteFuel;
    ///
    ///   private void UpdateFireplace() {
    ///       ... if (IsBurning() &amp;&amp; !m_infiniteFuel &amp;&amp; flag) { /* burn a tick of fuel */ } ...
    ///   }
    ///
    ///   public bool IsBurning() {
    ///       ...
    ///       if (!(m_nview.GetZDO().GetFloat(ZDOVars.s_fuel) &gt; 0f)) { return m_infiniteFuel; }
    ///       return true;
    ///   }
    ///
    /// So one field covers both halves: fuel stops draining AND a fire sitting at zero fuel still
    /// counts as lit. ValheimPlus does exactly this in a Fireplace.Awake postfix, splitting torches
    /// from fires by prefab name; the live cfg has both true, so we set it for every fireplace and
    /// skip the name list. m_infiniteFuel is per-instance, set on the object this client spawned, and
    /// the burn loop only runs on the ZDO owner, so an owner with the flag never spends fuel.
    /// </summary>
    [HarmonyPatch(typeof(Fireplace), "Awake")]
    internal static class Patch_VPF_Fireplace_Awake
    {
        private static void Postfix(Fireplace __instance)
        {
            try
            {
                if (!VPlusFallback.On(VPlusFallback.InfiniteFireplaceFuel)) return;
                if (__instance == null) return;
                __instance.m_infiniteFuel = true;
                VPlusFallback.InfoOnce("fire", "fires and torches set to infinite fuel.");
            }
            catch (Exception ex) { VPlusFallback.Warn("fireplace fuel: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [Oven] — CookingStation with m_useFuel (the stone oven)
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. The oven is a CookingStation with <c>m_useFuel = true</c>:
    ///
    ///   private void UpdateCooking() {
    ///       if (!m_nview.IsValid()) return;
    ///       bool flag = (m_requireFire &amp;&amp; IsFireLit()) || (m_useFuel &amp;&amp; GetFuel() &gt; 0f);
    ///       if (m_nview.IsOwner()) { float deltaTime = GetDeltaTime(); if (flag) { UpdateFuel(deltaTime); ... } }
    ///       UpdateVisual(flag);
    ///   }
    ///   private void UpdateFuel(float dt) { if (m_useFuel) { ... SetFuel(fuel - dt / m_secPerFuel); } }
    ///   private void SetFuel(float fuel) { m_nview.GetZDO().Set(ZDOVars.s_fuel, fuel); }
    ///
    /// ValheimPlus uses two hooks — a CookingStation.Awake postfix that fills the tank, and an
    /// UpdateFuel prefix that zeroes dt. We use ONE, a prefix on UpdateCooking that tops the tank back
    /// to m_maxFuel, and that is deliberately not a straight copy: V+'s fill happens in Awake, which
    /// runs on whichever client streams the oven in, so an oven owned by somebody else and already
    /// empty never gets refilled and — with dt zeroed — can never be lit again either. Topping up in
    /// the owner's own periodic tick is self-healing and cannot leave a dead oven behind. With the
    /// tank always full, zeroing dt is redundant, so that hook is not needed at all.
    ///
    /// The top-up itself fires at <see cref="VPlusFallback.PeriodicTopUpLevel"/>, not every time fuel
    /// dips a hair below max, so a lit oven writes its ZDO about once every 83 minutes rather than
    /// once a second. Read the note on that method: the level is vanilla's own definition of "full",
    /// so nothing about this is visible in-game.
    /// </summary>
    [HarmonyPatch(typeof(CookingStation), "UpdateCooking")]
    internal static class Patch_VPF_CookingStation_UpdateCooking
    {
        private static void Prefix(CookingStation __instance)
        {
            try
            {
                if (!VPlusFallback.On(VPlusFallback.InfiniteOvenFuel)) return;
                if (__instance == null || !__instance.m_useFuel) return;

                VPlusFallback.ResolveNViewRefs();
                var refField = VPlusFallback.CookingStationNView;
                if (refField == null) return;

                float max = __instance.m_maxFuel;
                VPlusFallback.FillFuel(refField(__instance), max, VPlusFallback.PeriodicTopUpLevel(max),
                    "oven", "oven topped up to full fuel and held there.");
            }
            catch (Exception ex) { VPlusFallback.Warn("oven fuel: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [HotTub] — Smelter named "$piece_bathtub"
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. The hot tub is a Smelter, and Smelter burns fuel inside its own
    /// owner-gated tick:
    ///
    ///   private void UpdateSmelter() {
    ///       if (!m_nview.IsValid()) return;
    ///       UpdateRoof(); UpdateSmoke(); UpdateState();
    ///       if (!m_nview.IsOwner()) return;
    ///       ... while (accumulator &gt;= 1f) { ... if (m_maxFuel &gt; 0) { fuel -= num2 / num3; SetFuel(fuel); } ... }
    ///   }
    ///   private void SetFuel(float fuel) { if (m_nview.IsValid()) m_nview.GetZDO().Set(ZDOVars.s_fuel, fuel); }
    ///
    /// ValheimPlus reaches the same place — a Smelter.UpdateSmelter prefix that, for the piece whose
    /// m_name equals SmelterDefinitions.HotTubName ("$piece_bathtub"), calls SetFuel(m_maxFuel) before
    /// vanilla runs. Same hook here, writing the ZDO field SetFuel writes because SetFuel is private.
    /// Matching on m_name rather than on the prefab is what V+ does and is what keeps every other
    /// smelter — kiln, furnace, windmill, spinning wheel, eitr refinery — untouched.
    /// </summary>
    [HarmonyPatch(typeof(Smelter), "UpdateSmelter")]
    internal static class Patch_VPF_Smelter_UpdateSmelter
    {
        internal const string HotTubName = "$piece_bathtub";

        private static void Prefix(Smelter __instance)
        {
            try
            {
                if (!VPlusFallback.On(VPlusFallback.InfiniteHotTubFuel)) return;
                if (__instance == null || __instance.m_maxFuel <= 0) return;
                if (!string.Equals(__instance.m_name, HotTubName, StringComparison.Ordinal)) return;

                VPlusFallback.ResolveNViewRefs();
                var refField = VPlusFallback.SmelterNView;
                if (refField == null) return;

                float max = __instance.m_maxFuel;
                VPlusFallback.FillFuel(refField(__instance), max, VPlusFallback.PeriodicTopUpLevel(max),
                    "hottub", "hot tub topped up to full fuel and held there.");
            }
            catch (Exception ex) { VPlusFallback.Warn("hot tub fuel: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [ShieldGenerator]
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. The Ashlands shield generator spends fuel per hit absorbed:
    ///
    ///   public void OnProjectileHit(GameObject obj) {
    ///       ... if (m_fuelPerDamage &gt; 0f) { float num = m_fuelPerDamage * ...; SetFuel(GetFuel() - num); } ...
    ///   }
    ///   private void SetFuel(float fuel) { m_nview.InvokeRPC("RPC_SetFuel", fuel); }
    ///   private void RPC_SetFuel(long sender, float fuel) {
    ///       if (m_nview.IsValid() &amp;&amp; m_nview.IsOwner()) m_nview.GetZDO().Set(ZDOVars.s_fuel, Mathf.Max(fuel, 0f));
    ///   }
    ///
    /// ValheimPlus refills after each of the three events that can spend fuel — Start, OnProjectileHit
    /// and RPC_Attack — and that is mirrored here, one postfix each so a renamed method in 1.0 costs
    /// one hook rather than the feature. Rare enough that a periodic top-up would be wasted work.
    /// </summary>
    [HarmonyPatch(typeof(ShieldGenerator), "Start")]
    internal static class Patch_VPF_ShieldGenerator_Start
    {
        private static void Postfix(ShieldGenerator __instance) => ShieldFuel.Refill(__instance);
    }

    [HarmonyPatch(typeof(ShieldGenerator), "OnProjectileHit")]
    internal static class Patch_VPF_ShieldGenerator_OnProjectileHit
    {
        private static void Postfix(ShieldGenerator __instance) => ShieldFuel.Refill(__instance);
    }

    [HarmonyPatch(typeof(ShieldGenerator), "RPC_Attack")]
    internal static class Patch_VPF_ShieldGenerator_RPC_Attack
    {
        private static void Postfix(ShieldGenerator __instance) => ShieldFuel.Refill(__instance);
    }

    internal static class ShieldFuel
    {
        internal static void Refill(ShieldGenerator instance)
        {
            try
            {
                if (!VPlusFallback.On(VPlusFallback.InfiniteShieldGeneratorFuel)) return;
                if (instance == null || instance.m_maxFuel <= 0) return;

                VPlusFallback.ResolveNViewRefs();
                var refField = VPlusFallback.ShieldGeneratorNView;
                if (refField == null) return;

                // Event-driven, not polled: Start, OnProjectileHit and RPC_Attack are the only three
                // places fuel is spent, so refilling the instant anything is gone costs nothing and
                // keeps the piece exactly at max. That matters here in a way it does not for the oven:
                // ShieldGenerator gates its start on `fuel >= m_maxFuel` and drives a visual off
                // `fuel / m_maxFuel`, so this one wants the tank genuinely full, not merely full to
                // the nearest unit.
                float max = instance.m_maxFuel;
                VPlusFallback.FillFuel(refField(instance), max, max,
                    "shieldgen", "shield generator topped up to full fuel and held there.");
            }
            catch (Exception ex) { VPlusFallback.Warn("shield generator fuel: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [Workbench] workbenchRange + workbenchEnemySpawnRange
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. How far you may build from a station is one public field:
    ///
    ///   public float m_rangeBuild = 10f;
    ///   public float m_extraRangePerLevel;
    ///   public GameObject m_areaMarker;
    ///
    ///   private List&lt;StationExtension&gt; GetExtensions() {
    ///       ... m_buildRange = m_rangeBuild + (float)GetExtentionCount(false) * m_extraRangePerLevel; ...
    ///   }
    ///
    /// ValheimPlus sets it in a CraftingStation.Start prefix and then fixes up the three things that
    /// have to move with it: the ring projector's radius, the ring object's scale (authored for a 20 m
    /// ring, hence the /20), and the child EffectArea's SphereCollider — the PlayerBase area, which is
    /// what stops monsters spawning inside your base. Its helper is
    ///
    ///   EffectArea a = parent.GetComponentInChildren&lt;EffectArea&gt;();
    ///   if (a != null &amp;&amp; (a.m_type &amp; includedTypes) &gt; 0) {
    ///       SphereCollider c = a.GetComponent&lt;SphereCollider&gt;(); if (c != null) c.radius = newRadius;
    ///   }
    ///
    /// with includedTypes = (Type)4 = EffectArea.Type.PlayerBase, and newRadius =
    /// workbenchEnemySpawnRange when that is &gt; 0, otherwise workbenchRange. The live cfg leaves
    /// workbenchEnemySpawnRange at 0, so the no-spawn bubble tracks the build range — reproduced here.
    ///
    /// Note this deliberately covers EVERY crafting station, not just the workbench, exactly as the
    /// V+ patch does despite the config key's name.
    /// </summary>
    [HarmonyPatch(typeof(CraftingStation), "Start")]
    internal static class Patch_VPF_CraftingStation_Start
    {
        private static void Prefix(CraftingStation __instance)
        {
            try
            {
                float range;
                if (!VPlusFallback.Metres(VPlusFallback.StationBuildRange, out range)) return;
                if (__instance == null) return;

                float was = __instance.m_rangeBuild;
                __instance.m_rangeBuild = range;

                if (__instance.m_areaMarker != null)
                {
                    CircleProjector circle = __instance.m_areaMarker.GetComponent<CircleProjector>();
                    if (circle != null) circle.m_radius = range;
                    // The marker mesh is authored at a 20 m ring; V+ scales by range/20.
                    float scale = range / 20f;
                    __instance.m_areaMarker.transform.localScale = new Vector3(scale, 1f, scale);
                }

                ResizePlayerBaseArea(__instance, range);

                VPlusFallback.InfoOnce("station:" + (__instance.m_name ?? "?"),
                    "station '" + (__instance.m_name ?? "?") + "' build range " +
                    VPlusFallback.F(was) + "m -> " + VPlusFallback.F(range) + "m.");
            }
            catch (Exception ex) { VPlusFallback.Warn("station build range: " + ex.Message); }
        }

        private static void ResizePlayerBaseArea(CraftingStation station, float radius)
        {
            try
            {
                EffectArea area = station.GetComponentInChildren<EffectArea>();
                if (area == null) return;
                if ((area.m_type & EffectArea.Type.PlayerBase) == 0) return;
                SphereCollider sphere = area.GetComponent<SphereCollider>();
                if (sphere != null) sphere.radius = radius;
            }
            catch (Exception ex) { VPlusFallback.Warn("station no-spawn area: " + ex.Message); }
        }
    }

    /// <summary>
    /// VERIFIED BY DECOMPILE. The roof requirement is one public bool consulted at use time:
    ///
    ///   public bool m_craftRequireRoof = true;
    ///   public bool CheckUsable(Player player, bool showMessage) {
    ///       if (m_craftRequireRoof &amp;&amp; !player.NoCostCheat()) { ... "$msg_stationneedroof" ... return false; }
    ///       ...
    ///   }
    ///
    /// ValheimPlus clears the field in a CheckUsable prefix. Same hook, same field. Clearing it at the
    /// call site (rather than in Start) means a station that streamed in before the setting was
    /// changed still picks it up.
    /// </summary>
    [HarmonyPatch(typeof(CraftingStation), "CheckUsable")]
    internal static class Patch_VPF_CraftingStation_CheckUsable
    {
        private static void Prefix(CraftingStation __instance)
        {
            try
            {
                if (!VPlusFallback.On(VPlusFallback.DisableStationRoofCheck)) return;
                if (__instance == null || !__instance.m_craftRequireRoof) return;
                __instance.m_craftRequireRoof = false;
                VPlusFallback.InfoOnce("roof", "crafting stations no longer need a roof.");
            }
            catch (Exception ex) { VPlusFallback.Warn("station roof check: " + ex.Message); }
        }
    }

    /// <summary>
    /// [Workbench] workbenchAttachmentRange. ValheimPlus SETS StationExtension.m_maxStationDistance in
    /// a prefix on the same Awake this plugin already postfixes:
    ///
    ///   [HarmonyPatch(typeof(StationExtension), "Awake")]
    ///   public static void Prefix(ref float ___m_maxStationDistance) {
    ///       if (Configuration.Current.Workbench.IsEnabled)
    ///           ___m_maxStationDistance = Configuration.Current.Workbench.workbenchAttachmentRange;
    ///   }
    ///
    /// This is a prefix for the same reason: it must land BEFORE
    /// <see cref="Patch_StationExtension_Awake"/> adds [Workstation] extraAttachmentRange, so the two
    /// compose the way they do today. The arithmetic, spelled out, because it is the one number in
    /// this file that is easy to get wrong:
    ///
    ///   today, V+ alive:  5 (prefab) -&gt; V+ SETS 20 -&gt; EilifPaths ADDS 10 = 30 m
    ///   V+ gone, this on: 5 (prefab) -&gt; we SET 20 -&gt; EilifPaths ADDS 10 = 30 m
    ///   V+ gone, this off:5 (prefab) -&gt;              EilifPaths ADDS 10 = 15 m
    ///
    /// SET, never ADD. Adding 20 on top of the prefab's 5 and then 10 again would give 35 and quietly
    /// drift from what the crew is used to.
    /// </summary>
    [HarmonyPatch(typeof(StationExtension), "Awake")]
    internal static class Patch_VPF_StationExtension_Awake
    {
        private static void Prefix(StationExtension __instance)
        {
            try
            {
                float range;
                if (!VPlusFallback.Metres(VPlusFallback.StationAttachmentRange, out range)) return;
                if (__instance == null) return;
                __instance.m_maxStationDistance = range;
            }
            catch (Exception ex) { VPlusFallback.Warn("station attachment range: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [Gathering] — trees, rocks, ore veins
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. Every harvestable in the game funnels its yield through one private
    /// method, which is why one hook is enough:
    ///
    ///   public List&lt;GameObject&gt; GetDropList() { int amount = Random.Range(m_dropMin, m_dropMax + 1); return GetDropList(amount); }
    ///   private List&lt;GameObject&gt; GetDropList(int amount) { ... list.Add(item2.m_item) ... return list; }
    ///
    /// The list holds one GameObject per item to spawn, so "30% more wood" is literally "add a second
    /// copy of this entry 30% of the time". That is exactly what ValheimPlus's postfix on
    /// <c>DropTable.GetDropList(int)</c> does: for each entry it looks the prefab name up in a fixed
    /// table of eighteen material names, then appends <c>applyModifierValueWithChance(1f, percent)</c>
    /// copies of it.
    ///
    /// The prefab list below is V+'s, verbatim and complete. Keeping it — rather than boosting every
    /// drop — is what stops this from also inflating things V+ never touched (leather scraps, resin,
    /// trophies, boss drops), which would be a different game, not a fallback. One consequence worth
    /// knowing: the live cfg gives every one of the eighteen the same 30, so a single percent knob
    /// reproduces it exactly; if a per-material split is ever wanted this is where it goes.
    ///
    /// The names are the ones V+ matched on and they are prefab names, not display names:
    /// RoundLog is core wood and FlametalOreNew is the Ashlands flametal.
    /// </summary>
    [HarmonyPatch(typeof(DropTable), "GetDropList", new Type[] { typeof(int) })]
    internal static class Patch_VPF_DropTable_GetDropList
    {
        private static readonly HashSet<string> Materials = new HashSet<string>(StringComparer.Ordinal)
        {
            "Wood", "FineWood", "RoundLog", "ElderBark", "YggdrasilWood",
            "Stone", "BlackMarble", "Grausten", "Blackwood",
            "TinOre", "CopperOre", "CopperScrap", "IronScrap", "SilverOre", "FlametalOreNew",
            "Chitin", "Feathers", "ProustitePowder"
        };

        private static void Postfix(ref List<GameObject> __result)
        {
            try
            {
                float percent;
                if (!VPlusFallback.Pct(VPlusFallback.GatheringBonusPercent, out percent)) return;
                if (__result == null || __result.Count == 0) return;

                List<GameObject> widened = new List<GameObject>(__result.Count);
                for (int i = 0; i < __result.Count; i++)
                {
                    GameObject item = __result[i];
                    if (item == null) continue;
                    if (!Materials.Contains(item.name)) { widened.Add(item); continue; }

                    int copies = VPlusFallback.ApplyPercentWithChance(1f, percent);
                    for (int c = 0; c < copies; c++) widened.Add(item);
                }
                __result = widened;
            }
            catch (Exception ex) { VPlusFallback.Warn("gathering bonus: " + ex.Message); }
        }
    }

    // =========================================================================================
    // [Pickable] — berries, mushrooms, flint, cores
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. Picking resolves its count in one place, on the owner:
    ///
    ///   private void RPC_Pick(long sender, int bonus) {
    ///       if (!m_nview.IsOwner() || m_picked) return;
    ///       ...
    ///       int num = (m_dontScale ? m_amount : Mathf.Max(m_minAmountScaled, Game.instance.ScaleDrops(m_itemPrefab, m_amount)));
    ///       num += bonus;
    ///       int num2 = 0;
    ///       for (int i = 0; i &lt; num; i++) { Drop(m_itemPrefab, num2++, 1); }
    ///       ...
    ///   }
    ///
    /// ValheimPlus transpiles this, splicing its CalculateYield in after the first <c>stloc.1</c> so
    /// the modifier lands on <c>num</c>. We take a different route to the same number: a prefix that
    /// inflates the public field <c>m_amount</c> and a finalizer that puts it back. No IL, so nothing
    /// here can be broken by 1.0 reordering the method's locals — which is exactly the failure mode
    /// "insert after the first stloc.1" has.
    ///
    /// The two are arithmetically identical on this world. The only difference is that we scale before
    /// <c>Game.ScaleDrops</c> and V+ scales after, and ScaleDrops is
    ///
    ///   public int ScaleDrops(GameObject drop, int amount) { if (m_resourceRate != 1f) { ... } return amount; }
    ///
    /// i.e. the identity function unless the world's resource-rate modifier is set. The live world
    /// boots with "Setting world modifier: Resources-&gt;default", so m_resourceRate is 1 and the two
    /// orders agree exactly. If Charlie ever moves the world onto a non-default resource rate, the two
    /// would differ by the rounding of one multiply — worth knowing, not worth an IL patch.
    ///
    /// The category lists are ValheimPlus's, verbatim. Quest items (DragonEgg, WitheredBone,
    /// GoblinTotem) sat under V+'s [Pickable] questItems = 0 and are therefore excluded here too.
    /// </summary>
    [HarmonyPatch(typeof(Pickable), "RPC_Pick")]
    internal static class Patch_VPF_Pickable_RPC_Pick
    {
        // V+ [Pickable] edibles + flowersAndIngredients + materials + valuables + surtlingCores +
        // blackCores. All six were 30 on the live server, so they collapse into one set; questItems
        // was 0 and is deliberately absent.
        private static readonly HashSet<string> Boosted = new HashSet<string>(StringComparer.Ordinal)
        {
            // edibles
            "Carrot", "Blueberries", "Cloudberry", "Raspberry", "Mushroom", "MushroomBlue",
            "MushroomYellow", "MushroomMagecap", "MushroomJotunPuffs", "MushroomSmokePuff",
            "Fiddleheadfern", "Vineberry", "Onion",
            // flowers and ingredients
            "Barley", "CarrotSeeds", "Dandelion", "Flax", "Thistle", "TurnipSeeds", "Turnip",
            "OnionSeeds", "RoyalJelly", "VoltureEgg",
            // materials
            "BoneFragments", "Flint", "Stone", "Wood", "Crystal", "Tar", "WolfHairBundle", "WolfClaw",
            // valuables
            "Amber", "AmberPearl", "Coins", "Ruby",
            // cores
            "SurtlingCore", "BlackCore"
        };

        private static void Prefix(Pickable __instance, out int __state)
        {
            __state = int.MinValue; // sentinel: the finalizer restores nothing
            try
            {
                float percent;
                if (!VPlusFallback.Pct(VPlusFallback.PickableBonusPercent, out percent)) return;
                if (__instance == null || __instance.m_itemPrefab == null) return;
                if (!Boosted.Contains(__instance.m_itemPrefab.name)) return;

                int original = __instance.m_amount;
                if (original <= 0) return;

                int widened = VPlusFallback.ApplyPercentWithChance(original, percent);
                if (widened == original) return;

                __state = original;
                __instance.m_amount = widened;
            }
            catch (Exception ex)
            {
                __state = int.MinValue;
                VPlusFallback.Warn("picking bonus: " + ex.Message);
            }
        }

        // FINALIZER, NOT POSTFIX. A Harmony postfix is skipped when the original method throws;
        // only a finalizer runs on both paths. That distinction is the whole point here, because
        // m_amount is shared per-instance state: a throw inside vanilla RPC_Pick would otherwise
        // leave the bush inflated and the NEXT pick would inflate the inflated value (1.3 x 1.3).
        // Returning void means the original exception is still rethrown unchanged. Same convention
        // as ToolStaminaPatch.ScopeFinalizer.
        private static void Finalizer(Pickable __instance, int __state)
        {
            try
            {
                if (__state == int.MinValue || __instance == null) return;
                __instance.m_amount = __state;
            }
            catch { }
        }
    }

    // =========================================================================================
    // [LootDrop] — what a killed creature drops
    // =========================================================================================

    /// <summary>
    /// VERIFIED BY DECOMPILE. Creature loot is rolled in one public method off the death handler:
    ///
    ///   public List&lt;Drop&gt; m_drops;
    ///   public List&lt;KeyValuePair&lt;GameObject, int&gt;&gt; GenerateDropList() {
    ///       foreach (Drop drop in m_drops) {
    ///           ... if (Random.value &lt;= num2) {
    ///                   int num3 = (drop.m_dontScale ? Random.Range(drop.m_amountMin, drop.m_amountMax)
    ///                                                : Game.instance.ScaleDrops(drop.m_prefab, drop.m_amountMin, drop.m_amountMax));
    ///                   ... }
    ///       }
    ///   }
    ///
    /// ValheimPlus swaps m_drops for a scaled copy in a prefix and puts the original back in a
    /// postfix, so the roll itself is untouched and only the min/max it draws between move. That is
    /// mirrored exactly, including V+'s rounding:
    ///
    ///   m_amountMin = (int)Helper.applyModifierValue(originalDrop.m_amountMin, multiplier)
    ///
    /// — a plain cast, i.e. truncation. This matters and is easy to mistake for a bug: at 30%, a drop
    /// of 1-to-2 becomes (int)1.3 to (int)2.6 = 1 to 2, unchanged. The bonus only bites once a drop's
    /// min or max is at least 4. It is kept as-is so the numbers match what the crew saw with V+.
    /// [LootDrop] lootDropChanceMultiplier was 0 on the live server, so drop CHANCE is not touched.
    ///
    /// The swap is by reference and the restore runs from a FINALIZER, so an exception inside vanilla
    /// cannot leave a creature prefab permanently carrying inflated drops. A postfix would not do:
    /// Harmony skips postfixes when the original throws.
    /// </summary>
    [HarmonyPatch(typeof(CharacterDrop), "GenerateDropList")]
    internal static class Patch_VPF_CharacterDrop_GenerateDropList
    {
        private static void Prefix(CharacterDrop __instance, out List<CharacterDrop.Drop> __state)
        {
            __state = null;
            try
            {
                float percent;
                if (!VPlusFallback.Pct(VPlusFallback.LootDropBonusPercent, out percent)) return;
                if (__instance == null || __instance.m_drops == null || __instance.m_drops.Count == 0) return;

                List<CharacterDrop.Drop> original = __instance.m_drops;
                List<CharacterDrop.Drop> widened = new List<CharacterDrop.Drop>(original.Count);
                for (int i = 0; i < original.Count; i++)
                {
                    CharacterDrop.Drop d = original[i];
                    if (d == null || d.m_prefab == null) { widened.Add(d); continue; }

                    widened.Add(new CharacterDrop.Drop
                    {
                        m_prefab = d.m_prefab,
                        m_amountMin = (int)VPlusFallback.ApplyPercent(d.m_amountMin, percent),
                        m_amountMax = (int)VPlusFallback.ApplyPercent(d.m_amountMax, percent),
                        m_chance = d.m_chance,
                        m_onePerPlayer = d.m_onePerPlayer,
                        m_levelMultiplier = d.m_levelMultiplier,
                        m_dontScale = d.m_dontScale
                    });
                }

                __state = original;
                __instance.m_drops = widened;
            }
            catch (Exception ex)
            {
                __state = null;
                VPlusFallback.Warn("loot amount bonus: " + ex.Message);
            }
        }

        // FINALIZER, NOT POSTFIX. See the note on Patch_VPF_Pickable_RPC_Pick: a postfix does not
        // run when the original throws, and this restore has to: leaving m_drops pointing at the
        // widened copy would make the next prefix treat THAT as the original and widen it again.
        private static void Finalizer(CharacterDrop __instance, List<CharacterDrop.Drop> __state)
        {
            try
            {
                if (__state == null || __instance == null) return;
                __instance.m_drops = __state;
            }
            catch { }
        }
    }
}
