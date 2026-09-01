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
        public const string PluginName = "Eilif Companion";
        public const string PluginVersion = "0.3.0";

        internal static ManualLogSource Log;

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

            _voiceDormant = string.IsNullOrEmpty(_voiceToken.Value);
            if (_voiceDormant)
                Log.LogInfo("[Eilif] VoiceToken is empty - voice half is DORMANT (only /oath capture is active).");
            else
                Log.LogInfo($"[Eilif] Voice half active. Polling {_voiceUrl.Value} every {_pollSeconds.Value}s while players online; speaking at most one line per {_lineSpacing.Value}s.");

            new Harmony(PluginGuid).PatchAll();
            Log.LogInfo($"[Eilif] {PluginName} v{PluginVersion} loaded. /oath capture armed, /pin capture armed, position emitter armed ({PositionEmitter.EmitIntervalSeconds:0}s).");
        }

        // Main-thread pump: poll timer + drain the outbound line queue.
        private void Update()
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

            // Live player-position emitter (independent of the voice half; own 60s timer).
            PositionEmitter.Tick(Time.unscaledDeltaTime);

            // World-key enforcement (independent of the voice half; runs even when voice is dormant).
            if (_enforceList.Length > 0)
            {
                _enforceTimer += Time.unscaledDeltaTime;
                if (_enforceTimer >= EnforceIntervalSeconds)
                {
                    _enforceTimer = 0f;
                    EnforceWorldKeys();
                }
            }

            if (_voiceDormant) return;

            // 2) Poll timer (real time, unaffected by game time scale).
            _pollTimer += Time.unscaledDeltaTime;
            if (_pollTimer < _pollSeconds.Value) return;
            _pollTimer = 0f;

            if (!ServerReady() || ConnectedPeerCount() <= 0) return;
            if (Interlocked.CompareExchange(ref _fetchInFlight, 1, 0) != 0) return; // already fetching

            string url = _voiceUrl.Value;
            string token = _voiceToken.Value;
            _ = Task.Run(() => FetchAsync(url, token));
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
                var m = PinRe.Match(text);
                if (!m.Success) return;

                string kind = m.Groups[1].Success ? "base" : "poi";
                string name = m.Groups[2].Value.Trim();
                if (string.IsNullOrEmpty(name)) return;

                string who = sender?.Name ?? "unknown";
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
