# Tournament Page Redesign — Design

**Date:** 2026-05-17
**Branch / worktree:** `worktree-tournament-page-redesign`
**Status:** Approved design, ready for implementation planning

## Overview

The public tournament page (`/tournament/[slug]`, e.g. `/tournament/d2vzqyb3`) is one
long vertical scroll: header → invite → all players → start/cancel → every round with
every match as a full-width card. For an active tournament (especially round-robin,
which has many matches) the page is tall and a player's own match is buried with no way
to filter to it. There is also no way to amend a wrongly-approved result, and reporting a
result does not notify the opponent — they only find out if they happen to have the page
open (websocket refresh).

This redesign delivers four things:

1. **Tabbed layout** replacing the single scroll.
2. **"Your matches" filter** (delivered as a dedicated tab + a pinned action card).
3. **Notify the opponent on report** so they can approve/deny.
4. **Misreport amendment** via a host "reopen match" action (round-robin only).

## Goals

- A player can see "what do I need to do right now?" without scrolling.
- A player can view only their own matches in one place.
- When a result is reported, the opponent is actively notified in Discord with working
  Approve/Deny controls.
- A wrongly-approved round-robin result can be corrected by the tournament host.

## Non-goals / Out of scope

- **Single-elimination reopen/amend stays exactly as today.** No post-approval amend for
  single-elim. The only recourse for single-elim remains the existing pre-approval Deny.
  No bracket rollback logic is built.
- No change to how rounds are generated, how standings are computed, or the casual
  (non-tournament) match flow.
- No change to the pending-tournament lobby behavior beyond it no longer being part of a
  tabbed shell (it already is a short page).
- No new auth model — existing NextAuth Discord session + `players.discord_user_id`.

## Current state (verified in code)

- Page: `packages/web/app/(app)/tournament/[slug]/page.tsx` (~549 lines, client
  component). Already receives `currentUserPlayerId`, `createdByUserId`, `participants`,
  `matches` (each with `roundNumber`, `playerOneId`, `playerTwoId`, `status`,
  `winnerId`, `reporterId`, `matchId`) and `isParticipant` from
  `GET /api/tournaments/[slug]`.
- Standings: separate route `packages/web/app/(app)/tournament/[slug]/standings/page.tsx`
  backed by `GET /api/tournaments/[slug]/standings`.
- Report: `POST /api/tournaments/[slug]/report/route.ts` — inserts a `matches` row
  (`status='pending'`), sets `tournament_matches.status='pending_approval'`, and only
  calls `notifyWsTournament` (no Discord notification).
- Approve/Deny: `POST /api/matches/[id]/approve/route.ts` and `.../deny/route.ts` →
  `createMatchService(db).approve/deny`. `deny` already resets the tournament match to
  `open` (pre-approval recovery path — unchanged). `approve` completes the tournament
  match and (single-elim) generates the next round / (round-robin) may complete the
  tournament.
- Bot announce server: `packages/bot/src/announce/server.ts` (`/internal/announce/*`),
  client helper `packages/web/src/lib/announce-bot.ts`. Existing kinds: draft-*,
  tournament-created, tournament-started.
- Bot already has Discord Approve/Deny buttons: `dashboard_approve:<matchId>` /
  `dashboard_deny:<matchId>` handled in `packages/bot/src/interactions/buttons.ts`
  (~lines 684–720), calling `deps.matches.approve/deny` + `notifyWsTournament`.
- Schema (`packages/shared/src/db/schema.ts`): `tournaments` has **no** channel column;
  `guild_settings.announce_channel_id` exists; `players.discord_user_id` and
  `players.display_name` exist; `matches` columns: id, guild_id, player_one_id,
  player_two_id, winner_id, reporter_id, approver_id, status, source, tournament_id,
  created_at, resolved_at. Migrations use `addColumnIfMissing` in `migrate(db)`.
- `leaderboard`/`stats` count only `status='approved'` matches — so a result that is
  set back to `denied` automatically drops out of standings.

---

## Part 1 — Tabbed layout

### Behavior by tournament status

- **Pending (lobby):** unchanged, **no tabs**. Invite link + copy + announce (host),
  players + open seats + progress, Join/Start, cancel. Nothing to tab through yet.
- **Active:** tab bar `Overview · My Matches · All Matches · Players · Standings`.
  Default tab = **Overview**.
- **Completed / Cancelled:** same tabs **minus the action card**, default tab =
  **Standings**.

The active tab is stored in the URL query (`?tab=overview|my|all|players|standings`) so
tabs are deep-linkable and the old standings link can land correctly. Unknown/absent
`tab` falls back to the status-appropriate default. Tab bar scrolls horizontally on
narrow screens.

### Tab contents

- **Overview** (active only has the action card):
  - **Your action card** (pinned, top): if you have an `open` match you're in →
    "Report result" with Win/Loss; if a match where you are the opponent is
    `pending_approval` → Approve / Deny inline. If nothing needs you, a calm "You're
    all caught up" state.
  - Tournament progress: round X of Y, N/M matches completed (derived client-side
    from the matches payload — no extra fetch).
  - Top-3 standings peek: fetched lazily from `GET /api/tournaments/[slug]/standings`
    (shared with the Standings tab — fetch once, cache in the shell), linking to the
    Standings tab. If standings haven't loaded yet, the peek shows a quiet skeleton
    rather than blocking Overview.
- **My Matches:** only matches where `currentUserPlayerId` is player one or two, across
  all rounds, grouped "Needs you" (open/your-turn) then "Done/Other". This is the
  **"your matches filter."** The tab label carries a **badge count** = number of items
  needing the user (your `open` matches + `pending_approval` matches where you are the
  opponent).
- **All Matches:** all matches grouped by round (current behavior). Completed rounds are
  **collapsed by default**; current/incomplete round expanded. Host-only "Reopen match"
  control on completed matches (Part 3).
- **Players:** existing player chips, host/you badges, host remove, your leave action.
- **Standings:** standings table rendered in-page, fed by the existing
  `GET /api/tournaments/[slug]/standings` data. The old route
  `/tournament/[slug]/standings` redirects to `/tournament/[slug]?tab=standings`.

### Component structure (refactor)

`page.tsx` is currently a 549-line client component doing data fetching, websocket
wiring, and all rendering inline. Split into a thin shell + focused components under
`packages/web/app/(app)/tournament/[slug]/` (or `packages/web/src/components/tournament/`,
matching the repo's existing component location convention — confirm during planning):

- `TournamentPage` (shell): fetch tournament + session, websocket subscription, decide
  lobby vs tabbed vs completed, own the active-tab state (synced to `?tab=`).
- `TournamentLobby` — pending state (invite/players/join/start/cancel), extracted as-is.
- `TabBar` — tab list + badge count, URL sync.
- `OverviewTab`, `MyMatchesTab`, `AllMatchesTab`, `PlayersTab`, `StandingsTab`.
- `YourActionCard` — the pinned report/approve/deny card (shared by Overview).
- `MatchCard` — extracted from current inline component; gains optional host "Reopen".
- `ReopenMatchButton` — host-only, round-robin, confirm dialog.

"My matches", badge count, and the action card are all derived **client-side** from data
already returned by `GET /api/tournaments/[slug]` (`currentUserPlayerId`, each match's
`playerOneId/playerTwoId/status/reporterId`). No new read API is required for Part 1.
`StandingsTab` fetches the existing standings endpoint on demand.

---

## Part 2 — Notify opponent on report

### Flow

When a result is reported via `POST /api/tournaments/[slug]/report` (after the pending
`matches` row and `tournament_matches.status='pending_approval'` are written):

1. The report route gathers: `guildId`, `slug`, `matchId`, `tournamentMatchId`,
   tournament `name`, `round_number` (from `tournament_matches`), reporter & opponent
   `discord_user_id` + `display_name` (from `players`), and the result phrasing
   (opponent won/lost).
2. It calls `announceToBot` with a **new kind** `match-report-pending`.
3. Bot handler `onMatchReportPending`:
   - Reads `guild_settings.announce_channel_id`. **If missing → no-op (graceful).**
   - Posts in that channel: pings `<@opponentDiscordId>` with a short line
     ("**{reporter}** reported: you **lost** Round 2 of **{tournament}** — approve?")
     and an action row with **Approve** / **Deny** buttons reusing the existing
     custom IDs `dashboard_approve:<matchId>` / `dashboard_deny:<matchId>`.
   - Writes the posted `channel_id` + `message_id` onto the `matches` row (new nullable
     columns `notify_channel_id`, `notify_message_id`).

### Auto-delete the notification

The ping is removed once the match is resolved, by either path:

- **Resolved via Discord button** (`dashboard_approve/deny` in `buttons.ts`): after
  resolving, if the match has stored notify ids, delete that message and clear the
  columns.
- **Resolved via web** (`approve`/`deny` API routes, including a later host reopen):
  the web route calls `announceToBot` with a **new kind** `match-resolved`
  `{ matchId }`; bot handler deletes the stored message and clears the columns.
- **TTL safeguard:** a lightweight periodic sweep in the bot deletes notify messages
  for matches that are resolved or older than a TTL but still have notify ids set
  (covers crashes / missed signals). Implement following the existing bot
  cleanup-service pattern (e.g. alongside `draft-cleanup`).

### Reuse / compatibility

- `dashboard_approve` / `dashboard_deny` handlers already resolve the match and call
  `notifyWsTournament`; they must work when triggered from a channel message button
  (not just the ephemeral dashboard). Verify they do not assume an ephemeral/dashboard
  origin; adjust the reply (e.g. update/acknowledge the channel message) as needed.
- Graceful degradation everywhere: if announce is unconfigured, the bot is down, or the
  channel post fails, the existing web flow is unaffected (the call is fire-and-forget,
  mirroring how `tournament-created`/`announce` already behave).

### Data model change

`addColumnIfMissing` in `migrate(db)` for `matches`:
- `notify_channel_id text` (nullable)
- `notify_message_id text` (nullable)

---

## Part 3 — Misreport amendment (host reopen, round-robin only)

### Behavior

On a **completed** match, the tournament **host** (`tournament.createdByUserId ===
session.user.id`) sees a "Reopen match" control (in `MatchCard`, surfaced in All Matches
and My Matches) with a confirm dialog.

- **Round-robin:** reopen voids the recorded result and lets the match be re-reported:
  - Set the resolved `matches` row `status='denied'` (keeps an audit trail; standings
    only count `approved`, so it drops out automatically).
  - Set `tournament_matches.status='open'`, `match_id=null`.
  - If the tournament had auto-completed (`tournaments.status='completed'` because this
    was the last RR match), set it back to `status='active'` and clear `ended_at`.
  - `notifyWsTournament({ kind: 'match-updated', slug })` so open pages refresh.
  - If the (already-resolved) notify message somehow still exists, the `match-resolved`
    cleanup applies; in practice it was deleted at first approval.
- **Single-elim:** **no reopen.** The host control is not shown for single-elim
  tournaments. If a reopen request reaches the API for a single-elim tournament it is
  rejected with a clear message ("Reopening results is only available for round-robin
  events").

### API + service

- New route: `POST /api/tournaments/[slug]/reopen` with body `{ tournamentMatchId }`
  (mirrors the existing `report` route's slug + body pattern). Validates session, that
  the caller is the tournament creator, that the tournament format is `round_robin`,
  and that the tournament match is `completed` with a `match_id`.
- Logic lives in the shared service layer (extend the tournament or match service with
  e.g. `reopenTournamentMatch({ tournamentId, tournamentMatchId, requesterPlayerId })`),
  so it is unit-testable without HTTP. Errors surface as thrown `Error`s mapped to 4xx
  by the route, matching the existing approve/deny route convention.

---

## Edge cases

- Reporter and opponent are the same / bye match: existing report route already rejects;
  notification is only attempted for real two-player matches.
- Opponent has no `discord_user_id` resolvable / not pingable: bot posts the message
  without a functional mention but still includes names and buttons (buttons are not
  identity-restricted beyond the existing `ensureOpponentCanResolve` check, which
  rejects a non-opponent who clicks).
- Result resolved on web before the bot finishes posting: the `match-resolved` signal
  may arrive before notify ids are stored — the TTL sweep cleans any orphan message.
- Reopen on a round-robin match whose opponent notification is long gone: no-op for the
  notification side; only the result/standings revert applies.
- Tab `?tab=` value invalid or for a tab not valid in the current status: fall back to
  the status default (Overview for active, Standings for completed).
- Pending tournament: no tabs, no action card, no reopen — unchanged lobby.

## Testing

- **Web (vitest, web config):**
  - Tab selection: status → default tab; `?tab=` deep link; old standings route
    redirects to `?tab=standings`.
  - "My Matches" filtering and badge count derivation from tournament payload.
  - Action card states: open→report, opponent+pending_approval→approve/deny, caught-up.
  - Reopen route: host + round-robin completed → success; non-host → 403; single-elim →
    rejected; non-completed → 400.
- **Shared (vitest):**
  - `reopenTournamentMatch`: RR completed → match `denied`, tournament_match `open`,
    standings drop the result, tournament un-completes when it had auto-completed;
    single-elim → throws; non-creator → throws.
- **Bot (vitest):**
  - `onMatchReportPending`: no announce channel → no-op; with channel → posts and
    persists notify ids.
  - Resolution (Discord button and `match-resolved`) deletes the notify message and
    clears columns; TTL sweep removes orphans.
- Existing report/approve/deny tests continue to pass (notification is additive and
  fire-and-forget).

## Affected files (indicative, finalized in the plan)

- `packages/web/app/(app)/tournament/[slug]/page.tsx` → split into shell + components.
- `packages/web/app/(app)/tournament/[slug]/standings/page.tsx` → redirect to tab.
- New: `packages/web/app/api/tournaments/[slug]/reopen/route.ts`.
- `packages/web/app/api/tournaments/[slug]/report/route.ts` → emit `match-report-pending`.
- `packages/web/app/api/matches/[id]/approve|deny/route.ts` → emit `match-resolved`.
- `packages/web/src/lib/announce-bot.ts` → add `match-report-pending`, `match-resolved`.
- `packages/bot/src/announce/server.ts` + handlers → new routes/handlers.
- `packages/bot/src/interactions/buttons.ts` → delete notify message on resolve.
- Bot cleanup service (new or alongside `draft-cleanup`) → TTL sweep.
- `packages/shared/src/db/schema.ts` → `notify_channel_id`, `notify_message_id` columns.
- `packages/shared/src/services/` → `reopenTournamentMatch`.
