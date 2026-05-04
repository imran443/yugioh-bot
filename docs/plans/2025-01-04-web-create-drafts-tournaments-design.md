# Web Draft & Tournament Creation + Settings Design

**Date:** 2025-01-04  
**Status:** Approved

## Overview

Allow authenticated web users to create drafts and tournaments from the web UI. The bot can also create tournaments from Discord. Web-created drafts/tournaments use the guild's real `guild_id` and `channel_id` (from env or user selection). The bot posts announcements to Discord channels based on per-guild settings.

## Approved Decisions

1. **Guild/Channel resolution** — Use real `DISCORD_GUILD_ID` and default channel from env. Users can override the channel via Discord API dropdown.
2. **Players auto-creation** — When a web user creates or joins a draft/tournament, auto-create a `players` row using `DISCORD_GUILD_ID` and their Discord display name.
3. **Bot announcements** — Per-guild settings control whether the bot announces draft/tournament events. Configurable from the web Settings page.
4. **Set browsing** — Full set browser with search, preview, and card images. Aggressive caching to avoid YGOPRODeck rate limits.

## Section 1: Web Draft & Tournament Creation

- `DISCORD_GUILD_ID` from env is the default guild for all web-created drafts/tournaments
- `DISCORD_DEFAULT_CHANNEL_ID` (or existing `DISCORD_REMINDER_CHANNEL_ID`) is the default channel for draft announcements
- Users can override the channel by picking from a dropdown populated via Discord API (`GET /guilds/{guild_id}/channels`)
- When a web user creates or joins, auto-create a `players` row: `(guild_id=DISCORD_GUILD_ID, discord_user_id=session.user.id, display_name=session.user.name)` if one doesn't exist
- All existing service code works as-is since we use real guild/channel IDs

## Section 2: Settings Page (Per-Guild Bot Announcements)

New `guild_settings` table:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| guild_id | text PK | — | FK to guilds |
| announce_draft_created | integer | 1 | Announce new drafts |
| announce_draft_started | integer | 1 | Announce draft start |
| announce_draft_completed | integer | 1 | Announce draft completion |
| announce_tournament_created | integer | 1 | Announce new tournaments |
| announce_tournament_completed | integer | 1 | Announce tournament completion |
| announce_channel_id | text | NULL | Override channel for announcements |

UI: Toggle panel for each announcement type + channel selector dropdown (from Discord API). Only visible to guild admins.

Bot behavior: Before posting, check `guild_settings`. If toggle is off, skip announcement. If `announce_channel_id` is set, post there; otherwise use `DISCORD_DEFAULT_CHANNEL_ID`.

## Section 3: Create Draft Flow (Web UI)

**Page:** `/drafts/new`

**Form fields:**
- Name (required)
- Channel (optional dropdown from Discord API, default from env)
- Sets (required, multi-select with browse/preview)
- Pack size (default 8)
- Packs per player (default 5)
- Pick timer seconds (default 45)
- Alternate pass direction (toggle, default on)
- Randomize seats (toggle, default off)

**Set browse/preview UX:**
- Type-to-search autocomplete using `listSets(query)`
- Selected sets show card count + sample card images
- "Browse all sets" modal with search, scroll, and card preview grid
- New API routes: `GET /api/sets` (list/search), `GET /api/sets/[name]/preview` (card count + sample images)

**Flow:**
1. User fills form, submits
2. `POST /api/drafts` auto-creates `players` row if needed (guild_id from env, discord_user_id from session)
3. Calls `createDraft(db, guildId, channelId, name, config, createdByUserId, creatorPlayerId)`
4. If `announce_draft_created` enabled, bot posts announcement to selected channel
5. Redirect to `/draft/[slug]`

## Section 4: API Caching Strategy for YGOPRODeck

- **Sets are fully cached** — `syncSets()` runs once (manually or on startup), stores all set names in `card_sets` table. Browse/search API queries DB only, never hits YGOPRODeck live.
- **Set previews are cached** — Check `card_catalog` for that set's cards. If cached, serve from DB. If not, fetch from YGOPRODeck once, cache all cards, serve from DB going forward.
- **Rate limiting** — Never fetch more than 1 set per second. Queue/deduplicate concurrent requests for the same uncached set.
- **`GET /api/sets/[name]/preview`** — Returns `{ name, cardCount, cached: boolean, sampleCards: [...] }`. If not cached, triggers background sync of that set only.
- **`card_sets` table expansion** — Add `card_count` column (populated after sync) so we can show "250 cards" without querying the catalog each time.

## Create Tournament Flow (Web UI)

**Page:** `/tournaments/new`

Similar to draft creation — name, channel dropdown, format selector. Auto-create player row. Bot announces if enabled.

## Outstanding Items

- Guild settings API routes (`GET /api/settings`, `PUT /api/settings`)
- Guild channel list API route (`GET /api/discord/channels`)
- Create tournament form page (`/tournaments/new`)
- Bot integration: announce draft/tournament events based on guild settings
- Expand `card_sets` schema: add `card_count` column
- Rate-limited set sync queue for preview fetches

## Previously Completed

- Nav bug fixes (sidebar overlap + double-active state)
- Shared `navItems` extraction
- `/api/drafts` route
- Full `/drafts` page with 4 status sections
- Shared `DraftCard` and `TournamentCard` components
- Docker hot-reload dev setup (`web-dev` stage + override)
- 37 tests passing (sidebar, mobile-drawer, ydk)