# Eilif Companion Client

Companion plugin for the **Eilif** community Valheim server — a private friends-and-family server with a public stats dashboard at [valheim-dashboard.vercel.app](https://valheim-dashboard.vercel.app).

## What it does — full disclosure

While you are connected to a server, this plugin periodically reads **one number from your own local map data — the percentage of the world map you have explored** — and posts it, together with your character name, to the Eilif community dashboard so the **Cartographer** leaderboard can rank explorers.

- **What is sent:** explored-map percentage (a single number) + character name. Nothing else. No position, no chat, no inventory, no system information.
- **Where:** only to the endpoint in `net.eilif.companionclient.cfg`. The Eilif modpack pre-fills the community dashboard URL; **with no URL configured the plugin does nothing at all.**
- **When:** every 5 minutes while connected, and once at logout.
- **Source:** fully open — [GitHub](https://github.com/cbspears/valheim-dashboard/tree/main/plugins/eilif-companion-client).

Intended for members of the Eilif server; harmless but useless anywhere else.

## Changelog
See CHANGELOG.md.
