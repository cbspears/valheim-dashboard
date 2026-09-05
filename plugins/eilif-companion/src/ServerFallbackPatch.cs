using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using HarmonyLib;

namespace EilifCompanion
{
    /// <summary>
    /// SERVER-SIDE half of the "ValheimPlus is not on 1.0" fallback: lift the vanilla 10-player cap.
    ///
    /// WHY THIS IS SERVER-SIDE. The cap is not a client rule. Vanilla decides it inside
    /// <c>ZNet.RPC_PeerInfo</c>, which only ever runs on the machine that owns the world, and the
    /// answer it gives is "Error 9, server is full" sent back down the joining peer's own RPC
    /// channel. No client-side plugin can raise it. Everything else in the fallback set (fuel, drop
    /// amounts, station range) is computed by the client that owns the object and lives in
    /// EilifPaths instead.
    ///
    /// VERIFIED BY DECOMPILE (ilspycmd against libs/assembly_valheim.dll, game 0.221.12).
    /// The whole cap is these four lines inside the private method
    /// <c>ZNet.RPC_PeerInfo(ZRpc rpc, ZPackage pkg)</c>, in the <c>if (m_isServer)</c> block:
    ///
    ///     if (GetNrOfPlayers() &gt;= 10)
    ///     {
    ///         rpc.Invoke("Error", 9);
    ///         ZLog.Log("Peer " + name + " disconnected due to server is full");
    ///         return;
    ///     }
    ///
    /// <c>public int GetNrOfPlayers()</c> returns <c>m_players.Count</c>, and on a dedicated server
    /// that list holds only real connected players (the headless host adds no entry of its own), so
    /// MaxPlayers = 20 means twenty vikings, not nineteen.
    ///
    /// There is no field to set and no property to override: the 10 is a literal compiled into the
    /// method body (<c>ldc.i4.s 10</c>, immediately after <c>call GetNrOfPlayers</c>). A transpiler
    /// is the only way in. This is the same place ValheimPlus 0.9.17.1 patches — its
    /// <c>ZNet.RPC_PeerInfo</c> transpiler walks to <c>call GetNrOfPlayers</c> and overwrites the
    /// operand of the next instruction with <c>Configuration.Current.Server.maxPlayers</c> — and it
    /// is the design Azumatt's MaxPlayerCount uses too. We differ in one deliberate way: instead of
    /// baking a number into the IL we replace that instruction with a <c>call</c> to
    /// <see cref="PlayerLimit"/>, so the value is read from config on every join and the cfg can be
    /// retuned mid-session without a rebuild.
    ///
    /// TWO SECONDARY CAPS, advertisement rather than gate, both patched here for completeness:
    ///
    ///   * <c>ZSteamMatchmaking.RegisterServer(...)</c> — the number the Steam server browser shows
    ///     as "x / y". This box runs the Steam backend (the live console log reads "Steam game server
    ///     initialized" then "Opened Steam server", and peers arrive as "Got connection SteamID ..."),
    ///     so it is the one that matters here.
    ///
    ///   * <c>ZPlayFabMatchmaking.CreateAndJoinNetwork()</c> and
    ///     <c>ZPlayFabMatchmaking.CreateLobby(...)</c> — the CROSSPLAY path. Inert while the server
    ///     runs the Steam backend, a real gate the moment crossplay is switched on, so both are
    ///     patched. They are reached through <c>AccessTools.TypeByName</c> and patched by hand:
    ///     neither is referenced at compile time, so a rename or deletion in 1.0 degrades to one
    ///     warning line instead of a load failure.
    ///
    /// THE DEDICATED-SERVER BUILD IS NOT THE CLIENT BUILD, and these three methods are exactly where
    /// that bites. `libs/assembly_valheim.dll` in this repo is copied from the local Steam CLIENT
    /// install, and reading only that gives the wrong answer here. Decompiled side by side
    /// (0.221.12, both builds):
    ///
    ///     client  valheim_Data/Managed:        SteamMatchmaking.CreateLobby(type, 10)
    ///     server  valheim_server_Data/Managed: SteamGameServer.SetMaxPlayerCount(10)
    ///
    ///     client:  new PlayFabNetworkConfiguration { MaxPlayerCount = 10u, ... }
    ///     server:  new PlayFabNetworkConfiguration { MaxPlayerCount = 11u, ... }
    ///     client:  new CreateLobbyRequest { MaxPlayers = 10u, ... }
    ///     server:  new CreateLobbyRequest { MaxPlayers = 11u, ... }
    ///
    /// The 11 is not a typo in the game: a dedicated server occupies a slot in its own PlayFab party
    /// and lobby, which it does not in ZNet.m_players. So the literal itself says which count it is,
    /// and the replacement follows it — 10 becomes MaxPlayers, 11 becomes MaxPlayers + 1. This is the
    /// same +1 rule ValheimPlus applies in ZPlayFabMatchmakingHelper.ConfiguredMaxPlayers. Only
    /// ZNet.RPC_PeerInfo's own `>= 10` is identical in both builds, which is why the join gate is the
    /// one hook that was safe to write from the client assembly alone. (Found the hard way: the first
    /// build of this file matched only the client shapes and all three secondary hooks logged
    /// "not found" on the local dedicated server. That is what the load test is for.)
    ///
    /// SAFETY / NO DOUBLE-APPLY. Every transpiler here returns the instruction stream UNTOUCHED when
    /// the feature is off, so with <c>Enabled = false</c> (the shipped default) the patched method's
    /// IL is byte-identical to vanilla. That matters for more than tidiness: ValheimPlus edits the
    /// very same instruction, and if both mods rewrote it the result would depend on which Harmony
    /// ran first — V+ would end up writing an int operand onto our <c>call</c> instruction and emit
    /// corrupt IL. So on top of the config gate, <see cref="Refuse"/> hard-refuses the whole section
    /// whenever ValheimPlus is present, by BepInEx GUID or by a normalised DLL-name prefix that a
    /// renamed fork still matches (see <see cref="DetectValheimPlus"/>). Turn this on only once V+
    /// is actually gone.
    ///
    /// AND WHEN IT IS OFF, IT SAYS SO WITH THE CONSEQUENCE. "Off because ValheimPlus is here" and
    /// "off with nothing lifting the cap at all" are very different states and used to print the
    /// same line. The second one is now a WARNING naming the vanilla 10, because the way this
    /// feature fails on launch night is not a crash: it is an uneventful boot log and an eleventh
    /// viking who cannot get in.
    ///
    /// NOTE: no System.ValueTuple anywhere in this file — see BUILD.md. The net462 BepInEx/Unity
    /// Mono runtime ships no ValueTuple and a reference to it fails the plugin load SILENTLY.
    /// </summary>
    // PUBLIC on purpose, not by habit: the rewritten IL inside ZNet.RPC_PeerInfo contains a literal
    // `call` to PlayerLimit(), and that call is emitted into a Harmony dynamic method. Harmony builds
    // those with skipVisibility, so an internal type would almost certainly work — "almost certainly"
    // being a poor thing to discover when the eleventh viking is knocking on launch night. Public
    // removes the question.
    public static class ServerFallback
    {
        /// <summary>The literal the vanilla methods carry. Also the value we hand back when off.</summary>
        internal const int VanillaCap = 10;

        internal const int MinPlayers = 1;
        internal const int MaxPlayersCeiling = 64;

        internal static ConfigEntry<bool> Enabled;
        internal static ConfigEntry<int> MaxPlayersCfg;

        /// <summary>True once ValheimPlus has been found next to us (see <see cref="Refuse"/>).</summary>
        internal static bool ValheimPlusPresent { get; private set; }

        /// <summary>What actually matched, for the log. Null while no ValheimPlus has been seen.</summary>
        internal static string ValheimPlusEvidence { get; private set; }

        // ValheimPlus identifies itself two ways, and BOTH are checked. The GUID survives a rename,
        // the file name does not.
        private const string ValheimPlusGuid = "org.bepinex.plugins.valheim_plus";
        private const string ValheimPlusDllPrefix = "valheimplus";

        private static readonly List<string> Applied = new List<string>();

        internal static void Bind(ConfigFile config)
        {
            Enabled = config.Bind("ServerFallback", "Enabled", false,
                "Master switch for the ValheimPlus stand-in features on this server. Ships OFF. Turn it " +
                "on ONLY when ValheimPlus is not installed: with V+ present it would fight V+ for the " +
                "same patch sites. Nothing in this section changes anything while it is false.");
            MaxPlayersCfg = config.Bind("ServerFallback", "MaxPlayers", 20,
                new ConfigDescription(
                    "How many players may be connected at once. Vanilla is hard-coded to 10; ValheimPlus " +
                    "[Server] maxPlayers on this world was 20, which is what this mirrors. Counts real " +
                    "players only, not the headless server itself. Needs Enabled = true.",
                    new AcceptableValueRange<int>(MinPlayers, MaxPlayersCeiling)));
        }

        /// <summary>
        /// Detects a ValheimPlus install. Returns a short description of what matched, or null.
        ///
        /// The PLUGIN FOLDER is the test that has to work, because it is the only one that can:
        /// on the live server ValheimPlus loads AFTER Eilif Companion (see the boot order in
        /// LogOutput.log), so <c>Chainloader.PluginInfos</c> does not yet contain it while our
        /// Awake — and therefore our Harmony patching — is running. The file is on disk either way.
        ///
        /// It matches a NORMALISED file-name prefix rather than the exact string "ValheimPlus.dll".
        /// The crew's own build is already a fork ("ValheimPlus_Grantapher_Temporary"), so a 1.0
        /// build arriving under some other name is not a hypothetical, and an exact-name test would
        /// let it through and put two mods on the same instruction.
        ///
        /// The registry is checked too, first and free, for the case where some other plugin has
        /// already loaded V+ before us.
        ///
        /// There is deliberately NO late re-check here, unlike the client plugin: a transpiler
        /// cannot be un-run, and the two-mods-one-instruction case is already loud on this side.
        /// Whichever transpiler runs second either writes an int operand onto a `call` and produces
        /// corrupt IL (Harmony throws at patch time) or fails to find its literal and logs
        /// "could not find" plus the Enabled-but-nothing-patched error from <see cref="Report"/>.
        /// Silently doing the wrong thing is the one outcome that is not available.
        /// </summary>
        private static string DetectValheimPlus()
        {
            try
            {
                var infos = Chainloader.PluginInfos;
                if (infos != null && infos.ContainsKey(ValheimPlusGuid))
                    return "plugin GUID " + ValheimPlusGuid;
            }
            catch { /* registry not usable this early; the folder scan below is the real test */ }

            try
            {
                string dir = Paths.PluginPath;
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return null;
                string[] files = Directory.GetFiles(dir, "*.dll", SearchOption.AllDirectories);
                if (files == null) return null;
                for (int i = 0; i < files.Length; i++)
                {
                    string bare = Path.GetFileNameWithoutExtension(files[i]);
                    if (Normalise(bare).StartsWith(ValheimPlusDllPrefix, StringComparison.Ordinal))
                        return Path.GetFileName(files[i]);
                }
                return null;
            }
            catch (Exception ex)
            {
                if (EilifCompanionPlugin.Log != null)
                    EilifCompanionPlugin.Log.LogWarning("[Eilif] ServerFallback: could not scan the plugin " +
                                                        "folder for ValheimPlus (" + ex.Message + "); assuming it is absent.");
                return null;
            }
        }

        /// <summary>Lowercase, letters and digits only, so "ValheimPlus_Grantapher_Temporary" reduces
        /// to "valheimplusgrantaphertemporary" and still matches the prefix.</summary>
        private static string Normalise(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            var sb = new System.Text.StringBuilder(value.Length);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c >= 'A' && c <= 'Z') sb.Append((char)(c + 32));
                else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
            }
            return sb.ToString();
        }

        /// <summary>
        /// True when the fallback should actually rewrite IL. Every transpiler asks this FIRST and
        /// bails out returning the untouched stream when it is false.
        /// </summary>
        internal static bool Active
        {
            get
            {
                if (Enabled == null || !Enabled.Value) return false;
                if (ValheimPlusPresent) return false;
                return true;
            }
        }

        /// <summary>
        /// The live player cap. Called from the rewritten IL inside ZNet.RPC_PeerInfo, so it must
        /// stay public-by-reflection, cheap, and incapable of throwing. Returns the vanilla 10 if
        /// anything at all is off, which makes a patched-but-disabled method behave like vanilla.
        /// </summary>
        public static int PlayerLimit()
        {
            try
            {
                if (!Active || MaxPlayersCfg == null) return VanillaCap;
                int v = MaxPlayersCfg.Value;
                if (v < MinPlayers) return MinPlayers;
                if (v > MaxPlayersCeiling) return MaxPlayersCeiling;
                return v;
            }
            catch { return VanillaCap; }
        }

        /// <summary>
        /// Advertised slot count for a literal that did NOT include the host's own slot (the vanilla
        /// literal there is 10). Same as the player cap.
        /// </summary>
        public static int Slots()
        {
            return PlayerLimit();
        }

        /// <summary>
        /// Advertised slot count for a literal that DID include the host's own slot (the vanilla
        /// literal there is 11, on the dedicated-server build). One more than the player cap, and
        /// still exactly 11 while the feature is off so a patched-but-disabled method is vanilla.
        /// </summary>
        public static int SlotsWithHost()
        {
            int v = PlayerLimit();
            int n = v + 1;
            return n > 250 ? 250 : n;
        }

        internal static void Note(string what)
        {
            Applied.Add(what);
        }

        /// <summary>The MaxPlayers the config asks for, for a log line only. Never throws.</summary>
        private static string ConfiguredCapForLog()
        {
            try
            {
                if (MaxPlayersCfg == null) return "the configured MaxPlayers";
                return MaxPlayersCfg.Value.ToString(CultureInfo.InvariantCulture);
            }
            catch { return "the configured MaxPlayers"; }
        }

        internal static void Fail(string what)
        {
            try
            {
                if (EilifCompanionPlugin.Log != null)
                    EilifCompanionPlugin.Log.LogError("[Eilif] ServerFallback: " + what);
            }
            catch { }
        }

        /// <summary>
        /// Resolve the V+ presence question once, before any patch class runs. Returns true when the
        /// caller must skip the whole section.
        /// </summary>
        internal static bool Refuse()
        {
            ValheimPlusEvidence = DetectValheimPlus();
            ValheimPlusPresent = ValheimPlusEvidence != null;
            if (!ValheimPlusPresent) return false;

            var log = EilifCompanionPlugin.Log;
            if (log == null) return true;

            if (Enabled == null || !Enabled.Value)
            {
                // The normal, correct configuration while V+ still runs the world. Name what matched
                // anyway, so a FALSE positive (some other plugin whose file name happens to start
                // with "valheimplus") is one grep away instead of an invisible reason the cap did
                // not move on launch night.
                log.LogInfo("[Eilif] ServerFallback: ValheimPlus detected (" + ValheimPlusEvidence +
                            "); the section is off, which is correct while V+ sets the cap itself.");
                return true;
            }

            log.LogWarning("========================================================================");
            log.LogWarning("[Eilif] ServerFallback is Enabled=true but ValheimPlus is still installed");
            log.LogWarning("[Eilif] on this server (" + ValheimPlusEvidence + "). These features exist");
            log.LogWarning("[Eilif] only to replace ValheimPlus when it is ABSENT; running both would");
            log.LogWarning("[Eilif] have the two mods rewriting the same instruction in");
            log.LogWarning("[Eilif] ZNet.RPC_PeerInfo, with no defined order. REFUSING to apply.");
            log.LogWarning("[Eilif] Remove ValheimPlus, or set [ServerFallback] Enabled = false and");
            log.LogWarning("[Eilif] let V+ keep the cap.");
            log.LogWarning("========================================================================");
            return true;
        }

        /// <summary>One line per enabled feature at load, one honest line when off.</summary>
        internal static void Report()
        {
            var log = EilifCompanionPlugin.Log;
            if (log == null) return;

            if (!Active)
            {
                if (ValheimPlusPresent)
                {
                    // Off BECAUSE ValheimPlus is here to set the cap. Nothing is missing.
                    log.LogInfo("[Eilif] ServerFallback: disabled (ValheimPlus present).");
                    return;
                }

                // Off with NOTHING lifting the cap. This is the state that quietly refuses viking
                // number eleven at the door, so it is a warning that names the consequence rather
                // than a bland "disabled" line. Greppable on purpose: the launch-day check should
                // look for this line as much as for the success line.
                log.LogWarning("[Eilif] ServerFallback: OFF and no ValheimPlus installed. This world " +
                               "is capped at the vanilla " + VanillaCap + " players. Set " +
                               "[ServerFallback] Enabled = true in the plugin config to raise it to " +
                               ConfiguredCapForLog() + ".");
                return;
            }

            if (Applied.Count == 0)
            {
                log.LogError("[Eilif] ServerFallback: Enabled=true but NO patch site was found. The " +
                             "player cap is still the vanilla " + VanillaCap + ". Read the errors above.");
                return;
            }

            foreach (string line in Applied)
                log.LogInfo("[Eilif] ServerFallback: " + line);
        }

        // ---- IL helpers -----------------------------------------------------------------

        /// <summary>
        /// True when this instruction pushes the given int constant. Covers ldc.i4.s (how a 10 is
        /// actually encoded), ldc.i4, and the ldc.i4.0..8 short forms, so a 1.0 recompile that
        /// changes the encoding does not silently miss.
        /// </summary>
        internal static bool LoadsInt(CodeInstruction ci, int wanted)
        {
            if (ci == null) return false;
            try { return ci.LoadsConstant(wanted); }
            catch { return false; }
        }

        /// <summary>
        /// Rewrites <paramref name="ci"/> IN PLACE into "call <paramref name="getter"/>". In place,
        /// never replaced: a CodeInstruction carries the labels and exception blocks attached to that
        /// offset, and building a fresh instruction would drop them and break any branch aiming here.
        /// </summary>
        internal static void ReplaceWithCall(CodeInstruction ci, MethodInfo getter)
        {
            ci.opcode = OpCodes.Call;
            ci.operand = getter;
        }

        /// <summary>True when the instruction stores into a member with this name (field or property setter).</summary>
        internal static bool StoresMemberNamed(CodeInstruction ci, string name)
        {
            if (ci == null || ci.operand == null) return false;
            var fi = ci.operand as FieldInfo;
            if (fi != null) return fi.Name == name;
            var mi = ci.operand as MethodInfo;
            if (mi != null) return mi.Name == "set_" + name;
            return false;
        }

        /// <summary>True when the instruction calls a method whose name is one of these.</summary>
        internal static bool CallsAnyOf(CodeInstruction ci, string[] names)
        {
            if (ci == null || names == null) return false;
            if (ci.opcode != OpCodes.Call && ci.opcode != OpCodes.Callvirt) return false;
            var mi = ci.operand as MethodInfo;
            if (mi == null) return false;
            for (int i = 0; i < names.Length; i++)
                if (mi.Name == names[i]) return true;
            return false;
        }

        /// <summary>
        /// Matches either shape of a vanilla player-count literal and reports which it was: 10 (the
        /// count excludes the host) or 11 (it includes the host, which is what the dedicated-server
        /// build carries in the PlayFab paths).
        /// </summary>
        internal static bool LoadsPlayerCountLiteral(CodeInstruction ci, out int original)
        {
            original = 0;
            if (LoadsInt(ci, VanillaCap)) { original = VanillaCap; return true; }
            if (LoadsInt(ci, VanillaCap + 1)) { original = VanillaCap + 1; return true; }
            return false;
        }

        /// <summary>The getter that preserves the meaning of the literal it replaces.</summary>
        internal static MethodInfo GetterFor(int original)
        {
            return AccessTools.Method(typeof(ServerFallback),
                original == VanillaCap + 1 ? "SlotsWithHost" : "Slots");
        }

        /// <summary>What that getter will return right now, for the log line.</summary>
        internal static int ValueFor(int original)
        {
            return original == VanillaCap + 1 ? SlotsWithHost() : Slots();
        }

        internal static string Num(int v) => v.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// THE gate. Turns <c>if (GetNrOfPlayers() &gt;= 10)</c> into
    /// <c>if (GetNrOfPlayers() &gt;= ServerFallback.PlayerLimit())</c>.
    /// </summary>
    [HarmonyPatch(typeof(ZNet), "RPC_PeerInfo")]
    internal static class Patch_SF_ZNet_RPC_PeerInfo_PlayerCap
    {
        private static readonly MethodInfo GetNrOfPlayers =
            AccessTools.Method(typeof(ZNet), "GetNrOfPlayers");
        private static readonly MethodInfo LimitGetter =
            AccessTools.Method(typeof(ServerFallback), "PlayerLimit");

        private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
        {
            // Untouched stream when off => the method keeps vanilla IL, and ValheimPlus (which edits
            // this exact instruction) is free to do its thing without us in the way.
            if (!ServerFallback.Active) return instructions;

            var list = new List<CodeInstruction>(instructions);
            if (GetNrOfPlayers == null || LimitGetter == null)
            {
                ServerFallback.Fail("ZNet.GetNrOfPlayers / PlayerLimit could not be resolved; player cap " +
                                    "stays at " + ServerFallback.VanillaCap + ".");
                return list;
            }

            for (int i = 0; i + 1 < list.Count; i++)
            {
                if (!list[i].Calls(GetNrOfPlayers)) continue;
                if (!ServerFallback.LoadsInt(list[i + 1], ServerFallback.VanillaCap)) continue;

                ServerFallback.ReplaceWithCall(list[i + 1], LimitGetter);
                ServerFallback.Note("player cap " + ServerFallback.Num(ServerFallback.VanillaCap) + " -> " +
                                    ServerFallback.Num(ServerFallback.PlayerLimit()) +
                                    " (ZNet.RPC_PeerInfo, the join gate).");
                return list;
            }

            ServerFallback.Fail("ZNet.RPC_PeerInfo: could not find 'GetNrOfPlayers() >= " +
                                ServerFallback.VanillaCap + "'. The player cap is UNCHANGED at " +
                                ServerFallback.VanillaCap + ". Re-check the method against 1.0 with " +
                                "ilspycmd before the crew tries to join.");
            return list;
        }
    }

    /// <summary>
    /// Steam backend advertisement: the slot count the server browser prints as "x / y". Not the join
    /// gate — that is <see cref="Patch_SF_ZNet_RPC_PeerInfo_PlayerCap"/> — but leaving it at 10 makes
    /// a 20-slot server read as full to anyone browsing.
    ///
    /// The dedicated-server build reaches it through <c>SteamGameServer.SetMaxPlayerCount(10)</c> and
    /// the client build through <c>SteamMatchmaking.CreateLobby(type, 10)</c>. Both are matched, by
    /// method NAME, so no Steamworks reference is needed at compile time and the same DLL is correct
    /// on either build. ValheimPlus patches the SetMaxPlayerCount one directly, by reflection, for
    /// the same reason.
    /// </summary>
    [HarmonyPatch(typeof(ZSteamMatchmaking), "RegisterServer")]
    internal static class Patch_SF_ZSteamMatchmaking_RegisterServer_LobbySize
    {
        private static readonly string[] Targets = new string[] { "SetMaxPlayerCount", "CreateLobby" };

        private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
        {
            if (!ServerFallback.Active) return instructions;

            var list = new List<CodeInstruction>(instructions);
            for (int i = 0; i + 1 < list.Count; i++)
            {
                int original;
                if (!ServerFallback.LoadsPlayerCountLiteral(list[i], out original)) continue;
                if (!ServerFallback.CallsAnyOf(list[i + 1], Targets)) continue;

                MethodInfo getter = ServerFallback.GetterFor(original);
                if (getter == null) continue;
                ServerFallback.ReplaceWithCall(list[i], getter);
                ServerFallback.Note("Steam browser slots " + ServerFallback.Num(original) + " -> " +
                                    ServerFallback.Num(ServerFallback.ValueFor(original)) +
                                    " (ZSteamMatchmaking.RegisterServer, advertised count only).");
                return list;
            }

            ServerFallback.Fail("ZSteamMatchmaking.RegisterServer: found no SetMaxPlayerCount(10) or " +
                                "CreateLobby(type, 10) to widen. The server browser will keep showing " +
                                ServerFallback.Num(ServerFallback.VanillaCap) + " slots; joining still works.");
            return list;
        }
    }

    /// <summary>
    /// Crossplay-only caps, patched by hand because neither method is referenced at compile time.
    /// Inert while the server runs the Steam backend; a real gate the moment crossplay is switched on.
    /// </summary>
    internal static class PlayFabPlayerCap
    {
        /// <summary>
        /// Shared transpiler body: replace the player-count literal that feeds a store to
        /// <paramref name="member"/>. Accepts either shape of the literal — 10 on the client build,
        /// 11 on the dedicated-server build, which counts the host's own slot — and picks the getter
        /// that preserves that meaning.
        /// </summary>
        private static IEnumerable<CodeInstruction> Rewrite(IEnumerable<CodeInstruction> instructions,
                                                            string member, string where)
        {
            if (!ServerFallback.Active) return instructions;

            var list = new List<CodeInstruction>(instructions);
            for (int i = 0; i + 1 < list.Count; i++)
            {
                int original;
                if (!ServerFallback.LoadsPlayerCountLiteral(list[i], out original)) continue;
                if (!ServerFallback.StoresMemberNamed(list[i + 1], member)) continue;

                MethodInfo getter = ServerFallback.GetterFor(original);
                if (getter == null) continue;
                ServerFallback.ReplaceWithCall(list[i], getter);
                ServerFallback.Note("crossplay " + member + " " + ServerFallback.Num(original) + " -> " +
                                    ServerFallback.Num(ServerFallback.ValueFor(original)) +
                                    " (" + where + "; only bites when crossplay is on).");
                return list;
            }

            ServerFallback.Fail(where + ": no '" + member + " = " + ServerFallback.VanillaCap + "' or '" +
                                member + " = " + (ServerFallback.VanillaCap + 1) + "' found. Harmless on " +
                                "the Steam backend; if crossplay is ON, the cap there is STILL " +
                                ServerFallback.VanillaCap + ".");
            return list;
        }

        public static IEnumerable<CodeInstruction> TranspileNetwork(IEnumerable<CodeInstruction> instructions)
        {
            return Rewrite(instructions, "MaxPlayerCount", "ZPlayFabMatchmaking.CreateAndJoinNetwork");
        }

        public static IEnumerable<CodeInstruction> TranspileLobby(IEnumerable<CodeInstruction> instructions)
        {
            return Rewrite(instructions, "MaxPlayers", "ZPlayFabMatchmaking.CreateLobby");
        }

        /// <summary>
        /// Applied by hand from the plugin's Awake. Each target is resolved by name and each failure
        /// is a logged warning, never an exception out of Awake.
        /// </summary>
        internal static void Apply(Harmony harmony)
        {
            if (!ServerFallback.Active) return;

            Type t = null;
            try { t = AccessTools.TypeByName("ZPlayFabMatchmaking"); } catch { }
            if (t == null)
            {
                ServerFallback.Fail("ZPlayFabMatchmaking type not found; crossplay player caps left at " +
                                    ServerFallback.VanillaCap + " (harmless on the Steam backend).");
                return;
            }

            PatchOne(harmony, t, "CreateAndJoinNetwork", "TranspileNetwork");
            PatchOne(harmony, t, "CreateLobby", "TranspileLobby");
        }

        private static void PatchOne(Harmony harmony, Type target, string methodName, string transpilerName)
        {
            try
            {
                MethodBase m = AccessTools.Method(target, methodName);
                if (m == null)
                {
                    ServerFallback.Fail("ZPlayFabMatchmaking." + methodName + " not found; crossplay cap " +
                                        "left at " + ServerFallback.VanillaCap + ".");
                    return;
                }
                MethodInfo tr = AccessTools.Method(typeof(PlayFabPlayerCap), transpilerName);
                harmony.Patch(m, null, null, new HarmonyMethod(tr));
            }
            catch (Exception ex)
            {
                ServerFallback.Fail("could not patch ZPlayFabMatchmaking." + methodName + ": " + ex.Message);
            }
        }
    }
}
