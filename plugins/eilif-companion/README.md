# Eilif Companion

A deliberately tiny, **server-side-only** BepInEx 5 plugin for the Eilif Valheim server
(BepInEx 5.4.2333 + ValheimPlus). No client installs, no gameplay changes — purely additive.
Two halves:

- **EARS** — captures in-game `/oath <text>` chat commands and writes a marker line to the
  BepInEx log (our SFTP poller tails it).
- **VOICE** — periodically pulls queued lines from the dashboard and speaks them in global chat
  as an NPC ("Eilif").

`BepInPlugin` GUID: `media.blockspace.eilif.companion` — name `Eilif Companion` — v`0.1.0`.

---

## How it works

### EARS — `/oath` capture
A HarmonyX **Postfix** on the private `ZRoutedRpc.HandleRoutedRPC(RoutedRPCData)`. On a dedicated
server every routed RPC passes through this method, so we can observe the routed **`ChatMessage`**
payload with zero client installs (the exact pattern the WebMap mod uses for its chat-command pins).

For each `ChatMessage` we read a *copy* of the payload (so the original re-broadcast is untouched):
`Vector3 position, int type, UserInfo userInfo, string text`. If `text` starts with `/oath ` (case-
insensitive) and has non-empty oath text, we log:

```
[EILIF_OATH] <exact character name> | <oath text>
```

at Info level. `userInfo.Name` is the sender's exact character name.

> **Suppression:** because this is a Postfix, the `/oath` line has *already* been re-broadcast to
> other players — it appears in chat as normal. Suppressing it would require a Prefix that drops the
> whole routed RPC (invasive/risky), so by design we **let it through**. Fine for the pilot.

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

---

## Config (`BepInEx/config/media.blockspace.eilif.companion.cfg`, section `[Voice]`)

| Key | Default | Notes |
| --- | --- | --- |
| `VoiceUrl` | `https://valheim-dashboard.vercel.app/api/voice` | polled endpoint |
| `VoiceToken` | `` (empty) | sent as `x-voice-token`. **Empty ⇒ voice half stays dormant** (one info line logged); `/oath` capture still runs. |
| `PollSeconds` | `120` | seconds between polls; clamped to `30..3600`; only polls while ≥1 player online |
| `SpeakerName` | `Eilif` | fallback speaker when a line has no `speaker` |
| `ChatType` | `shout` | `shout` (global, reliable) or `normal` (proximity-based — see caveat) |

> **`ChatType` caveat:** `shout` is broadcast globally and always reaches every player. `normal` is
> **proximity-based on the client** and is sent from world origin (`Vector3.zero`), so distant players
> may not see it. We ship `shout` and will A/B at the pilot.

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

## After the Valheim 1.0 / Deep North update

Re-run `./refresh-libs.sh` (pulls the patched game DLLs), then `dotnet build -c Release`, and
re-deploy. If Iron Gate changed the `ChatMessage` RPC shape, validate the two touch-points below.

## What MUST be validated on the live server at the pilot

- **`/oath` marker fires** with the exact character name (confirms the `ChatMessage` payload order
  `pos,int,UserInfo,text` and that our reimplemented `GetStableHashCode("ChatMessage")` matches the
  game's method hash on this build).
- **Voice send renders** in every client's chat as the speaker name (confirms the outbound
  `InvokeRoutedRPC("ChatMessage", …)` param order and that a server-built `UserInfo` serializes OK).
- **`shout` vs `normal`** reach (A/B `ChatType`).
- **ValheimPlus coexistence** — confirm V+ doesn't also patch `HandleRoutedRPC`/chat in a conflicting way.
