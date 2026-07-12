<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Next.js 16 (App Router), React 19, Tailwind v4, TypeScript, Supabase. See `README.md` for the product overview and `docs/PROJECT.md` for architecture/decisions/risks.

## Setup

Node **20.9+** is required (pinned in `.nvmrc` and `package.json#engines`); the system Node on the host is 18, so activate nvm first:

```bash
export NVM_DIR=~/.config/nvm
. $NVM_DIR/nvm.sh
nvm use 20
```

Then:

```bash
npm install
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (`next dev`) |
| `npm run build` | Production build (`next build`) — run this before trusting any change is deploy-safe |
| `npm start` | Serve a production build locally (`next start`) |
| `npm run lint` | ESLint (`eslint`) |
| `npx tsc --noEmit` | Type-check the whole project without emitting output |
| `npm test` | Runs every `*.test.mjs` under `scripts/` and `lib/` through `tsx` (see below) |

## Verification expectations before calling work done

Run, in order:

```bash
npx tsc --noEmit
npm test
npm run build
```

All three must be clean. `next build` is the closest thing this repo has to an integration check — it type-checks route handlers and Server Components in ways `tsc --noEmit` alone can miss.

### Tests

There is no Jest/Vitest — tests are plain `.mjs` scripts (importing `.ts` source directly) executed via [`tsx`](https://github.com/privatenumber/tsx), each printing a pass/fail summary and exiting non-zero on assertion failure. `npm test` discovers and runs all of them:

```json
"test": "find scripts lib -name '*.test.mjs' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 npx tsx"
```

Convention: a test file lives next to the module it covers (or in `scripts/`) and is named `<thing>.test.mjs`. To run a single test file directly: `npx tsx scripts/epithets.test.mjs`. Current coverage: `scripts/epithets.test.mjs`, `scripts/gs-client.test.mjs`, `scripts/gs-boss.test.mjs`, `scripts/milestones.test.mjs` — add new ones under `scripts/` or `lib/` (e.g. `lib/ops/*.test.mjs`) and `npm test` picks them up automatically, no wiring needed.

The three background **services** (`services/discord-bot`, `services/log-poller`, `services/stats-parser`) are separate npm projects with their own `package.json`/`node_modules` and are **not** covered by the root `npm test`. Each has its own test entry points — see "Services" below.

## Deploy

Deploys are **CLI-only** — there is no GitHub→Vercel auto-deploy connected. Vercel requires the git commit author to be `charlie@blockspace.media` (the team owner); a mismatched author blocks the deploy with `TEAM_ACCESS_REQUIRED`.

```bash
export NVM_DIR=~/.config/nvm; . $NVM_DIR/nvm.sh; nvm use 20
vercel deploy --prod --yes --scope charlie-9292s-projects
```

Deploys are Charlie's call to trigger, not an agent's.

## Services (run on the host via systemd, not on Vercel)

| Service | Dir | Unit | Purpose |
|---|---|---|---|
| Discord bot | `services/discord-bot/` | `eilif-discord-bot.service` | `npm start` (or `npm run dry-run`). Relays events, recaps, milestones, chat mirror. |
| Log poller | `services/log-poller/` | `valheim-log-poller.service` | `npm start`. Tails `BepInEx/LogOutput.log` over SFTP → derives presence/sessions/deaths → `/api/webhook`. |
| Map snapshot | (root `scripts/map-snapshot.mjs`) | `eilif-map-snapshot.service` | `node scripts/map-snapshot.mjs --loop`. Pulls WebMap `map.png`/`fog.png` over SFTP on a cadence. |

Reference unit files live under `services/*/` for inspection; the live units are `/etc/systemd/system/eilif-*.service` and `valheim-log-poller.service` on the host. Each service has its own `.env` (gitignored) — see each directory for its required vars.

## Database / migrations

Supabase Postgres. SQL migration files live in `db/*.sql`, one file per change, named `db/<date>_<slug>.sql`. **There is no migration runner in this repo** — migrations are hand-applied by Charlie against the Supabase project (`syuwavxpmtdmxupxjzje`) via the SQL editor or CLI, at his discretion, and are written to be idempotent (`create table if not exists`, guarded `alter`, etc.) so re-running one is safe. When you add a migration file, say clearly in your summary that it is unapplied and needs a manual apply — never assume it has run just because the file exists in the repo.

## Environment variables

Copy `.env.local.example` → `.env.local` and fill in values; never commit real secrets. That file is the source of truth for the current variable list (Supabase URL/keys, webhook secrets, ops cockpit vars, etc.) — keep it in sync whenever you add a new env var.

## Config (edit & redeploy, no code changes needed)

- `config/server.ts` — server name, tagline, max players, address
- `config/mods.ts` — installed mod list shown on `/mods`
- `config/art.ts` — `ART_AVAILABLE` gate for painterly art assets
- `config/fish.ts` — fish prefab → display name map
