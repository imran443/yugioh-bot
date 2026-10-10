# Dueling Domain

A web app for YuGiOh drafts, tournaments, automated duels and community stats, with a standalone scheduling worker.

## Features

### Shelved Discord bot

The bot package and Docker target remain buildable, typechecked and tested. PR 2 removes its Compose service and deployment steps; web and worker run with `DISCORD_BOT_ENABLED=0`. Existing bot commands remain in source for an explicitly configured isolated run.

### Web Dashboard
- Custom Clerk email/password and Discord sign-in; invitation sign-up and password reset
- View active, pending, completed, and cancelled drafts
- Create new drafts with set picker and config options
- Create new tournaments with format selection
- Draft detail pages: manage pending drafts (start, cancel, edit), participate in active drafts, view completed draft summaries and export YDK
- Tournament detail pages: view participants, matches, standings; start/cancel tournaments (creator only); report match results
- Account profile and linked Discord settings at `/settings/account`
- Real-time draft updates via Socket.IO
- Automated Normal/Domain duel tables with the approved Obsidian duel room: 1v1, Tag 2v2, and 3-player and 4-player free-for-all (rules in [ADR-0002](docs/adr/0002-multiplayer-duel-rules.md))

## Local Setup

```bash
npm install
cp .env.example .env
npm run build --workspace=packages/shared
# Fill .env with absolute DATABASE_PATH/CARD_IMAGE_CACHE_DIR and internal secrets.
# Pull Clerk dev keys into ignored packages/web/.env.local (owner-approved instance).
# Start each in a separate terminal:
npm run dev:web
npm run dev:ws
npm run dev:duel
npm run dev:worker
```

SQLite data is stored in `./data/bot.sqlite` by default.

### Saved decks

**Decks** in the sidebar opens your private library at `/decks`. **New deck** opens `/decks/new`; saved lists reopen at `/decks/:id`. Decks are stored in SQLite and scoped to the configured guild and signed-in application user. Other accounts cannot list, read, update, or delete them.

The editor lays out every copy in separate **Main**, **Extra**, and **Side** card grids, alongside a card inspector and engine-catalog search by name or passcode. Click a card to inspect it, add/remove a copy, or move a copy between sections. Search places Fusion/Synchro/Xyz/Link monsters in Extra by default and other cards in Main; **Side** adds an explicit Side copy. Domain decks have a searchable **Deck Master** slot; promoting a deck card moves one copy out, and changing/clearing that choice restores it during the editing session, including after saving.

Upload/drop **YDK**, paste YDK or **YDKE**, or build a deck from search. Imports replace the current list; empty/unrecognized files leave it intact. **Export YDK** preserves card order, duplicates, all three sections, and an explicit Master in a `#deckmaster` section before `#main`. Domain imports with a lone Side card and no explicit Master select that card automatically. Switching formats does not delete cards or a saved Master.

**Save** accepts unfinished lists; it does not certify duel legality. Unknown passcodes remain visible rather than being silently discarded. Unsaved changes are guarded on links, Back/Forward, and browser unload; failed saves retain the edits. Delete requires confirmation. In a duel lobby, choose **Use a saved deck → Load deck**. This loads a room-local copy, so lobby edits do not overwrite your library. Standard rooms omit any saved Domain Master from that copy. The room validates its own rules before **Ready with this deck**, and submission revalidates server-side.

### Automated duel service

Authenticated **Standard** tables use selectable EDOPro Master Rule presets **1–5**, defaulting to **Master Rule 5**. **Domain** is a separate mode using modern rules plus Domain mechanics. The selection is fixed when a table is created and retained for reconnect, replay, and history. These are native gameplay presets with the current card catalog, not historical card pools or banlists. Players choose; the private compiled engine enforces legality and resolves effects. An organizer can fill an empty opponent seat with **Add practice bot** for solo testing. The bot brings a format-valid generic EARTH Normal Monster deck, makes basic legal choices, summons, and attacks automatically; it is not a competitive AI. The table type is chosen at creation: 1v1 (default), Tag 2v2, FFA3 or FFA4, in both Standard and Domain; the rules are in [ADR-0002](docs/adr/0002-multiplayer-duel-rules.md). Tag, FFA3 and FFA4 tables need `MULTIPLAYER_TABLES` on (see Environment Variables). Community match history and ranking remain available.

**Create game** opens the responsive `/duels/new` creator: visibility, Standard/Domain, automatic engine, Master Rules, versioned Forbidden & Limited list, TCG/OCG pool, turn timer, starting LP/hand, draw count, timeout behavior, deck validation, and opening shuffle. Settings are enforced server-side and retained in reconnect/replay/history; they cannot be changed after creation. Standard defaults to the pinned TCG September 2026 list; Domain defaults to no banlist and its official deck rules. Rules-changing overrides are labeled **Custom Domain**, never official Domain. The available lists are None, [TCG September 2026](https://www.yugioh-card.com/en/limited/list_2026-09-21/), and OCG July 2026, compiled from pinned [Project Ignis lists](https://github.com/ProjectIgnis/LFLists); they do not silently update existing rooms.

**Invalid decks allowed** disables competitive size/copy/banlist/Domain-membership checks, not engine safety: known playable cards, valid zones/scripts, the selected card pool, enough cards for the opening hand, and a monster Deck Master for Domain are still required. Custom Domain imports with validation disabled keep their Side Deck and require an explicit Master. **Starting deck not shuffled** uses imported top-to-bottom order for the opening only; later card-effect shuffles still work.

**Turn clocks** are a time bank: the room's timer (e.g. 4 minutes) is the most a player can hold. Only the player with the pending prompt is charged. Each accepted decision gives that player 3 seconds back, and at the start of every turn each player regains a quarter of the bank (at least 30 seconds, so 1 minute on a 4-minute bank), never above the full bank. The web room shows a short "+3s" or "+1:00" next to a clock when time is added. Engine processing is excluded. Disconnects, reloads, worker eviction, and host recovery do not reset the saved deadline. Timeout either records a loss or continues at zero until the next turn, according to the room setting. No-timer rooms have no clock; legacy rooms keep their previous no-timer/no-banlist behavior.

The canonical resource bundle is worktree-local `data/duel-engine` (`cards.cdb`, `card-scripts/`, `strings.conf`, `ocgcore.domain.wasm`, `ocgcore.standard.wasm`, `manifest.json`, plus `ocgcore.multi.wasm` and `ocgcore.multi-domain.wasm` for Tag/FFA tables, `ocgcore.domain.legacy.wasm` and `card-scripts/domain.legacy.lua` for the legacy 1v1 engine). In the pinned 1v1 engine, Domain mode loads only `DUEL_DATA_DIR/ocgcore.domain.wasm` (default `./data/duel-engine`); Standard mode loads only `DUEL_DATA_DIR/ocgcore.standard.wasm`, the ygopro-core built from the same pins without the Domain patch (it has only the shared engine bug fixes in `packages/duel-server/domain-core/src/apply-core-fixes.mjs`, which both builds apply; the rules stay stock) (the npm `ocgcore-wasm` core is older than the pinned card scripts and is used only by legacy Standard 1v1 games). Neither falls back to `out/`, `packages/duel-server/domain-core/dist` or the npm core; a missing file is an error that names its build script. Shuffled openings use the core's pinned seed; unshuffled openings use the imported order. Both replay with the saved settings and accepted-input journal. A `manifest.json` `bundleVersion` change interrupts in-flight tables.

With deck validation enabled, Domain submission requires a separate Deck Master, exactly 60 singleton Main Deck cards, at most 15 Extra Deck cards, and no Side Deck. Main Deck Pendulum Masters can be activated as scales or Pendulum Summoned from the Deck Master Zone; non-Pendulum Main Deck Masters can also be Pendulum Summoned when eligible. Extra Deck Pendulum Masters require their proper Extra Deck summon mechanic. Summon surcharges apply to subsequent departures, including effect-based summons, and recall eligibility resets on changes of location kind. Format rules: [Domain Format](https://www.domainformat.com/rules).

To choose your Deck Master, create a **Domain** table, then upload/drop a YDK file or paste YDK / a `ydke://` link. The shared **Deck Master** picker searches monsters by name or passcode and previews the selection. Each imported card also has a **Master** action: it moves one copy into the separate slot; changing or clearing that choice restores the previous promoted card to its original section. Choosing from a 60-card Main Deck leaves 59, so add another legal card before readying. Choosing a separate monster leaves the 60 Main cards intact.

With deck validation enabled, a sole Side card is automatically selected as the Master. Other Side cards stay visible and invalid instead of being silently discarded. A fresh import replaces the old master selection; the editor's YDK text preserves an explicit selection in a `#deckmaster` section before `#main`, including Custom Domain imports with a Side Deck. The selected room banlist also applies to the Master (including equivalent card identities). **Ready with this deck** remains disabled until the server accepts the deck's rules. Standard tables have no Master picker and normally accept 40–60 Main cards.

Imported catalog/artwork IDs absent from the engine database are resolved through the existing card catalog to an unambiguous engine card name before validation. For example, Barrel Dragon `81480461` resolves to `81480460`. Unknown or ambiguous cards still fail; enabled copy limits, Domain membership, and singleton rules apply to the canonical IDs.

File and pasted deck imports are checked immediately against the room's saved rules, without submitting the deck or changing readiness. A banner above the editor lists card and deck-level problems; invalid card copies have red outlines, an **Invalid** label, and a removal reason. Click a card to remove that copy; every edit refreshes validation. Forbidden cards mark every copy, while copy-limit errors mark only excess copies in Main/Extra/Side order. **Ready with this deck** stays disabled while checking, when validation fails, or while any issues remain. Validation follows the room's **Invalid decks allowed** setting, and submission still revalidates server-side.

The practice bot is a real bot seat, not a fabricated Discord player. Its Domain deck has 60 unique low-level EARTH Normal Monsters plus Axe Raider (`48305365`) as a separate Deck Master; its Normal deck has 40 cards. It sees only its own redacted engine view, and its accepted choices use the same durable journal as human choices. Bot wins are recorded by seat without awarding them to a human.

The **Obsidian duel room** uses an immersive two-sided field with five Monster and Spell/Trap zones per player and separate piles. MR1–2 have no Pendulum or Extra Monster Zones; MR3 has separate Pendulum Zones; MR4–5 (including the default Domain preset) use integrated Pendulum Zones and shared Extra Monster Zones. Custom Domain fields follow their selected Master Rule. Left-click a card for its engine-offered actions; hover or focus it for stats. The inspector preserves exact card instances when choosing from a pile. Escape closes an action menu without submitting an answer. Required targets, zones, materials, and positions use the engine's prompt; optional chains offer Pass, mandatory chains do not. Only Domain tables show the Deck Master rail. Its recall prompt names the Master and displays the next summon surcharge before the choice.

The room uses the **Match Sheet** look: a ruled obsidian sheet with antique-gold hairlines, purple only for your legal actions and selections, gold for chains and responses, and red only for LP loss and destruction. Monster Zones keep one slot with crossing portrait and landscape guides; cards rotate only when their engine position requires it. The board sizes itself from the available width and height (CSS container units), so both hands, all rows, and both LP tallies stay on screen from 390×844 phones to 2560-wide monitors. In the Battle Phase (including damage steps) the board hairlines and header phase warm to ember orange. GY, Banished, and your visible Extra Deck cards fan their top cards on the pile; hover or focus spreads the fan, and **Open GY** / **Open Banished** / **Open Extra Deck** opens the full pile in the inspector.

The bottom **station track** replaces the phase buttons: DP SP M1 BP M2 EP on one rail, finished stations ticked, the current station lit (purple on your turn, gold otherwise), and a caption naming what you can do there. The main button always names the next engine-offered step (**To Battle**, **To Main 2**, **End Turn**), with **End Turn** as a secondary button when both are offered; it glows when only phase moves remain. Only engine-offered phase moves are clickable. The turn player's name and both clocks sit at its left.

Life Points use the Oxanium face and roll like a slot machine: every changed digit spins on its own reel, the reels stop left to right, losses flash red and gains gold. The previous value stays struck through beside a −/+ delta chip until the next change. Initial and reconnected mounts do not roll; reduced motion snaps to the new value with a short pulse. Screen readers hear the exact new value once. When a duel ends by LP 0, deck out, surrender, time, or lost connection, a full-screen **YOU WIN** / **YOU LOSE** screen (or **<Name> WINS** for spectators, **DRAW**, **DUEL INTERRUPTED**) shows the reason in plain words, both final LP totals, and in Domain the Deck Masters. Click, Space, or Esc skips its intro; **View board** returns to the final board.

Main Phase 1, Battle Phase, Main Phase 2, and End Phase announcements come from engine `NEW_PHASE` events, not button clicks. A non-blocking centered ribbon preserves intermediate phases when the engine advances immediately to the next turn. Events are deduplicated and initial/reconnected snapshots do not replay old announcements. Reduced motion keeps the text without the entrance animation.

Card backs are an original design: a gold four-point star in a ring on a dark field with a wide gold frame and four corner diamonds, with no text and no official marks. The Extra Deck variant is violet. The SVG sources are `packages/web/public/duel/card-back-main.svg` and `card-back-extra.svg`. Run `node packages/web/scripts/render-card-backs.mjs` to render them to the 1394×2031 WebP files (`card-back-*-hd.webp`) that the duel UI uses. The 3D effects draw the same SVG. Main and Extra Deck piles show subtly angled card layers only when their counts exceed one; empty piles remain empty. The background is an original seamless 1024×1024 matte slate texture stored losslessly to retain fine grain, not an enlarged concept-image crop.

The Match Sheet room pass played real practice duels against the bot at 1440×900, 1920×1080, and 390×844: zone placement, the Deck Master recall prompt, Battle Phase ember, a direct attack with the slot-machine LP roll, pile fans and **Open GY**, and the lose and spectator result screens.

Summons, sets, activations, attacks, and chain resolution produce non-blocking feedback in engine order. Face-down identities stay private to their owner, including logs and presentation events. **Options** provides persisted sound and motion preferences: sound starts off and requires a browser interaction to unlock; motion follows the device setting unless overridden. Muting stops current voices. Reduced motion keeps informational cues without animated movement.

**Room access and recovery:** signed-in members of the configured community may watch public tables. Private tables require an organizer's **Copy invite** link for first admission; the grant persists, so admitted viewers can return through the ordinary room URL. Private tables and history are omitted from unauthorized lists, and direct room/deck/action/Socket.IO-token requests are denied. Returning players recover their identity-bound seats, including during an active duel; spectators receive only the public board/events, never private hands, deck lists, or actionable prompts. Clerk sessions resolve to `users.id`; Discord linking is optional and no guild membership REST check is made. Authenticated Socket.IO notifications trigger authoritative HTTP snapshots, including on reconnect. Tokens renew before expiry; HTTP polling remains available if realtime is unavailable. Presence reports occupied online seats and spectator count. A disconnect alone is not a defeat, but an enabled clock continues running.

The room's left header identifies **Spectator** mode. **Live**, **Polling**, **Catching up…**, and **Reconnecting** show connection/recovery state; **Options → Catch up now** requests a fresh snapshot. Returning to a tab, restoring a connection, or re-entering the room catches up to the current authoritative board, without undoing moves or replaying old animation/audio cues. Refreshes are serialized; updates received during a refresh trigger a trailing snapshot. Game choices stay disabled until catch-up succeeds. Visible, online tabs poll every second without a live subscription and every ten seconds while live.

Active players and spectators receive role-specific confirmation before in-app departure or same-document Back/Forward navigation. Closing/reloading a tab uses the browser's generic leave warning, subject to browser activation and mobile lifecycle restrictions. Leaving does not surrender, free a seat, or pause a running clock. Finished games have no leave guard. Browser verification covered live public moves, offline/re-entry recovery for both roles, HTTP-only polling, racing snapshots, simulated tab-return events, cancelled Back/Forward with and without the Navigation API, native close prompts, and the spectator header/manual recovery at 390px width.

**Room lifecycle:** your own tables in **Live tables** have **Close**: organizers cancel a lobby, a seated non-organizer leaves it (also **Leave table** in the room), and an active duel closes only by surrender. Finished (completed or interrupted) and cancelled tables leave **Live tables** immediately. **Live tables** show your own open tables plus other duels with activity in the last 15 minutes; other players' lobbies and idle duels are hidden. **Match history** lists completed and interrupted duels (**Mine** or **All**, most recent 100; cancelled lobbies are not listed) and offers a move-by-move replay rebuilt from the pinned seed and accepted-input journal, available only while the engine bundle version matches. Replays never modify the duel. `DUEL_ARCHIVE_AFTER_MS` still sweeps legacy rows that were never archived. SQLite retains outcomes, decks, accepted inputs, and available final board snapshots; private and public projections remain separate. Completed workers are released after final-state persistence. Idle active workers are reclaimed after five minutes without room requests (`DUEL_IDLE_WORKER_MS`); a returning viewer reconstructs the game from its pinned seed and accepted-input journal. Rebuild the Domain bundle and restart the duel service to activate native rule changes; changing the bundle version interrupts existing active games rather than replaying them under different rules.

Compiled HTTP workers and the emitted standalone browser have completed ordinary Normal 1v1 games (including privacy, stale/wrong-seat/outsider rejection, and journal replay) and Domain 1v1 Deck Master leave → GY → offered recall → re-summon at +500 LP. The Obsidian room has also been exercised from both seats at desktop and 390px widths: card and multi-card-pile menus, keyboard dismissal, horizontal face-down cards, optional responses, two-link resolution, sound/mute, reduced motion, reversible Link-material selection through a completed Link Summon, and a live Master recall/resummon from 8000 to 7500 LP. Narrow-screen checks include reaching both ends of a seven-card hand. Native lifecycle smokes cover the second recall/resummon to 6500 LP. This does not imply complete card compatibility.

Current native regressions also cover Master Rule first-turn draws and field rules, Main Deck Pendulum scale activation/Pendulum Summoning, effect-based Deck Master surcharge payment, recall after location-kind changes, and right-scale/Link-arrow integrity across both cores. The existing `patch-package` patch for `ocgcore-wasm@0.1.2` includes the wasm32 card-data offset correction; keep the install-time patch applied when rebuilding or deploying.

**Prepare resources** (worktree root, after `npm install`):

```bash
npm run duel:prepare
# Domain wasm + domain.lua into data/duel-engine. Default: already-pulled
# docker.io/emscripten/emsdk:4.0.9. DOMAIN_CORE_BUILD=local uses host em++.
npx tsx packages/duel-server/scripts/build-domain-core.ts
# Standard wasm (stock rules plus the shared core fixes), same toolchain and pins:
# ocgcore.standard.wasm into data/duel-engine, integrity.standardWasm in manifest.json.
npx tsx packages/duel-server/scripts/build-domain-core.ts standard
# Multi cores for Tag, 3-player and 4-player tables. They build into packages/duel-server/domain-core/dist as
# ocgcore.multi.sync.wasm and ocgcore.multi-domain.sync.wasm. The engine reads ocgcore.multi.wasm and
# ocgcore.multi-domain.wasm from the data directory (the deploy workflow installs both).
npx tsx packages/duel-server/scripts/build-domain-core.ts multi
npx tsx packages/duel-server/scripts/build-domain-core.ts multi-domain
# Legacy Domain core (Compose Domain default: DUEL_1V1_ENGINE=legacy):
npx tsx packages/duel-server/scripts/build-domain-core.ts legacy-domain
```

The multi cores and the legacy Domain core are separate builds, not part of `duel:prepare`. See [duel-engine-switch.md](docs/deployment/duel-engine-switch.md) for which engine runs which table.

**Compiled engine** (bind `127.0.0.1:4003` by default; never expose that port). `dist/worker.js` must sit next to `dist/worker-client.js`. Load `.env` into the process environment — do not pass `node --env-file` (Node 24 rejects it when Next forwards the flag into `NODE_OPTIONS`).

```bash
npm run build --workspace=@yugidraft/shared
npm run build --workspace=@yugidraft/duel-server
node packages/duel-server/dist/server.js
```

On memory-capped WSL, use this compiled host and the emitted standalone web below. Do not run unbounded `next dev` / Turbopack; it can spawn runaway PostCSS processes.

**Emitted Next standalone** (`output: "standalone"`, `outputFileTracingRoot` is the worktree). The web build runs `package:standalone` after Next finishes, copying `.next/static` and `public` beside the emitted server. Both the local start script and Docker use this complete tree; missing assets otherwise leave HTML visible while CSS and JavaScript return 404.

```bash
npm run build --workspace=@yugioh-discord-bot/web
# Repair assets in an existing completed build without running Next again:
npm run package:standalone --workspace=@yugioh-discord-bot/web
```

After loading local `.env` and Clerk dev keys from ignored `packages/web/.env.local` into the process environment (public key during build, secret during start), launch from the worktree root:

```bash
HOSTNAME=127.0.0.1 PORT=3000 \
WEB_URL=http://localhost:3000 DISCORD_BOT_ENABLED=0 \
DATABASE_PATH="$PWD/data/bot.sqlite" \
DUEL_INTERNAL_URL=http://127.0.0.1:4003 \
WS_INTERNAL_URL=http://127.0.0.1:4002 \
systemd-run --user --scope --unit=yugidraft-web-local \
  -p MemoryMax=1536M -p MemorySwapMax=256M -p TasksMax=128 \
  npm run start --workspace=@yugioh-discord-bot/web
```

`start` launches `packages/web/.next/standalone/packages/web/server.js`, not `next start`. The web process needs `DUEL_INTERNAL_SECRET` matching the engine or deck ready never reaches the host. Configure the Clerk instance for the local app origin and its `/sso-callback` flow.

For host-run web with Docker WebSocket services, Docker-only names such as `http://ws:4002` are not reachable from the web process. Publish WebSocket internal `4002` on `127.0.0.1` only, retain matching signing secrets, and mount the same worktree `data` directory into the supporting containers. The current local override is `/tmp/yugioh-local-3000.override.yml`; it also publishes Socket.IO at `localhost:3002` and sets its browser origin to `http://localhost:3000`. Build the browser with `NEXT_PUBLIC_WS_URL=http://localhost:3002`. Leave the older Docker web container stopped to avoid a duplicate app.

Set `WS_INTERNAL_URL=http://127.0.0.1:4002` for **both** host-run web and duel processes; Compose overrides it with `http://ws:4002` inside Docker. After changing either setting, restart that process. The WebSocket image must also include the current duel subscription and `/internal/duel/changed` handlers: an older draft-only image leaves the UI in **Polling** even if Socket.IO connects. Internal notifications are awaited, so a Docker-only hostname in a host process delays table creation and card responses while DNS fails.

Source attribution: [ocgcore-wasm](https://github.com/n1xx1/ocgcore-wasm), [EDOPro core](https://github.com/edo9300/ygopro-core), [ProjectIgnis CardScripts](https://github.com/ProjectIgnis/CardScripts), and the GPL-3.0 [Domain Toolbox](https://github.com/DarknessCatt/Yugioh-Domain-Toolbox) used as the Domain legality reference. Engine, scripts, and card artwork have separate licensing requirements; no Master Duel assets are bundled.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes (web build/dev) | Web build arg; production repository variable. Dev keys belong in ignored `packages/web/.env.local` only |
| `CLERK_SECRET_KEY` | Yes (web runtime) | Backend API key; explicitly passed to one-off owner CLI runs, never image builds |
| `DISCORD_BOT_ENABLED` | Yes | Compose fixes web/worker to `0`; only literal `1` enables an explicitly run shelved bot |
| `DISCORD_GUILD_ID` | Yes | Community scope for gameplay and owner season operations |
| `SITE_DOMAIN` | Yes (Compose) | Caddy app hostname; see [production environment setup](docs/deployment/vm-runbook.md#create-env) |
| `WEB_URL` | Yes | Canonical app origin and WS CORS origin; Compose fails if missing |
| `MARKETING_URL` | No | Marketing origin for external waitlist links |
| `NEXT_PUBLIC_WS_URL` | No (dev only) | Separate browser WebSocket URL, e.g. `http://localhost:3001`; production uses page origin |
| `WS_INTERNAL_SECRET` | Yes (web + duel + worker + ws) | Shared HMAC secret for broadcasts and room tokens; generate with `openssl rand -hex 32` |
| `WS_INTERNAL_URL` | Yes (web + duel + worker) | Internal WS URL; `http://ws:4002` in Compose |
| `BUG_REPORT_GITHUB_TOKEN` | No (web runtime) | Server-side token for issue creation; fine-grained PATs need resource owner `DuelingDomain`, Issues write access and org approval if required; empty keeps reports local |
| `BUG_REPORT_GITHUB_REPO` | No | Defaults to `DuelingDomain/yugioh-bot` |
| `DUEL_FX_LAB`, `DUEL_SCENARIOS`, `DRAFT_TEST_BOTS` | No | Server feature gates; staging enables scenarios only |
| `E2E_AUTH`, `E2E_AUTH_SECRET` | Isolated E2E only | Literal `1` and ≥32-character secret enable signed-cookie test login; absent from production/staging Compose |
| `DUEL_INTERNAL_SECRET` | Yes (web + duel) | Shared HMAC secret for web → private duel host (`x-announce-signature`). Generate with `openssl rand -hex 32`. Never expose port 4003 |
| `DUEL_INTERNAL_URL` | Yes (web) | Internal URL of the duel host. Host: `http://127.0.0.1:4003`. Compose: `http://duel:4003` |
| `DUEL_DATA_DIR` | No | Canonical engine bundle. Defaults to `./data/duel-engine`. Use an absolute path when the process cwd is not the worktree |
| `DUEL_1V1_ENGINE` | No | Global choice for new 1v1 games: `legacy` (default) or `pinned`. Domain uses this choice; Standard can override it. See `docs/deployment/duel-engine-switch.md` |
| `DUEL_STANDARD_1V1_ENGINE` | No | Standard 1v1 choice: `legacy` or `pinned`. Compose defaults missing or empty values to `pinned`; native runs fall back to `DUEL_1V1_ENGINE`. Roll back with `legacy` in `.env`, then recreate `duel`. Each game of a series reads the switch at its start |
| `MULTIPLAYER_TABLES` | No | `1`, `true` or `on` opens Tag, 3-player and 4-player tables. The code default is off (1v1 only), but `docker-compose.yml` and `docker-compose.staging.yml` default it to `1` (on). `0` closes new multi tables. Set it on `duel` and `web` |
| `DUEL_INTERNAL_HOST` | No | Duel host bind address. Defaults to `127.0.0.1` (`0.0.0.0` in Compose) |
| `DUEL_INTERNAL_PORT` | No | Duel host port. Defaults to `4003` |
| `DUEL_ARCHIVE_AFTER_MS` | No | Delay before terminal tables are archived from live listings; default `600000` (10 minutes). Records remain in SQLite |
| `DUEL_IDLE_WORKER_MS` | No | Idle worker reclamation delay; default `300000` (5 minutes). Re-entry replays the game without forfeiting a seat |
| `DUEL_BOT_STEP_MS` | No | Base pause in ms before each practice bot action, so players can follow its play (phase moves about 0.6x, summons/sets/activations 1x, attacks 1.5x, plus jitter). Defaults to `900`; `0` makes the bot answer instantly inside the player's request |
| `DATABASE_PATH` | No | SQLite file path. Defaults to `./data/bot.sqlite`. Web and duel must open the same file |

## Docker

### Development (with hot reload)

```bash
docker compose --env-file .env --env-file packages/web/.env.local up -d --build
```

The tracked `docker-compose.override.yml` is auto-merged for local dev. It switches the web service to the `web-dev` target, enables polling-based file watching, and bind-mounts the source directories needed for HMR.

To reset local draft test data and reopen the SQLite-backed services against a fresh seed, run:

```bash
npm run reset:test-data
```

The seed uses the tracked offline catalog at `scripts/data/draft-catalog-legendary.json`, including in fresh checkouts and worktrees. Refresh that fixture deliberately with `npm run snapshot:draft-catalog`; ordinary seeding and tests do not fetch the catalog.

### Production

Use the `Deploy` workflow on `main` for image updates. It prepares and verifies the engine bundle
and installs it before recreating containers. To start already built images:

```bash
docker compose -f docker-compose.yml up -d
```

Production should always use the base file explicitly so local dev overrides are not loaded.

The stack runs 5 services:
- **worker** — Draft expiry, report approval, tournament deadlines, set sync and image eviction
- **ws** — Socket.IO WebSocket server for real-time draft updates
- **duel** — Private automated engine (`packages/duel-server/dist/server.js`, loopback 4003)
- **web** — Next.js 16 dashboard (standalone `packages/web/server.js`)
- **caddy** — Reverse proxy ([HTTPS and redirects](docs/deployment/vm-runbook.md#deployment-pipeline))

## Deployment

### VM Deployment (Hetzner / Any VPS)

The app runs on a VM via Docker Compose with Caddy as a reverse proxy. GitHub Actions deploys on every push to `main`.

**SSH access:** use the VM IP from the [runbook facts list](docs/deployment/vm-runbook.md#current-repository-state).

```bash
ssh -i ~/.ssh/hetzner_deploy root@YOUR_VM_IP
```

If you need to set or reset the root password after logging in:

```bash
passwd
```

**Quick setup:**
1. Create a VM (e.g., Hetzner CAX11, 4GB RAM, Ubuntu 24.04)
2. Install Docker and Git on the VM
3. Clone the repo to `/opt/yugioh-bot`
4. Configure [DNS, firewall](docs/deployment/vm-runbook.md#create-the-server), and the [production environment](docs/deployment/vm-runbook.md#create-env)
5. Configure production Clerk for the final app origin, Discord callback, invitation/email templates and legal links (see [runbook](docs/deployment/vm-runbook.md#clerk-configuration))
6. Add GitHub Actions secrets (`VM_HOST`, `VM_USER`, `VM_SSH_PRIVATE_KEY`, `VM_PORT`) and the public `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` repository variable
7. Follow the runbook's [first production start](docs/deployment/vm-runbook.md#build--run): run the
   `Deploy` workflow on `main` to build images and install the engine bundle. Later starts of
   already built images use `docker compose -f docker-compose.yml up -d` (without `--build`).

See the [VM runbook](docs/deployment/vm-runbook.md) for the full step-by-step guide.

**SSH into the production VM:**

```bash
ssh -i ~/.ssh/hetzner_deploy root@YOUR_VM_IP
```

Production uses HTTPS by default. Follow the [VM runbook](docs/deployment/vm-runbook.md#vm-setup-hetzner-cax11-or-similar) for domain setup and deployment.

## Quality Checks

```bash
npm test
npm run typecheck
npm run build
```

For focused duel checks, run `npx vitest run tests/host.test.ts` from `packages/duel-server`, or `npx vitest run tests/services/duels.test.ts` from `packages/shared`. Keep these runs package-scoped: root-level Vitest path filters can also collect copied tests inside local previews under `data/` and `.next/standalone/`.

## Backups

See the [runbook's Backups section](docs/deployment/vm-runbook.md#backups) for automatic backups and restore instructions.

## Project Structure

```
packages/
  bot/          Shelved Discord bot (build/tests retained)
  web/          Next.js web dashboard (App Router, TailwindCSS v4)
  ws/           Socket.IO WebSocket server (draft real-time updates)
  shared/       Shared library (database schema, services, types)
  duel-server/  Private Normal/Domain engine host: 1v1, Tag and FFA (canonical data in `data/duel-engine`)
  worker/       Scheduling worker and compiled owner ops CLI
  e2e/          Playwright duel tests on an isolated stack (ports 3300 family, `E2E_SLOT` for parallel runs; see packages/e2e/README.md)
```
