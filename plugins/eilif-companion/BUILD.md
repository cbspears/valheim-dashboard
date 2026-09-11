# Rebuild-at-1.0 procedure (server-side plugin)

Verified warm 2026-08-21 against the **current live install** (`Valheim game version: l-0.221.12`,
Steam buildid `21981559`, native Steam under `~/snap/steam/...`). `libs/` checksums were already
byte-identical to that install — no drift found. dotnet SDK on this machine: **8.0.422** at
`~/.dotnet`. Offline NuGet restore (`dotnet restore --source /dev/null`) succeeds in <1s — the
`Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 package is already in the local cache, so a
launch-day rebuild needs **no network access** for NuGet. Full build (`dotnet build -c Release`)
takes under 2s.

## Deploying **0.3.4** (built 2026-09-11, staged, NOT yet on the box)

`dist/EilifCompanion.dll` is now **0.3.4**. It carries everything 0.3.3 did, unchanged, plus two
things — one new feature and one bug fix that players can feel.

**1. `[VPlusHotfixShim]`, ON by default.** Valheim hotfix 1.0.10/1.0.12 (dedicated build
`25253791`) turned `PlayerProfile.s_bypassCheatChecks` from a public static FIELD into a static
PROPERTY. ValheimPlus 10.0.2 and 10.0.3 were compiled against the field and still carry
`ldsfld bool [assembly_valheim]PlayerProfile::s_bypassCheatChecks` in two places, so on 1.0.12 they
throw `MissingFieldException` and smelters, kilns, furnaces, windmills, spinning wheels and
fermenter taps stop producing while V+ is loaded. This section removes **exactly two** ValheimPlus
patches and nothing else: the prefix `ValheimPlus.GameClasses.Smelter_Spawn_Patch` puts on
`Smelter.Spawn`, and the transpiler `ValheimPlus.GameClasses.Fermenter_DelayedTap_Transpiler` puts
on `Fermenter.DelayedTap`. Full design, the identification rule, and why it re-runs after every V+
repatch: `README.md`, section `[VPlusHotfixShim]`. The identical shim ships in EilifPaths 1.7.2 for
the client side.

**No new Harmony patch class**, so `patch classes applied: 2/2` is unchanged. **Three log lines are
new**; the first is the one to grep on the boot:

```
[Eilif] VPlusHotfixShim: Smelter.Spawn prefix removed (1), Fermenter.DelayedTap transpiler removed (1). ...
[Eilif] VPlusHotfixShim: after - Smelter.Spawn prefixes 0 [], transpilers 0 []; Fermenter.DelayedTap prefixes 0 [], transpilers 0 [].
[Eilif] VPlusHotfixShim: ValheimPlus re-applied its patches; removed again (...)   # only when it had to
```

`VPlusHotfixShim: inert - ValheimPlus is not loaded` is the healthy line on a box with no V+.
A `ValheimPlus is loaded but neither broken patch was found` **warning** means either V+ has been
fixed (switch the section off) or its class names moved (the shim is no longer finding them, and
smelters are still dead) — read it, do not skip it.

**2. Bug fix: the 30-second map-closer is gone.** `EnforceWorldKeys()` used to call the private
`ZoneSystem.SendGlobalKeys(0L)` on every pass where any peer was connected. On the client that RPC
ends in `Game.UpdateNoMap()` → `Minimap.SetMapMode(Small)`, i.e. it **shuts every player's open
large map, every 30 seconds** (Mikael's report). The re-send was redundant: vanilla
`RPC_SetGlobalKey` already calls `SendGlobalKeys(0L)` itself whenever a key is actually added, and a
joining peer gets its own `SendGlobalKeys(peerID)`. Removed outright rather than made conditional —
on the tick a key IS enforced, vanilla has already broadcast. Key enforcement and the `[EILIF_KEY]`
lines are untouched, and the log poller needs no edit.

**Load-tested 2026-09-11** on `~/Valheim-Test-Server-hotfix` (game **1.0.12**, dedicated build
25253791, BepInEx 5.4.23.3, the box's plugin set), two 200 s boots — one with ValheimPlus **10.0.2**
and one with **10.0.3** — plus a throwaway test plugin that drove V+'s own
`UnpatchSelf()` + `PatchAll()` twice per boot to exercise the repatch path. Both boots: `2/2`,
shim removed `(1)`/`(1)`, post-strip dump empty on both methods, **0 `Exception` lines**, and the
shim re-stripped on every driven repatch.

---

## Deploying **0.3.3** (built 2026-09-05, staged, NOT yet on the box)

> "NOT uploaded" here means **not yet SFTP'd onto the GTX box**, which is a stopped-window job.
> Eilif Companion is server-only and is **never** published to Thunderstore, so nothing on this
> page is about a package upload. The two client plugins are the published ones.

`dist/EilifCompanion.dll` is now **0.3.3**, and it **supersedes the staged 0.3.2** — 0.3.2 was built
2026-09-04 but never reached the box, so there is nothing to reconcile: upload 0.3.3 and 0.3.2 is
simply skipped. Everything described in the 0.3.2 notes below is still in it, unchanged.

**What 0.3.3 adds: `[ServerFallback]`, dormant.** ValheimPlus has no 1.0 build, and V+ is the only
reason this world allows more than ten players. 0.3.3 carries a stand-in — `MaxPlayers = 20`,
matching the V+ `[Server] maxPlayers` the crew has been playing under — behind
`[ServerFallback] Enabled = false`. While that is false the plugin applies **no** fallback patch
class at all and `ZNet.RPC_PeerInfo` keeps byte-identical vanilla IL, which is what lets ValheimPlus
go on rewriting that same instruction untouched. If ValheimPlus is present the section refuses to
apply even when switched on, and says so in a warning block naming what it found; presence is
checked by BepInEx GUID **and** by a normalised DLL-name prefix, so a renamed fork does not slip
past. Full design, patch-site table and the log lines to check: `README.md`, section
`[ServerFallback]`.

**⚠️ Uploading 0.3.3 does not raise the cap on its own.** It ships `Enabled = false`, which is safe,
but if ValheimPlus is also gone from the box that combination is the vanilla **10**-player cap with
nothing saying so. Since 0.3.3 that state logs a warning instead of a bland "disabled" line:

```
[Warning] [Eilif] ServerFallback: OFF and no ValheimPlus installed. This world is capped at the
vanilla 10 players. Set [ServerFallback] Enabled = true in the plugin config to raise it to 20.
```

Grep the boot log for `ServerFallback: OFF and no ValheimPlus` as part of the launch-morning check,
not just for `player cap 10 -> 20`.

**Also in 0.3.3: per-player voice targeting.** A queued line can now name one recipient. It rides in
the `voice_lines` row's existing `meta.target` jsonb key (no schema change, no new column); the API
passes it through as a `target` member on the line, and `Speak()` sends the `ShowMessage` (or the
`ChatMessage` variant, when `Voice.ChatType` is `shout`/`normal`) to that peer's `m_uid` alone
instead of `ZRoutedRpc.Everybody`. The name is matched case-insensitively against
`ZNetPeer.m_playerName` — the server's own name for the peer, the same field `SpeakerIdentity` uses,
never the name inside a client packet. A line for somebody who is **not connected is dropped, not
broadcast**: the queue is unaffected because `/api/voice` marks a line spoken when it hands it over
(the claim IS the acknowledgement — this plugin has no ack POST), so a dropped line cannot loop.
**No new Harmony patch class**, so `patch classes applied: 2/2` is unchanged.

**SIX log lines are new** (0.3.3). The first is the one to grep on the launch-morning boot; the
last two are WARNINGs that should never appear:

```
[Eilif] voice targeting: supported                                   # startup, unconditional
[Eilif] voice target '<name>' is not online, line dropped            # targeted, nobody by that name
[Eilif] Spoke (center) to '<name>': <text>                           # targeted center banner, delivered
[Eilif] Spoke (<talkType>) as '<speaker>' to '<name>': <text>        # targeted chat line, delivered
[Eilif] voice target '<name>' matches N connected peers (uids a, b); no server-side rule tells them apart, speaking to the first, uid <uid>.
[Eilif] voice target lookup failed: <message>                        # the resolver's own catch
```

The `matches N connected peers` warning means two connected peers carry the same `m_playerName`
(Valheim permits duplicate character names, and a modified client can send any name it likes during
the handshake). **The first match in `ZNet.m_peers` wins — in practice, whoever connected earlier —
and nothing server-side can do better.** Do not "improve" that tie-break by round-tripping the uid
through `ZNet.GetPeer()`: 0.3.3 shipped that idea for an afternoon and it is a tautology, because
`GetPeers()` returns `m_peers` itself and `GetPeer(uid)` re-finds the same object in it (decompile
line numbers are in the source comment on `TryResolveTargetPeer`). Every matching uid is printed so
an operator can at least see who received the line.

`[Eilif] Spoke (center): <text>` — the untargeted line — is unchanged, as is the untargeted
`to N peer(s)` chat line. None of the six are markers the log poller parses, so **the poller needs
no matching edit**.

Two other behaviours worth knowing: a dropped line does **not** spend the `LineSpacingSeconds`
budget (nothing was said, so the next real line goes out on the next frame rather than 20 s later),
and the plugin sends `x-eilif-caps: targeting` + `x-eilif-plugin: <version>` on every voice poll.

### ⚠ DEPLOY ORDER — targeting fails OPEN if you get it wrong

A targeted line is private. A Companion that predates 0.3.3 does not know the `target` member
exists, ignores it, and speaks the line **to the whole hall**. So the three switches have to be
thrown in this order, and no other:

| # | Do this | Why it must come first |
|---|---|---|
| 1 | Upload **Companion 0.3.3+** to the box and restart (server STOPPED, DLL is file-locked) | Until it is on the box, the box cannot address a line at one viking |
| 2 | Deploy the site (the `/api/voice` change) | Without it the route never returns a `target` field at all, and the plugin broadcasts |
| 3 | Set `VOICE_TARGETING=1` in the **bot** `.env` and restart `eilif-discord-bot` | This is the only thing that makes the bot queue a private line. **Leave it unset until 1 and 2 are both true.** |

Step 3 is the dangerous one because it is a hand-edited env var with no interlock —
`services/discord-bot/src/voice.js` reads `process.env.VOICE_TARGETING === '1'` and nothing checks
what is on the box. Two of the three orderings are covered anyway: the **route refuses to hand a
targeted line to a plugin that did not advertise `x-eilif-caps: targeting`** (it consumes the line
and logs `[voice] withheld targeted line …` to the Vercel runtime log instead of letting it be
broadcast), so getting step 3 ahead of step 1 costs silence, not a leak. The uncovered one is step 3
ahead of step 2: an undeployed route strips the target and the line goes out to everybody. Confirm
the boot log line above and the deploy before flipping the var.

To verify after the fact: grep the boot log for `voice targeting: supported`, and check the cockpit's
`companion-voice` heartbeat for `metrics.targeting` (display only — the route gates on the live
request header, not on that row, because the heartbeat write is throttled to one a minute).

**Load-tested 2026-09-05** on the local creative dedicated server (`~/Valheim-Test-Server-2`, game
0.221.12, BepInEx 5.4.23.3), six boots across two sessions, all clean, nothing left behind
(all ten pre-existing plugin DLLs `md5sum -c` OK, config dir identical, `LogOutput.log` restored
byte-identical):

| Run | State | Result |
| --- | --- | --- |
| 1 | off, V+ present | `ValheimPlus detected (ValheimPlus.dll)` then `disabled (ValheimPlus present)` |
| 2 | on, V+ present | the refusal block, naming `ValheimPlus.dll` |
| 3 | on, V+ **renamed** `ValheimPlus_Grantapher_Temporary.dll` | still refused, naming the renamed file — the exact hole the old exact-name scan had |
| 4 | off, V+ **absent** | the new `OFF and no ValheimPlus installed` **warning** |
| 5 | on, V+ absent | `patch classes: 2/2 applied` + all four sites (`player cap 10 -> 20`, Steam browser slots, both crossplay literals `11 -> 21`) |
| 6 | V+ renamed past the prefix, EilifPaths on | the client plugin's late re-check fired the `ValheimPlus IS loaded after all` error |

`patch classes applied: 2/2` was unchanged in every run. This is a LOAD test only — no player has
been the eleventh viking on a real server yet.

> ⚠️ **Read the dedicated-server assembly, not just `libs/`.** `refresh-libs.sh` copies the **client**
> `assembly_valheim.dll`, and three of the four player-cap sites have different bodies on the
> dedicated-server build: `ZSteamMatchmaking.RegisterServer` calls `SteamGameServer.SetMaxPlayerCount(10)`
> on the server and `SteamMatchmaking.CreateLobby(type, 10)` on the client, and the PlayFab
> `MaxPlayerCount` / `MaxPlayers` literals are `11` on the server against `10` on the client. Only
> `ZNet.RPC_PeerInfo`'s `>= 10` is identical in both. The first build of this feature was written
> from the client assembly alone and three of its four hooks logged "not found" on the first real
> boot. For any server-side patch, decompile
> `valheim_server_Data/Managed/assembly_valheim.dll` as well.

---

## Deploying **0.3.2** (built 2026-09-04, superseded by 0.3.3 above)

`dist/EilifCompanion.dll` was **0.3.2**. It carries everything 0.3.1 did — both the
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

1. **`MISSING patch class`** — **zero lines is healthy, and this is the first grep after a 1.0
   rebuild.** A plugin prints its `Loading [...]` line whether or not its Harmony patches went on,
   so `Loading` proves the DLL was chainloaded and nothing more. Each `MISSING patch class` line
   names the class **and the feature that died with it**
   (`EilifCompanionPlugin.cs:288`). One hit is one feature gone, silently, with nothing else
   saying so.
2. **`Eilif Companion 0.3.4`** — the version actually loaded.
3. **`[Eilif] patch classes applied: 2/2`** — both hooks on (OathCapture + the pin capture); anything
   else means read the `[Eilif] could not apply <Class>: <message>` lines above it. The denominator
   is a fixed roster in the source, never a count of what loaded, so a class the runtime could not
   even enumerate still shows as a shortfall.
4. **`[Eilif] ServerFallback patch classes: 2/2 applied.`** — prints **only** when
   `[ServerFallback] Enabled = true`. Its absence on a night that still runs ValheimPlus is
   correct.

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
2. **Prove the server is on the same build — by its version line, not by md5.**

   ```bash
   bash scripts/verify-restart.sh <World>     # read-only; step ⓪ prints the box's version
   ```

   Look for `Valheim version: <the 1.0 number> (network version NN)`, read out of the box's
   own `console.log`. Compare it with what Steam shows for the local client (step 1).

   > **Do NOT md5-compare the box's `assembly_valheim.dll` against the local client's.** That
   > gate was written here on 2026-09-04 and **can never pass**: the dedicated-server and
   > client assemblies are different compilations of the same game. Measured on this PC
   > 2026-09-06, both reporting `Valheim version: l-0.221.12 (network version 36)` —
   >
   > | Install | Size | md5 |
   > |---|---|---|
   > | Steam **client** `valheim_Data/Managed/assembly_valheim.dll` | 2,126,848 | `2a2990bacab27146173924d88b2628b4` |
   > | local **dedicated server** `valheim_server_Data/Managed/assembly_valheim.dll` | 2,119,680 | `d09453434188a144b179a4d448289352` |
   >
   > The server assembly carries `SetMaxPlayerCount` and `SteamGameServer`, which the client
   > assembly does not — this repo already relies on that difference elsewhere. So the old
   > step 2 produced a **guaranteed** mismatch and told the operator to "stop and reconcile",
   > i.e. a false STOP on the critical path. `docs/LAUNCH-DAY.md` never routed through here
   > (its step 1 compares the local client against a known-good literal and is correct), but
   > `CLAUDE.md` advertises this BUILD.md sequence, so a fresh session could have followed it.
   >
   > A local **dedicated-server** install of the same build would be a valid comparison
   > (`~/Valheim-Test-Server-2` is what `docs/LAUNCH-DAY.md` step 3 uses), but on launch
   > morning it may not have updated to 1.0 yet — which is exactly why step 3 there is
   > conditional. The version line works unconditionally.

3. **Verifying a rebuilt DLL, when you get there.** `md5` on `dist/` is still the right thing
   to compare against the copy you upload to the box, but it is **not** a "did the source
   change" test: SourceLink stamps `AssemblyInformationalVersion = "<Version>+<HEAD sha>"`, so
   on launch day HEAD has moved and the md5 differs either way. PE sections are 512-byte
   aligned, so a small code change routinely leaves the **size** unchanged too. The only way
   to prove a rebuild is stamp-only is a second build:

   ```bash
   bash scripts/rebuild-plugins.sh --source-revision <the before-DLL's sha> --sandbox /tmp/rb
   # then compare that DLL's md5 with the before value
   ```

   Cheaper day-of check when you only need "is this the new artifact": the csproj `<Version>`
   string must appear inside the built DLL, plus its size — which is what
   `rebuild-plugins.sh` already asserts and prints per plugin.
4. Only then run the build sequence below.

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
