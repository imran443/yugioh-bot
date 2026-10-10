# YugiDraft

A Discord-first Yu-Gi-Oh draft, tournament, and duel platform. Discord is the lobby; the web dashboard is the draft room, tournament view, and duel table.

## Language

### Drafts

**Host stop / Cancelled draft**:
Under the owner rule of 2026-10-09, a host stop cancels the whole draft: null and void. Players must do a new draft. Cancel discards every pick and gives no decks, exports or tournament. There is no End now action to keep picks. See `docs/api/draft-host-end.md` for the API and the unchanged automatic pool-exhaustion paths.

**Cube**:
A reusable, guild-owned draft configuration and card pool. Stored in `cubes` with optional explicit `cube_cards` entries split into `main` / `extra` pools and per-card `max_copies`. Supplies shared booster-style drafts or a player's private pool in a **Theme draft**. Bot template commands also save cubes.
_Avoid_: Theme (for the saved resource)

**Theme draft**:
A draft with `DraftConfig.mode === "theme"` where each player picks privately from an assigned **Cube**. `allowedCubeIds` lists available cubes; `draft_player_cube` stores player assignments. The mode and UI still use "theme"; the saved resource is a **Cube**.

### Tournaments

**Tournament**:
A bracketed competition between players, with one of a fixed set of **Formats** (currently Round Robin or Single Elimination). Owned by a single Discord guild.
_Avoid_: Event, competition

**Organizer**:
The Discord user who created a **Tournament**. Stored as `created_by_user_id`. Has rights to start, cancel, and manage it. May also be a **Participant** (default), but can leave the participant list if hosting only.
_Avoid_: Creator, host, admin

**Participant**:
A player registered to play in a **Tournament**. Stored in `tournament_participants`. Distinct from **Organizer** — an organizer is a participant by default but can opt out.
_Avoid_: Player (reserved for the broader `players` table identity), entrant, competitor

**Format**:
The bracket structure of a **Tournament**. Currently `round_robin` or `single_elim`. Determines how matches are generated when the tournament starts.

**Pending / Active / Completed / Cancelled**:
A **Tournament**'s lifecycle status. `pending` = accepting participants; `active` = bracket generated, matches in progress; `completed` = final match resolved; `cancelled` = aborted by organizer.

**Invite link**:
A shareable URL based on the tournament's `web_slug` (e.g., `/tournament/abcd1234`). Under the web access policy documented in `CLAUDE.md`, signed-in members of the configured Discord guild can join while the tournament is **pending**. Not rotatable — if leaked, cancel and recreate.

**Kick**:
The **Organizer**'s removal of a **Participant** from a **pending** Tournament. Distinct from **Leave**, which is participant-initiated.

**Leave**:
A **Participant**'s self-removal from a **pending** Tournament. Available to all participants, including the **Organizer**.

### Duels

**Table**:
One automated duel room, from lobby to result, with a web slug. Hosted by the private duel host and stored in the duel tables of SQLite. Players or bots take its **Seats**; other guild members may spectate public tables.
_Avoid_: Game, room (in code and docs)

**Seat**:
One duelist position at a **Table**, numbered from 0 in turn order. A seat holds a human or a practice bot. In Tag, seat % 2 is the team (seats 0 and 2 against 1 and 3).

**Table format**:
The seat layout of a **Table**: `1v1` (default), `tag` (2v2, shared team LP), `ffa3` or `ffa4` (free-for-all, one LP each). Chosen at creation and fixed. Distinct from a tournament **Format**. The rules are in `docs/adr/0002-multiplayer-duel-rules.md`.

**Standard / Domain**:
The two duel modes. **Standard** uses stock rules with a Master Rule preset. **Domain** adds the Domain Format mechanics, a **Deck Master** and its own deck rules. Both work at every **Table format**.

**Deck Master**:
A Domain-only monster in its own zone, set apart from the Main Deck. It can be recalled and summoned again, with a surcharge. Standard tables have none.

**Preset**:
A scripted starting board for hand scenarios and e2e runs (`packages/duel-server/src/presets/`). The `list-presets` and `start-preset` host operations exist only when `DUEL_SCENARIOS=1`. Not a Master Rule preset.

**Engine**:
The wasm core that runs a **Table**. Compose defaults Standard 1v1 to the **pinned** merged engine (`DUEL_STANDARD_1V1_ENGINE=pinned`) and Domain 1v1 to **legacy** (`DUEL_1V1_ENGINE=legacy`). Native runs with no Standard override use the global choice, which defaults to legacy. Each game of a series reads the switch at its start. A 1v1 game saves its engine, so recover and replay use it after either switch changes. Tag and FFA tables always use a **multi core** (`ocgcore.multi.wasm`, or `ocgcore.multi-domain.wasm` for Domain). See `docs/deployment/duel-engine-switch.md`.

### Notifications

**Announcement**:
A Discord message the bot posts into a guild's announce channel about a **Draft** or **Tournament** lifecycle event. Triggered _automatically_ (draft/tournament created, started, completed) or _manually_ by the **Organizer** via an "Announce in Discord" button. For a tournament it carries the name, **Format**, current participant count, organizer mention, and a link to the **Invite link**. User-visible; the manual trigger surfaces success/failure back to the Organizer.
_Avoid_: notification (reserved — see **Broadcast**)

**Broadcast**:
A real-time state push to the WebSocket server (relayed to browser clients in a **Draft**, **Tournament**, or **Duel** room) about a state change — a pick, resync, seat update, status, completion, or duel invalidation. HTTP/network failures are swallowed (some callers await delivery); no user-visible Discord message. Distinct from an **Announcement**.
_Avoid_: announcement, event

## Relationships

- A **Tournament** has exactly one **Organizer**.
- A **Tournament** has zero or more **Participants**. By default, the **Organizer** is auto-joined as a **Participant** at create time.
- An **Organizer** may **Leave** the participant list (becoming a non-playing host) while the **Tournament** is **pending**.
- Any **Participant** may **Leave** a **pending** **Tournament**; the **Organizer** may **Kick** any other **Participant**.
- A **Tournament** can only start when it has at least 2 **Participants**; the Start affordance is disabled below that threshold.

## Flagged ambiguities

- "Player" was used informally to mean both the broader `players` table row (a Discord user known to the bot) and a **Participant** in a tournament — resolved: **Player** = `players` row; **Participant** = `tournament_participants` row referencing a player in the context of one tournament.
