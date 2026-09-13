# Eilif Boards — "Living Boards"

A deliberately tiny, **server-side-only** BepInEx 5 plugin for the Eilif Valheim server
(BepInEx 5.4.2333 + ValheimPlus). No client installs, no gameplay changes, **no Harmony patches at
all** — it only reads and writes sign ZDOs.

It polls the dashboard's `/api/boards` feed and paints the leaderboard strings onto ordinary
in-game signs, so the crew can read the standings without leaving Valheim. A board that also
publishes a `leaders` entry can be asked for as a one-line **leader plaque** instead of a full top
five.

**Since 0.3.0 the list of boards is DATA, not code.** The plugin has no compiled-in vocabulary: any
key the feed publishes is a valid `[board:<key>]` marker, so adding a leaderboard on the dashboard
never needs another plugin build. The vocabulary in force is printed to `LogOutput.log` on the first
successful poll (grep `feed vocabulary:`) — that log line is the only authoritative list.

`BepInPlugin` GUID: `media.blockspace.eilif.boards` — name `Eilif Boards` — v`0.3.0`.

Version history: `CHANGELOG.md` in this folder.

Sibling plugins: `../eilif-companion` (server, ears/voice/positions — the HTTP + threading pattern
here is lifted from it), `../eilif-paths` and `../eilif-companion-client` (client, shipped in the
r2modman pack). **This one ships to the dedicated server only.**

---

## How it works

### 1. A player claims a sign

Write a marker on any sign in-game (build a sign, interact, type):

```
[board:<key>]          <- any key the feed publishes
[board:<key>:leader]   <- any key the feed also publishes a plaque for
```

At the time of writing the dashboard publishes these (**always confirm against the `feed
vocabulary:` line in the log — this list is documentation, not the contract**):

| Marker | What the sign shows |
| --- | --- |
| `[board:kills]` `[board:deaths]` `[board:builds]` `[board:resources]` `[board:explored]` `[board:distance]` `[board:damage]` `[board:hours]` `[board:crafts]` `[board:fish]` | The **top five** for that stat, leader's number accented. |
| the same ten with `:leader` — `[board:kills:leader]` | Only the **leader** — header plus one line. Same header, same name, same number as the top row of the full board. |
| `[board:titles]` | Every titled viking, alphabetical. |
| `[board:deeds]` | Great Deeds progress and the newest deed earned. |

Case-insensitive, surrounding whitespace fine (`  [BOARD: Deeds ]  `, `[ board : kills : leader ]`
both work). The key may be letters, digits and `_`. Matching is **case-insensitive on the marker and
exact on the feed**: whatever spelling the feed uses is what gets stamped into the sign. The marker
must be the sign's **whole** text — a sign that merely mentions a marker inside a sentence is a
player's sign and is never touched.

`:leader` works only on keys the feed carries a `leaders` entry for. Living Titles is alphabetical
(no winner to name) and Great Deeds is a warband total, so the feed publishes no plaque for them and
`[board:titles:leader]` / `[board:deeds:leader]` are not markers at all: those signs stay the
player's, exactly like any other text we do not recognise. An unknown key (`[board:bogus]`) or an
unknown suffix (`[board:kills:best]`) is the same — not a marker, sign untouched.

**Before the first successful poll** (the first seconds after a restart, or a whole session with the
feed down) the plugin has no feed vocabulary, so it falls back to a small built-in list — the twelve
keys above — purely so a marker written during an outage is still claimed and painted once the feed
recovers. The fallback is printed to the log if the first poll fails. It is a stand-in, never the
authority.

To change a live board into a plaque (or the other way round), just write the other marker on it.
The next poll re-points it; nothing has to be rebuilt.

It must be a plain **`sign`** (the writable wooden sign piece). That is the only text-bearing sign
prefab in 0.221.12; the blank decorative `sign_notext` plank cannot hold a marker and is not
scanned. If a marker never turns into a board, check the piece first.

### 2. Discovery scan finds it

Every `ScanSeconds` (default 300) the plugin enumerates sign ZDOs with
`ZDOMan.GetAllZDOsWithPrefabIterative("sign", …)` — the game's own **batched** enumerator, which
walks at most 400 non-empty sectors per call. The plugin makes exactly **one call per frame** and
then classifies at most 128 collected ZDOs per frame, so a scan is spread over many frames and never
stalls the server tick.

A sign whose text is a marker gets the claim stamped into a custom ZDO string
(`eilif_board = "kills"`, or `"kills:leader"` for a plaque) and the live board text written over the
marker immediately. From then on the sign is found by its `eilif_board` stamp, and the claim —
variant included — survives restarts because it lives in the world save, not in memory. A bare
`"kills"` still means the full board, so signs stamped by v0.1.0 keep working untouched.

### 3. Poll writes the boards

Every `PollSeconds` (default 60) a **background** task does
`GET Url` with `Authorization: Bearer <Token>`. The response is parsed with
`DataContractJsonSerializer` (no extra shipped dependency, same as the Companion's `/api/voice`
parser) and handed back to the main thread, which is the only place that touches the world.

The response is read as `boards` = `{ "<key>": "<sign text>" }` and `leaders` = the same shape for
the subset that has a plaque; a top-level `keys` array, when present, is the authoritative
vocabulary (otherwise the keys of `boards` are). Neither object's keys are known at compile time, so
they are read by a small hand-rolled string-map reader rather than by a DataContract — see
`src/BoardsFeed.cs` (`JsonMaps`) for why that, and not `UseSimpleDictionaryFormat`.

A plaque claim reads the response's `leaders` member. If a dashboard is older than that member, or a
board simply stops publishing a plaque, the claim falls back to the full board **silently** — a top five where a plaque was asked for, rather
than a frozen sign — and becomes a plaque again by itself once the feed carries one.

For each claimed sign, the board string is written to `ZDOVars.s_text` **only if it differs** from
what the ZDO already holds, and `s_author` / `s_authorDisplayName` are set to `""` (an empty author
is the game's "unconditionally viewable" case — no UGC/mute lookup). Clients re-read the ZDO every
2s via `Sign.UpdateText` and re-render when `DataRevision` changed, so the sign updates by itself
with no RPC of ours.

**No ownership is taken.** `ZDO.Set` has no owner check, the server's per-peer sync sends any ZDO
whose `DataRevision` moved, and `ZDOMan.ReleaseZDOS` would hand a grabbed sign back within ~2s
anyway. Full reasoning with decompile line numbers is in the class doc of `src/SignBoards.cs`.

### 4. Player edits win

The plugin remembers the exact text it last wrote per sign. If a claimed sign's text differs from
**both** that and its board string, a human wrote on it:

* the new text is a marker → the sign is **re-claimed** for that board;
* anything else → the sign is **unclaimed** (the `eilif_board` key is cleared, the player's text is
  left exactly as they wrote it) and the plugin never touches it again until it is re-marked.

> **One documented exception.** Right after a server restart the in-memory map is empty, so the scan
> *adopts* whatever text a stamped sign currently carries as "our last write". An edit made while the
> plugin was **not running** is therefore overwritten by the next poll instead of unclaiming the
> sign. The `eilif_board` stamp is the contract: to take a sign back, write on it while the server
> is up.

### 5. Failure behaviour

Everything degrades to "signs stop updating". Every game-facing method is wrapped; the update pump
itself is inside one try/catch and stops itself (with one error line) rather than throwing into
Unity's `Update` loop.

* **401** — the Token does not match the dashboard's `BOARDS_TOKEN`.
* **503** — the dashboard has no `BOARDS_TOKEN` set (feed is off).
* **Network / timeout / unparseable JSON** — one bucket.

Each is logged **once per status change**, never once per poll, and the plugin backs off to one poll
every 5 minutes until the status changes. Recovery logs one line.

A board key that disappears from the feed leaves its sign's last text alone (logged once). A board
key with no claimed sign costs nothing.

---

## Config (`BepInEx/config/media.blockspace.eilif.boards.cfg`)

| Section | Key | Default | Notes |
| --- | --- | --- | --- |
| `[General]` | `Enabled` | `true` | Master switch. `false` = loads and does nothing. |
| `[Feed]` | `Url` | `https://eilif-dashboard.vercel.app/api/boards` | Never point this at the old `valheim-dashboard.vercel.app` host unless you know why. Expected JSON: `{"generatedAt":"..","keys":["kills",..],"boards":{"<key>":"<sign text>",..},"leaders":{"<key>":"<sign text>",..},"data":{..}}` — `boards` is the only required member. |
| `[Feed]` | `Token` | `` (empty) | `Authorization: Bearer <Token>`, must equal the dashboard's `BOARDS_TOKEN`. **Empty *or still the literal `__BOARDS_TOKEN__` placeholder* ⇒ one error line naming which, and the plugin stays dormant.** Server-only secret — it is NOT in any player-facing pack. |
| `[Feed]` | `PollSeconds` | `60` | Clamped to `15..3600`. The feed has a 30s server-side cache, so below ~30 buys nothing. |
| `[Discovery]` | `ScanSeconds` | `300` | Clamped to `60..86400`. How often new markers are picked up. |

A ready-to-upload copy with `Url` filled and `Token` left as the literal placeholder
`__BOARDS_TOKEN__` is at **`dist/media.blockspace.eilif.boards.cfg`**. Substitute the real secret at
upload time; do not commit it.

---

## Ops: what to grep in `LogOutput.log` after a restart

Every line starts with `[EilifBoards]`, so the one-token check is:

```bash
grep -F '[EilifBoards]' LogOutput.log
```

A healthy boot looks like this (in this order, within ~15s of the world loading):

| Grep | Meaning |
| --- | --- |
| `Eilif Boards v0.3.0 loaded. Enabled=true, Url=…, PollSeconds=60, ScanSeconds=300, Token=set (N chars)` | **The boot summary.** Confirms the DLL loaded AND the cfg was read. Absent ⇒ the plugin did not load at all. It no longer lists the markers — the next line does. |
| `feed vocabulary: 12 board(s) - [board:kills] [board:deaths] …. 10 of them also take ':leader' - …` | **The marker vocabulary**, read off the first successful poll. This is the authoritative answer to "what can the crew write on a sign?". It is re-logged as `feed vocabulary CHANGED:` whenever the dashboard adds or drops a board — i.e. a new leaderboard shows up here with no plugin change. |
| `no board list has been read from the feed yet …` | The **first** poll failed, so the built-in fallback list is in force. Logged once; the real vocabulary line replaces it as soon as a poll lands. |
| `updated 3/8 boards` | A poll landed and wrote 3 of 8 claimed signs. Logged on the first apply and thereafter only when something changed. |
| `scan complete: 12 sign(s) in world, 8 claimed, 0 new this scan` | A discovery scan finished. The first number is **distinct valid** sign ZDOs (the game's iterator hands back the boundary sector twice; that is deduped before counting). |
| `claimed sign 123456:78 for board kills` | A marker was picked up. A plaque reads `for board kills:leader`. |
| `claimed sign 123456:78 for board kills:leader (was kills)` | Someone rewrote a live board sign as a plaque (or any marker as another). |
| `unclaimed sign 123456:78 (player edit)` | Someone wrote their own text on a board sign. |
| `feed recovered (was http:401)` | The feed came back. |

Trouble:

| Grep | Meaning |
| --- | --- |
| `Feed.Token is empty - Living Boards is DORMANT` | The cfg has no token at all. |
| `Feed.Token is still the literal placeholder __BOARDS_TOKEN__ … DORMANT` | The prefilled cfg was uploaded **without substituting the secret** — the single most likely deploy slip. Fix the cfg, restart. |
| `the world was reloaded; dropping N cached claim(s)` | Should never appear on a dedicated server. Harmless (claims rebuild from the ZDO stamps on the next scan), but worth knowing about. |
| `feed poll failed: HTTP 401 …` | Token mismatch with the dashboard's `BOARDS_TOKEN`. |
| `feed poll failed: HTTP 503 …` | `BOARDS_TOKEN` is unset on Vercel. |
| `board 'titles' is not in the feed` | That key vanished from the feed; the sign keeps its last text. A claim reads `'kills:leader'` here only when the **full board** is missing too — a missing plaque alone falls back quietly and logs nothing. |
| `the feed lists N board key(s) in 'keys' that its 'boards' object does not carry text for: …` | **Feed-side bug.** Those markers are claimable but can never paint. Fix the dashboard, not the plugin. |
| `boards JSON envelope (generatedAt/keys) did not bind: … Logged once.` | The `keys` array (or `generatedAt`) was malformed. Harmless: the vocabulary falls back to the keys of `boards`. Logged once per server lifetime. |
| `the update pump threw and has been stopped` | Bug. Signs are frozen; nothing else is affected. Restart to retry, and file it. |
| *(nothing at all)* | The DLL is not in `BepInEx/plugins/` — or the log did not truncate and you are reading the previous boot. Confirm the truncation first. |

> **Repo gotcha, worth repeating:** confirm `LogOutput.log` actually truncated before trusting that
> new plugin code loaded.

---

## Ops: swapping the DLL on the live box

The GTX host is **Windows**, so a loaded plugin DLL is file-locked and cannot be overwritten while
the server runs. The swap is always:

1. **Panel → Stop.** Wait for the process to actually exit (the lock can linger a few seconds).
2. SFTP `dist/EilifBoards.dll` over `BepInEx/plugins/EilifBoards.dll` (retry the upload if it is
   refused — that is the lock, not a permissions problem). **Nothing else changes:** the cfg, the
   token, the URL, the `eilif_board` ZDO stamps and every claimed sign carry over untouched.
3. **Panel → Start** (Stop → Start, never a soft "Restart").
4. Grep the fresh `LogOutput.log`:

   ```bash
   grep -F '[EilifBoards]' LogOutput.log | head -20
   ```

   Expect `Eilif Boards v0.3.0 loaded…`, then within a poll `feed vocabulary: …` listing the keys,
   then `updated N/M boards`. If the version still says `v0.2.0`, the old DLL is still in place
   (the upload lost the race with the lock) — or the log did not truncate; confirm that first.

**0.2.0 → 0.3.0 is a DLL-only swap.** No config change, no migration, no re-mint of the modpack
(this plugin is server-side and ships in no player-facing pack), and no coordination with the
dashboard deploy in either direction: 0.3.0 reads an old feed fine, and 0.2.0 ignores new keys.

## Build

Needs the user-local .NET SDK (`~/.dotnet`, on PATH) and `libs/` populated.

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
./refresh-libs.sh          # (re)copy game DLLs + fetch BepInEx refs into libs/
dotnet build -c Release    # outputs plugins/eilif-boards/dist/EilifBoards.dll
```

`dist/EilifBoards.dll` is the committed, deployable artifact. `libs/`, `obj/` and `bin/` are
git-ignored. Build-only `MSB3277` warnings are expected and benign (net462 targeting pack under a
newer SDK), exactly as in the sibling plugins. See `BUILD.md` for the rebuild-at-1.0 procedure.

## Deploy

1. `dotnet build -c Release`.
2. SFTP `dist/EilifBoards.dll` into the server's `BepInEx/plugins/` (GTXGaming panel — host/creds in
   the project runbook).
3. SFTP `dist/media.blockspace.eilif.boards.cfg` into the server's `BepInEx/config/`, **with
   `__BOARDS_TOKEN__` replaced by the real `BOARDS_TOKEN`** (the same value that is set in Vercel's
   env for the dashboard). Uploading the prefilled cfg means one restart, not two.
4. **Stop → Start** the server from the panel (not "Restart" if the panel's restart is a soft one —
   the DLL has to be re-read).
5. Verify with the greps above, then in-game: build a sign, write `[board:kills]` on it, and within
   `ScanSeconds` it should turn into the kills leaderboard. Then write `[board:kills:leader]` on that
   same sign — by the next poll it should collapse to the leader alone, which also proves the
   re-marker path still re-points a live board.
6. **Look at that first board.** `Sign.m_characterLimit` is 50 — that is the limit on what a *player*
   can type, and nothing checks length on the read path, so the feed's ≤200-character strings set and
   replicate fine. But the sign art was laid out for ~50 characters. If a board overflows or clips,
   that is a **feed-side** fix (shorten the strings in `lib/boards.ts`, or wrap them in a TMP
   `<size=…>` tag), not a plugin change.

## After the Valheim 1.0 / Deep North update

Re-run `./refresh-libs.sh`, `dotnet build -c Release`, re-deploy. The two things a 1.0 rebuild has to
re-verify are in `BUILD.md`: the **`"sign"` prefab name** and the **sign ZDO key layout**
(`ZDOVars.s_text` / `s_author`). Neither is a compile error if it changes.
