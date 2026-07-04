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
        public const string PluginVersion = "0.1.1";

        internal static ManualLogSource Log;

        // ---- Config ----
        private ConfigEntry<string> _voiceUrl;
        private ConfigEntry<string> _voiceToken;
        private ConfigEntry<int> _pollSeconds;
        private ConfigEntry<string> _speakerName;
        private ConfigEntry<string> _chatType;

        // ---- Voice pump state (main thread except where noted) ----
        private static readonly ConcurrentQueue<VoiceLine> OutQueue = new ConcurrentQueue<VoiceLine>();
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        private int _fetchInFlight; // 0/1 via Interlocked
        private float _pollTimer;
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

            try
            {
                // Unity Mono runtime: make sure modern TLS is enabled for the Vercel HTTPS endpoint.
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            }
            catch { /* older runtimes may not expose Tls12 explicitly; ignore */ }

            _voiceDormant = string.IsNullOrEmpty(_voiceToken.Value);
            if (_voiceDormant)
                Log.LogInfo("[Eilif] VoiceToken is empty - voice half is DORMANT (only /oath capture is active).");
            else
                Log.LogInfo($"[Eilif] Voice half active. Polling {_voiceUrl.Value} every {_pollSeconds.Value}s while players online.");

            new Harmony(PluginGuid).PatchAll();
            Log.LogInfo($"[Eilif] {PluginName} v{PluginVersion} loaded. /oath capture armed.");
        }

        // Main-thread pump: poll timer + drain the outbound line queue.
        private void Update()
        {
            // 1) Drain queued lines and speak them (must happen on the main thread).
            while (OutQueue.TryDequeue(out var line))
            {
                try { Speak(line); }
                catch (Exception ex) { Log.LogWarning($"[Eilif] Failed to speak line {line?.id}: {ex.Message}"); }
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
