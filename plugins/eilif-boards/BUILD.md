# Rebuild-at-1.0 procedure (server-side plugin)

Written 2026-08-27 against the **current live install** (`Valheim game version: l-0.221.12`, native
Steam under `~/snap/steam/...`). dotnet SDK on this machine: **8.0.422** at `~/.dotnet`. Full build
(`dotnet build -c Release`) takes under 1s and the NuGet restore is offline (the
`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package is already in the local cache), so a
launch-day rebuild needs no network for NuGet.

## Exact sequence, once the 1.0 game DLLs are live

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
cd plugins/eilif-boards
./refresh-libs.sh              # re-copies assembly_valheim.dll, UnityEngine*.dll from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifBoards.dll (intended — that's the deployable artifact)
```

Then deploy per `README.md` ("Deploy"): DLL into `BepInEx/plugins/`, prefilled cfg into
`BepInEx/config/`, **Stop → Start**, then the greps.

## What a 1.0 rebuild MUST re-verify (none of these are compile errors)

1. **The `"sign"` prefab name.** `src/SignBoards.cs` passes the literal string `"sign"` to
   `ZDOMan.GetAllZDOsWithPrefabIterative`, which hashes it and compares against `ZDO.GetPrefab()`.
   Prefab names live in the **asset data**, not in the code, so a rename or a new writable sign
   variant (a Deep North signpost, …) is a **silent no-op**: the scan finds zero signs and nothing is
   ever claimed. Re-verify by listing the prefab asset PATHS across all game data:

   ```bash
   V=~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data
   grep -rhoaE 'Assets/[A-Za-z0-9_/]*/[A-Za-z0-9_]*[Ss]ign[A-Za-z0-9_]*\.prefab' "$V" | sort -u
   ```

   In 0.221.12 that yields exactly three, of which only the first is a writable player piece:

   | Prefab | What it is |
   | --- | --- |
   | `Assets/GameElements/Pieces/sign.prefab` | the writable wooden sign — **the one we scan** |
   | `Assets/GameElements/Pieces/sign_notext.prefab` | decorative blank plank, carries no player text |
   | `Assets/world/Rooms/rooms/woodfarm_signpost.prefab` | room decoration, not player-buildable |

   If 1.0 adds a writable variant, `SignPrefab` has to become a list and the scan has to run once per
   prefab.

   > **Do not use the command that was here before this note.** It searched only
   > `StreamingAssets/SoftRef/Bundles` (where `sign_notext` does **not** live) and matched
   > case-insensitively against `^sign[_a-z0-9]*$`, which returns compression noise like `sigN` /
   > `sIGn` alongside real names. It reported "exactly one name: `sign`", which is wrong — there are
   > two `Pieces/` signs. Harmless in the end (the second is not text-bearing), but the method could
   > not have caught a real new variant, which is the entire point of this check.

   **Symptom in the log:** `scan complete: 0 sign(s) in world` on a server that visibly has signs.

2. **The sign ZDO key layout.** We write `ZDOVars.s_text` and clear `ZDOVars.s_author` /
   `ZDOVars.s_authorDisplayName` (0.221.12 decompile lines 67333 / 67067 / 67069 — the hashes of
   `"text"`, `"author"`, `"authorPlatformDisplayName"`). These are compile-time symbols, so a
   *rename* breaks the build (good). What does **not** break the build is Iron Gate changing the
   **meaning** of an empty author. Today `Sign.UpdateText` (124631-124634) maps an empty author to
   `PlatformUserID.None`, whose `IsValid` is false, which grants the view unconditionally; if 1.0
   flips that default, server-written signs would render as `ᚬᛏᛁᛚᛚᚴᛅᚾᚴᛚᛁᚴ` (the "hidden" glyphs) on
   every client. Re-read `Sign.UpdateText` / `UpdateViewPermission` after the patch:

   ```bash
   DOTNET_ROLL_FORWARD=Major ilspycmd -t Sign libs/assembly_valheim.dll | sed -n '/UpdateText/,/OnCheckPermissionCompleted/p'
   ```

   **Symptom in-game:** boards update (the log says `updated N/M boards`) but players see runes.

3. **`ZDOMan.GetAllZDOsWithPrefabIterative` still exists and still batches.** It is a public method,
   so a rename is a compile error — but its 401-non-empty-sector-per-call budget (0.221.12 lines 66527-66531) is what
   keeps the scan off the frame budget. If that method ever becomes a single-shot walk, the
   per-frame slicing in `ScanStep` is no longer enough and `ScanSeconds` becomes a hitch every five
   minutes. Also note the vanilla quirk we work around: it `break`s **before** `index++`, so the
   sector it stopped on is walked twice and its ZDOs appear twice in the list. `Classify` dedupes on
   `ZDOID`; if Iron Gate fixes that bug the dedupe is simply redundant, never wrong.

4. **`ZDO.Set` still has no owner check.** The whole design rests on the server being able to write a
   ZDO it does not own and have `ZDOMan`'s per-peer sync replicate it (`CreateSyncList` 66234 →
   `ShouldSend`, revision-based, owner-blind → `SendZDOs` 66040; client side `RPC_ZDOData` 66108
   accepts any higher `DataRevision`). If 1.0 adds an ownership assert to `ZDO.Set`, the fix is
   **not** to start calling `SetOwner` blindly — see the class doc in `src/SignBoards.cs` for why
   ownership churns against `ReleaseNearbyZDOS` (65928) — but to force-send per peer
   (`ZDOMan.ForceSendZDO`) or take ownership *only* for the frame of the write.

   **Symptom in-game:** the log says `updated N/M boards` but clients never see the new text.

## Gotchas confirmed while building this plugin

- **`dotnet build -o <other-dir>` still overwrites `dist/`.** The csproj's `CopyToDist` MSBuild
  target (`AfterTargets="Build"`) unconditionally copies `$(TargetPath)` into the project's own
  `dist/` regardless of `-o` — same as the two sibling plugins. For a normal rebuild that is what you
  want; for a throwaway build the fix is `git checkout -- dist/EilifBoards.dll` afterward.
- **`System.ValueTuple` must never be used** (target is `net462`; the BepInEx/Unity Mono runtime
  ships no `System.ValueTuple` reference — a tuple literal/field on a load path causes a **silent**
  plugin load failure, no exception, the plugin just never registers). Source comments in all three
  `src/*.cs` files say so where the next edit is most likely to land. Verify after any rebuild:
  `strings -e l dist/EilifBoards.dll | grep -i valuetuple` must print nothing.
- **The JSON contract classes must stay `public`.** `BoardsResponse` / `BoardsPayload` are filled by
  `DataContractJsonSerializer` via reflection. Making them `internal` turns every field into a
  `CS0649` "never assigned" warning (10 of them). `../eilif-companion` has the same classes public
  for the same reason.
- **`DataContractJsonSerializer` tolerates a lot, but NOT a UTF-8 BOM.** Executed 2026-08-27 against
  a realistic `/api/boards` body: out-of-order members bind fine (the contract sorts members
  alphabetically, so 9 of our 10 arrive "wrong" — this is the assumption the parser rests on), the
  undeclared `data` member and its nested arrays are skipped, missing members stay `null`, and raw
  multi-byte UTF-8 round-trips. A leading `EF BB BF` however throws
  `SerializationException: Encountered unexpected character 'ï'`. `Parse` in `src/BoardsFeed.cs`
  therefore skips a BOM before handing the bytes to the deserializer. `Response.json()` never emits
  one, so this only matters if something is ever put in front of the feed.
- **The log-line literals are UTF-16 in the DLL.** `strings dist/EilifBoards.dll | grep EilifBoards`
  finds nothing; the #US heap is UTF-16, so it is `strings -e l dist/EilifBoards.dll`. (Plain
  `strings` *does* find the assembly version and the plugin GUID — those live in the metadata blob.)
- **`ZNet.IsDedicated()` is useless as a guard** — it is hard-coded to `return false` in the shipped
  assembly (0.221.12 line 69519). The server guard is `ZNet.instance.IsServer()` (69509).
- **`ZDOExtraData` has no `RemoveString`** (it has `RemoveFloat`/`Int`/`Long`/`Vec3`/`Quaternion` at
  64651-64671). Unclaiming a sign therefore clears `eilif_board` to `""`; since every read is
  `GetString(key, "")`, absent and empty are indistinguishable and that is a true removal.
- Build-only warnings (`MSB3277` reference-conflict-resolution, ~30 lines) are expected and benign —
  they come from targeting `net462` via the reference-assemblies package under a newer SDK. The build
  must otherwise be `0 Error(s)` with **no `CS` warnings**.
