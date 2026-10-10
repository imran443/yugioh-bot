# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use Node 22 for `better-sqlite3` compatibility (Docker and CI also use Node 22).

```bash
# Build shared before running consumers (imports resolve to shared/dist)
npm run build --workspace=packages/shared

# Prepare duel-engine resources before starting duel (separate from the TS build)
npm run duel:prepare
npx tsx packages/duel-server/scripts/build-domain-core.ts

# Development (run each in separate terminals)
# Optional shelved bot: npm run dev:bot (isolated credentials, DISCORD_BOT_ENABLED=1)
npm run dev:worker   # Gameplay timers, set sync and image eviction
npm run dev:ws       # WebSocket server with hot reload
npm run dev:duel     # Private EDOPro engine host with hot reload
npm run dev:web      # Next.js dev server

# Quality checks
npm test             # All packages via Turborepo (duel tests need engine resources)
npm run typecheck    # All packages
npm run build        # All packages (shared must build first — Turbo handles ordering)

# CI runs these; locally run only the test files for the areas you touched.
# Engine suites (duel-server): test:engine needs the built cores (DUEL_REQUIRE_CORES=1, NSEAT_LIVE=1); test:native runs the native checks
npm run test:engine
npm run test:native

# Browser e2e on an isolated stack (Playwright, packages/e2e)
npm run e2e

# Run tests in a single package
npm test --workspace=packages/bot
npm test --workspace=packages/shared
npm test --workspace=packages/web
npm test --workspace=packages/ws
npm test --workspace=packages/worker
npm test --workspace=packages/duel-server

# Run a single test file (bot/shared — no config needed)
npx vitest run packages/bot/tests/services/drafts.test.ts

# Run a single web test file (must specify the web vitest config)
npx vitest run packages/web/tests/cards-resolve-route.test.ts -c packages/web/vitest.config.ts

# Docker (local dev with hot reload)
docker compose --env-file .env --env-file packages/web/.env.local up -d --build

# Docker (production — start already built images without the override file)
# For image updates, run the Deploy workflow on main; see docs/deployment/vm-runbook.md.
docker compose -f docker-compose.yml up -d

# Seed test data and restart services
npm run reset:test-data

# Deploy Discord slash commands
npm run commands:deploy --workspace=packages/bot  # dev (tsx)
```

## Architecture

This is an npm workspaces + Turborepo monorepo with seven packages (see `docs/architecture.md` for the full map):

- **`packages/shared`** (`@yugidraft/shared`) — The foundation. Contains the SQLite schema (`src/db/schema.ts`), shared business-logic services (drafts, cubes, matches, tournaments, players, guild settings, card catalog, duels), and WebSocket event types (`src/ws/`). All other packages depend on its built `dist`; rebuild after shared source changes before checking consumers.
- **`packages/bot`** — Shelved Discord bot (discord.js), outside Compose and deploy service lists. Its Docker target, tests and typecheck remain. Only literal `DISCORD_BOT_ENABLED=1` enables startup or command deployment; disabled startup idles without DB, Discord or HTTP initialization, and command deployment exits 0. It owns none of the four migrated schedulers.
- **`packages/ws`** — Socket.IO server for draft/tournament updates and duel invalidations/presence. Public browser port 3001 (`WS_PORT`); internal HTTP port 4002 (`WS_INTERNAL_PORT`) receives signed broadcasts from `bot`, `web`, `duel-server`, and `worker`.
- **`packages/web`** — Next.js 16 App Router dashboard. Custom Clerk v7 email/password and Discord sign-in, invitation sign-up and password reset. Real-time draft UI uses Zustand (`src/lib/stores/draft-store.ts`) fed by the WebSocket connection.
- **`packages/duel-server`** (`@yugidraft/duel-server`) — EDOPro engine host using `ocgcore-wasm` and engine workers. `build` compiles TypeScript; `dev` runs `tsx watch src/server.ts`; `start` runs `dist/server.js`. Only exposes private HTTP on `127.0.0.1:4003` by default (`DUEL_INTERNAL_HOST` / `DUEL_INTERNAL_PORT`). Web routes call it through `src/lib/duel-host.ts`.
- **`packages/worker`** (`@yugidraft/worker`) — Draft expiry (1s), report approval and tournament deadline closure (60s), set metadata sync and image eviction. Exactly one worker per SQLite file; startup sweeps catch durable deadlines and SIGTERM drains in-flight work. No public port; `WORKER_HEALTH_PATH` holds its local heartbeat.
- **`packages/e2e`** (`@yugidraft/e2e`) — Playwright duel tests on an isolated stack (web/ws/duel plus worker, 3300 port family, own SQLite file/cache/heartbeat, offline HMAC-signed E2E cookie). `E2E_SLOT=0-9` gives concurrent stacks. See `packages/e2e/README.md`.

### Duel resources and Docker

- Engines: Compose defaults new Standard 1v1 games to `DUEL_STANDARD_1V1_ENGINE=pinned`; Domain keeps `DUEL_1V1_ENGINE=legacy`. Native runs with no Standard override use the global choice (default `legacy`). Each game reads the switches at its start and saves its engine for recover/replay. Set the Standard override to `legacy` and recreate `duel` to roll back; an empty Compose value means `pinned`. Tag, FFA3 and FFA4 always use the multi cores (`ocgcore.multi.wasm`, `ocgcore.multi-domain.wasm`). See `docs/deployment/duel-engine-switch.md`.
- `MULTIPLAYER_TABLES` gates Tag/FFA tables. The code default is off, but Compose defaults it to on (`1`); set it on both `duel` and `web`, and `0` closes new multi tables.
- The multi cores and the legacy Domain core are separate builds (`build-domain-core.ts multi|multi-domain|legacy-domain`), not part of `duel:prepare` or the package TypeScript build.
- `duel:prepare` downloads pinned card data, strings, and Lua scripts into `DUEL_DATA_DIR` (default root `data/duel-engine`). `scripts/build-domain-core.ts` in `packages/duel-server` separately builds the patched Domain Format WASM bundle with the pinned Emscripten Docker image; `DOMAIN_CORE_BUILD=local` uses a local `em++` toolchain. Neither step is part of the package's TypeScript build.
- `Dockerfile` has `bot`, `ws`, `duel`, `web`, `worker`, and `web-dev` runtime targets. Compose mounts `./data` into web/duel/worker/ws; duel startup runs `packages/duel-server/scripts/install-engine-bundle.sh` to validate the prepared bundle. The deploy workflow prepares/caches that bundle separately (`.github/workflows/deploy.yml`).
- Compose binds duel to `0.0.0.0:4003` inside the Docker network and sets web's `DUEL_INTERNAL_URL=http://duel:4003`. On `SITE_DOMAIN` (the app), Caddy routes `/socket.io/*` to `ws:3001` and other HTTP to `web:3000`. Optional `MARKETING_DOMAIN` serves `site/public` read-only, proxies only `POST /api/waitlist`, and redirects `/login` to the app; `LEGACY_DOMAIN` redirects old paths to the app with 308. Empty extra domains use reserved `.localhost` defaults. Deploy recreates Caddy, refreshing its Caddyfile bind mount. See `docs/deployment/domains.md` for routing. Internal ports 4001/4002/4003 are not published. The dev override adds a shared TypeScript watcher and exposes web/ws on 3000/3001.

### Database

Single SQLite file (root `data/bot.sqlite`) shared between web, WS, duel-server and worker (and an explicitly run shelved bot). Every process must use the same absolute `DATABASE_PATH`; Compose sets `/app/data/bot.sqlite` explicitly. For native development, set an absolute path in your checkout before starting services. The worker also requires an absolute `CARD_IMAGE_CACHE_DIR`, shared with web. `openDatabase` enables WAL, a 5000-ms busy timeout and foreign keys, then calls the idempotent `migrate(db)` in `packages/shared/src/db/schema.ts`. Identity releases migrate once offline before starting all updated consumers together; see the VM runbook for matched DB/code/env rollback.

`users.id` is application identity. `players.user_id` links it to an unchanged gameplay player ID in the configured community. Owners/creators store integer user IDs; `session.user.id` is their canonical decimal string. Clerk sessions resolve through `session-identity.ts` to `users`, fetching the Backend API only for missing/stale (>5 minutes) or forced sync. Verified Discord linking runs transactionally and preserves gameplay history; email-only members work without Discord membership checks. `session.user.discordUserId` is nullable. Draft room tokens use application IDs; duel tokens still use player IDs.

### Service pattern

Shared business logic lives in factory functions: `createDraftService(db)`, `createMatchService(db)`, etc. These are defined in `packages/shared/src/services/` and consumed by bot/web/duel-server/worker. Worker services own draft/tournament timers, set sync and shared filesystem eviction. Bot services under `packages/bot/src/services/` retain command-facing draft cleanup, Discord notification cleanup and reminders; draft images re-export the shared implementation. Bot template commands use the shared `createCubeService`.

### Discord interaction wrappers

The bot wraps all discord.js interactions into framework-agnostic `*Like` types (e.g., `CommandInteractionLike`, `ButtonInteractionLike`) before passing them to handlers in `src/interactions/` and `src/commands/handlers.ts`. This keeps handler logic testable without Discord mocks.

### Inter-service communication

- Internal HTTP uses `httpTransport` in `packages/shared/src/notify/signed-post.ts`: HMAC-SHA256 over the exact serialized JSON body, sent as `x-announce-signature: sha256=<hex>`. Receivers verify the raw body with the matching secret before parsing JSON.
- **Bot/web/duel-server/worker → ws**: `createBroadcaster` posts draft/tournament events to `/internal/draft/*` and `/internal/tournament/*`; duel invalidations use `/internal/duel/changed`. Uses `WS_INTERNAL_URL` / `WS_INTERNAL_SECRET` on port 4002 (`packages/ws/src/internal-http.ts`).
- **Discord effects**: Compose fixes `DISCORD_BOT_ENABLED=0` on web and worker. Mutations commit and publish WS updates without bot HTTP or Discord REST. `/api/discord/channels` and `/api/tournaments/[slug]/announce` return 404 `{ "error": "discord_disabled" }`. Discord capability reaches UI through server-rendered props.

- **Web → duel-server**: `packages/web/src/lib/duel-host.ts` posts operations to `/internal/duel` with `DUEL_INTERNAL_URL` / `DUEL_INTERNAL_SECRET` on port 4003. URL defaults to `http://127.0.0.1:4003`; Compose uses `http://duel:4003`. Browsers use authenticated web API routes.
- **Browser → ws**: Socket.IO connects to `NEXT_PUBLIC_WS_URL` (falls back to the page origin). Draft/tournament joins use slugs. Duel joins require a 5-minute token from `/api/duels/[slug]/connection`, signed with `WS_INTERNAL_SECRET` over JSON claims (`slug`, `guildId`, `playerId`, `seat`, `expiresAt`); ws verifies it in `src/duel-events.ts`. See `packages/shared/src/ws/duel-token.ts`.

### Web access model

- `packages/web/proxy.ts` uses `clerkMiddleware`; one server resolver maps sessions to `users.id`. Protected APIs return 401 JSON without a session; pages redirect to `/sign-in?redirect_url=...`. Sync failure returns 503. `auth()` and `requireWebAccess()` retain their session/guard shapes.
- Public paths: `/sign-in(.*)`, `/sign-up(.*)`, `/sso-callback(.*)`, `/access`, legacy `/login` redirect, static assets/icons, exact `POST /api/waitlist` and `GET /api/auth/session`. `/api/waitlistx` stays protected. Existing FX-lab paths are public only when enabled. Anonymous session GET returns 200 `null`.
- Existing-player recovery also opens `/welcome-back`, exact `GET /api/auth/existing-player/start` and `GET /api/auth/callback/discord`, and exact `POST /api/auth/existing-player/complete` and `POST /api/auth/existing-player/ticket`. It proves Discord identity directly, requires a verified email and legal consent, and claims the existing `users` row without email-based account merging. Recovery cookies are encrypted with a key derived from the Clerk secret; the short-lived Clerk ticket never enters a URL. Runtime Discord OAuth client credentials reach only web.
- There is no web/shared admin role or Discord membership gate. Creators manage drafts, tournaments and cubes; seat, participant, invite-grant and saved-deck ownership checks still apply. All reads remain scoped to `DISCORD_GUILD_ID`. Season writes use the VM owner CLI only.
- `/settings` redirects to `/settings/account`, the sole `<UserProfile/>` page. Focus/return calls `/api/account/refresh` for forced sync. Two accounts with history are not automatically merged; the owner handles conflicts.
- Isolated E2E uses a one-hour HMAC-signed `dd_e2e_session` HttpOnly/SameSite cookie for seeded `users.id`. Only literal `E2E_AUTH=1` plus `E2E_AUTH_SECRET` of at least 32 characters enables `/api/test-auth/session` and `/api/test-auth/sign-out`; both 404 when disabled. Test mode skips Clerk middleware/provider initialization and shows offline account controls. Production/staging Compose forward neither E2E gate nor secret.
- Legal links are `https://duelingdomain.com/privacy` and `https://duelingdomain.com/terms`; the app has no legal pages/public exceptions. Contact: `support@duelingdomain.com`.
- `/dev/fx-lab`, `/dev/table-preview`, `/dev/solid-preview` and their card-image routes are public with `DUEL_FX_LAB=1` or in `next dev`; otherwise 404. Draft test bots require `DRAFT_TEST_BOTS=1` in production (allowed in non-production); APIs provide the UI capability.

### Env and owner operations

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a web build arg (production repository variable). `CLERK_SECRET_KEY` is web runtime only; never supply it to a build. Dev keys live in ignored `packages/web/.env.local` and never reach staging/production. Staging has a separate instance/source. Web uses an explicit Compose environment list, never a broad env file. `WEB_URL` is required for WS CORS and app links; no NextAuth fallback exists. `MARKETING_URL` supplies external waitlist links.

Owner tools ship in the worker image: `node packages/worker/dist/ops/cli.js season|merge-users|clerk-precreate-users|clerk-reconcile-waitlist`. Dry-run is default; `--apply` writes, `--report` chooses a private 0600 report. Pass Clerk secret explicitly for import/reconcile: `docker compose -f docker-compose.yml run --rm --no-deps -e CLERK_SECRET_KEY worker node packages/worker/dist/ops/cli.js ...`. Stop writers and revoke source Clerk sessions before merge apply. See the VM runbook for commands and rollback.

### Draft flow

Drafts are started from the web dashboard; the shelved bot retains its command implementation. The worker's draft timer (`packages/worker/src/draft-timer.ts`) polls active drafts every second and expires pick steps past their deadline, then notifies the ws server. The ws server broadcasts to all browser clients in the draft's Socket.IO room.

### Cubes and theme draft mode

- New theme drafts require web runtime `THEME_DRAFTS=1|true|on` (default off in every build); production Compose defaults to `0`, staging uses `STAGING_THEME_DRAFTS=1`, and existing theme lobbies/games, summaries and deck exports remain available when off. `GET /api/drafts` and `GET /api/cubes` return `themeDraftsEnabled` for the browser.
- Reusable pools/configs live in `cubes` / `cube_cards` (`main`/`extra` pools, per-card `max_copies`, draft config in `config_json`). `createCubeService` supports archetype seeding, passcode imports, and saved configs; `applyCubeToConfig` supplies shared booster-style drafts. The library/editor uses `/cubes`, `/cubes/[id]`, and `/api/cubes`; `/themes` and `/themes/[id]` redirect to the corresponding cube pages. Legacy theme and draft-template tables are dropped by migration.
- `DraftConfig.mode === "theme"` deals each player privately from an assigned cube. `allowedCubeIds` controls available cubes; `draft_player_cube` stores assignments. `themeSelection` still supports `host_assigned`, `random`, and `player_pick`; `uniqueThemes` controls distinct assignments.
- In `packages/shared/src/services/drafts.ts`, `startThemeDraft` assigns seats/cubes and checks main-pool sufficiency; `openThemeRound` deals up to `themePackSize` choices; `pickThemeCard` advances `current_wave_number` once everyone dealt a pack has picked. Main-deck rounds precede optional extra-deck rounds; `burnUnpicked` controls whether unpicked choices return to the pool.
- Web flow: `/drafts/new` → `/drafts/new/theme` → lobby cube creation/attachment, claim/preview, and start preflight. Draft cube management uses `/api/drafts/[slug]/cubes`; player claims use `/api/drafts/[slug]/claim-cube` with `cubeId`; analysis uses `/api/drafts/[slug]/preflight`. Card catalog supports `syncByArchetype`, `listArchetypes`, and `card_catalog.archetype`.

### Card catalog

Card data is fetched from ygoprodeck.com and cached in `card_catalog`. The worker syncs set metadata at `SETS_SYNC_CRON` (default `0 6 * * *`, `SETS_SYNC_TIMEZONE=UTC`). Bot images, the web card-image route and the worker share the same absolute `CARD_IMAGE_CACHE_DIR` (Compose: `/app/data/card-images`). Worker startup and cron cleanup evict oldest files over `CARD_IMAGE_CACHE_MAX_BYTES` (default `16106127360`, 15 GiB) on `IMAGE_CLEANUP_CRON` (default `0 4 * * *`, `IMAGE_CLEANUP_TIMEZONE=UTC`). Next's optimized images have a separate cache with a 1-year minimum TTL (`packages/web/next.config.ts`).

## Design context (`.impeccable.md`)

Dark-mode-first competitive UI. High-contrast card displays, crisp typography, minimal chrome. Accent colors from Yu-Gi-Oh brand (purple/gold) used sparingly for active states. Design principles: speed over ceremony, live state is truth, draft-room immersion, Discord is the lobby.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `DuelingDomain/yugioh-bot`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
