# Rebuild-at-1.0 procedure (server-side plugin)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore (`dotnet restore --source /dev/null`) succeeds in <1s — the
`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package is already in the local cache, so a
launch-day rebuild needs **no network access** for NuGet. Full build (`dotnet build -c Release`)
takes under 2s.

## Deploying **0.3.2** (built 2026-09-04, staged, NOT uploaded)

`dist/EilifCompanion.dll` is now **0.3.2**. It carries everything 0.3.1 did — both the
`[EILIF_OATH]` and `[EILIF_CHAT]` captures moved off the dead `Chat.RPC_ChatMessage` postfix onto
the `Chat.OnNewChatMessage` **Prefix** that the `/pin` capture already proves works here (audit
voice-6 — this is what stops oaths being stored SHOUT-UPPERCASED), and per-patch isolation with an
explicit count (audit plugins-6) — plus one new thing:

**Server-side speaker verification (audit security-3).** Every chat-driven marker line is now
emitted under the name the SERVER holds for the sending peer
(`ZNet.instance.GetPeer(senderID).m_playerName`, verified against `libs/assembly_valheim.dll` with
`ilspycmd`), never the `UserInfo.Name` carried inside the client's own chat packet. `RPC_ChatMessage`
forwards that packet field unchecked, so before this a crafted ChatMessage RPC could sign another
viking's name to an oath, mirror words into #server as them, or plant pins under their name. The two
names are identical for every honest client; when they differ the peer name wins and a
`[EILIF_IDENT] mismatch peer=<peer> claimed=<claim> uid=<id>` warning is logged. A sender uid with no
peer record is refused outright (`[EILIF_IDENT] unknown sender …`) rather than falling back to the
claim. See `src/SpeakerIdentity.cs` for the decompiled evidence and the two impersonation routes this
does NOT close (duplicate character names; a forged `m_senderPeerID`).

**Log-line safety, the other half of the same hole.** The poller reads `LogOutput.log`, so the TEXT
of a shout and the NAME of a peer are identity surfaces too, and both are attacker-written
(`m_playerName` is assigned in `ZNet.RPC_PeerInfo` straight from the handshake packet). Three things
are now flattened before anything is logged: control characters (a carriage return could forge a
whole extra line), **rich-text tag openers** and, in names only, the **`|` field separator**. Both of
the latter two were confirmed by driving the real parser:

- The poller's console-echo guard is an *unanchored substring* test that runs before every marker
  regex, so a player who simply SHOUTS `Console: <color=orange>Victim</color>: <color=x>/oath …`
  used to have it reproduced verbatim on our raw-case `[EILIF_CHAT]` line and read back as a genuine
  echo from Victim. No modified client needed. (The same shape also arrived via a pin's place name
  and via a crafted `m_playerName`.)
- Marker lines are `" | "`-delimited and the oath/chat parsers split on the FIRST separator, so a
  peer named `Bren | hello` filed its chat and oaths under `Bren`, and a name of
  `Bren | poi | X | 1.0 | 2.0` planted pins on him.

Only tag openers (`<` followed by a letter or `/`) are flattened, never every angle bracket: the
poller suppresses a shout's console-echo twin by comparing name + uppercased text, so rewriting `<3`
or `5 > 3` would double-post those shouts to #server. `scripts/plugin-log-safety.test.mjs` in the
dashboard repo locks this in against the real parser. Anchoring `RE.consoleShout` to the Unity Log
prefix would close the same hole from the poller side as well, and is still worth doing.

**No marker-line FORMAT changed** — `[EILIF_OATH] <name> | <text>`, `[EILIF_CHAT]`, `[EILIF_PIN]`,
`[EILIF_POS]` are byte-identical in shape, only whose name goes in `<name>` changed — and
`[EILIF_IDENT]` is deliberately not a marker the poller parses, so **the log poller needs no matching
edit**. No config keys changed. **ValheimPlus `[Chat]` stays ENABLED** — it is what makes `/s` shouts
carry server-wide — and no server config changes: V+'s patch throws inside `Chat.AddInworldText`,
which `OnNewChatMessage` calls from its *body*, so our Prefix has already written its marker line
before the NRE fires.

**The GTX host is Windows and a loaded plugin DLL is file-locked**, so this swap only works inside a
stopped window: **Panel Stop** → SFTP-upload `dist/EilifCompanion.dll` over
`<nest>/BepInEx/plugins/EilifCompanion/EilifCompanion.dll` (retrying upload — the lock can linger a
few seconds after the process exits) → **Panel Start** (Stop → Start, never Restart) → then grep
`LogOutput.log` for:

1. **`Eilif Companion 0.3.2`** — the version actually loaded.
2. **`[Eilif] patch classes applied: 2/2`** — both hooks on (OathCapture + the pin capture); anything
   else means read the `[Eilif] could not apply <Class>: <message>` lines above it.

Then have someone shout `/s /oath I will hold the north` and confirm a raw-case
`[EILIF_OATH] <Name> | I will hold the north` line appears — mixed case is the proof the 0.3.1 hook is
live, since the old echo path could only ever produce capitals, and the name being right is the proof
the 0.3.2 peer lookup resolved. Check the LOG LINE, not the Oath wall: every shout also reaches the
poller as the server's uppercased console echo, and the poller only suppresses that twin for chat —
an oath's echo arrives second and the webhook's delete-then-insert lets it win, so the wall can still
read `I WILL HOLD THE NORTH` under the claimed name while the log line is correct. That gap is in
`services/log-poller`, not in this plugin (see the note at the top of `src/OathCapture.cs`).

A healthy server logs **no `[EILIF_IDENT]` lines at all**; one
appearing means either an impersonation attempt or that `GetPeer`/`m_playerName` moved in a game
update — in which case oaths, chat mirroring and pins all stop (by design: dropped, never
misattributed), and that grep is how you find out. So read the two greps together: the **positive**
one (a shout produces its `[EILIF_OATH]`/`[EILIF_PIN]` line) is what tells you the captures are alive
at all, and the absence of `[EILIF_IDENT]` only means nothing was *misattributed*. These warnings are
rate-limited to **one a minute** — a modified client could otherwise drive them as fast as it can
send chat packets, and this log is what the poller drags down over SFTP every 20s — so the line that
does get through carries a `(+N suppressed in the last minute)` count.

Fold this into the same stopped window as the 1.0 rebuild if one is coming.

## Launch-day sequence — do these BEFORE `refresh-libs.sh` (added 2026-09-04, audit plugins-9)

`refresh-libs.sh` copies the game DLLs out of the **local Steam client install**
(`~/snap/steam/.../Valheim/valheim_Data/Managed`). That install has `AutoUpdateBehavior 0`, i.e. it
only updates while Steam is running — so on launch day it is entirely possible to rebuild every
plugin against the **0.221.12** assemblies and ship them to a **1.0** server. Nothing in the build
catches that; the symptom is eight plugins that silently fail to load.

1. **Launch Steam and confirm Valheim shows the 1.0 build** before touching `refresh-libs.sh`.
   Let the download finish; check the build id in Steam → Valheim → Properties → Updates.
2. **Prove the server is on the same build.** SFTP-get the box's
   `valheim_server_Data/Managed/assembly_valheim.dll` and md5-compare it with the local
   `valheim_Data/Managed/assembly_valheim.dll`:

   ```bash
   md5sum ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed/assembly_valheim.dll
   # and the box's copy, fetched read-only:
   #   sshpass -e sftp ... <<< 'get <nest>/valheim_server_Data/Managed/assembly_valheim.dll /tmp/srv.dll'
   md5sum /tmp/srv.dll
   ```

   Client and dedicated-server builds are not always byte-identical across the whole Managed dir,
   but `assembly_valheim.dll` is the one this plugin compiles against — a mismatch there means the
   two are on different game builds and the rebuild is pointed at the wrong target. Stop and
   reconcile before compiling.
3. Only then run the build sequence below.

## Exact sequence, once the 1.0 game DLLs are live

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
cd plugins/eilif-companion
./refresh-libs.sh              # re-copies assembly_valheim.dll etc. from the live Steam install
dotnet build -c Release        # outputs + OVERWRITES dist/EilifCompanion.dll (intended — that's the deployable artifact)
```


## Deploying a rebuilt server DLL (the DLL is file-locked while the server runs)

The GTX host is Windows: a loaded plugin DLL cannot be overwritten in place. The swap only works
inside a stopped window, and it must be the same window as the game update:

1. **Panel Stop.**
2. Upload every rebuilt server-side DLL over SFTP (retrying-upload pattern — the lock can linger a
   few seconds after the process exits).
3. Do the rest of the stopped-window work at the same time (world upload, `Start.bat` fields,
   `worlds_local` sweep, V+ / WebMap cfg edits) — see `docs/LAUNCH-WIPE.md`.
4. **Panel Start** (Stop → Start, never Restart).
5. `bash scripts/verify-restart.sh <World>` — the Valheim version line, the plugin list, and the
   plugin's own boot line are the proof it loaded against the new build. Then verify per
   `README.md` "What MUST be validated on the live server" — especially the `ChatMessage` RPC
   param order, which Iron Gate may have changed in 1.0, and the `[EILIF_KEY]` world-key lines.
   Two more members are load-bearing since 0.3.2 and must be re-checked on the 1.0 assemblies
   (`ilspycmd -t ZNet libs/assembly_valheim.dll` and `-t ZNetPeer`): **`ZNet.GetPeer(long)`** and
   **`ZNetPeer.m_playerName`**. They are what every marker line's name now comes from, so if either
   moves, `SpeakerIdentity.PeerName` returns null, every oath/chat/pin is DROPPED (deliberately —
   never misattributed) and the log fills with `[EILIF_IDENT] unknown sender` instead.
6. **Only then re-mint the modpack.** Minting before the server is proven up means publishing a
   pack code that pins DLLs nobody has confirmed load.

## Gotchas confirmed during this warm-check

- **`dotnet build -o <other-dir>` still overwrites `dist/`.** The csproj's `CopyToDist` MSBuild
  target (`AfterTargets="Build"`) unconditionally copies `$(TargetPath)` into the project's own
  `dist/` regardless of `-o`. For a normal rebuild this is exactly what you want (dist/ IS the
  deployable artifact) — it only matters if you're doing a scratch/throwaway build and want to
  avoid touching the tracked file (in which case `git checkout -- dist/EilifCompanion.dll`
  afterward is the fix, not `-o`).
- **`System.ValueTuple` must never be used** (target is `net462`; BepInEx/Unity Mono ships no
  `System.ValueTuple` reference, so a tuple literal or tuple-typed field in the plugin's `Awake`
  path causes a **silent** plugin load failure — no exception surfaces, the plugin just never
  registers). This project's source (`src/*.cs`) does **not** currently reference tuples, so no
  action needed — but if you add one during a post-1.0 patch, don't. (The sibling `eilif-paths`
  plugin has a source-level comment on this same gotcha; it isn't otherwise written down here or
  in `eilif-companion-client`, hence this note.) **v0.2.1 adds a matching source comment** on the
  voice-pump state block in `src/EilifCompanionPlugin.cs` so the constraint is visible where the
  next edit is most likely to land.
- **Line pacing is config, not code (since v0.2.1).** The `Update()` pump speaks at most one queued
  line per `Voice.LineSpacingSeconds` (default 20, range 5–300) instead of draining the whole queue
  in one frame — center-screen messages used to overwrite each other when a poll returned 2–3 lines.
  Tunable live in `BepInEx/config/media.blockspace.eilif.companion.cfg` on the server, no rebuild
  needed; the queue holds the backlog, nothing is dropped. This is the plugin-side floor only —
  the dashboard/bot side owns the *semantic* gaps (ambient 30 min, deeds 10 min).
- Build-only warnings (`MSB3277` reference-conflict-resolution, ~30 lines) are expected and benign
  — they come from targeting `net462` via the `Microsoft.NETFramework.ReferenceAssemblies` package
  under a newer SDK, not from anything wrong with this project.
