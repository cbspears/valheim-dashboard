using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
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

        /// <summary>0/1 via Interlocked: has the "envelope did not bind" warning been logged yet?</summary>
        private static int _envelopeWarned;

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
                            BoardsResponse snapshot = Parse(bytes);
                            result = snapshot == null
                                ? FeedResult.Network("response was 200 but the JSON did not parse")
                                : FeedResult.Success(snapshot);
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
        /// TWO PARSERS, ON PURPOSE (0.3.0).
        ///
        /// The ENVELOPE ("generatedAt", "keys") is still read by DataContractJsonSerializer — the
        /// same no-extra-dependency parser the Companion uses for /api/voice, and the one whose
        /// behaviour against a real /api/boards body was executed and written down on 2026-08-27:
        /// members arriving out of contract order all bind (the read context scans the member table
        /// circularly, not forward-only); the undeclared "data" member and its nested arrays are
        /// skipped harmlessly; missing members are left null rather than throwing; and TMP markup,
        /// \n, \uXXXX and raw multi-byte UTF-8 all round-trip.
        ///
        /// The two OPEN-ENDED objects ("boards" and "leaders") are read by <see cref="JsonMaps"/>
        /// instead, because as of 0.3.0 their keys are whatever the dashboard decided to publish and
        /// a DataContract cannot name them at compile time. The obvious alternative —
        /// <c>[DataMember] Dictionary&lt;string,string&gt;</c> with
        /// <c>DataContractJsonSerializerSettings.UseSimpleDictionaryFormat = true</c> — is rejected
        /// deliberately: that flag's DESERIALISATION path is a corner of
        /// System.Runtime.Serialization, and the runtime this DLL actually executes on is the
        /// Unity/BepInEx Mono BCL, which is a re-implementation we cannot exercise from a build
        /// machine (there is no way to run it here without the game). If it silently mis-bound, the
        /// symptom would be every board on the server freezing, discovered by a player. The
        /// hand-rolled reader below uses nothing but string/char/StringBuilder, is deterministic,
        /// and is unit-testable off the game entirely.
        ///
        /// FAILURE POLICY. A DCJS throw is NOT fatal any more: "generatedAt" is decoration and
        /// "keys" degrades to the boards object's own key set (see
        /// <see cref="BoardsResponse.BuildVocabulary"/>), so the snapshot is still usable. The one
        /// hard requirement is unchanged from 0.1.0: no "boards" object means no usable snapshot,
        /// because every claim — plaques included — can fall back to a full board.
        ///
        /// ONE THING THAT DOES NOT WORK, hence the skip below: a leading UTF-8 BOM makes ReadObject
        /// throw `SerializationException: Encountered unexpected character 'ï'`. Today's route uses
        /// `Response.json()` and never emits one, so this is belt-and-braces — but a CDN, proxy or
        /// hand-saved fixture in front of the feed could introduce one, and losing every board to
        /// three invisible bytes is not a failure worth allowing. (JsonMaps would cope on its own;
        /// the skip is what keeps the envelope readable too.)
        /// </summary>
        private static BoardsResponse Parse(byte[] json)
        {
            try
            {
                if (json == null || json.Length == 0) return null;

                int offset = 0;
                if (json.Length >= 3 && json[0] == 0xEF && json[1] == 0xBB && json[2] == 0xBF)
                {
                    offset = 3;
                }
                int count = json.Length - offset;
                if (count <= 0) return null;

                BoardsResponse r = null;
                try
                {
                    using (var ms = new MemoryStream(json, offset, count))
                    {
                        var ser = new DataContractJsonSerializer(typeof(BoardsResponse));
                        r = (BoardsResponse)ser.ReadObject(ms);
                    }
                }
                catch (Exception ex)
                {
                    // Decoration only, so this is NOT a poll failure. Logged ONCE for the plugin's
                    // lifetime: a feed that trips it trips it every 60s forever, and a warning that
                    // repeats until the log rolls is a warning nobody reads.
                    if (Interlocked.CompareExchange(ref _envelopeWarned, 1, 0) == 0)
                    {
                        EilifBoardsPlugin.LogWarn("boards JSON envelope (generatedAt/keys) did not bind: " +
                                                  ex.Message + ". The board keys will be taken from the " +
                                                  "'boards' object itself; boards still work. Logged once.");
                    }
                }
                if (r == null) r = new BoardsResponse();

                string text = Encoding.UTF8.GetString(json, offset, count);
                r.Boards = JsonMaps.ExtractStringMap(text, "boards");
                r.Leaders = JsonMaps.ExtractStringMap(text, "leaders");

                if (r.Boards == null) return null;

                r.BuildVocabulary();
                return r;
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
        internal readonly BoardsResponse Snapshot;   // the whole parsed response: boards AND leaders

        private FeedResult(int kind, int status, string detail, BoardsResponse snapshot)
        {
            Kind = kind;
            HttpStatus = status;
            Detail = detail;
            Snapshot = snapshot;
        }

        internal bool Ok { get { return Kind == KindOk; } }

        internal static FeedResult Success(BoardsResponse snapshot)
        {
            return new FeedResult(KindOk, 0, null, snapshot);
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
    //
    // THE CONTRACT, as of plugin 0.3.0 (feed side: app/api/boards/route.ts + lib/boards.ts):
    //
    //   {
    //     "generatedAt": "2026-09-13T16:00:00.000Z",   // string, optional, decoration only
    //     "keys": ["kills","deaths", ... ],            // string[], optional but PREFERRED — the
    //                                                  //   authoritative list of board keys
    //     "boards":  { "<key>": "<sign text>", ... },  // REQUIRED. Keys are free-form; the plugin
    //                                                  //   has no compiled-in list any more.
    //     "leaders": { "<key>": "<sign text>", ... },  // optional; the subset of keys that also
    //                                                  //   publish a one-line leader plaque
    //     "data":    { ... }                           // ignored, any shape
    //   }
    //
    // A key must match /^[A-Za-z0-9_]+$/ to be reachable from a sign, because that is what the
    // marker regex in ../src/SignBoards.cs accepts between "[board:" and "]" (or before ":leader").
    // Anything else the feed publishes is simply never claimable — no error, no crash.
    //
    // Any member value that is not a string inside "boards"/"leaders" (null, a number, an object)
    // is skipped, not fatal: that key behaves exactly like a key the feed did not send at all.

    // Public (not internal) on purpose, matching ../eilif-companion/src/EilifCompanionPlugin.cs:
    // DataContractJsonSerializer assigns these fields by reflection, so the compiler's
    // "never assigned" analysis (CS0649) would fire on an internal type. Public types are exempt.
    [DataContract]
    public class BoardsResponse
    {
        [DataMember(Name = "generatedAt")] public string generatedAt;

        /// <summary>
        /// The feed's own list of every board key it publishes (added by the 0.3.0 dashboard).
        /// NULL on any older feed, which is handled: <see cref="BuildVocabulary"/> then falls back
        /// to the keys of the <c>boards</c> object itself. This is also why a DataContract failure
        /// on the envelope is survivable — losing this member costs nothing but the feed's opinion
        /// about ordering.
        /// </summary>
        [DataMember(Name = "keys")] public string[] keys;

        // ---- filled by BoardsFeed.Parse AFTER ReadObject, by JsonMaps. NOT DataMembers. --------

        /// <summary>Board key -&gt; full board text. Never null on a snapshot that reached the world.</summary>
        public Dictionary<string, string> Boards;

        /// <summary>Board key -&gt; one-line leader plaque. Null when the feed carries no "leaders".</summary>
        public Dictionary<string, string> Leaders;

        /// <summary>
        /// Every key a <c>[board:&lt;key&gt;]</c> marker may name in this snapshot: <see cref="keys"/>
        /// when the feed sent one, otherwise the keys of <see cref="Boards"/>. Never null after
        /// <see cref="BuildVocabulary"/>.
        /// </summary>
        public string[] Vocabulary;

        /// <summary>
        /// Every key a <c>[board:&lt;key&gt;:leader]</c> marker may name: exactly the keys of
        /// <see cref="Leaders"/>. Empty (not null) when the feed carries no plaques at all.
        /// </summary>
        public string[] LeaderVocabulary;

        /// <summary>
        /// Works out the two marker vocabularies. Called once per successful parse, on the
        /// background thread, before the snapshot is published to the main thread.
        /// </summary>
        internal void BuildVocabulary()
        {
            List<string> v = new List<string>();
            if (keys != null)
            {
                for (int i = 0; i < keys.Length; i++)
                {
                    string k = keys[i];
                    if (string.IsNullOrEmpty(k)) continue;
                    if (IndexOfKey(v, k) < 0) v.Add(k);
                }
            }
            if (v.Count == 0 && Boards != null)
            {
                foreach (string k in Boards.Keys)
                {
                    if (string.IsNullOrEmpty(k)) continue;
                    if (IndexOfKey(v, k) < 0) v.Add(k);
                }
            }
            Vocabulary = v.ToArray();

            List<string> lv = new List<string>();
            if (Leaders != null)
            {
                foreach (string k in Leaders.Keys)
                {
                    if (string.IsNullOrEmpty(k)) continue;
                    if (IndexOfKey(lv, k) < 0) lv.Add(k);
                }
            }
            LeaderVocabulary = lv.ToArray();
        }

        /// <summary>
        /// Board keys this snapshot says exist but carries no string for — i.e. markers a player
        /// can claim that will never resolve to text. Empty in a healthy feed; the plugin logs it
        /// once per distinct vocabulary so a feed-side mistake is visible from LogOutput.log
        /// instead of from a sign that never changes. Never null.
        /// </summary>
        public string[] KeysWithoutText()
        {
            List<string> missing = new List<string>();
            if (Vocabulary != null)
            {
                for (int i = 0; i < Vocabulary.Length; i++)
                {
                    if (Lookup(Boards, Vocabulary[i]) == null) missing.Add(Vocabulary[i]);
                }
            }
            return missing.ToArray();
        }

        /// <summary>
        /// The sign text one CLAIM asks for ("kills" = the full board, "kills:leader" = the plaque),
        /// or null if this snapshot cannot answer it (the caller then leaves the sign alone).
        ///
        /// A leader claim falls back to the full board SILENTLY whenever the plaque is missing: an
        /// older dashboard, a feed that dropped the member, or a board that simply stopped
        /// publishing one. Showing a top-five where a plaque was asked for is a small,
        /// self-explaining wrong; freezing the sign — or logging once per missing key on every poll
        /// — is worse. The claim itself stays intact in the ZDO, so the sign becomes a plaque again
        /// the moment the feed carries one.
        /// </summary>
        public string Resolve(string claim)
        {
            string key = BoardKeys.KeyOf(claim);
            if (key == null) return null;

            if (BoardKeys.IsLeader(claim))
            {
                string plaque = Lookup(Leaders, key);
                if (plaque != null) return plaque;
            }

            return Lookup(Boards, key);
        }

        /// <summary>
        /// Exact match first — the feed's spelling is canonical — then case-insensitive, so a claim
        /// stamped into a ZDO under an older spelling of the same key ("Kills" vs "kills") keeps
        /// resolving instead of silently freezing its sign.
        /// </summary>
        private static string Lookup(Dictionary<string, string> map, string key)
        {
            if (map == null || string.IsNullOrEmpty(key)) return null;
            string exact;
            if (map.TryGetValue(key, out exact)) return exact;
            foreach (KeyValuePair<string, string> kv in map)
            {
                if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)) return kv.Value;
            }
            return null;
        }

        private static int IndexOfKey(List<string> list, string key)
        {
            for (int i = 0; i < list.Count; i++)
            {
                if (string.Equals(list[i], key, StringComparison.OrdinalIgnoreCase)) return i;
            }
            return -1;
        }
    }

    /// <summary>
    /// Marker vocabulary and claim strings. As of 0.3.0 the vocabulary is DATA, not code: it comes
    /// from the feed, so adding a leaderboard on the dashboard never needs another plugin build.
    /// The constants that used to live here (Kills, Deaths, …) are gone on purpose — a compiled-in
    /// list is exactly the thing this version removes.
    ///
    /// Three different questions, three different answers, and mixing them up is the bug to avoid:
    ///
    ///   * <see cref="Claim(string,string,BoardsResponse)"/> — "may a player claim a sign with
    ///     this marker?" Asked of the CURRENT feed. Unknown key ⇒ not a marker ⇒ the sign stays
    ///     the player's, exactly as in 0.2.0.
    ///   * <see cref="CanonicalClaim"/> — "is this eilif_board stamp one of ours?" Asked of the
    ///     SHAPE only, never of the feed. A stamp was written by us when its key was valid, and a
    ///     board that drops out of the feed for one poll must not disown its signs.
    ///   * <see cref="BoardsResponse.Resolve"/> — "what text does this claim want today?" Asked of
    ///     the snapshot; null means "leave the sign exactly as it is".
    /// </summary>
    internal static class BoardKeys
    {
        /// <summary>The variant that asks for the leader row alone instead of the top five.</summary>
        internal const string Leader = "leader";

        /// <summary>
        /// Separates a board key from its variant, in the marker AND in the <c>eilif_board</c> stamp:
        /// "kills:leader". A BARE "kills" is the full board, which is why every sign stamped by
        /// 0.1.0/0.2.0 keeps meaning exactly what it meant then.
        /// </summary>
        internal const char VariantSeparator = ':';

        /// <summary>
        /// The vocabulary used when NO feed has ever been read — the first seconds after a restart,
        /// or a whole session in which the feed never answers. It exists so a player writing
        /// "[board:kills]" during an outage still gets the sign claimed (and painted the moment the
        /// feed recovers) instead of silently keeping their marker text.
        ///
        /// It is a convenience, NOT the contract: the feed decides. Keeping it in sync with the
        /// dashboard is optional — a key missing from here is claimable one poll later, and a key
        /// here that the feed does not publish resolves to nothing (one "not in the feed" warning,
        /// sign keeps its text).
        /// </summary>
        internal static readonly string[] FallbackAll =
        {
            "kills", "deaths", "builds", "resources", "explored", "distance", "titles", "deeds",
            "damage", "hours", "crafts", "fish"
        };

        /// <summary>
        /// The fallback subset that also answers to ":leader". "titles" is alphabetical (no winner
        /// to name) and "deeds" is a warband total, so neither has a leader row — same as 0.2.0.
        /// </summary>
        internal static readonly string[] FallbackLeaders =
        {
            "kills", "deaths", "builds", "resources", "explored", "distance",
            "damage", "hours", "crafts", "fish"
        };

        /// <summary>Board keys claimable right now: the feed's, or the fallback if there is no feed yet.</summary>
        internal static string[] VocabularyOf(BoardsResponse snapshot)
        {
            if (snapshot == null || snapshot.Vocabulary == null || snapshot.Vocabulary.Length == 0)
                return FallbackAll;
            return snapshot.Vocabulary;
        }

        /// <summary>
        /// Keys whose ":leader" plaque is claimable right now. With a snapshot in hand this is
        /// exactly what the feed publishes plaques for — an empty array if it publishes none, which
        /// makes "[board:x:leader]" not a marker at all rather than a board in disguise. Without a
        /// snapshot it is the fallback subset.
        /// </summary>
        internal static string[] LeaderVocabularyOf(BoardsResponse snapshot)
        {
            if (snapshot == null) return FallbackLeaders;
            return snapshot.LeaderVocabulary != null ? snapshot.LeaderVocabulary : new string[0];
        }

        /// <summary>Case-insensitive membership test, returning the vocabulary's own spelling.</summary>
        internal static string Canonical(string candidate, string[] vocabulary)
        {
            if (string.IsNullOrEmpty(candidate) || vocabulary == null) return null;
            for (int i = 0; i < vocabulary.Length; i++)
            {
                if (string.Equals(vocabulary[i], candidate, StringComparison.OrdinalIgnoreCase)) return vocabulary[i];
            }
            return null;
        }

        /// <summary>
        /// The canonical CLAIM for a marker's key plus optional variant — "kills" or "kills:leader"
        /// — or null if it is not a claim against <paramref name="snapshot"/> at all.
        ///
        /// Case-insensitive on the marker, EXACT on the feed: the returned claim always carries the
        /// feed's spelling, which is what gets stamped into the ZDO and looked up later.
        ///
        /// ":leader" is only meaningful for a key the feed publishes a plaque for. An unknown key
        /// or an unknown suffix ("[board:kills:best]") is therefore NOT A MARKER rather than a
        /// mistyped one: a sign we do not understand belongs to the player who wrote it, and
        /// silently showing them something else would teach the crew that a spelling works where it
        /// does not.
        /// </summary>
        internal static string Claim(string key, string variant, BoardsResponse snapshot)
        {
            string canonical = Canonical(key, VocabularyOf(snapshot));
            if (canonical == null) return null;
            if (string.IsNullOrEmpty(variant)) return canonical;
            if (!string.Equals(variant, Leader, StringComparison.OrdinalIgnoreCase)) return null;

            return Canonical(canonical, LeaderVocabularyOf(snapshot)) != null
                ? canonical + VariantSeparator + Leader
                : null;
        }

        /// <summary>
        /// The canonical claim for a stored <c>eilif_board</c> stamp, or null if it is not one.
        ///
        /// SHAPE ONLY, deliberately — this is the one place that must NOT consult the feed. A stamp
        /// is our own writing and its key was valid when it was written; re-validating it against
        /// today's snapshot would disown every sign of a board the feed is momentarily missing (the
        /// sign would fall back to "plain player sign" and never be touched again), which is the
        /// opposite of the "keep the last text" failure behaviour the rest of the plugin has.
        ///
        /// Splits on the FIRST separator only, so anything past a second colon fails rather than
        /// being quietly ignored.
        /// </summary>
        internal static string CanonicalClaim(string stored)
        {
            if (string.IsNullOrEmpty(stored)) return null;
            string s = stored.Trim();
            if (s.Length == 0) return null;

            int sep = s.IndexOf(VariantSeparator);
            if (sep < 0) return IsKeyShape(s) ? s : null;

            string key = s.Substring(0, sep);
            string variant = s.Substring(sep + 1);
            if (!IsKeyShape(key)) return null;
            return string.Equals(variant, Leader, StringComparison.OrdinalIgnoreCase)
                ? key + VariantSeparator + Leader
                : null;
        }

        /// <summary>
        /// What a board key is allowed to look like. Exactly the character class the marker regex
        /// in SignBoards accepts, so "a stamp we would write" and "a marker a player can type" can
        /// never drift apart.
        /// </summary>
        internal static bool IsKeyShape(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                          (c >= '0' && c <= '9') || c == '_';
                if (!ok) return false;
            }
            return true;
        }

        /// <summary>The board key a claim names ("kills:leader" -&gt; "kills"), or null if it is not a claim.</summary>
        internal static string KeyOf(string claim)
        {
            if (string.IsNullOrEmpty(claim)) return null;
            int sep = claim.IndexOf(VariantSeparator);
            string key = sep < 0 ? claim : claim.Substring(0, sep);
            return IsKeyShape(key) ? key : null;
        }

        /// <summary>True if this claim asks for the leader plaque rather than the full board.</summary>
        internal static bool IsLeader(string claim)
        {
            if (string.IsNullOrEmpty(claim)) return false;
            int sep = claim.IndexOf(VariantSeparator);
            return sep >= 0 &&
                   string.Equals(claim.Substring(sep + 1), Leader, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// A minimal reader for the ONE JSON shape a DataContract cannot express: a named top-level
    /// member whose value is an object of string -&gt; string with keys unknown at compile time.
    ///
    /// SCOPE, and why it is safe to hand-roll this much. It does not "parse JSON" in general: it
    /// walks the top-level object, skips every member it was not asked for (strings, numbers,
    /// literals, and arbitrarily nested objects/arrays — "data" is exactly that), and when it finds
    /// the one it wants, reads that object's string-valued members. Anything it does not
    /// understand makes it return null, which the caller treats as "no such member" — the same
    /// outcome DataContractJsonSerializer gives for a missing member.
    ///
    /// It is deliberately conservative about the things that actually bite: string escapes
    /// (\" \\ \/ \b \f \n \r \t \uXXXX) are decoded properly, so a board string containing a quote
    /// or a TMP tag cannot end a value early; a non-string value inside the map is skipped rather
    /// than fatal; and nesting is depth-capped so a hostile body cannot recurse the stack away.
    /// It reads the body as a .NET string, so multi-byte UTF-8 is already decoded by the caller.
    ///
    /// NO System.ValueTuple ANYWHERE (see ../BUILD.md) — plain out-parameters only.
    /// </summary>
    internal static class JsonMaps
    {
        /// <summary>How deep a skipped value may nest before we give up. "data" is 3-4 deep.</summary>
        private const int MaxDepth = 32;

        /// <summary>
        /// The string-valued members of the top-level object member <paramref name="member"/>, or
        /// null if there is no such member, it is not an object, or the document is not parseable.
        /// An empty object yields an empty (non-null) map — the distinction matters: a present but
        /// empty "boards" is a live feed with nothing to say, a missing one is not a snapshot.
        /// </summary>
        internal static Dictionary<string, string> ExtractStringMap(string json, string member)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(member)) return null;

            int i = 0;
            if (!SkipWs(json, ref i) || json[i] != '{') return null;
            i++;
            if (!SkipWs(json, ref i)) return null;
            if (json[i] == '}') return null;

            while (true)
            {
                if (!SkipWs(json, ref i) || json[i] != '"') return null;
                string name;
                if (!ReadString(json, ref i, out name)) return null;
                if (!SkipWs(json, ref i) || json[i] != ':') return null;
                i++;
                if (!SkipWs(json, ref i)) return null;

                if (string.Equals(name, member, StringComparison.Ordinal))
                {
                    // Found it. A non-object value (null, a string, an array) is not a board map.
                    return json[i] == '{' ? ReadStringMap(json, ref i) : null;
                }

                if (!SkipValue(json, ref i, 0)) return null;
                if (!SkipWs(json, ref i)) return null;
                if (json[i] == ',') { i++; continue; }
                return null;   // '}' (member absent) or malformed — same answer either way
            }
        }

        /// <summary>Reads the object at <paramref name="i"/> (which must be '{') as string -&gt; string.</summary>
        private static Dictionary<string, string> ReadStringMap(string json, ref int i)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            i++;   // past '{'
            if (!SkipWs(json, ref i)) return null;
            if (json[i] == '}') { i++; return map; }

            while (true)
            {
                if (!SkipWs(json, ref i) || json[i] != '"') return null;
                string key;
                if (!ReadString(json, ref i, out key)) return null;
                if (!SkipWs(json, ref i) || json[i] != ':') return null;
                i++;
                if (!SkipWs(json, ref i)) return null;

                if (json[i] == '"')
                {
                    string value;
                    if (!ReadString(json, ref i, out value)) return null;
                    if (!string.IsNullOrEmpty(key)) map[key] = value;
                }
                else
                {
                    // Not a sign string (null, a number, a nested object). Skip it: that key then
                    // behaves exactly like one the feed never sent.
                    if (!SkipValue(json, ref i, 0)) return null;
                }

                if (!SkipWs(json, ref i)) return null;
                if (json[i] == ',') { i++; continue; }
                if (json[i] == '}') { i++; return map; }
                return null;
            }
        }

        /// <summary>Advances past whitespace. False at end of input (never leaves i out of range).</summary>
        private static bool SkipWs(string s, ref int i)
        {
            while (i < s.Length)
            {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') { i++; continue; }
                return true;
            }
            return false;
        }

        /// <summary>Reads the JSON string at <paramref name="i"/> (which must be '"'), escapes decoded.</summary>
        private static bool ReadString(string s, ref int i, out string value)
        {
            value = null;
            if (i >= s.Length || s[i] != '"') return false;
            i++;

            StringBuilder sb = new StringBuilder(32);
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') { value = sb.ToString(); return true; }
                if (c != '\\') { sb.Append(c); continue; }

                if (i >= s.Length) return false;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) return false;
                        int cp;
                        if (!int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber,
                                          CultureInfo.InvariantCulture, out cp)) return false;
                        // Surrogate halves append as-is and pair up naturally in the StringBuilder.
                        sb.Append((char)cp);
                        i += 4;
                        break;
                    default: return false;
                }
            }
            return false;   // unterminated
        }

        /// <summary>Advances past one complete JSON value of any shape.</summary>
        private static bool SkipValue(string s, ref int i, int depth)
        {
            if (depth > MaxDepth) return false;
            if (!SkipWs(s, ref i)) return false;

            char c = s[i];
            if (c == '"')
            {
                string ignored;
                return ReadString(s, ref i, out ignored);
            }

            if (c == '{' || c == '[')
            {
                char close = c == '{' ? '}' : ']';
                i++;
                if (!SkipWs(s, ref i)) return false;
                if (s[i] == close) { i++; return true; }

                while (true)
                {
                    if (close == '}')
                    {
                        if (!SkipWs(s, ref i) || s[i] != '"') return false;
                        string k;
                        if (!ReadString(s, ref i, out k)) return false;
                        if (!SkipWs(s, ref i) || s[i] != ':') return false;
                        i++;
                    }
                    if (!SkipValue(s, ref i, depth + 1)) return false;
                    if (!SkipWs(s, ref i)) return false;
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == close) { i++; return true; }
                    return false;
                }
            }

            // number / true / false / null: run to the next structural character.
            int start = i;
            while (i < s.Length)
            {
                char d = s[i];
                if (d == ',' || d == '}' || d == ']' ||
                    d == ' ' || d == '\t' || d == '\r' || d == '\n') break;
                i++;
            }
            return i > start;
        }
    }
}
