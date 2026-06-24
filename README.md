# ⚔ The Fractured Realms — Valheim Server Dashboard

A community dashboard for a modded Valheim dedicated server (G-Portal), with Discord integration.
Shows who's online, session history & leaderboards, installed mods, and boss-gated world progress + a living roadmap.

**Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 · Supabase · TypeScript. Dark Norse fantasy theme.

> ⚠️ **Node 20+ required** (Next 16). This repo is pinned via `.nvmrc`. Locally:
> `nvm use` then `npm run dev`.

## Pages
- **Hall** (`/`) — server status, currently online, recent events, boss progress
- **Vikings** (`/players`) — roster, who's sailing now, leaderboards
- **World** (`/world`) — boss kill timeline (progression gates) + roadmap
- **Saga** (`/events`) — filterable event feed
- **Mods** (`/mods`) — installed mods, edit in `config/mods.ts`

## Configuration (edit & redeploy)
- `config/server.ts` — server name, tagline, max players, address
- `config/mods.ts` — the mod list shown on the Mods page

## API
- `POST /api/webhook` — inbound game events (auth via `x-webhook-secret`). Fed by the SFTP log poller and/or the DiscordConnector relay.
- `GET /api/status` — public server status JSON (CORS-open) for badges/bots.

## Environment (`.env.local`, set the same in Vercel)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=   # server-only, never expose
WEBHOOK_SECRET=              # shared secret for /api/webhook
```

## Data model (Supabase)
`players`, `sessions`, `events`, `player_stats`, `bosses`, `roadmap`, `server_status` — public-read RLS, writes via service role.

---
*Evolving project — built to be tweaked.* 🛠️
