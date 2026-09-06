using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using Splatform;
using UnityEngine;

namespace EilifCompanion
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class EilifCompanionPlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "media.blockspace.eilif.companion";

        /// <summary>
        /// ⚠ WIRE CONTRACT — DO NOT RENAME. BepInEx stamps every line this plugin logs with this
        /// exact string as the log SOURCE ("[Info   :Eilif Companion] [EILIF_OATH] …"), and the SFTP
        /// log poller anchors all four of its marker regexes to it:
        /// services/log-poller/src/parser.js, `EILIF_PREFIX = ^\[\w+\s*:\s*Eilif Companion\]\s*`.
        /// Changing this name silently kills oath capture, the chat mirror, pin capture and the live
        /// position layer all at once — the plugin keeps logging happily and the poller stops seeing
        /// a single marker. A rename needs a matching edit to that constant and to
        /// services/log-poller/test-parser.js.
        /// </summary>
        public const string PluginName = "Eilif Companion";
        public const string PluginVersion = "0.3.3";

        internal static ManualLogSource Log;

        // ---- The patch roster (v0.3.3, audit plugins-1.0) --------------------------------------
        //
        // WHY A HARD-CODED LIST AND NOT JUST A COUNT. The apply loop below used to compute BOTH
        // halves of its "patch classes applied: N/M" line from the types it could enumerate, and
        // that number is not trustworthy across a game update. AccessTools.GetTypesFromAssembly
        // swallows a ReflectionTypeLoadException and returns only the types that LOADED, and a
        // patch class fails to load when a game type in its own signature is gone (a Prefix taking
        // `UserInfo`, say). A class that vanishes that way never reaches the loop, so M shrank in
        // step with N and a 1.0 boot that had silently lost the oath capture still printed the
        // healthy-looking "1/1". The type-load failure that only breaks the ATTRIBUTE (typeof(Chat)
        // missing) at least logged a line, but the headline number still read clean.
        //
        // So M is now a fixed expectation. 2/2 stays exactly what it has always meant, a boot that
        // lost a class reads 1/2, and every missing name is named on its own MISSING line.
        private static readonly string[] ExpectedPatchClasses =
        {
            "OathCapture",                    // [EILIF_OATH] + [EILIF_CHAT] capture
            "Patch_OnNewChatMessage_Pin",     // [EILIF_PIN] capture
        };

        // Applied only while [ServerFallback] is on; counted separately, same reasoning.
        private static readonly string[] ExpectedFallbackClasses =
        {
            "Patch_SF_ZNet_RPC_PeerInfo_PlayerCap",
            "Patch_SF_ZSteamMatchmaking_RegisterServer_LobbySize",
        };

        // What each roster entry buys, for the MISSING line. Kept beside the roster so the two
        // cannot drift.
        private static string FeatureOf(string patchClass)
        {
            switch (patchClass)
            {
                case "OathCapture":
                    return "in-game /oath capture AND the game->Discord chat mirror ([EILIF_OATH] / [EILIF_CHAT] lines stop)";
                case "Patch_OnNewChatMessage_Pin":
                    return "in-game /pin capture ([EILIF_PIN] lines stop; the dashboard map gets no new player pins)";
                case "Patch_SF_ZNet_RPC_PeerInfo_PlayerCap":
                    return "the player-cap lift (the join gate stays at the vanilla 10)";
                case "Patch_SF_ZSteamMatchmaking_RegisterServer_LobbySize":
                    return "the advertised Steam browser slot count (joining still works)";
                default:
                    return "an unnamed feature";
            }
        }

        // ---- Config ----
        private ConfigEntry<string> _voiceUrl;
        private ConfigEntry<string> _voiceToken;
        private ConfigEntry<int> _pollSeconds;
        private ConfigEntry<string> _speakerName;
        private ConfigEntry<string> _chatType;
        private ConfigEntry<int> _lineSpacing;
        private ConfigEntry<string> _enforcedKeys;

        // ---- World-key enforcement state ----
        // Vanilla applies `-modifier` launch args to the world's startingGlobalKeys and logs
        // "Setting world modifier: ..." at boot, but on this host the granted keys never showed up
        // in the RUNTIME global-key set (live-verified 2026-08-31: boot logged DeathPenalty->casual
        // yet players still dropped equipped gear — Player.OnDeath keys off ZoneSystem's
        // DeathKeepEquip global key, checked client-side). Global keys are server-authoritative
        // and sync to every client, so re-asserting them here fixes the whole fleet with no
        // client-side mod change. Assert-if-missing, so a normal pass is a no-op.
        private string[] _enforceList = Array.Empty<string>();
        private float _enforceTimer;
        private const float EnforceIntervalSeconds = 30f;
        private string _lastLoggedKeys;
        private System.Reflection.MethodInfo _sendGlobalKeys; // private ZoneSystem.SendGlobalKeys(long)
        private bool _sendGlobalKeysMissing;

        // ---- Voice pump state (main thread except where noted) ----
        // NOTE: no System.ValueTuple anywhere in this file — see BUILD.md and the source comment in
        // ../eilif-paths/src/EilifPathsPlugin.cs. The net462 BepInEx/Unity Mono runtime ships no
        // ValueTuple reference, and a tuple literal/field on the Awake path fails the plugin load
        // SILENTLY. Plain fields and out-vars only.
        private static readonly ConcurrentQueue<VoiceLine> OutQueue = new ConcurrentQueue<VoiceLine>();
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        private int _fetchInFlight; // 0/1 via Interlocked
        private float _pollTimer;
        // Time since the last spoken line. Starts "already elapsed" so the first line of a session
        // is spoken the moment it lands rather than after an opening LineSpacingSeconds of silence.
        private float _speakTimer = float.MaxValue;
        private bool _voiceDormant;

        private void Awake()
        {
            Log = Logger;

            _voiceUrl = Config.Bind("Voice", "VoiceUrl",
                "https://valheim-dashboard.vercel.app/api/voice",
                "Endpoint polled for queued lines. Returns JSON: {\"lines\":[{\"id\":\"..\",\"text\":\"..\",\"speaker\":\"Eilif\"}]}");
            _voiceToken = Config.Bind("Voice", "VoiceToken", "",
                "Bearer-style token sent as the 'x-voice-token' header. If empty, the voice half stays dormant.");
            _pollSeconds = Config.Bind("Voice", "PollSeconds", 120,
                new ConfigDescription("Seconds between voice polls (only when >=1 player is connected).",
                    new AcceptableValueRange<int>(30, 3600)));
            _speakerName = Config.Bind("Voice", "SpeakerName", "Eilif",
                "Fallback speaker name used when a line has no 'speaker' field.");
            _chatType = Config.Bind("Voice", "ChatType", "center",
                new ConfigDescription("How spoken lines are broadcast: 'center' (raid-banner style, most reliable), 'shout' (chat, global) or 'normal' (chat, proximity).",
                    new AcceptableValueList<string>("center", "shout", "normal")));
            _lineSpacing = Config.Bind("Voice", "LineSpacingSeconds", 20,
                new ConfigDescription("Minimum seconds between two spoken lines. A poll can hand back several lines at once; they wait in the queue and Eilif speaks one at a time at this spacing instead of stacking them in a single frame.",
                    new AcceptableValueRange<int>(5, 300)));
            _enforcedKeys = Config.Bind("WorldKeys", "EnforcedGlobalKeys", "deathkeepequip",
                "Comma-separated global keys asserted into the world whenever they are missing (checked every 30s). " +
                "Use for world-modifier keys the panel's -modifier args fail to apply at runtime, e.g. " +
                "'deathkeepequip' (keep equipped gear on death; inventory still drops). Value keys like " +
                "'skillreductionrate 15' work too. Empty = feature off.");

            try
            {
                // Unity Mono runtime: make sure modern TLS is enabled for the Vercel HTTPS endpoint.
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            }
            catch { /* older runtimes may not expose Tls12 explicitly; ignore */ }

            var keys = (_enforcedKeys.Value ?? "").Split(',');
            var list = new System.Collections.Generic.List<string>(keys.Length);
            foreach (var k in keys)
            {
                var t = k.Trim().ToLowerInvariant();
                if (t.Length > 0) list.Add(t);
            }
            _enforceList = list.ToArray();
            if (_enforceList.Length > 0)
                Log.LogInfo($"[Eilif] World-key enforcement armed: {string.Join(", ", _enforceList)} (every {EnforceIntervalSeconds:0}s).");

            // [ServerFallback] — the stand-in for ValheimPlus's [Server] maxPlayers when V+ is not
            // installed. Bound BEFORE Harmony runs: its transpilers read this config at PATCH time to
            // decide whether to touch the IL at all (see src/ServerFallbackPatch.cs).
            ServerFallback.Bind(Config);
            ServerFallback.Refuse();

            _voiceDormant = string.IsNullOrEmpty(_voiceToken.Value);
            if (_voiceDormant)
                Log.LogInfo("[Eilif] VoiceToken is empty - voice half is DORMANT (only /oath capture is active).");
            else
                Log.LogInfo($"[Eilif] Voice half active. Polling {_voiceUrl.Value} every {_pollSeconds.Value}s while players online; speaking at most one line per {_lineSpacing.Value}s.");

            // Every attribute-declared patch class is applied ON ITS OWN (v0.3.1, audit plugins-6).
            // A bare PatchAll() throws on the FIRST target it cannot resolve and abandons the rest
            // of the batch — and the order it walks the classes in is not defined, so a single
            // changed signature in a game update could take out the oath capture, the pin capture,
            // or both, at random, and the exception would escape Awake before the "loaded" line
            // below ever printed. The plugin would then look completely absent in the log while the
            // voice pump, world-key enforcement and position emitter (all Update()-driven, none of
            // them Harmony) carried on working — the worst possible diagnostic signal on a launch
            // night. Isolating each class turns that into a named error line plus an honest count.
            // Same pattern (and same reason) as ../eilif-paths/src/EilifPathsPlugin.cs.
            //
            // The [ServerFallback] classes (named Patch_SF_*) are counted SEPARATELY and are not
            // applied at all while that section is off, so the "2/2" grep below keeps meaning exactly
            // what it has always meant, and a disabled fallback leaves ZNet.RPC_PeerInfo carrying
            // byte-identical vanilla IL — which is what keeps ValheimPlus, if it is still installed,
            // free to rewrite that same instruction without us in the way.
            var harmony = new Harmony(PluginGuid);
            var applied = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
            bool fallbackOn = ServerFallback.Active;
            foreach (Type t in AccessTools.GetTypesFromAssembly(typeof(EilifCompanionPlugin).Assembly))
            {
                string name = "?";
                try
                {
                    if (t == null) continue;
                    name = t.Name;
                    if (t.GetCustomAttributes(typeof(HarmonyPatch), true).Length == 0) continue;
                    bool isFallback = name.StartsWith("Patch_SF_", StringComparison.Ordinal);
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
                    applied.Add(name);
                }
                catch (Exception ex)
                {
                    // Named, and with the consequence attached: "could not apply X" alone does not
                    // tell whoever is reading the boot log at 06:00 whether anything they care
                    // about just went dark.
                    Log.LogError("[Eilif] could not apply " + name + ": " + ex.Message +
                                 " -> " + FeatureOf(name) + ".");
                }
            }

            if (fallbackOn)
            {
                Log.LogInfo("[Eilif] ServerFallback patch classes: " +
                            CountApplied(applied, ExpectedFallbackClasses) + "/" +
                            ExpectedFallbackClasses.Length + " applied.");
                ReportMissing(applied, ExpectedFallbackClasses);
            }
            // The one unambiguous post-rebuild grep: 2/2 is healthy (OathCapture +
            // Patch_OnNewChatMessage_Pin), anything else means read the MISSING lines below it.
            // The denominator is the fixed roster, never a count of what happened to load, so a
            // class the runtime could not even enumerate still shows up as a shortfall here.
            Log.LogInfo($"[Eilif] patch classes applied: {CountApplied(applied, ExpectedPatchClasses)}/{ExpectedPatchClasses.Length}");
            ReportMissing(applied, ExpectedPatchClasses);

            // Crossplay-only player caps: resolved by name and patched by hand, so a renamed or
            // deleted method in 1.0 is one warning line rather than a dead plugin. No-op when
            // [ServerFallback] is off.
            PlayFabPlayerCap.Apply(harmony);

            // One line per enabled fallback feature, or 'ServerFallback: disabled'.
            ServerFallback.Report();

            Log.LogInfo($"[Eilif] {PluginName} v{PluginVersion} loaded. /oath capture armed, /pin capture armed, position emitter armed ({PositionEmitter.EmitIntervalSeconds:0}s).");
        }

        private static int CountApplied(System.Collections.Generic.HashSet<string> applied, string[] roster)
        {
            int n = 0;
            for (int i = 0; i < roster.Length; i++)
                if (applied.Contains(roster[i])) n++;
            return n;
        }

        /// <summary>
        /// One ERROR line per roster entry that did not go on, naming what stopped working. This is
        /// the line that has to exist for a class the runtime dropped BEFORE the loop could see it
        /// (a game type gone from a patch method's own signature), where there is no exception to
        /// report and nothing else in the log says a thing.
        /// </summary>
        private static void ReportMissing(System.Collections.Generic.HashSet<string> applied, string[] roster)
        {
            for (int i = 0; i < roster.Length; i++)
            {
                if (applied.Contains(roster[i])) continue;
                Log?.LogError("[Eilif] MISSING patch class " + roster[i] + " - " + FeatureOf(roster[i]) +
                             ". Re-check that method against this game build with ilspycmd and rebuild.");
            }
        }

        // Main-thread pump: poll timer + drain the outbound line queue.
        //
        // Every independent half is wrapped on its own (v0.3.3): a throw out of Update lands in
        // Unity's own loop, which logs it and calls Update again next frame, so one broken feature
        // used to mean an unbounded error every frame AND took the other three down with it for
        // that frame. Segmented, a failed voice poll cannot stop the position emitter, and a failed
        // key sweep cannot stop the voice.
        private void Update()
        {
            try { PumpSpeak(); } catch (Exception ex) { Fault("speak", ex); }
            try { PositionEmitter.Tick(Time.unscaledDeltaTime); } catch (Exception ex) { Fault("position", ex); }
            try { PumpWorldKeys(); } catch (Exception ex) { Fault("worldkeys", ex); }
            try { PumpVoicePoll(); } catch (Exception ex) { Fault("voice", ex); }
        }

        // ---- Fault reporting for the Update pump ------------------------------------------------
        // First failure of a given pump is an error line; after that the pump is allowed to keep
        // running (a transient must heal itself) but says so at most once a minute, with the count
        // of what it swallowed, so nothing is lost and nothing floods LogOutput.log — the file the
        // SFTP poller drags down every 20 seconds.
        private const double FaultCooldownSeconds = 60d;
        private readonly System.Collections.Generic.Dictionary<string, DateTime> _faultLastUtc =
            new System.Collections.Generic.Dictionary<string, DateTime>(StringComparer.Ordinal);
        private readonly System.Collections.Generic.Dictionary<string, int> _faultSuppressed =
            new System.Collections.Generic.Dictionary<string, int>(StringComparer.Ordinal);

        private void Fault(string pump, Exception ex)
        {
            try
            {
                DateTime now = DateTime.UtcNow;
                DateTime last;
                if (_faultLastUtc.TryGetValue(pump, out last) && (now - last).TotalSeconds < FaultCooldownSeconds)
                {
                    int n;
                    _faultSuppressed.TryGetValue(pump, out n);
                    _faultSuppressed[pump] = n + 1;
                    return;
                }
                int suppressed;
                _faultSuppressed.TryGetValue(pump, out suppressed);
                _faultSuppressed[pump] = 0;
                _faultLastUtc[pump] = now;
                Log?.LogError("[Eilif] " + pump + " pump failed: " + ex.Message +
                              (suppressed > 0 ? " (+" + suppressed + " more in the last minute)" : "") +
                              ". The other pumps are unaffected.");
            }
            catch { /* the fault reporter must never fault */ }
        }

        private void PumpSpeak()
        {
            // 1) Speak at most ONE queued line per LineSpacingSeconds (must happen on the main
            //    thread). A poll can return up to 3 lines; the rest wait in the queue rather than
            //    being fired back-to-back in a single frame, so center-screen messages don't
            //    overwrite each other before anyone can read them. Nothing is dropped.
            float spacing = _lineSpacing.Value;
            if (_speakTimer < spacing) _speakTimer += Time.unscaledDeltaTime; // clamped: never grows unbounded while idle
            if (_speakTimer >= spacing && OutQueue.TryDequeue(out var line))
            {
                _speakTimer = 0f;
                try { Speak(line); }
                catch (Exception ex) { Log.LogWarning($"[Eilif] Failed to speak line {line?.id}: {ex.Message}"); }
            }
        }

        // World-key enforcement (independent of the voice half; runs even when voice is dormant).
        private void PumpWorldKeys()
        {
            if (_enforceList.Length == 0) return;
            _enforceTimer += Time.unscaledDeltaTime;
            if (_enforceTimer < EnforceIntervalSeconds) return;
            _enforceTimer = 0f;
            EnforceWorldKeys();
        }

        private void PumpVoicePoll()
        {
            if (_voiceDormant) return;

            // 2) Poll timer (real time, unaffected by game time scale).
            _pollTimer += Time.unscaledDeltaTime;
            if (_pollTimer < _pollSeconds.Value) return;
            _pollTimer = 0f;

            if (!ServerReady() || ConnectedPeerCount() <= 0) return;
            if (Interlocked.CompareExchange(ref _fetchInFlight, 1, 0) != 0) return; // already fetching

            string url = _voiceUrl.Value;
            string token = _voiceToken.Value;
            try
            {
                _ = Task.Run(() => FetchAsync(url, token));
            }
            catch (Exception ex)
            {
                // FetchAsync clears the flag in its own finally, but it never runs if the queue
                // itself refuses the work. Without this the voice half would wedge shut for the
                // life of the process on one failed Task.Run.
                Interlocked.Exchange(ref _fetchInFlight, 0);
                Log.LogWarning($"[Eilif] Voice poll could not be queued: {ex.Message}");
            }
        }

        private static bool ServerReady()
        {
            return ZNet.instance != null && ZRoutedRpc.instance != null;
        }

        // Assert any missing enforced keys into the live world, log the runtime key list
        // whenever it changes, and re-broadcast the list to every client. Main thread only.
        //
        // Why all three (live-debugged 2026-08-31): the boot logged DeathPenalty->casual and the
        // .fwl carried deathkeepequip, yet a player who joined and died a minute after the boot
        // still dropped equipped gear — so somewhere between the world's startingGlobalKeys, the
        // server's runtime key set, and the client's synced copy, the key went missing, and none
        // of those hops is observable from outside. This makes the server log the source of truth
        // ([EILIF_KEY] lines readable over SFTP) and heals both possible failure points:
        //  - key absent server-side  -> SetGlobalKey routes through the server's own "SetGlobalKey"
        //    RPC (RPC_SetGlobalKey: idempotent add + broadcast), fixing all peers at once;
        //  - key present server-side but a client desynced -> the periodic SendGlobalKeys
        //    re-broadcast (private; reflection) re-syncs every connected client each pass.
        // Vanilla's boot-time SetStartingGlobalKeys wipes modifier-enum keys before re-applying
        // its own list, so after a restart a key can be missing for up to EnforceIntervalSeconds —
        // acceptable: nobody dies in the first 30 seconds of a boot.
        private void EnforceWorldKeys()
        {
            if (!ServerReady() || ZoneSystem.instance == null) return;

            try
            {
                var current = ZoneSystem.instance.GetGlobalKeys();
                current.Sort(StringComparer.Ordinal);
                var joined = string.Join(" | ", current);
                if (joined != _lastLoggedKeys)
                {
                    _lastLoggedKeys = joined;
                    Log.LogInfo($"[EILIF_KEY] runtime world keys ({current.Count}): {joined}");
                }
            }
            catch (Exception ex)
            {
                Log.LogWarning($"[Eilif] world-key list read failed: {ex.Message}");
            }

            foreach (var key in _enforceList)
            {
                try
                {
                    if (ZoneSystem.instance.GetGlobalKeyExact(key)) continue;
                    ZoneSystem.instance.SetGlobalKey(key);
                    Log.LogInfo($"[EILIF_KEY] enforced world key: {key}");
                }
                catch (Exception ex)
                {
                    Log.LogWarning($"[Eilif] world-key enforce failed for '{key}': {ex.Message}");
                }
            }

            // Belt-and-suspenders: re-sync every connected client's key list. Cheap (a small
            // string list per pass) and idempotent client-side (RPC_GlobalKeys clears + re-adds).
            if (ConnectedPeerCount() > 0 && !_sendGlobalKeysMissing)
            {
                try
                {
                    if (_sendGlobalKeys == null)
                    {
                        _sendGlobalKeys = AccessTools.Method(typeof(ZoneSystem), "SendGlobalKeys");
                        if (_sendGlobalKeys == null)
                        {
                            _sendGlobalKeysMissing = true;
                            Log.LogWarning("[Eilif] ZoneSystem.SendGlobalKeys not found - client key re-sync disabled.");
                            return;
                        }
                    }
                    _sendGlobalKeys.Invoke(ZoneSystem.instance, new object[] { ZRoutedRpc.Everybody });
                }
                catch (Exception ex)
                {
                    _sendGlobalKeysMissing = true; // don't retry a broken reflection path every pass
                    Log.LogWarning($"[Eilif] client key re-sync failed (disabled): {ex.Message}");
                }
            }
        }

        private static int ConnectedPeerCount()
        {
            try
            {
                var peers = ZNet.instance?.GetPeers();
                return peers?.Count ?? 0;
            }
            catch { return 0; }
        }

        // Background thread: HTTP only, then enqueue results for the main thread.
        private async Task FetchAsync(string url, string token)
        {
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    req.Headers.TryAddWithoutValidation("x-voice-token", token);
                    using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode)
                        {
                            Log.LogWarning($"[Eilif] Voice poll HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}");
                            return;
                        }

                        var bytes = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                        var parsed = ParseLines(bytes);
                        if (parsed == null || parsed.Length == 0) return;

                        int n = 0;
                        foreach (var l in parsed)
                        {
                            if (l == null || string.IsNullOrEmpty(l.text)) continue;
                            OutQueue.Enqueue(l);
                            if (++n >= 3) break; // spec: 0-3 lines
                        }
                        if (n > 0) Log.LogInfo($"[Eilif] Voice poll queued {n} line(s).");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.LogWarning($"[Eilif] Voice poll failed: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _fetchInFlight, 0);
            }
        }

        private static VoiceLine[] ParseLines(byte[] json)
        {
            try
            {
                using (var ms = new MemoryStream(json))
                {
                    var ser = new DataContractJsonSerializer(typeof(VoiceResponse));
                    var r = (VoiceResponse)ser.ReadObject(ms);
                    return r?.lines;
                }
            }
            catch (Exception ex)
            {
                Log.LogWarning($"[Eilif] Voice JSON parse failed: {ex.Message}");
                return null;
            }
        }

        // Broadcast a line to all connected players. Main thread only.
        private void Speak(VoiceLine line)
        {
            if (ZRoutedRpc.instance == null) return; // shouldn't happen; Update guards, queue may lag

            string speaker = string.IsNullOrEmpty(line.speaker) ? _speakerName.Value : line.speaker;
            string mode = (_chatType.Value ?? "center").ToLowerInvariant();
            string text = line.text ?? "";

            if (mode == "center")
            {
                // The raid-banner channel: MessageHud.RPC_ShowMessage(long sender, int type, string text).
                // No UserInfo involved, so it is immune to the platform privacy check that rejects
                // synthetic chat senders ("Failed to get player info..."). Renders center-screen on
                // every connected client, exactly like "The forest is moving...".
                ZRoutedRpc.instance.InvokeRoutedRPC(ZRoutedRpc.Everybody, "ShowMessage",
                    new object[] { (int)MessageHud.MessageType.Center, text });
                Log.LogInfo($"[Eilif] Spoke (center): {text}");
                return;
            }

            var talkType = mode == "normal" ? Talker.Type.Normal : Talker.Type.Shout;
            var userInfo = new UserInfo
            {
                Name = speaker,
                // Steam-shaped synthetic id: same-platform senders skip the PlayFab lookup path
                // that rejected our custom platform id outright.
                UserId = new PlatformUserID("Steam", "76561198000000001")
            };
            var args = new object[] { Vector3.zero, (int)talkType, userInfo, text };

            // Per-peer sends: never invoke the server's own ChatMessage handler (its player-info
            // lookup throws on synthetic senders); deliver straight to each connected client.
            var peers = ZNet.instance?.GetPeers();
            if (peers == null || peers.Count == 0) return;
            foreach (var p in peers)
                ZRoutedRpc.instance.InvokeRoutedRPC(p.m_uid, "ChatMessage", args);

            Log.LogInfo($"[Eilif] Spoke ({talkType}) as '{speaker}' to {peers.Count} peer(s): {text}");
        }
    }

    // ---- /pin capture -------------------------------------------------------
    // Unlike /oath (which the mod-free "shout console echo" already captures),
    // a pin needs the player's real world position — that's only available on
    // the server by hooking the chat pipeline directly. Chat.OnNewChatMessage
    // is confirmed (via decompile) to run server-side for SHOUTED messages
    // (proximity/whisper chat never reaches the dedicated server), carrying
    // the sender's position at the moment they spoke. We log it in the same
    // tagged-line style as [EILIF_OATH] so the log poller can parse it with
    // zero extra transport.
    //
    // v0.3.2 (audit security-3): the pin is filed under the SERVER's name for the
    // sending peer, not the client-supplied UserInfo.Name — otherwise a crafted
    // ChatMessage RPC could plant, rename or move another viking's map pins under
    // their name. See SpeakerIdentity.
    // Bare-name binding here is deliberate for the same reason it is in OathCapture (this prefix
    // declares the full parameter list, so the signature is already pinned and an explicit Type[]
    // would only make a 1.0 parameter ADDITION fatal). The full reasoning lives in one place:
    // src/OathCapture.cs, above its [HarmonyPatch] attribute. Read it before changing either.
    [HarmonyPatch(typeof(Chat), "OnNewChatMessage")]
    internal static class Patch_OnNewChatMessage_Pin
    {
        // name|kind, e.g. "/pin The Dark Chapel" or "/pin base Odinshold"
        private static readonly System.Text.RegularExpressions.Regex PinRe =
            new System.Text.RegularExpressions.Regex(
                @"^\s*/pin\s+(?:(base)\s+)?(.+?)\s*$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        static void Prefix(GameObject go, long senderID, Vector3 pos, Talker.Type type, UserInfo sender, string text)
        {
            try
            {
                if (type != Talker.Type.Shout || string.IsNullOrEmpty(text)) return;
                var m = PinRe.Match(SpeakerIdentity.Safe(text, SpeakerIdentity.MaxTextLen));
                if (!m.Success) return;

                string kind = m.Groups[1].Success ? "base" : "poi";
                string name = m.Groups[2].Value.Trim();
                if (string.IsNullOrEmpty(name)) return;

                // The server's peer record, never the packet's claim. Null = a sender uid with no
                // peer record: drop the pin rather than file it under an unverifiable name (the
                // old code filed those as "unknown", which put a real pin on the map for nobody).
                string who = SpeakerIdentity.Resolve(senderID, sender != null ? sender.Name : null, "pin");
                if (who == null) return;
                // world x/z only — the dashboard converts to map-fraction coords.
                EilifCompanionPlugin.Log.LogInfo(
                    $"[EILIF_PIN] {who} | {kind} | {name} | {pos.x.ToString("F1", System.Globalization.CultureInfo.InvariantCulture)} | {pos.z.ToString("F1", System.Globalization.CultureInfo.InvariantCulture)}");
            }
            catch (Exception ex)
            {
                EilifCompanionPlugin.Log.LogWarning($"[Eilif] pin capture failed: {ex.Message}");
            }
        }
    }

    // ---- JSON contract for the /api/voice response ----
    [DataContract]
    public class VoiceResponse
    {
        [DataMember(Name = "lines")] public VoiceLine[] lines;
    }

    [DataContract]
    public class VoiceLine
    {
        [DataMember(Name = "id")] public string id;
        [DataMember(Name = "text")] public string text;
        [DataMember(Name = "speaker")] public string speaker;
    }
}
