# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run each in separate terminals)
npm run dev:bot      # Discord bot with hot reload
npm run dev:ws       # WebSocket server with hot reload
npm run dev:web      # Next.js dev server

# Quality checks
npm test             # All packages via Turborepo
npm run typecheck    # All packages
npm run build        # All packages (shared must build first — Turbo handles ordering)

# Run tests in a single package
npm test --workspace=packages/bot
npm test --workspace=packages/shared
npm test --workspace=packages/web

# Run a single test file (bot/shared — no config needed)
npx vitest run packages/bot/tests/services/drafts.test.ts

# Run a single web test file (must specify the web vitest config)
npx vitest run packages/web/tests/cards-resolve-route.test.ts -c packages/web/vitest.config.ts

# Docker (local dev with hot reload)
docker compose up -d --build

# Docker (production — no override file)
docker compose -f docker-compose.yml up -d --build

# Seed test data and restart services
npm run reset:test-data

# Deploy Discord slash commands
npm run commands:deploy  # dev (tsx)
```

## Architecture

This is an npm workspaces + Turborepo monorepo with four packages:

- **`packages/shared`** (`@yugidraft/shared`) — The foundation. Contains the SQLite schema (`src/db/schema.ts`), all shared business-logic services (drafts, matches, tournaments, players, guild settings, card catalog), and the WebSocket event type definitions (`src/ws/events.ts`). All other packages depend on this. Must be built before `bot` or `ws`.
- **`packages/bot`** — Discord bot (discord.js). Handles slash commands, buttons, modals, select menus, and autocomplete. Also runs an internal announce HTTP server on port 4001 so the web can trigger bot announcements.
- **`packages/ws`** — Socket.IO WebSocket server for real-time draft state. Exposes a public port (3001) for browser clients and a private internal HTTP endpoint (4002) that `bot` and `web` call to broadcast draft events.
- **`packages/web`** — Next.js 16 App Router dashboard. Discord OAuth via NextAuth v5. Real-time draft UI uses Zustand (`src/lib/stores/draft-store.ts`) fed by the WebSocket connection.

### Database

Single SQLite file (`./data/bot.sqlite`) shared between `bot` and `web`. Both open it directly via `@yugidraft/shared/db`. `DATABASE_PATH` env var overrides the default path. Schema migration runs automatically at startup in `packages/shared/src/db/schema.ts` via `migrate(db)` — it uses `addColumnIfMissing` for backwards-compatible migrations.

### Service pattern

All business logic lives in factory functions: `createDraftService(db)`, `createMatchService(db)`, etc. These are defined in `packages/shared/src/services/` and imported by both `bot` and `web`. The bot additionally has bot-only services under `packages/bot/src/services/` (draft timer, draft images, draft cleanup, draft templates).

### Discord interaction wrappers

The bot wraps all discord.js interactions into framework-agnostic `*Like` types (e.g., `CommandInteractionLike`, `ButtonInteractionLike`) before passing them to handlers in `src/interactions/` and `src/commands/handlers.ts`. This keeps handler logic testable without Discord mocks.

### Inter-service communication

- **Bot → WebSocket server**: `packages/bot/src/lib/notify-ws.ts` POSTs to the ws internal HTTP endpoint with `WS_INTERNAL_SECRET` bearer auth to broadcast pick/resync/complete events.
- **Web → Bot**: `packages/web/src/lib/announce-bot.ts` POSTs to the bot's announce server on port 4001 with `BOT_ANNOUNCE_SECRET` bearer auth to trigger Discord messages.
- **Browser → WebSocket server**: Socket.IO client connects to `NEXT_PUBLIC_WS_URL` for real-time draft updates.

### Draft flow

Drafts are started from either Discord or the web dashboard. The bot's draft timer (`packages/bot/src/services/draft-timer.ts`) polls active drafts every second and expires pick steps past their deadline, then notifies the ws server. The ws server broadcasts to all browser clients in the draft's Socket.IO room.

### Card catalog

Card data is fetched from ygoprodeck.com and cached in the `card_catalog` SQLite table. The bot syncs sets daily (cron, configurable via `SETS_SYNC_CRON`). Card images are cached to disk at `CARD_IMAGE_CACHE_DIR` (default `./data/card-images`), evicted by oldest-first when the cache exceeds `CARD_IMAGE_CACHE_MAX_BYTES` (default 15 GB).

## Design context (`.impeccable.md`)

Dark-mode-first competitive UI. High-contrast card displays, crisp typography, minimal chrome. Accent colors from Yu-Gi-Oh brand (purple/gold) used sparingly for active states. Design principles: speed over ceremony, live state is truth, draft-room immersion, Discord is the lobby.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `imran443/yugioh-bot`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
