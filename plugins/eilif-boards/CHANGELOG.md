# EilifBoards — changelog

Server-side-only BepInEx plugin (`media.blockspace.eilif.boards`). It ships to the Eilif dedicated
server and **never** to a player-facing modpack, so a release here is a DLL swap in a stopped
window and nothing else — see "Ops: swapping the DLL on the live box" in `README.md`.

The version lives in **three** places that must move together: `EilifBoards.csproj` `<Version>`,
`EilifBoardsPlugin.PluginVersion`, and this file (the repo has been bitten by a const that lagged
the csproj — the const is what the boot log prints, so a lagging one makes the log lie about which
DLL is loaded).

---

## 0.3.0 — 2026-09-13

**The board vocabulary is now data, not code.** Adding a leaderboard on the dashboard no longer
needs a plugin build.

- **Any key the feed publishes is a valid marker.** `boards` and `leaders` are read as open-ended
  `{"<key>":"<sign text>"}` maps instead of two hard-coded eight/six-field DataContracts. A
  `[board:<key>]` marker is claimed iff `<key>` is in the feed's vocabulary; `[board:<key>:leader]`
  iff that key also has a `leaders` entry. Unknown keys and unknown suffixes stay unclaimed exactly
  as before — the sign remains the player's and its text is untouched.
- **New top-level `keys` array honoured.** When the feed sends `keys: string[]` that is the
  authoritative vocabulary; otherwise the keys of the `boards` object are. A key named in `keys`
  that `boards` carries no text for is logged once as a feed-side bug.
- **The boot line no longer lists the markers** (it cannot — there is no compiled-in list). Instead
  the plugin logs `feed vocabulary: N board(s) - [board:…] …` on the first successful poll, and
  again as `feed vocabulary CHANGED:` whenever the dashboard adds or drops a board. If the *first*
  poll fails it logs its built-in fallback list once instead, so the log always carries a usable
  vocabulary.
- **Fallback vocabulary** (used only until a poll succeeds): `kills deaths builds resources explored
  distance titles deeds damage hours crafts fish`, of which all but `titles`/`deeds` take `:leader`.
  A stand-in for the seconds after a restart and for feed outages, never the authority.
- **Marker keys may now contain digits and `_`** (`[A-Za-z0-9_]+`, was letters only), kept in
  lockstep with the `eilif_board` stamp validator, so a future key like `boss_damage` is reachable.
- **A stored `eilif_board` stamp is validated by SHAPE only, never against today's feed.** A board
  that drops out of the feed for one poll keeps its signs (and their last text) instead of being
  silently disowned.
- **Parser split.** `DataContractJsonSerializer` still reads the envelope (`generatedAt`, `keys`);
  the two open-ended objects are read by a small hand-rolled reader (`JsonMaps`) because the
  `UseSimpleDictionaryFormat` deserialisation path cannot be verified against the Unity/BepInEx Mono
  BCL from a build machine. An envelope throw is no longer fatal — it is logged once and the
  vocabulary falls back to the `boards` keys. Reasoning in `BUILD.md`.
- Rebuilt against the current game assemblies (`libs/` refreshed from the live Steam install,
  `assembly_valheim.dll` md5 `4bb76903e6080acaf48323e01a21e7ac`; the previous build used the
  2026-09-09 / 1.0.7 copy).

Unchanged on purpose: no Harmony patches, revision-based ZDO replication with no ownership taken,
the 300 s discovery scan and its per-frame budgets, unclaim-on-player-edit, the empty-author write,
the config keys, the token handling and the feed URL. Backward compatible in both directions — 0.3.0
reads a 0.2.0/0.1.0 feed (plaques and all), and a 0.2.0 plugin ignores new keys.

## 0.2.0 — 2026-08-27

- **Leader plaques.** Any of the six ranked stat markers accepts a `:leader` suffix
  (`[board:kills:leader]`) and shows only the leader row, read from the feed's new `leaders` member.
- The variant is stored in the `eilif_board` ZDO stamp (`kills:leader`), so it survives restarts and
  a bare `kills` still means the full board — signs stamped by 0.1.0 keep working untouched.
- A missing plaque falls back to the full board **silently** and becomes a plaque again by itself
  once the feed carries one.
- `[board:titles:leader]` / `[board:deeds:leader]` are deliberately not markers.

## 0.1.0 — 2026-08-27

- First release. Polls `/api/boards` and paints eight leaderboard strings onto signs claimed with
  `[board:<key>]`; claims live in the `eilif_board` ZDO string so they survive restarts; player
  edits unclaim; no Harmony, no ownership, revision-based replication.
