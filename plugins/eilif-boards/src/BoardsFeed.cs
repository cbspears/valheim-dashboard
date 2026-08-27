using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;
using System.Threading.Tasks;

namespace EilifBoards
{
    /// <summary>
    /// THE FEED HALF. Owns the dashboard poll and nothing else.
    ///
    /// THREADING (copied wholesale from ../eilif-companion/src/EilifCompanionPlugin.cs):
    /// the main thread only ever calls <see cref="TryBeginFetch"/> (which returns immediately)
    /// and <see cref="TakeResult"/> (which picks up whatever a finished background task left
    /// behind). All HTTP happens on a Task-pool thread; nothing here ever blocks Unity's Update.
    /// A single in-flight flag (Interlocked, same as the Companion's <c>_fetchInFlight</c>)
    /// means a slow or hung request can never pile up a queue of overlapping polls.
    ///
    /// NO System.ValueTuple ANYWHERE — see ../BUILD.md and the source comments in
    /// ../../eilif-paths/src/EilifPathsPlugin.cs. The net462 BepInEx/Unity Mono runtime ships no
    /// ValueTuple reference and a tuple field on a load path fails the plugin load SILENTLY.
    /// Plain classes and out-vars only.
    /// </summary>
    internal sealed class BoardsFeed
    {
        // One shared client for the plugin's lifetime (Companion does the same). A 20s timeout is
        // well inside the 60s default poll cadence, so a stalled request can never overlap the next.
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private readonly string _url;
        private readonly string _token;

        private int _inFlight;            // 0/1 via Interlocked
        private FeedResult _pending;      // written by the background task, drained on the main thread

        internal BoardsFeed(string url, string token)
        {
            _url = url;
            _token = token;

            try
            {
                // Unity Mono runtime: make sure modern TLS is enabled for the Vercel HTTPS endpoint.
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            }
            catch { /* older runtimes may not expose Tls12 explicitly; ignore */ }
        }

        /// <summary>
        /// Main thread. Kicks off a background fetch unless one is already running. Never throws,
        /// never blocks. Returns false if a fetch was already in flight (the caller keeps its timer
        /// reset either way — a stuck request must not turn into a busy loop).
        /// </summary>
        internal bool TryBeginFetch()
        {
            try
            {
                if (Interlocked.CompareExchange(ref _inFlight, 1, 0) != 0) return false;
                Task.Run(new Func<Task>(FetchAsync));
                return true;
            }
            catch (Exception ex)
            {
                Interlocked.Exchange(ref _inFlight, 0);
                Volatile.Write(ref _pending, FeedResult.Network("could not start the poll task: " + ex.Message));
                return false;
            }
        }

        /// <summary>
        /// Main thread. Returns the result of a finished fetch exactly once, or null if none is
        /// waiting. The caller applies it to the world; this class never touches game state.
        /// </summary>
        internal FeedResult TakeResult()
        {
            FeedResult r = Volatile.Read(ref _pending);
            if (r == null) return null;
            Volatile.Write(ref _pending, null);
            return r;
        }

        // ---- background thread from here down ---------------------------------------------

        private async Task FetchAsync()
        {
            FeedResult result;
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Get, _url))
                {
                    // The feed authenticates with a plain Bearer token (app/api/boards/route.ts).
                    // TryAddWithoutValidation, like the Companion: HttpClient's strict header
                    // parser is not worth an exception on a stray character in an operator-pasted
                    // token — a malformed token is the server's 401 to report, not ours to throw.
                    req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + _token);

                    using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
                    {
                        int code = (int)resp.StatusCode;
                        if (!resp.IsSuccessStatusCode)
                        {
                            result = FeedResult.Http(code, resp.ReasonPhrase);
                        }
                        else
                        {
                            byte[] bytes = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                            BoardsPayload boards = Parse(bytes);
                            result = boards == null
                                ? FeedResult.Network("response was 200 but the JSON did not parse")
                                : FeedResult.Success(boards);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // Includes TaskCanceledException (the 20s timeout), DNS failures, TLS failures.
                result = FeedResult.Network(ex.Message);
            }

            // PUBLISH FIRST, THEN RELEASE — the same order as the Companion's
            // `OutQueue.Enqueue(l)` inside the try / `Interlocked.Exchange(ref _fetchInFlight, 0)`
            // in the finally. The reverse order (clear, then publish) opens a window where the main
            // thread starts fetch B while this task has not yet stored its result: if B finishes
            // first, this task's older result then clobbers B's newer one and the boards go
            // backwards for one cycle. The finally still runs on every path, so a throw here can
            // never strand _inFlight at 1 and wedge polling forever.
            try
            {
                Volatile.Write(ref _pending, result);
            }
            finally
            {
                Interlocked.Exchange(ref _inFlight, 0);
            }
        }

        /// <summary>
        /// DataContractJsonSerializer, the same no-extra-dependency parser the Companion uses for
        /// /api/voice.
        ///
        /// EXECUTED against a realistic /api/boards payload, not just reasoned about (2026-08-27).
        /// Confirmed: members arriving out of contract order all bind (the contract sorts members
        /// alphabetically, so 9 of our 10 arrive "wrong" on the wire — this is the single assumption
        /// the whole parser rests on, and it holds because the JSON read context scans the member
        /// table circularly rather than forward-only); the undeclared "data" member and its nested
        /// arrays/objects are skipped harmlessly; missing members are left null rather than throwing;
        /// an absent "boards" yields null, which the caller reports as a parse failure; and TMP
        /// markup, \n, \uXXXX and raw multi-byte UTF-8 (o-umlaut, em-dash, ellipsis) all round-trip.
        ///
        /// ONE THING THAT DOES NOT WORK, hence the skip below: a leading UTF-8 BOM makes ReadObject
        /// throw `SerializationException: Encountered unexpected character 'ï'`. Today's route uses
        /// `Response.json()` and never emits one, so this is belt-and-braces — but a CDN, proxy or
        /// hand-saved fixture in front of the feed could introduce one, and losing every board to
        /// three invisible bytes is not a failure worth allowing.
        /// </summary>
        private static BoardsPayload Parse(byte[] json)
        {
            try
            {
                int offset = 0;
                if (json != null && json.Length >= 3 &&
                    json[0] == 0xEF && json[1] == 0xBB && json[2] == 0xBF)
                {
                    offset = 3;
                }

                using (var ms = new MemoryStream(json, offset, json.Length - offset))
                {
                    var ser = new DataContractJsonSerializer(typeof(BoardsResponse));
                    var r = (BoardsResponse)ser.ReadObject(ms);
                    return r == null ? null : r.boards;
                }
            }
            catch (Exception ex)
            {
                EilifBoardsPlugin.LogWarn("boards JSON parse failed: " + ex.Message);
                return null;
            }
        }
    }

    /// <summary>Outcome of one poll. Immutable; crosses the thread boundary by reference.</summary>
    internal sealed class FeedResult
    {
        /// <summary>Kind of outcome. A plain int, not an enum, to keep the type surface trivial.</summary>
        internal const int KindOk = 0;
        internal const int KindHttp = 1;
        internal const int KindNetwork = 2;

        internal readonly int Kind;
        internal readonly int HttpStatus;    // 0 unless Kind == KindHttp
        internal readonly string Detail;     // human text for the log; null on success
        internal readonly BoardsPayload Boards;

        private FeedResult(int kind, int status, string detail, BoardsPayload boards)
        {
            Kind = kind;
            HttpStatus = status;
            Detail = detail;
            Boards = boards;
        }

        internal bool Ok { get { return Kind == KindOk; } }

        internal static FeedResult Success(BoardsPayload boards)
        {
            return new FeedResult(KindOk, 0, null, boards);
        }

        internal static FeedResult Http(int status, string reason)
        {
            // The route returns 401 for a bad/missing token and 503 only when BOARDS_TOKEN is unset
            // on the dashboard (app/api/boards/route.ts). Vercel itself also emits 503 for platform
            // conditions, so that hint names the likely cause without asserting it.
            string hint =
                status == 401 ? " - the Token in [Feed] does not match the dashboard's BOARDS_TOKEN" :
                status == 503 ? " - most likely BOARDS_TOKEN is unset on the dashboard (feed off); Vercel also returns 503 when the deployment itself is unavailable" :
                "";
            return new FeedResult(KindHttp, status, "HTTP " + status + " " + (reason ?? "") + hint, null);
        }

        internal static FeedResult Network(string message)
        {
            return new FeedResult(KindNetwork, 0, message, null);
        }

        /// <summary>
        /// A stable identity for "the same failure as last time", so a broken feed logs ONE error
        /// instead of one per poll. Network failures collapse to a single bucket on purpose: a
        /// flapping DNS/TLS message must not defeat the log-once rule.
        /// </summary>
        internal string StatusKey()
        {
            if (Kind == KindOk) return "ok";
            if (Kind == KindHttp) return "http:" + HttpStatus;
            return "network";
        }
    }

    // ---- JSON contract for the /api/boards response ------------------------------------------
    // Only the members we consume are declared; "data" (the raw numbers behind the strings) is
    // deliberately absent and is ignored by the deserializer.

    // Public (not internal) on purpose, matching ../eilif-companion/src/EilifCompanionPlugin.cs:
    // DataContractJsonSerializer assigns these fields by reflection, so the compiler's
    // "never assigned" analysis (CS0649) would fire on an internal type. Public types are exempt.
    [DataContract]
    public class BoardsResponse
    {
        [DataMember(Name = "generatedAt")] public string generatedAt;
        [DataMember(Name = "boards")] public BoardsPayload boards;
    }

    /// <summary>
    /// The eight ready-to-paste sign strings. Field names match the JSON keys exactly, and the
    /// same eight names are the marker vocabulary (<c>[board:kills]</c> etc.) — see
    /// <see cref="BoardKeys.All"/>.
    /// </summary>
    [DataContract]
    public class BoardsPayload
    {
        [DataMember(Name = "kills")] public string kills;
        [DataMember(Name = "deaths")] public string deaths;
        [DataMember(Name = "builds")] public string builds;
        [DataMember(Name = "resources")] public string resources;
        [DataMember(Name = "explored")] public string explored;
        [DataMember(Name = "distance")] public string distance;
        [DataMember(Name = "titles")] public string titles;
        [DataMember(Name = "deeds")] public string deeds;

        /// <summary>
        /// The board string for a key, or null if the feed did not carry it this time. Null is a
        /// real case the caller must handle: a claimed sign whose board vanished keeps its text.
        /// </summary>
        public string Get(string key)
        {
            switch (key)
            {
                case BoardKeys.Kills: return kills;
                case BoardKeys.Deaths: return deaths;
                case BoardKeys.Builds: return builds;
                case BoardKeys.Resources: return resources;
                case BoardKeys.Explored: return explored;
                case BoardKeys.Distance: return distance;
                case BoardKeys.Titles: return titles;
                case BoardKeys.Deeds: return deeds;
                default: return null;
            }
        }
    }

    /// <summary>The eight board keys, in the order the dashboard lists them.</summary>
    internal static class BoardKeys
    {
        internal const string Kills = "kills";
        internal const string Deaths = "deaths";
        internal const string Builds = "builds";
        internal const string Resources = "resources";
        internal const string Explored = "explored";
        internal const string Distance = "distance";
        internal const string Titles = "titles";
        internal const string Deeds = "deeds";

        internal static readonly string[] All =
        {
            Kills, Deaths, Builds, Resources, Explored, Distance, Titles, Deeds
        };

        /// <summary>Case-insensitive membership test, returning the canonical lower-case key.</summary>
        internal static string Canonical(string candidate)
        {
            if (string.IsNullOrEmpty(candidate)) return null;
            for (int i = 0; i < All.Length; i++)
            {
                if (string.Equals(All[i], candidate, StringComparison.OrdinalIgnoreCase)) return All[i];
            }
            return null;
        }
    }
}
