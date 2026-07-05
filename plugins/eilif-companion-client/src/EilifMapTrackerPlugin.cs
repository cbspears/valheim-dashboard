using System;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;

namespace EilifCompanionClient
{
    /// <summary>
    /// EARS (client edition): automatic cartography tracking for the Eilif dashboard.
    ///
    /// While the local player is connected to a multiplayer server, every ~5 min (and once on
    /// logout/disconnect) it reads the private Minimap fog array (<c>Minimap.m_explored</c>,
    /// <c>bool[textureSize²]</c>) straight out of memory, computes the explored-map percentage the
    /// SAME way the .fch stats-parser does (explored pixels INSIDE the inscribed disc / disc
    /// pixels — the square's corners are endless ocean, so a full map reads ~100%, not >100%), and
    /// POSTs a tiny JSON to the dashboard ingest:
    ///
    ///   { schemaVersion:1, game:'valheim', source:'client-map', playerName, world, exploredPct }
    ///
    /// This supersedes the .fch-upload plan for pack players: the pack ships this DLL, so playing =
    /// tracked, no opt-in. Constraints honoured: never blocks the main thread (compute is cheap,
    /// the HTTP POST is off-thread), silent no-op at the menu / in singleplayer / when not connected
    /// to a server, and it degrades quietly on any network or reflection failure.
    /// </summary>
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class EilifMapTrackerPlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "net.eilif.companionclient";
        public const string PluginName = "Eilif Companion Client";
        public const string PluginVersion = "0.1.0";

        internal static ManualLogSource Log;
        internal static EilifMapTrackerPlugin Instance;

        // ---- Config ----
        private ConfigEntry<string> _url;
        private ConfigEntry<string> _token;
        private ConfigEntry<int> _intervalSeconds;

        // ---- State (main thread unless noted) ----
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        private int _postInFlight;    // 0/1 via Interlocked
        private float _postTimer;
        private bool _wasConnected;
        private float _lastPct = -1f; // last computed %, for the hard-disconnect fallback post

        // Cached reflection handles for the private Minimap fog array (verified vs decompile:
        // `private bool[] m_explored` sized `m_textureSize * m_textureSize`, row-major
        // `m_explored[y * m_textureSize + x]`; `public int m_textureSize = 256`).
        private static readonly FieldInfo ExploredField =
            AccessTools.Field(typeof(Minimap), "m_explored");
        private static readonly FieldInfo TextureSizeField =
            AccessTools.Field(typeof(Minimap), "m_textureSize");

        private void Awake()
        {
            Log = Logger;
            Instance = this;

            _url = Config.Bind("Map", "Url",
                "https://valheim-dashboard.vercel.app/api/gs-ingest",
                "Dashboard ingest endpoint. The explored-map % is POSTed here as source:'client-map'.");
            _token = Config.Bind("Map", "Token", "",
                "Optional Bearer token. If set it is sent as 'Authorization: Bearer <token>'. Blank is fine (pilot).");
            _intervalSeconds = Config.Bind("Map", "IntervalSeconds", 300,
                new ConfigDescription("Seconds between map-% posts while connected to a server.",
                    new AcceptableValueRange<int>(60, 3600)));

            try
            {
                // Unity Mono runtime: make sure modern TLS is enabled for the Vercel HTTPS endpoint.
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            }
            catch { /* older runtimes may not expose Tls12 explicitly; ignore */ }

            // Hook logout so we always send a FRESH final reading on a clean quit-to-menu / log out
            // (Minimap + local player are still alive inside Game.Logout). Hard disconnects that
            // skip Logout are covered by the connected->disconnected fallback in Update().
            new Harmony(PluginGuid).PatchAll(typeof(Patch_GameLogout));

            Log.LogInfo($"[EilifMap] {PluginName} v{PluginVersion} loaded. Posting explored-map % to {_url.Value} every {_intervalSeconds.Value}s while on a server.");
        }

        private void Update()
        {
            bool connected = IsOnServer();

            if (connected)
            {
                _postTimer += Time.unscaledDeltaTime;
                if (_postTimer >= _intervalSeconds.Value)
                {
                    _postTimer = 0f;
                    ComputeAndPost("interval");
                }
            }
            else if (_wasConnected)
            {
                // Left the server without a clean Logout (network drop / kick). Minimap is gone, so
                // send the last value we computed this session — exploration only grows and the
                // ingest uses GREATEST, so a slightly-stale final post never rolls anyone backwards.
                _postTimer = 0f;
                if (_lastPct >= 0f)
                    Post(_lastCachedPlayer, _lastCachedWorld, _lastPct, "disconnect(cached)");
                _lastPct = -1f;
            }

            _wasConnected = connected;
        }

        // True only when the local player is connected to a REMOTE multiplayer server (a pure
        // client). False at the menu (no ZNet), in singleplayer / when hosting (IsServer), or before
        // the world + local player + minimap exist. This is the single gate for every post.
        private static bool IsOnServer()
        {
            var znet = ZNet.instance;
            if (znet == null || znet.IsServer()) return false;      // menu, or local host / singleplayer
            if (znet.GetServerPeer() == null) return false;         // not (yet) connected to a server
            return Minimap.instance != null && Player.m_localPlayer != null;
        }

        // Cached identity so the disconnect fallback can post after Minimap/Player are torn down.
        private string _lastCachedPlayer = "";
        private string _lastCachedWorld = "";

        /// <summary>Read fog + compute % on the MAIN thread, then fire the POST off-thread.</summary>
        internal void ComputeAndPost(string reason)
        {
            try
            {
                var mm = Minimap.instance;
                var znet = ZNet.instance;
                var player = Player.m_localPlayer;
                if (mm == null || znet == null || player == null) return;

                float? pct = ComputeExploredPct(mm);
                if (pct == null) return;

                string playerName = player.GetPlayerName();
                string world = znet.GetWorldName() ?? "";
                _lastCachedPlayer = playerName;
                _lastCachedWorld = world;
                _lastPct = pct.Value;

                Post(playerName, world, pct.Value, reason);
            }
            catch (Exception ex)
            {
                Log.LogWarning($"[EilifMap] compute/post failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Explored-map %, identical math to services/stats-parser (fch.js exploredPercent):
        /// count explored cells inside the inscribed disc (radius = size/2) over disc cells, so
        /// uncovered ocean in the square's corners can't push it past 100%.
        /// </summary>
        private static float? ComputeExploredPct(Minimap mm)
        {
            if (ExploredField == null || TextureSizeField == null) return null;
            var explored = ExploredField.GetValue(mm) as bool[];
            if (explored == null || explored.Length == 0) return null;
            int size = (int)TextureSizeField.GetValue(mm);
            if (size <= 0 || explored.Length < size * size) return null;

            float r = size / 2f;
            float r2 = r * r;
            long exploredCount = 0;
            long discPixels = 0;
            for (int y = 0; y < size; y++)
            {
                float dy = y - r;
                float rowMax = r2 - dy * dy;
                if (rowMax < 0) continue; // whole row outside the disc
                float half = (float)Math.Sqrt(rowMax);
                int x0 = Math.Max(0, (int)Math.Ceiling(r - half));
                int x1 = Math.Min(size - 1, (int)Math.Floor(r + half));
                int rowBase = y * size;
                for (int x = x0; x <= x1; x++)
                {
                    discPixels++;
                    if (explored[rowBase + x]) exploredCount++;
                }
            }
            if (discPixels == 0) return null;
            float pct = (float)((double)exploredCount / discPixels * 100.0);
            return Math.Min(100f, pct);
        }

        /// <summary>Fire-and-forget POST of the tiny JSON. Never blocks the main thread.</summary>
        private void Post(string playerName, string world, float pct, string reason)
        {
            if (string.IsNullOrEmpty(playerName)) return;
            if (Interlocked.CompareExchange(ref _postInFlight, 1, 0) != 0) return; // one at a time

            // Round to 2 dp (the ingest stores 0-100). Invariant culture so we never emit "0,87".
            float rounded = (float)Math.Round(pct, 2);
            string json =
                "{\"schemaVersion\":1,\"game\":\"valheim\",\"source\":\"client-map\"," +
                "\"playerName\":" + JsonStr(playerName) + "," +
                "\"world\":" + JsonStr(world) + "," +
                "\"exploredPct\":" + rounded.ToString("0.##", CultureInfo.InvariantCulture) + "}";

            string url = _url.Value;
            string token = _token.Value;
            string pctText = rounded.ToString("0.##", CultureInfo.InvariantCulture);
            _ = Task.Run(() => PostAsync(url, token, json, playerName, world, pctText, reason));
        }

        private async Task PostAsync(string url, string token, string json,
            string playerName, string world, string pctText, string reason)
        {
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Post, url))
                {
                    req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                    if (!string.IsNullOrEmpty(token))
                        req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);

                    using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (resp.IsSuccessStatusCode)
                            Log.LogInfo($"[EilifMap] posted {pctText}% for {playerName} ({world}) [{reason}]");
                        else
                            Log.LogWarning($"[EilifMap] post HTTP {(int)resp.StatusCode} {resp.ReasonPhrase} for {playerName}");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.LogWarning($"[EilifMap] post failed: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _postInFlight, 0);
            }
        }

        // Minimal JSON string escaper (player/world names only — no dependency needed).
        private static string JsonStr(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    // Fresh final reading on a clean logout / quit-to-menu (Minimap + local player still alive here).
    [HarmonyPatch(typeof(Game), "Logout")]
    internal static class Patch_GameLogout
    {
        private static void Prefix()
        {
            try { EilifMapTrackerPlugin.Instance?.ComputeAndPost("logout"); }
            catch (Exception ex) { EilifMapTrackerPlugin.Log?.LogWarning($"[EilifMap] logout hook failed: {ex.Message}"); }
        }
    }
}
