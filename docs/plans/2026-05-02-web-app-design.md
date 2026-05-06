# YugiDraft Web App + Discord Bot Design

## Goal

Rebuild the Yu-Gi-Oh drafting and tournament experience as a Next.js 16 web app with real-time drafting via WebSockets, full tournament bracket tracking, YDK export, and a Discord bot that serves as a convenience layer — linking to the web for all interactive features.

## Design Context

See `.impeccable.md` for persisted brand, personality, and design principles.

**Three-word personality:** Competitive, focused, modern.

**Core principles:**
1. Speed over ceremony — every extra click between seeing a pack and picking a card is a failure
2. Live state is truth — WebSocket keeps the board current; stale state is a bug
3. Draft-room immersion — feels like sitting at a table, not filling out a form
4. Discord is the lobby — drafts start and notify through Discord; the web site is the play surface
5. Competitive clarity — card images, pick order, timer, and pool are always visible and unambiguous
6. Full parity — every feature works on web; bot is convenience, not requirement

## Architecture: Monorepo (Approach A)

Single repo, shared DB and services, three processes via Docker Compose.

```
yugioh-discord-bot/
├── src/
│   ├── bot/                    # Discord bot entry
│   │   ├── commands/           # Slash command definitions + handlers
│   │   ├── interactions/       # Button, select menu, modal handlers
│   │   └── index.ts            # Bot entry point
│   ├── web/                    # Next.js 16 App Router
│   │   ├── app/
│   │   │   ├── (auth)/         # Discord OAuth login/callback
│   │   │   │   ├── login/page.tsx
│   │   │   │   └── callback/page.tsx
│   │   │   ├── draft/[slug]/
│   │   │   │   ├── page.tsx            # Draft room
│   │   │   │   ├── lobby/page.tsx      # Pre-draft lobby
│   │   │   │   ├── pool/page.tsx       # Full pool viewer
│   │   │   │   └── summary/page.tsx    # Post-draft summary
│   │   │   ├── tournament/[id]/
│   │   │   │   ├── page.tsx            # Tournament detail + bracket
│   │   │   │   ├── standings/page.tsx  # Leaderboard
│   │   │   │   └── report/page.tsx     # Match reporting
│   │   │   ├── tournaments/
│   │   │   │   └── page.tsx            # Tournament list
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx            # Player dashboard
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx                # Home / redirect
│   │   ├── components/
│   │   │   ├── draft/          # CardGrid, PackDisplay, SeatList, PoolPanel, Timer, CardPreview
│   │   │   ├── tournament/     # BracketView, MatchCard, StandingsTable, ReportForm
│   │   │   └── ui/             # Button, Modal, Sheet, Badge (shadcn-style)
│   │   ├── lib/
│   │   │   ├── stores/        # Zustand stores (draft state, tournament state)
│   │   │   ├── hooks/         # SWR hooks, WebSocket hook
│   │   │   ├── ydk.ts         # YDK export logic
│   │   │   └── utils.ts
│   │   └── middleware.ts       # Auth check, guild verification
│   ├── shared/                 # Shared between bot and web
│   │   ├── db/                 # Schema, migrations, connection (WAL mode)
│   │   ├── services/           # Draft engine, card catalog, tournaments, matches
│   │   └── types/              # TypeScript types for all entities
│   └── ws/                     # Socket.IO server
│       ├── server.ts           # Socket.IO entry point
│       ├── rooms.ts            # Draft room management
│       └── events.ts           # Pick, rotate, timer, tournament events
├── public/
├── docker-compose.yml
├── Dockerfile.web
├── Dockerfile.bot
├── Dockerfile.ws
├── package.json                # Workspace root (turborepo)
├── turbo.json
└── tsconfig.json
```

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Web framework | **Next.js 16** App Router | RSC, API routes, latest features |
| Database | **SQLite (WAL mode)** → Postgres later | Same as bot, single-server deploy |
| Real-time | **Socket.IO** | Reconnects, rooms, binary compression, draft+tournament events |
| Auth | **NextAuth.js v5** with Discord provider | OAuth, guild check, session cookies |
| Styling | **Tailwind CSS v4** | Design tokens, responsive, dark-first |
| Fonts | **Russo One + Chakra Petch** (next/font) | Competitive gaming, preloaded |
| Icons | **Lucide React** | Consistent, tree-shakeable |
| Card images | **YGOPRODeck API** (cached on disk) | Same source as bot; served via next/image |
| Client state | **Zustand** | Lightweight, WebSocket writes to store |
| Server state | **SWR** | Draft metadata, tournament data |
| YDK export | **Client-side Blob download** | Parse passcodes into .ydk format |
| Deployment | **Docker Compose on GCE** | Same VM, add web + ws containers |

## Data Model Changes

New columns and tables for the web app:

```sql
-- Existing drafts table gains:
ALTER TABLE drafts ADD COLUMN web_slug TEXT UNIQUE;
-- web_slug: URL-safe ID for deep links (e.g. 'abc123')

-- Existing tournament tables gain:
ALTER TABLE tournaments ADD COLUMN web_slug TEXT UNIQUE;
ALTER TABLE tournaments ADD COLUMN bracket_json TEXT;
-- bracket_json: JSON blob for bracket state (matchups, winners, losers)

-- New: tournament_matches (if not already sufficient)
CREATE TABLE IF NOT EXISTS tournament_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  round INTEGER NOT NULL,
  match_index INTEGER NOT NULL,
  player1_id INTEGER REFERENCES tournament_players(id),
  player2_id INTEGER REFERENCES tournament_players(id),
  winner_id INTEGER REFERENCES tournament_players(id),
  status TEXT NOT NULL DEFAULT 'pending',
  reported_at TEXT,
  UNIQUE(tournament_id, round, match_index)
);
```

## Web App Screens

### 1. Draft Room `/draft/[slug]`

The core drafting experience. Real-time, immersive, competitive.

**Mobile (<640px):** Single column, sticky timer, 2-col card grid, collapsible pool bottom sheet.

**Tablet (640–1024px):** Two panels — cards left, pool/seats right.

**Desktop (>1024px):** Three panels — seats (left), pack display (center), pool (right).

**Card interaction:**
- Desktop: hover enlarges card to show full art + name + attribute + level + full effect text in a floating preview panel positioned adjacent (not overlapping). Click or press Enter to pick.
- Mobile: tap opens bottom sheet with full card detail (art, effect, stats) and "Pick this card" + "Back to pack" buttons.
- Keyboard: Tab through cards, 1-8 to highlight, Enter to confirm, Escape to dismiss.

**Timer bar:** Sticky on mobile, left-panel on desktop. Russo One, tabular-nums. Switches from `--text-primary` to `--accent-cta` (rose) under 10 seconds. Subtle pulse on last 5 seconds (respects prefers-reduced-motion).

**Seat list:** Current player highlighted with `--accent-primary` left border. Picked players show checkmark. Waiting players show pulse dot.

**Pick animation:** 150ms scale-up on confirmed card, then card slides into pool panel. Pack rearranges to fill gap.

**Waiting for others:** Dimmed pack, "Waiting for [Player]..." status, subtle loading pulse.

### 2. Draft Lobby `/draft/[slug]/lobby`

Pre-draft waiting room. Accessible while draft status is `pending`.

- Draft name, format settings (packSize, packsPerPlayer, pickSeconds)
- Custom timer field showing `pickSeconds` per pick
- Player list with Discord avatars and ready indicators
- Live updates via WebSocket when players join
- "Starts when creator begins..." status

### 3. Pool Viewer `/draft/[slug]/pool`

Full drafted pool with search, filter, and sort.

- Card list: image, name, type, attribute, level/rank
- Filter chips: Monster / Spell / Trap / Extra Deck
- Sort: Name, Type, Pick Order, Attribute
- YDK export button (always visible, not just at draft end)
- Available during and after the draft

### 4. Post-Draft Summary `/draft/[slug]/summary`

- Final pool with YDK export
- Pick-by-pick expandable timeline
- Type breakdown stats (Monsters/Spells/Traps)
- "Return to Discord" button

### 5. Tournament List `/tournaments`

- Active and pending tournaments for the user's guild
- Quick join buttons
- Deep links to tournament detail pages

### 6. Tournament Detail `/tournament/[id]`

- Tournament info: name, format (round robin / single elim), status
- **Bracket view** (single elimination): visual bracket with match cards
- **Round robin view**: standings table with W/L records
- Match reporting: select opponent, report win/loss
- Opponent approval flow on web
- Link back to Discord if preferred

### 7. Player Dashboard `/dashboard`

- Your active drafts (with deep links to draft rooms)
- Your active tournaments (with deep links to brackets)
- Lifetime stats (wins, losses, win rate)
- Recent match history
- Quick links: Start a draft, Create a tournament

### 8. Match Reporting `/tournament/[id]/report`

- Select opponent from active tournament matches
- Report win or loss
- Shows pending approvals needing your response
- Approval/denial buttons

## Discord Bot Integration (Revised)

The bot keeps ALL existing commands as convenience — every action also works on the web.

| Bot Command | Behavior | Web Link |
|-------------|----------|----------|
| `/draft start` | Creates draft in DB, posts deep link to channel | `https://yugidraft.com/draft/abc123` |
| `/draft cancel` | Cancels draft, updates web via WS | N/A |
| `/draft join` | Adds player (or they click the deep link) | Same deep link |
| `/duel @player result:win` | Reports casual match, links to web for details | `https://yugidraft.com/dashboard` |
| `/approve` | Approves pending match, links to web | `https://yugidraft.com/tournament/xyz/report` |
| `/deny` | Denies pending match | Same |
| `/stats` | Shows stats in Discord, links to web dashboard | `https://yugidraft.com/dashboard` |
| `/rankings` | Shows leaderboard in Discord, links to web | `https://yugidraft.com/tournaments` |
| `/event dashboard` | Opens ephemeral Discord dashboard, all buttons link to web | Deep links per feature |
| `/event create` | Creates tournament, posts deep link | `https://yugidraft.com/tournament/xyz` |
| `/event signup` | Posts signup with Join button + web link | Web signup link |
| `/event start` | Starts tournament, posts bracket link | `https://yugidraft.com/tournament/xyz` |

**Key rule:** The bot does NOT send "draft completed" messages. Draft completion is shown in the web UI only.

**Bot changes from current code:**
- Remove Discord pick UI (numbered buttons, ephemeral pickers, pool viewers)
- Remove card image generation via sharp for Discord
- Add deep links to every bot response
- Bot responses become shorter: command result + "View on web: <link>"
- `/draft start` posts: "Draft starting! Pick cards here: <link>"

## WebSocket Events

| Direction | Event | Payload |
|-----------|-------|---------|
| Server → Client | `draft:state` | Full board state (pack, picks, timer, seats) |
| Server → Client | `draft:pick` | Who picked, which card, remaining pack |
| Server → Client | `draft:rotate` | New pack after rotation, next player alert |
| Server → Client | `draft:timer` | Countdown tick (every second) |
| Server → Client | `draft:complete` | Draft finished, pool summary |
| Server → Client | `tournament:update` | Bracket update, match result |
| Server → Client | `tournament:match` | New match needing attention |
| Client → Server | `pick:card` | Player picks a card |
| Client → Server | `refresh:state` | Request full state resync |
| Client → Server | `tournament:report` | Report match result |
| Client → Server | `tournament:approve` | Approve/deny pending result |

## Auth Flow

1. Bot posts deep link in Discord: `https://yugidraft.com/draft/abc123`
2. User clicks → Next.js checks session → no session → redirects to Discord OAuth
3. Discord OAuth callback → NextAuth verifies identity, checks guild membership
4. Sets HttpOnly session cookie → redirects to original deep link
5. Draft room verifies user is a draft participant before allowing picks
6. For tournaments: any guild member can view brackets; only participants can report matches

## YDK Export Format

Cards sorted into sections by type:

```
#main
12345678
23456789
...
#extra
34567890
...
#side
45678901
...
```

- Main Deck monsters, Spells, and Traps → `#main`
- Extra Deck monsters (Fusion, Synchro, XYZ, Link) → `#extra`
- Side Deck cards → `#side` (future feature; currently empty)
- Export available during and after draft
- Client-side Blob download, no server round-trip needed

## Draft Timer Settings

`/draft start` command options (also configurable on web lobby page):

```
/draft start name:FridayNight pack_size:8 packs_per_player:5 pick_seconds:60
```

Defaults: `packSize: 8`, `packsPerPlayer: 5`, `pickSeconds: 45`, `alternatePassDirection: true`, `randomizeSeats: false`.

Custom timer is shown in the draft lobby and in the draft room timer bar.

## Design System Tokens

| Token | Value | Notes |
|-------|-------|-------|
| `--bg-deep` | `#0A0E1A` | Near-black with blue undertone |
| `--bg-surface` | `#141929` | Card/panel backgrounds |
| `--bg-elevated` | `#1E2440` | Hover/active states |
| `--text-primary` | `#E8ECF4` | High contrast on dark (10:1+) |
| `--text-secondary` | `#8892B0` | Muted labels, timestamps |
| `--accent-primary` | `#7C3AED` | Purple — primary action, your turn |
| `--accent-secondary` | `#A78BFA` | Purple light — pick focus |
| `--accent-cta` | `#F43F5E` | Rose — timer warning, confirm |
| `--accent-gold` | `#F59E0B` | Gold — card rarity, featured picks |
| `--accent-success` | `#10B981` | Green — confirmed picks, completed |
| `--border` | `#2A3150` | Subtle borders between panels |
| `--font-display` | `Russo One` | Headings, timer, seat numbers |
| `--font-body` | `Chakra Petch` | All other text (6 weights) |
| `--radius-md` | `8px` | Cards, buttons |
| `--radius-lg` | `12px` | Panels, modals |
| `--shadow-card` | `0 2px 8px rgba(0,0,0,0.3)` | Default card shadow |
| `--shadow-hover` | `0 4px 16px rgba(124,58,237,0.2)` | Hover glow |

**Anti-patterns (do NOT use):**
- No glassmorphism on dark backgrounds
- No emoji icons — Lucide SVG only
- No `#FFFFFF` backgrounds
- No gradient text for "impact"
- No monospace font as lazy shorthand
- No bounce/elastic easing — use ease-out-quart only

## Responsive Breakpoints

| Breakpoint | Layout | Card Grid | Pool |
|-----------|--------|-----------|------|
| `<640px` | Single column, stacked | 2 columns | Collapsible bottom sheet |
| `640–1024px` | Two panels — cards left, pool/seats right | 3 columns | Right panel |
| `>1024px` | Three panels — seats, cards, pool | 4 columns | Right panel |

**Touch targets:** Minimum 44×44px on all interactive elements.

**Keyboard controls:** 1-8 to highlight card, Enter to confirm, Escape to cancel, Tab/Shift+Tab to navigate.

**Accessibility:** `prefers-reduced-motion` respected (skip animations, use opacity crossfade). All card images have `alt` text. Focus states visible for keyboard nav.

## Deployment: GCE Docker Compose

```yaml
services:
  bot:
    build:
      context: .
      dockerfile: Dockerfile.bot
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./card-images:/app/card-images
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      - NEXTAUTH_URL=https://yugidraft.com
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET}
    volumes:
      - ./data:/app/data
      - ./card-images:/app/card-images
    restart: unless-stopped

  ws:
    build:
      context: .
      dockerfile: Dockerfile.ws
    ports:
      - "3001:3001"
    env_file: .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

Same GCE VM, same GitHub Actions SSH deploy, add Caddy reverse proxy for HTTPS on the domain.

## Migration Path (Incremental)

1. **Scaffold monorepo** — Restructure src/ into bot/, web/, shared/, ws/. Keep bot running.
2. **Shared services** — Move DB, draft engine, card catalog, tournaments into shared/.
3. **Web auth** — NextAuth Discord OAuth, session middleware, guild verification.
4. **Draft lobby + room** — Lobby page, Socket.IO connection, state hydration, pack display, pick interaction.
5. **Card serving** — Next.js API route for YGOPRODeck images with caching.
6. **Bot deep links** — Update bot responses to include web URLs. Remove Discord pick UI.
7. **Tournament pages** — List, bracket, reporting, standings.
8. **Dashboard** — Player stats, active drafts/tournaments, match history.
9. **YDK export** — Client-side .ydk download.
10. **Caddy + domain** — HTTPS, production deploy.

Each step ships incrementally. The bot stays running throughout.