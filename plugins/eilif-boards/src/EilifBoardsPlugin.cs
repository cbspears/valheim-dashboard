using System;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using UnityEngine;

namespace EilifBoards
{
    /// <summary>
    /// LIVING BOARDS — a server-side-only BepInEx 5 plugin for the Eilif Valheim server.
    ///
    /// It polls the dashboard's /api/boards feed and paints the resulting leaderboard strings onto
    /// ordinary in-game signs, so the crew can read the standings without leaving Valheim. A player
    /// claims a sign by writing "[board:kills]" on it — or "[board:kills:leader]" for a plaque with
    /// only the leader on it; from then on the plugin owns that sign until the player writes
    /// something else on it.
    ///
    /// SHAPE (deliberately the same as ../eilif-companion): one BaseUnityPlugin with an Update()
    /// pump on the main thread, one background Task for HTTP, results handed back by reference and
    /// applied on the main thread. Nothing here patches the game — no Harmony, no hooks. If the
    /// plugin fails, signs stop updating; nothing else changes.
    ///
    /// NO System.ValueTuple ANYWHERE. The net462 BepInEx/Unity Mono runtime ships no ValueTuple
    /// reference, and a tuple literal or tuple-typed field on the Awake path makes the plugin fail
    /// to load SILENTLY (no exception, it simply never registers). See ../BUILD.md.
    /// </summary>
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class EilifBoardsPlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "media.blockspace.eilif.boards";
        public const string PluginName = "Eilif Boards";
        public const string PluginVersion = "0.2.0";

        /// <summary>Every log line this plugin emits starts with this. Grep for it after a restart.</summary>
        private const string LogPrefix = "[EilifBoards] ";

        /// <summary>
        /// The literal that ships in dist/media.blockspace.eilif.boards.cfg in place of the real
        /// secret. It is NOT empty, so without this check an un-substituted cfg would sail past the
        /// "Token is empty" guard and settle into a silent 401 backoff loop instead of saying what
        /// is actually wrong. Deploying the prefilled cfg unedited is the single most likely
        /// operator mistake, so it gets its own error line.
        /// </summary>
        private const string TokenPlaceholder = "__BOARDS_TOKEN__";

        /// <summary>Poll interval floor used while the feed is failing (401 / 503 / network).</summary>
        private const float BackoffSeconds = 300f;

        /// <summary>Delay from "server is up" to the first discovery scan, so the first poll lands first.</summary>
        private const float FirstScanDelaySeconds = 10f;

        internal static ManualLogSource Log;

        // ---- Config ----
        private ConfigEntry<bool> _enabled;
        private ConfigEntry<string> _url;
        private ConfigEntry<string> _token;
        private ConfigEntry<int> _pollSeconds;
        private ConfigEntry<int> _scanSeconds;

        // ---- Runtime state (main thread only) ----
        private BoardsFeed _feed;
        private SignBoards _boards;
        private BoardsResponse _latest;     // most recent successful snapshot (for scan-time writes)

        private bool _dormant;              // no token => do nothing at all
        private bool _bootstrapped;         // first ready frame has run
        private bool _notAServerLogged;
        private bool _pumpBroken;           // an Update() threw; log once, then keep quiet

        private float _pollTimer;
        private float _scanTimer;
        private float _nextScanIn = FirstScanDelaySeconds;
        private bool _backingOff;
        private string _lastStatusKey;      // "ok" / "http:401" / "network"; drives log-once

        // =====================================================================================

        private void Awake()
        {
            Log = Logger;

            _enabled = Config.Bind("General", "Enabled", true,
                "Master switch. When false the plugin loads and does nothing at all (no polling, no scanning, no writes).");

            _url = Config.Bind("Feed", "Url",
                "https://eilif-dashboard.vercel.app/api/boards",
                "The dashboard's boards feed. Returns JSON: {\"generatedAt\":\"..\",\"boards\":{\"kills\":\"..\",\"deaths\":\"..\",\"builds\":\"..\",\"resources\":\"..\",\"explored\":\"..\",\"distance\":\"..\",\"titles\":\"..\",\"deeds\":\"..\"},\"data\":{..}}");

            _token = Config.Bind("Feed", "Token", "",
                "Sent as 'Authorization: Bearer <Token>'. Must match the dashboard's BOARDS_TOKEN. SERVER-ONLY secret - it never ships in a player-facing pack. If empty, the plugin logs one error and stays dormant.");

            _pollSeconds = Config.Bind("Feed", "PollSeconds", 60,
                new ConfigDescription("Seconds between feed polls. The feed has its own 30s server-side cache, so anything below ~30 buys nothing.",
                    new AcceptableValueRange<int>(15, 3600)));

            _scanSeconds = Config.Bind("Discovery", "ScanSeconds", 300,
                new ConfigDescription("Seconds between discovery scans (which find newly marked signs and refresh the claimed-sign cache). The scan is spread over many frames and never walks the whole ZDO store in one go.",
                    new AcceptableValueRange<int>(60, 86400)));

            try
            {
                _boards = new SignBoards();

                if (!_enabled.Value)
                {
                    _dormant = true;
                    LogInfo(PluginName + " v" + PluginVersion + " loaded but DISABLED ([General] Enabled = false). Doing nothing.");
                    return;
                }

                if (string.IsNullOrEmpty(_token.Value) || _token.Value == TokenPlaceholder)
                {
                    _dormant = true;
                    LogErr("Feed.Token is " +
                          (string.IsNullOrEmpty(_token.Value)
                               ? "empty"
                               : "still the literal placeholder " + TokenPlaceholder + " (the shipped cfg was uploaded without substituting the secret)") +
                          " - Living Boards is DORMANT. Set Token in " +
                          "BepInEx/config/" + PluginGuid + ".cfg to the dashboard's BOARDS_TOKEN and restart the server. " +
                          "No signs will be read or written until then.");
                    return;
                }

                _feed = new BoardsFeed(_url.Value, _token.Value);

                LogInfo(PluginName + " v" + PluginVersion + " loaded. Enabled=true, Url=" + _url.Value +
                     ", PollSeconds=" + PollInterval() + ", ScanSeconds=" + ScanInterval() +
                     ", Token=set (" + _token.Value.Length + " chars). Markers: [board:kills] " +
                     "[board:deaths] [board:builds] [board:resources] [board:explored] [board:distance] " +
                     "[board:titles] [board:deeds]. The six stat markers also take a ':leader' " +
                     "suffix ([board:kills:leader]) for a plaque showing only the leader.");
            }
            catch (Exception ex)
            {
                _dormant = true;
                LogErr("failed to initialise: " + ex.Message + ". Living Boards is dormant; nothing else is affected.");
            }
        }

        /// <summary>
        /// Main-thread pump. Everything is inside one try/catch: a throw here would land in Unity's
        /// Update loop, which is exactly what must never happen.
        /// </summary>
        private void Update()
        {
            if (_dormant || _pumpBroken) return;

            try
            {
                if (!ServerReady()) return;

                float dt = Time.unscaledDeltaTime;

                if (!_bootstrapped)
                {
                    // First frame with a live ZNet/ZDOMan: poll immediately so the log shows a
                    // result within seconds of a restart rather than one PollSeconds later.
                    _bootstrapped = true;
                    _pollTimer = 0f;
                    _scanTimer = 0f;
                    _nextScanIn = FirstScanDelaySeconds;
                    _feed.TryBeginFetch();
                }

                // 1) Pick up a finished poll (the ONLY place a background result touches the world).
                FeedResult result = _feed.TakeResult();
                if (result != null) HandleResult(result);

                // 2) Discovery scan: one slice per frame while a scan is running, otherwise a timer.
                if (_boards.ScanInProgress)
                {
                    _boards.ScanStep(_latest);
                }
                else
                {
                    _scanTimer += dt;
                    if (_scanTimer >= _nextScanIn)
                    {
                        _scanTimer = 0f;
                        _nextScanIn = ScanInterval();
                        _boards.BeginScan();
                    }
                }

                // 3) Poll timer. TryBeginFetch is a no-op while one is already in flight, and the
                //    timer is reset either way so a hung request can never become a busy loop.
                _pollTimer += dt;
                float interval = _backingOff ? Math.Max(PollInterval(), BackoffSeconds) : PollInterval();
                if (_pollTimer >= interval)
                {
                    _pollTimer = 0f;
                    _feed.TryBeginFetch();
                }
            }
            catch (Exception ex)
            {
                _pumpBroken = true;
                LogErr("the update pump threw and has been stopped: " + ex + ". Signs will stop updating; " +
                      "nothing else on the server is affected. Restart to retry.");
            }
        }

        // =====================================================================================

        private void HandleResult(FeedResult result)
        {
            string key = result.StatusKey();

            if (result.Ok)
            {
                if (_lastStatusKey != null && _lastStatusKey != "ok")
                    LogInfo("feed recovered (was " + _lastStatusKey + "); back to polling every " + PollInterval() + "s.");
                _lastStatusKey = key;
                _backingOff = false;
                _latest = result.Snapshot;
                _boards.Apply(result.Snapshot);
                return;
            }

            // Failure: log ONCE per distinct status, then stay quiet until the status changes.
            if (key != _lastStatusKey)
            {
                LogErr("feed poll failed: " + result.Detail + ". Backing off to one poll every " +
                      (int)Math.Max(PollInterval(), BackoffSeconds) + "s until it recovers; " +
                      "this is logged once per status change, not once per poll.");
            }
            _lastStatusKey = key;
            _backingOff = true;
        }

        /// <summary>
        /// True only on a machine that is actually running the world. On a pure client
        /// `ZNet.IsServer()` (decompile 69509) is false and this plugin never does anything —
        /// it ships to the dedicated server only, but a stray copy in a client's plugin folder is
        /// harmless. (`ZNet.IsDedicated()` at 69519 is hard-coded to return false in the shipped
        /// assembly, so it is useless as a guard.) `ZDOMan.instance` (65438) must also exist before
        /// any ZDO work is possible.
        /// </summary>
        private bool ServerReady()
        {
            ZNet net = ZNet.instance;
            if (net == null) return false;

            if (!net.IsServer())
            {
                if (!_notAServerLogged)
                {
                    _notAServerLogged = true;
                    LogInfo("this session is not a server - Living Boards is idle (it is a server-only plugin).");
                }
                return false;
            }

            return ZDOMan.instance != null;
        }

        private int PollInterval()
        {
            // The ConfigEntry already clamps to 15..3600, but a hand-edited cfg plus a future
            // BepInEx that stops clamping must not be able to produce a zero-second poll.
            return Math.Max(15, _pollSeconds.Value);
        }

        private int ScanInterval()
        {
            return Math.Max(60, _scanSeconds.Value);
        }

        // ---- logging -------------------------------------------------------------------------
        // Every line carries the [EilifBoards] prefix so ops can grep LogOutput.log for one token.
        // Logging itself is wrapped: a null logger during teardown must not become an exception.

        internal static void LogInfo(string message)
        {
            try { if (Log != null) Log.LogInfo(LogPrefix + message); } catch { }
        }

        internal static void LogWarn(string message)
        {
            try { if (Log != null) Log.LogWarning(LogPrefix + message); } catch { }
        }

        internal static void LogErr(string message)
        {
            try { if (Log != null) Log.LogError(LogPrefix + message); } catch { }
        }
    }
}
