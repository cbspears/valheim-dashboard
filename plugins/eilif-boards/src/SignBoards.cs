using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace EilifBoards
{
    /// <summary>
    /// THE WORLD HALF. Owns every read and write of sign ZDOs. Main thread ONLY — nothing in this
    /// file may ever be touched from the poll task.
    ///
    /// ---------------------------------------------------------------------------------------
    /// HOW A SIGN BECOMES A BOARD
    /// ---------------------------------------------------------------------------------------
    /// A player writes a marker on any sign in-game: "[board:kills]" (the eight keys are the eight
    /// members of <see cref="BoardsPayload"/>; case-insensitive, surrounding whitespace ignored).
    /// The periodic discovery scan sees that text, stamps the board key into a custom ZDO string
    /// (<c>eilif_board</c>) and immediately writes the live board text over the marker. From then on
    /// the sign is found by its <c>eilif_board</c> key, so the marker never has to survive.
    ///
    /// ---------------------------------------------------------------------------------------
    /// WHY WE WRITE THE ZDO DIRECTLY AND DO **NOT** TAKE OWNERSHIP
    /// ---------------------------------------------------------------------------------------
    /// (decompile references are lines in the 0.221.12 dump)
    ///
    /// * A sign's text is not component state, it is ZDO state: `Sign.UpdateText` (124612) reads
    ///   `ZDOVars.s_text` straight off the ZDO (124623), and `Sign.Awake` starts an
    ///   `InvokeRepeating("UpdateText", 2f, 2f)` (124555) — every client re-reads its own copy every 2s
    ///   and re-renders whenever `ZDO.DataRevision` changed since the last look (124616-124622). So the
    ///   ONLY thing we have to achieve is "bump this ZDO's DataRevision on the server".
    ///
    /// * `ZDO.Set(int hash, string value)` (63111) exists with exactly that signature — no `bool`
    ///   tail parameter (the `okForNotOwner` default arg is on the *int* overload at 63046, and is
    ///   dead in its own body) — and has no owner check at all. It delegates to `ZDOExtraData.Set`,
    ///   and if that reports a change it calls `IncreaseDataRevision` (63222), which on the server
    ///   is just `DataRevision++` (the `ClientChanged` branch is client-only). The "if changed" is
    ///   BELIEVED to make an identical rewrite a no-op, but that is unverified: the decision is made
    ///   inside `BinarySearchDictionary.SetValue`, which is not in `assembly_valheim` and so is not
    ///   in the decompile. Do not rely on it — `WriteBoard` does its own `current == want` compare
    ///   first, which is what actually guarantees we never churn a revision for nothing.
    ///
    /// * Replication does not depend on ownership either. On the server `ZDOMan.CreateSyncList`
    ///   (66234) collects every ZDO in each peer's active sectors and keeps the ones where
    ///   `ZDOPeer.ShouldSend` (65349) is true — and `ShouldSend` compares
    ///   revisions, never owners. `SendZDOs` (66040) then serialises them to that peer. On the
    ///   receiving client `RPC_ZDOData` (66108) accepts any packet whose DataRevision is greater
    ///   than its local copy (66139-66163) regardless of who owns it, so an owning client happily
    ///   takes our text. It does not push back, either: line 66159 overwrites the client's
    ///   DataRevision with ours and 66162 records that same number as "what the server has", so the
    ///   client's own `ShouldSend` against the server is false on the very next tick.
    ///
    /// * It PERSISTS. `ZDOMan.PrepareSave` (65483) snapshots via `GetSaveClone` (66538), which
    ///   clones every ZDO with `Persistent` set — owner is never consulted. A sign is a persistent
    ///   piece, so board text written to a client-owned sign survives a world save and a server
    ///   restart exactly like a player-written sign would.
    ///
    /// * KNOWN, ACCEPTED, SELF-HEALING RACE (the one leg with a real hole in it). Valheim's model is
    ///   last-revision-wins with no merge, so if the owning client bumps the SAME DataRevision
    ///   number in the same instant we do (e.g. `WearNTear` writing health on that sign), both sides
    ///   land on N+1 with different payloads and each then rejects the other at the `num4 <=
    ///   DataRevision` test (66142) — the server keeps our board text, that one client keeps its
    ///   own, and `ShouldSend` will not resend because the revisions match. It self-heals the next
    ///   time the board TEXT actually changes (a fresh `Set` → N+2). Not fixable from a plugin;
    ///   requires damage to a sign inside a sub-second window, so it is a curiosity, not a risk.
    ///
    /// * Taking ownership would be actively WORSE. `ZDOMan.ReleaseZDOS` (65897) runs every 2s on the
    ///   server and calls `ReleaseNearbyZDOS` (65928) for the server itself and for every peer: a
    ///   persistent ZDO owned by someone whose active area no longer contains it is handed to
    ///   whoever is standing there. A sign we grabbed would be taken back within ~2s, and each
    ///   hand-off is an `IncreaseOwnerRevision` (63231) of pure network churn. `ZNetView.ClaimOwnership`
    ///   — what `Sign.SetText` (124698) uses — is the right call for the *player* editing a sign in
    ///   front of them; it is the wrong call for a headless server writing to signs across the map.
    ///
    /// * Authorship: `Sign.UpdateText` reads `ZDOVars.s_author` (124626) and maps an EMPTY author to
    ///   `PlatformUserID.None` at 124631-124634 (that mapping is in `UpdateText`, not in
    ///   `UpdateViewPermission`). `None.IsValid` is false, so `UpdateViewPermission` (124646)
    ///   short-circuits straight to `OnCheckPermissionCompleted(Granted)` at 124662 — no UGC lookup,
    ///   no mute check, no platform round trip, identically on Steam / Xbox / PlayFab / crossplay.
    ///   Every write therefore sets `s_author` and `s_authorDisplayName` to "".
    ///
    ///   Clearing is not merely convenient, it is REQUIRED. Leaving a real player's platform id on a
    ///   sign we overwrite sends every viewer down `RelationsManager.CheckPermissionAsync` (76822)
    ///   once per sign per 2s tick, and that path can (a) return `Denied` for any viewer who has
    ///   muted or blocked that player (76858), (b) return `Denied` on a restricted platform account
    ///   (76878), (c) return `Error` — which is NOT granted (76766) — on a transient profile-lookup
    ///   failure, blanking the board to runes, or (d) return `GrantedRequiresFiltering` (76916),
    ///   which runs the board through `CensorShittyWords.Filter` (124673) and asterisks it. All four
    ///   are per-viewer and invisible from the server. Empty author skips the lot.
    ///
    ///   ("host" is the game's other special value — `c_AuthorHostPlaceholder`, 76778. It maps to
    ///   `m_author = null` and hits the *Denied* branch at 124653, and worse: 124653 has no `return`,
    ///   so control falls into `m_author.Value` at 124655 and throws `InvalidOperationException` out
    ///   of the 2s `InvokeRepeating` on every tick. Never write it.)
    ///
    ///   TRADE-OFF WORTH KNOWING: because the empty-author path returns plain `Granted` and never
    ///   `GrantedRequiresFiltering`, board text bypasses `CensorShittyWords` on every platform,
    ///   Xbox included. Board strings embed player-chosen character names, so that filter is being
    ///   skipped over player-derived text. Fine for a known private crew; revisit if the feed ever
    ///   carries free-form player input.
    ///
    /// * CAVEAT, not a blocker: `Sign.m_characterLimit` is **50** (124534) and gates
    ///   `TextInput.RequestText` (124608) — i.e. it limits what a PLAYER can type, and nothing
    ///   validates length on the read path. The feed's strings are up to 200 characters, so a board
    ///   is ~4x what the sign art was laid out for. It sets and replicates fine; whether it *reads*
    ///   well is a visual question, so check one board in-game at deploy (see README "Deploy").
    ///
    /// ---------------------------------------------------------------------------------------
    /// NO System.ValueTuple ANYWHERE (see ../BUILD.md) — plain classes and out-vars only.
    /// ---------------------------------------------------------------------------------------
    /// </summary>
    internal sealed class SignBoards
    {
        /// <summary>
        /// The writable sign piece's prefab name. `ZDOMan.GetAllZDOsWithPrefabIterative` (66496)
        /// hashes this with the game's own `GetStableHashCode` and matches it against
        /// `ZDO.GetPrefab()`, so the string has to be the prefab name exactly.
        ///
        /// VERIFIED, not guessed: prefab names live in the asset data, not in the code, so this was
        /// checked against the shipped 0.221.12 server data (`valheim_server_Data/*.assets`).
        /// Scanning for /^sign[_a-z0-9]*$/ yields exactly TWO prefabs:
        ///
        ///   * "sign"        — the writable wooden sign. The one we scan.
        ///   * "sign_notext" — `Assets/GameElements/Pieces/sign_notext.prefab`, the decorative
        ///                     blank-plank variant. It carries no player text, so it cannot hold a
        ///                     `[board:*]` marker and is deliberately NOT scanned.
        ///
        /// (An earlier revision of this comment claimed `sign_notext` did not exist. It does; it is
        /// simply not text-bearing.) Consequence to know: a board can only ever live on a plain
        /// `sign`. If the crew builds anything else and it does not turn into a board, that is this
        /// line, not a bug. Re-check after the 1.0 / Deep North update (see ../BUILD.md).
        /// </summary>
        private const string SignPrefab = "sign";

        /// <summary>
        /// Our custom ZDO string key. Written through `ZDO.Set(string, string)` (63106), which hashes
        /// the name with the game's own `GetStableHashCode` — we deliberately do NOT reimplement that
        /// hash (it lives in `StringExtensionMethods`, which is not even in `assembly_valheim.dll`),
        /// so a mismatch is impossible by construction. The 11-char hash per access is noise next to
        /// a dictionary lookup and happens at most a few hundred times per five-minute scan.
        /// </summary>
        private const string BoardKeyZdoKey = "eilif_board";

        /// <summary>
        /// How many collected sign ZDOs we classify per frame. The COLLECTION half is already
        /// budgeted by the game (`GetAllZDOsWithPrefabIterative` breaks after 401 non-empty sectors
        /// per call — `num++` then `if (num > 400) break`, 66527-66531); this bounds the half we own.
        /// Null sectors are skipped for free and do NOT count against that budget, so one call can
        /// still walk the whole 512x512 = 262,144-slot array (`m_zdoSectorsWidth`, 67588) on a sparse
        /// world. That is a cheap null check per slot, and the number of CALLS is what the budget
        /// bounds — so a scan is always a bounded number of frames and can never wedge.
        /// </summary>
        private const int ClassifyBudgetPerFrame = 128;

        /// <summary>What we know about one claimed sign. Mutable, main thread only.</summary>
        private sealed class Claim
        {
            internal string Board;      // one of BoardKeys.All
            internal string LastWrote;  // the exact text we last wrote, or null = "never / unknown"

            internal Claim(string board) { Board = board; }
        }

        // "[board:kills]", "  [BOARD: Deeds ]  " — anchored, so a sign that merely mentions a
        // marker inside a longer sentence is a player's sign and is left alone.
        private static readonly Regex MarkerRe =
            new Regex(@"^\s*\[\s*board\s*:\s*([A-Za-z]+)\s*\]\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private readonly Dictionary<ZDOID, Claim> _claims = new Dictionary<ZDOID, Claim>();
        private readonly HashSet<string> _missingBoardLogged = new HashSet<string>();
        private bool _loggedFirstApply;

        /// <summary>
        /// The ZDOMan our cached ZDOIDs belong to, so we can notice a world swap underneath us.
        ///
        /// WHY THIS EXISTS: `ZDOID.GetHashCode` (65290) is `GetUserID(UserKey).GetHashCode() ^ ID`,
        /// and `GetUserID` (65205) indexes a STATIC `List&lt;long&gt;` intern table. The `ZDOMan`
        /// constructor calls `ZDOID.Reset()` (65454), which rebuilds that table from scratch. So if a
        /// world is ever unloaded and reloaded in-process, every ZDOID we are still holding either
        /// silently stops matching freshly-deserialised ones or, if its `UserKey` now exceeds the
        /// rebuilt table, throws `ArgumentOutOfRangeException` straight out of a dictionary probe.
        /// That would be caught by `Apply`'s try/catch and re-thrown on every single poll: signs
        /// frozen forever, one warning line, no crash — precisely the silent failure this plugin is
        /// meant not to have. A dedicated server does not reload worlds in-process, so this should
        /// never fire; it costs one reference compare per poll/scan and turns "dead until someone
        /// notices" into "rebuilt on the next scan", because the claims live in the ZDOs anyway.
        /// </summary>
        private ZDOMan _world;

        // ---- discovery-scan state (a scan spans many frames) ----
        private bool _scanActive;
        private bool _scanCollected;                 // collection done, classification in progress
        private int _scanSectorIndex;                // the `ref index` cursor GetAllZDOsWithPrefabIterative owns
        private int _scanCursor;                     // how far through _scanBuf we have classified
        private int _scanNewClaims;
        private readonly List<ZDO> _scanBuf = new List<ZDO>();
        private readonly HashSet<ZDOID> _scanSeen = new HashSet<ZDOID>();

        internal int ClaimedCount { get { return _claims.Count; } }
        internal bool ScanInProgress { get { return _scanActive; } }

        // =====================================================================================
        // DISCOVERY SCAN
        // =====================================================================================

        /// <summary>
        /// Drops every cached ZDOID if the world was swapped under us. See <see cref="_world"/> for
        /// why. Main thread; called from the two entry points that hash a cached ZDOID.
        /// </summary>
        private void SyncWorld()
        {
            ZDOMan man = ZDOMan.instance;
            if (man == null || ReferenceEquals(man, _world)) return;

            if (_world != null)
            {
                // Not a warning about US — the world changed. Say what we did and move on.
                EilifBoardsPlugin.LogInfo("the world was reloaded; dropping " + _claims.Count +
                                       " cached claim(s). They are rebuilt from the eilif_board ZDO " +
                                       "stamps on the next discovery scan.");
            }
            _world = man;
            _claims.Clear();
            _scanActive = false;
            _scanCollected = false;
            _scanBuf.Clear();
            _scanSeen.Clear();
        }

        /// <summary>Arms a scan. The work happens in <see cref="ScanStep"/>, one slice per frame.</summary>
        internal void BeginScan()
        {
            SyncWorld();
            if (_scanActive) return;
            _scanActive = true;
            _scanCollected = false;
            _scanSectorIndex = 0;
            _scanCursor = 0;
            _scanNewClaims = 0;
            _scanBuf.Clear();
            _scanSeen.Clear();
        }

        /// <summary>
        /// One frame's slice of the discovery scan. Returns true when the scan has just finished.
        /// Never throws.
        /// </summary>
        internal bool ScanStep(BoardsPayload boards)
        {
            if (!_scanActive) return false;
            try
            {
                if (!_scanCollected)
                {
                    ZDOMan man = ZDOMan.instance;
                    if (man == null) { _scanActive = false; return false; }

                    // ONE call per frame. The method walks up to 400 non-empty sectors and returns
                    // false to say "call me again"; on the final call it sweeps the outside-sector
                    // buckets, drops invalid ZDOs and returns true (66496-66534).
                    _scanCollected = man.GetAllZDOsWithPrefabIterative(SignPrefab, _scanBuf, ref _scanSectorIndex);
                    return false;
                }

                int budget = ClassifyBudgetPerFrame;
                while (_scanCursor < _scanBuf.Count && budget-- > 0)
                {
                    Classify(_scanBuf[_scanCursor++], boards);
                }
                if (_scanCursor < _scanBuf.Count) return false;

                FinishScan();
                return true;
            }
            catch (Exception ex)
            {
                // A broken scan must never wedge the plugin: abandon this pass, keep the cache we
                // already have, try again at the next ScanSeconds tick.
                EilifBoardsPlugin.LogWarn("discovery scan aborted: " + ex.Message);
                _scanActive = false;
                _scanBuf.Clear();
                _scanSeen.Clear();
                return false;
            }
        }

        private void FinishScan()
        {
            // _scanSeen, not _scanBuf.Count: the collected list is inflated by the vanilla
            // duplicate-sector bug (see Classify), so _scanBuf.Count would over-report "signs in
            // world" by exactly the number of duplicates. _scanSeen holds distinct valid ZDOIDs.
            int total = _scanSeen.Count;
            _scanBuf.Clear();

            // Prune claims the scan did not see. Deliberately NOT a blind "not seen => drop":
            // re-check the ZDO directly, so a sign the iterator happened to miss keeps working.
            List<ZDOID> stale = null;
            foreach (KeyValuePair<ZDOID, Claim> kv in _claims)
            {
                if (_scanSeen.Contains(kv.Key)) continue;
                ZDO zdo = SafeGet(kv.Key);
                if (zdo != null && BoardKeys.Canonical(zdo.GetString(BoardKeyZdoKey, "")) == kv.Value.Board) continue;
                if (stale == null) stale = new List<ZDOID>();
                stale.Add(kv.Key);
            }
            if (stale != null)
            {
                for (int i = 0; i < stale.Count; i++) _claims.Remove(stale[i]);
            }

            _scanSeen.Clear();
            _scanActive = false;
            _scanCollected = false;

            EilifBoardsPlugin.LogInfo("scan complete: " + total + " sign(s) in world, " +
                                   _claims.Count + " claimed, " + _scanNewClaims + " new this scan" +
                                   (stale != null ? ", " + stale.Count + " dropped" : "") + ".");
        }

        /// <summary>Decide what one scanned sign ZDO is: a fresh marker, an existing board, or a player's sign.</summary>
        private void Classify(ZDO zdo, BoardsPayload boards)
        {
            try
            {
                if (zdo == null || !zdo.IsValid()) return;
                ZDOID id = zdo.m_uid;

                // GetAllZDOsWithPrefabIterative breaks out of its loop BEFORE `index++` when it hits
                // its 400-sector budget (66524-66529), so the sector it stopped on is walked again on
                // the next call and its ZDOs land in the list twice. Dedupe here rather than paying
                // for a List.Contains per element.
                if (!_scanSeen.Add(id)) return;

                string text = zdo.GetString(ZDOVars.s_text, "");
                string marked = ParseMarker(text);
                string stamped = BoardKeys.Canonical(zdo.GetString(BoardKeyZdoKey, ""));

                if (marked != null)
                {
                    // A player just claimed (or re-pointed) this sign.
                    Claim claim;
                    bool isNew = !_claims.TryGetValue(id, out claim);
                    if (isNew) { claim = new Claim(marked); _claims[id] = claim; }
                    bool changed = isNew || claim.Board != marked;

                    claim.Board = marked;
                    claim.LastWrote = null; // the marker is not ours; force a write

                    if (stamped != marked) zdo.Set(BoardKeyZdoKey, marked);

                    if (changed)
                    {
                        _scanNewClaims++;
                        EilifBoardsPlugin.LogInfo("claimed sign " + id + " for board " + marked + ".");
                    }

                    // "immediately write the current board text" — only possible once a poll has
                    // landed; otherwise the marker stays visible until the first successful poll.
                    if (boards != null) WriteBoard(zdo, claim, boards);
                    return;
                }

                if (stamped != null)
                {
                    // Already ours. Re-seat it in the cache (this is what makes the scan a cache
                    // refresh across restarts).
                    Claim claim;
                    if (!_claims.TryGetValue(id, out claim))
                    {
                        claim = new Claim(stamped);
                        // ADOPT the text that is on the sign right now as "our last write". After a
                        // server restart the cache is empty and the sign still carries whatever we
                        // wrote before the restart; without this the very next poll would read
                        // "text differs from our last write" and unclaim a perfectly good board.
                        // The trade-off is explicit: an edit a player made while the plugin was NOT
                        // running is overwritten by the next poll rather than unclaiming the sign.
                        // The eilif_board stamp is the contract — to take a sign back, write on it
                        // while the server is up. (Documented in README.md.)
                        claim.LastWrote = text;
                        _claims[id] = claim;
                    }
                    else
                    {
                        claim.Board = stamped;
                    }
                    return;
                }

                // Plain player sign. Not ours, never touched.
            }
            catch (Exception ex)
            {
                EilifBoardsPlugin.LogWarn("could not classify a sign: " + ex.Message);
            }
        }

        // =====================================================================================
        // POLL RESULT -> SIGNS
        // =====================================================================================

        /// <summary>
        /// Push a fresh feed snapshot onto every claimed sign. Main thread. Never throws.
        /// </summary>
        internal void Apply(BoardsPayload boards)
        {
            if (boards == null) return;
            try
            {
                SyncWorld();

                int changed = 0;
                int unclaimed = 0;

                // Snapshot the keys: Apply can remove entries (unclaim) while iterating.
                ZDOID[] ids = new ZDOID[_claims.Count];
                _claims.Keys.CopyTo(ids, 0);

                for (int i = 0; i < ids.Length; i++)
                {
                    ZDOID id = ids[i];
                    Claim claim;
                    if (!_claims.TryGetValue(id, out claim)) continue;

                    try
                    {
                        ZDO zdo = SafeGet(id);
                        if (zdo == null)
                        {
                            // Sign destroyed (or its ZDO went away). Nothing to log — the next scan
                            // is the source of truth for what exists.
                            _claims.Remove(id);
                            continue;
                        }

                        string current = zdo.GetString(ZDOVars.s_text, "");
                        string want = boards.Get(claim.Board);

                        // ---- respect player edits ----------------------------------------------
                        // Differs from BOTH our last write and the board string => a human touched it.
                        if (current != claim.LastWrote && current != want)
                        {
                            string marked = ParseMarker(current);
                            if (marked != null)
                            {
                                // They re-pointed the sign at a (possibly different) board.
                                if (claim.Board != marked)
                                    EilifBoardsPlugin.LogInfo("claimed sign " + id + " for board " + marked +
                                                           " (was " + claim.Board + ").");
                                claim.Board = marked;
                                claim.LastWrote = null;
                                zdo.Set(BoardKeyZdoKey, marked);
                                want = boards.Get(marked);
                            }
                            else
                            {
                                // They wrote their own text. Release the sign and leave it alone.
                                // There is no "remove key" on the string side of ZDOExtraData (it
                                // has RemoveFloat/Int/Long/Vec3/Quaternion at 64651-64671 but no
                                // RemoveString), so clearing to "" is the removal: every read is
                                // `GetString(key, "")`, which cannot tell absent from empty.
                                zdo.Set(BoardKeyZdoKey, "");
                                _claims.Remove(id);
                                unclaimed++;
                                EilifBoardsPlugin.LogInfo("unclaimed sign " + id + " (player edit).");
                                continue;
                            }
                        }

                        if (WriteBoard(zdo, claim, want)) changed++;
                    }
                    catch (Exception ex)
                    {
                        // One bad sign never stops the sweep.
                        EilifBoardsPlugin.LogWarn("could not update sign " + id + ": " + ex.Message);
                    }
                }

                if (changed > 0 || unclaimed > 0 || !_loggedFirstApply)
                {
                    _loggedFirstApply = true;
                    EilifBoardsPlugin.LogInfo("updated " + changed + "/" + _claims.Count + " boards" +
                                           (unclaimed > 0 ? " (" + unclaimed + " unclaimed)" : "") + ".");
                }
            }
            catch (Exception ex)
            {
                EilifBoardsPlugin.LogWarn("board apply failed: " + ex.Message);
            }
        }

        // =====================================================================================
        // helpers
        // =====================================================================================

        private bool WriteBoard(ZDO zdo, Claim claim, BoardsPayload boards)
        {
            return WriteBoard(zdo, claim, boards.Get(claim.Board));
        }

        /// <summary>
        /// Writes <paramref name="want"/> onto the sign if and only if it differs from what the ZDO
        /// already holds. Returns true if the ZDO was actually written.
        /// </summary>
        private bool WriteBoard(ZDO zdo, Claim claim, string want)
        {
            if (want == null)
            {
                // The feed no longer carries this board. Keep whatever the sign says; say so once.
                if (_missingBoardLogged.Add(claim.Board))
                    EilifBoardsPlugin.LogWarn("board '" + claim.Board + "' is not in the feed; its sign(s) keep their last text.");
                return false;
            }
            _missingBoardLogged.Remove(claim.Board);

            string current = zdo.GetString(ZDOVars.s_text, "");
            if (current == want)
            {
                claim.LastWrote = want;
                return false;
            }

            // ZDOVars.s_text / s_author / s_authorDisplayName are the game's own precomputed hashes
            // (67333 / 67067 / 67069 -> "text", "author", "authorPlatformDisplayName").
            zdo.Set(ZDOVars.s_text, want);
            // Empty author == unconditionally viewable on every client; see the class doc.
            zdo.Set(ZDOVars.s_author, "");
            zdo.Set(ZDOVars.s_authorDisplayName, "");
            claim.LastWrote = want;
            return true;
        }

        /// <summary>The board key a sign's text claims, or null if it is not a marker.</summary>
        private static string ParseMarker(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            // Cheap reject before the regex: every marker contains '['.
            if (text.IndexOf('[') < 0) return null;
            Match m = MarkerRe.Match(text);
            if (!m.Success) return null;
            return BoardKeys.Canonical(m.Groups[1].Value);
        }

        private static ZDO SafeGet(ZDOID id)
        {
            ZDOMan man = ZDOMan.instance;
            if (man == null) return null;
            ZDO zdo = man.GetZDO(id);
            return (zdo != null && zdo.IsValid()) ? zdo : null;
        }
    }
}
