# Eilif Companion

A deliberately tiny, **server-side-only** BepInEx 5 plugin for the Eilif Valheim server
(BepInEx 5.4.2333 + ValheimPlus). No client installs. Four parts — three of them purely
observational, one (WORLD KEYS, added in 0.3.0) that **does change the world's rules**:

- **EARS** — captures in-game `/oath <text>` and `/pin <name>` chat commands and writes marker
  lines to the BepInEx log (our SFTP poller tails it).
- **VOICE** — periodically pulls queued lines from the dashboard and speaks them center-screen /
  in global chat as an NPC ("Eilif").
- **POSITION** — every 60s, if any players are online, emits one `[EILIF_POS]` marker line per
  connected player (name, world x/z, biome) for the live map layer.
- **WORLD KEYS** (v0.3.0) — every 30s, asserts the global keys listed in
  `[WorldKeys] EnforcedGlobalKeys` into the running world. Ships defaulting to `deathkeepequip`
  (keep equipped gear on death). **This overrides the GTX panel** — see [World keys](#world-keys-v030).

`BepInPlugin` GUID: `media.blockspace.eilif.companion` — name `Eilif Companion` — v`0.3.2`.

---

## How it works

### EARS — `/oath` capture (hook moved in v0.3.1)
A HarmonyX **Prefix** on `Chat.OnNewChatMessage(GameObject, long senderID, Vector3 pos,
Talker.Type type, UserInfo sender, string text)` — the same hook the `/pin` capture has always used,
and the reason this one moved.

**What was wrong before 0.3.1.** The capture used to postfix `Chat.RPC_ChatMessage`. That hook is
dead on this server: ValheimPlus's `[Chat]` patch throws an NRE earlier in the same chain, so the
original never completes and our postfix never runs. The 09-01 boot log contains **zero**
`[EILIF_OATH]` lines; all ten oaths on record reached the dashboard through the poller's *console
echo* fallback instead — and the echo is the server printing a SHOUT, which Valheim
display-uppercases. That is why every signature on the Oath wall reads `I WILL NOT RUN, JUMP OR
CLIMB!`. (Audit finding voice-6.)

**Why `OnNewChatMessage` is the right hook.** The decompile shows `RPC_ChatMessage` doing exactly
one thing — `OnNewChatMessage(null, sender, position, (Talker.Type)type, userInfo, text)` — so it
carries every argument the old hook had, one level further down, and a Prefix on it is *proven* to
run on this exact server, because that is where `/pin` lives. Oaths captured here keep their
**original casing**.

**V+ `[Chat]` stays enabled — nothing about the server config has to change.** That section is what
makes `/s` shouts carry server-wide (`shoutDistance` + `serverSyncsConfig`), which is the behaviour
oaths and the chat mirror are built on, so turning it off is not on the table. Its patch throws
inside `Chat.AddInworldText`, and `AddInworldText` is called from the **body** of
`OnNewChatMessage` — so our Prefix has already run and already written its marker line before the
NRE happens. The exception still kills the rest of that call (which is why the old postfix, one
frame further out, never ran and never will), but it can no longer cost us the capture.

**Whose name goes on the line (v0.3.2).** `<name>` is the name the SERVER holds for the sending
peer — `ZNet.instance.GetPeer(senderID)?.m_playerName`, set during the handshake and the same name
the server itself uses for kicks and the permitted list — never the `UserInfo.Name` inside the
packet. `RPC_ChatMessage` forwards that field from the client unchecked, so a crafted ChatMessage
RPC could otherwise sign anyone's name to an oath, mirror chat as them or plant pins under their
name (audit security-3). When the two names differ the peer name wins and a warning is logged:

```
[EILIF_IDENT] mismatch peer=<server's name> claimed=<packet's name> uid=<sender uid>
```

A sender uid with no peer record is refused outright (`[EILIF_IDENT] unknown sender uid=… claimed=…
- oath dropped`) rather than falling back to the claim — a healthy server logs **no `[EILIF_IDENT]`
lines at all**, and these warnings are rate-limited to one a minute (with a `(+N suppressed …)`
count) so a modified client cannot flood the log the poller tails. See `src/SpeakerIdentity.cs` for
the decompiled evidence, the log-injection hardening that came with it, and the two impersonation
routes it does NOT close (duplicate character names, which need a SteamID binding downstream; and a
forged `m_senderPeerID`, which now only lets an attacker borrow a genuinely-connected peer's real
name).

**The name is only half of it (v0.3.2).** The poller reads a log line, so a shout's TEXT and a
peer's NAME can forge identity without touching `UserInfo` at all. Shouting the literal string
`Console: <color=orange>Victim</color>: <color=x>/oath …</color>` used to be reproduced verbatim on
the raw-case `[EILIF_CHAT]` line and read back by the poller as a genuine console echo from Victim
(its echo guard is an unanchored substring test that runs before the marker regexes), and a peer
named `Bren | hello` shifted this line's own `" | "` fields to file chat, oaths and pins under
`Bren`. `SpeakerIdentity.Safe` now defangs rich-text tag openers in text and `SafeName` flattens `|`
in names, both verified by driving the real parser
(`scripts/plugin-log-safety.test.mjs`). Ordinary punctuation (`<3`, `5 > 3`, `>_<`) is deliberately
left alone, because the poller suppresses a shout's echo twin by comparing name + uppercased text
and rewriting it would double-post those shouts to Discord.

Both markers are emitted from this one Prefix. If `text` starts with `/oath ` (case-insensitive)
and has non-empty oath text, we log, at Info level:

```
[EILIF_OATH] <exact character name> | <oath text>
```

and any other **shouted**, non-`/command` text is mirrorable chat, logged in the same shape:

```
[EILIF_CHAT] <exact character name> | <shout text>
```

`sender.Name` is the sender's exact character name. Both line formats are byte-identical to 0.3.0's
(`services/log-poller/src/parser.js` anchors each to the plugin's own log prefix and splits
name/text on the FIRST `" | "`), so the poller needs no matching change — it keeps preferring these
raw-case lines over their uppercased console-echo twins. A repeat of the same marker + sender + text
inside 5 seconds is suppressed, so nothing can put one signature on the wall (or one sentence in
#server) twice.

> **Suppression:** the `/oath` line is still re-broadcast to other players and appears in chat as
> normal. Swallowing it would mean a Prefix that *skips* the original chat handling for everyone,
> which is invasive and risky for a cosmetic gain — by design we **let it through**.

### VOICE — speak queued lines
The plugin's `Update()` (main thread) runs a `PollSeconds` timer. When it fires **and ≥1 player is
connected** (`ZNet.instance.GetPeers().Count > 0`) and `VoiceToken` is set, a background task does
`GET VoiceUrl` with header `x-voice-token: <VoiceToken>`. The response
(`{"lines":[{"id","text","speaker"}]}`, 0–3 lines) is parsed with `DataContractJsonSerializer`
(no extra shipped dependency) and results are pushed to a `ConcurrentQueue`.

`Update()` drains that queue **on the main thread** and, for each line, calls:

```csharp
ZRoutedRpc.instance.InvokeRoutedRPC(
    ZRoutedRpc.Everybody, "ChatMessage",
    new object[] { Vector3.zero, (int)Talker.Type.Shout, userInfo, text });
```

i.e. exactly how the game's own `Chat`/`Talker` emits chat. `userInfo` is a server-built `UserInfo`
with `Name = <speaker>` and a synthetic (non-null) `PlatformUserID` so serialization can't NRE.
All HTTP is off-thread; all `ZRoutedRpc` sends are on the main thread.

### POSITION — live player-position emitter
The plugin's `Update()` (main thread) also drives a fixed **60s** timer (`PositionEmitter`). When it
fires **and ≥1 player is connected** (`ZNet.instance.GetPeers().Count > 0`), it logs one line per
fully-in-world player at Info level:

```
[EILIF_POS] <name> | <x> | <z> | <biome>
```

- `name` = `ZNetPeer.m_playerName`.
- `x` / `z` = world coords, formatted `F1` with **InvariantCulture** (no locale commas).
- `biome` = `Heightmap.Biome` word from `WorldGenerator.instance.GetBiome(x, z)` (e.g. `Meadows`);
  `None` if the world generator isn't ready or the lookup throws.

Position source is the peer's character ZDO (`ZDOMan.instance.GetZDO(peer.m_characterID).GetPosition()`),
falling back to `peer.m_refPos`. Peers whose `m_characterID` is `ZDOID.None` (connected but not yet
spawned in-world) are skipped. Every dereference is null-guarded and each peer is wrapped in its own
try/catch, so on a headless server one bad peer never kills the sweep. Nothing is broadcast to
clients — this is log-only, tailed by the SFTP poller.

---

## World keys (v0.3.0)

Every `30s` the plugin walks `EnforcedGlobalKeys` and, for any key where
`ZoneSystem.GetGlobalKeyExact(key)` is false, calls `ZoneSystem.SetGlobalKey(key)`. The changed
key list is logged once per change as `[EILIF_KEY] runtime world keys (N): …`, and each assertion
as `[EILIF_KEY] enforced world key: <key>`. Connected clients get their key list re-synced on the
same pass (`ZoneSystem.SendGlobalKeys`, idempotent client-side).

**This exists because the panel's `-modifier deathpenalty` args do not grant keep-gear at the tier
the server actually runs.** Decompile-verified against 0.221.12: the death-penalty tiers map to
keys through Unity scene data, and `veryeasy` grants only `skillreductionrate 15`. Keep-gear is the
`deathkeepequip` key, which **only the CASUAL tier** grants. On the live box the panel says
`DeathPenalty->easy` and `deathkeepequip` exists solely because this plugin injects it.

### Precedence — the plugin wins, by design

- The panel and the in-game console are **second**, this config is **first**. A death-penalty
  change in the panel, or a `removeglobalkey deathkeepequip` in the console, is undone within 30
  seconds.
- **To relax keep-gear you must blank the cfg value and restart** — changing the panel alone will
  not do it.
- The write is not just runtime. `SetGlobalKey` → `GlobalKeyAdd(canSaveToServerOptionKeys: true)`
  also appends the key to `ZNet.World.m_startingGlobalKeys`, which is **persisted into the world's
  `.fwl`** on the next world save. So the key outlives the plugin in the save file, and grepping the
  `.fwl` for `deathkeepequip` can never tell you whether the panel or the plugin put it there.
  `scripts/verify-restart.sh` reports the panel tier and the plugin's `[EILIF_KEY]` line as two
  separate facts for exactly this reason.
- Value keys work the same way: `GlobalKeyAdd` replaces a same-prefix entry, so putting
  `skillreductionrate 15` in the cfg would override the panel's 50 on every boot.

### The mixed-rules trap

If the panel were ever set to **Hard** (`deathdeleteitems`) while this plugin still asserts
`deathkeepequip`, `Player.CreateTombStone` produces mixed semantics: unequipped items deleted
outright, equipped items kept. Set the panel and this list to say the same thing.

### The fragility this is not a fix for

Plugin-injected keep-gear survives exactly as long as the plugin loads. The first boot where it
does not — which is what a Valheim 1.0 update does to an unrecompiled BepInEx plugin — everybody
drops everything again, silently. **Panel tier Casual is the durable configuration**; treat this
enforcement as belt-and-braces on top of it, not as a replacement for it.

---

## Config (`BepInEx/config/media.blockspace.eilif.companion.cfg`, section `[Voice]`)

| Key | Default | Notes |
| --- | --- | --- |
| `VoiceUrl` | `https://valheim-dashboard.vercel.app/api/voice` | polled endpoint |
| `VoiceToken` | `` (empty) | sent as `x-voice-token`. **Empty ⇒ voice half stays dormant** (one info line logged); `/oath` capture still runs. |
| `PollSeconds` | `120` | seconds between polls; clamped to `30..3600`; only polls while ≥1 player online |
| `SpeakerName` | `Eilif` | fallback speaker when a line has no `speaker` |
| `ChatType` | `center` | `center` (raid-banner style, most reliable — the shipped default), `shout` (chat, global) or `normal` (chat, proximity — see caveat) |

> **`ChatType` caveat:** `shout` is broadcast globally and always reaches every player. `normal` is
> **proximity-based on the client** and is sent from world origin (`Vector3.zero`), so distant players
> may not see it. We ship `shout` and will A/B at the pilot.

### Section `[WorldKeys]` (v0.3.0)

| Key | Default | Notes |
| --- | --- | --- |
| `EnforcedGlobalKeys` | `deathkeepequip` | Comma-separated global keys re-asserted into the world whenever missing (checked every 30s). Value keys (`skillreductionrate 15`) work too. **Empty = feature off** — that is the switch for relaxing keep-gear, and it needs a restart. |

---

## Build

Needs the user-local .NET SDK (`~/.dotnet`, on PATH) and `libs/` populated.

```bash
./refresh-libs.sh          # (re)copy game DLLs + fetch BepInEx refs into libs/
dotnet build -c Release    # outputs plugins/eilif-companion/dist/EilifCompanion.dll
```

`dist/EilifCompanion.dll` is the committed, deployable artifact.

## Deploy (pilot)

1. `dotnet build -c Release`.
2. SFTP `dist/EilifCompanion.dll` into the server's `BepInEx/plugins/`.
3. Restart the server from the GTXGaming panel.
4. On first boot the config file is generated — set `VoiceToken` (and adjust `ChatType`), then
   restart once more to activate the voice half.
5. Verify: a player types `/oath I will hold the north` in-game → `LogOutput.log` gets
   `[EILIF_OATH] <CharName> | I will hold the north`.
6. Verify world keys (v0.3.0): `LogOutput.log` gets `[Eilif] World-key enforcement armed: …` at
   boot and, within 30s, `[EILIF_KEY] runtime world keys (N): …`. `bash scripts/verify-restart.sh
   <World>` prints the panel tier and the plugin's enforcement as two separate lines.

## After the Valheim 1.0 / Deep North update

Re-run `./refresh-libs.sh` (pulls the patched game DLLs), then `dotnet build -c Release`, and
re-deploy. If Iron Gate changed the `ChatMessage` RPC shape, validate the two touch-points below.

## What MUST be validated on the live server at the pilot

- **`/oath` marker fires** with the exact character name (confirms the `ChatMessage` payload order
  `pos,int,UserInfo,text` and that our reimplemented `GetStableHashCode("ChatMessage")` matches the
  game's method hash on this build).
- **No `[EILIF_IDENT]` lines** anywhere in a normal session (v0.3.2). `unknown sender` on every
  shout would mean `ZNet.GetPeer(long)` / `ZNetPeer.m_playerName` moved in a game update, in which
  case oaths, chat and pins are being dropped rather than misattributed — re-check both members
  against `libs/assembly_valheim.dll` with `ilspycmd` before doing anything else. Pair this with the
  positive check above: silence here only proves nothing was misattributed, not that the captures
  ran.
- **Voice send renders** in every client's chat as the speaker name (confirms the outbound
  `InvokeRoutedRPC("ChatMessage", …)` param order and that a server-built `UserInfo` serializes OK).
- **`shout` vs `normal`** reach (A/B `ChatType`).
- **ValheimPlus coexistence** — confirm V+ doesn't also patch `HandleRoutedRPC`/chat in a conflicting way.
