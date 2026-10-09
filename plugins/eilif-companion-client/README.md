# Eilif Companion Client

> **Disclosure: this plugin was written with AI assistance** (Anthropic Claude, directed and reviewed by the Eilif server admin). It is listed under Thunderstore's "AI Generated" category for that reason. Source is public at the link in the manifest.


Companion plugin for the **Eilif** community Valheim server, a private friends-and-family server with a public stats dashboard at [valheim-dashboard.vercel.app](https://valheim-dashboard.vercel.app).

## What it does: full disclosure

While you are connected to a server, this plugin sends three kinds of data to the Eilif community dashboard, and nothing else:

1. **Explored-map percentage**: one number read from your own local map data, posted with your character name every 5 minutes and at logout. Feeds the Cartographer leaderboard. **Since 0.3.2 that post carries your character name twice**: once as the reading's owner and once as the reporter. That lets the dashboard confirm a reading came from the character it belongs to and refuse one posted for somebody else. It is the same name either way; nothing new is collected.
2. **Your own deaths** (since 0.2.0): when your character dies, the plugin reads the game's own record of the killing blow (its hit type, such as Fall, Drowning or Burning, and the attacking creature's name if there was one) plus the biome, and posts that single event. This exists because the death causes from other stats mods are often wrong, and the Eilif dashboard shows honest ones. **Since 0.3.1 that report also carries the reporting character's name**, which is your own, the same name already sent with the map percentage. That lets the dashboard verify a death report came from the character it is about and reject one filed by anyone else. It is not an extra piece of information about you; it is the same name, sent twice, so the server can check that they match.
3. **Your own profile counters** (new in 0.4.0): a small set of lifetime totals read from your own local character profile, posted with your character name on the same 5 minute cadence as the map percentage and once on logout. Exactly these: your total enemy kills (back since 0.4.5, read from the same lifetime bucket), builds placed, crafts made, items picked up, distance travelled (total, walked, run, sailed, flown), and, since 0.4.4, your fishing totals: fish caught, fish hooked, fish lost, and how many of the caught ones were of each quality tier 0 to 6. (0.4.0 to 0.4.2 sent kills and deaths as entry fields; 0.4.3 stopped because the two readings fought over the dashboard's zero-point; 0.4.5 sends kills again as a profile counter, which the dashboard now prefers over the per-world weapon file because that file resets on a rebuilt mod profile and can leak between characters on a shared PC. Deaths still come from the dashboard's own death events.) These feed the build, distance, craft, resource and fishing boards and the collective Great Deeds. On Valheim 1.0 the stats mod that used to supply them stopped doing so, which is why the plugin now reads them directly. Nothing per-item is sent, and nothing about position, inventory or other players. You can turn this off with `[Stats] Enabled = false` in the config.

- **Never sent:** position history, chat, inventory contents, individual items, system information, or anything about other players.
- **Where:** only to the endpoint in `net.eilif.companionclient.cfg`. The Eilif modpack pre-fills the community dashboard URL. **With no URL configured the plugin sends nothing at all.**
- **Source:** fully open on [GitHub](https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-companion-client).

## It also changes two gameplay rules: read this before installing

Version 0.3.0 added a **client-side tombstone keep-list**, and until 0.4.6 it was the only part of this plugin that touches gameplay rather than just reporting on it (0.4.6 adds the Halloween pumpkin filter below). (0.3.1, 0.3.2 and 0.3.3 changed nothing about it; 0.3.4 is the same code rebuilt for Valheim 1.0 so that the key check works there, and 0.4.0 adds only the profile-stats reporter above, 0.4.1 only fixes the map percentage on 1.0, 0.4.3 only changes which counters are read, 0.4.4 only adds the fishing counters, 0.4.5 only adds the kills counter, 0.4.6 only adds the pumpkin filter, and all of them leave the tombstone rule untouched; see the changelog.)

Valheim decides what goes into your tombstone on **your own machine**, in `Inventory.MoveInventoryToGrave`, which spares quest items and whatever you had equipped. This plugin adds a Harmony **prefix** on that method which briefly marks keep-listed items as equipped so the game's own filter spares them, and a **finalizer** that unmarks them immediately afterwards. The flag never outlives that single call, and if the patch ever fails to apply you simply get exact vanilla behaviour. The result: your tools, weapons, shield, torch and ammo stay on you when you die, while resources, food and loot still drop into the grave, so a death stays a corpse run without becoming a re-gearing chore.

**It is gated on the server, not on you.** The patch only does anything on a world whose vanilla `deathkeepequip` global key is set, the key the Casual death-penalty tier grants (and which the Eilif server also asserts through its server-side companion plugin). On any server that has not opted into gentle deaths, including every public server you might carry this profile onto, the keep-list is inert and your deaths are exactly vanilla.

The list is yours to change, in `net.eilif.companionclient.cfg` under `[Death]`:

```ini
[Death]
KeepItemTypes = OneHandedWeapon, TwoHandedWeapon, TwoHandedWeaponLeft, Bow, Shield, Torch, Tool, Ammo, AmmoNonEquipable
```

Those are `ItemDrop.ItemData.ItemType` names. **Blank the value to turn the feature off entirely** and get vanilla tombstones back even on a `deathkeepequip` world.

## Halloween pumpkins: only from listed creatures (new in 0.4.6)

The Eilif server runs **HalloweenPieces**, which makes its pumpkin item (`BHP_PumpkinDrop`) drop from every enemy. Loot is rolled on the client that owns the dying creature, normally the killer's, so this plugin is where the choice is made: a Harmony **postfix** on `CharacterDrop.GenerateDropList` removes the rolled pumpkin entries unless the creature is on the list. Nothing else in the drop list is touched, and if the patch ever fails to apply you get HalloweenPieces' own behaviour.

The list is in `net.eilif.companionclient.cfg` under `[Halloween]`:

```ini
[Halloween]
PumpkinDropCreatures = Draugr,Draugr_Ranged,Draugr_Elite
```

Those are creature **prefab** names (`Draugr_Elite`, not "Draugr Elite"), matched without regard to case or surrounding spaces. **`*` means every creature** (the filter is off), and **an empty value means no creature drops pumpkins**. On a server without HalloweenPieces there is no pumpkin drop to remove, so the key does nothing.

Intended for members of the Eilif server; harmless but useless anywhere else.

## Changelog
See CHANGELOG.md.
