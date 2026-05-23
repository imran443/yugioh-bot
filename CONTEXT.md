# YugiDraft

A Discord-first Yu-Gi-Oh draft and tournament platform. Discord is the lobby; the web dashboard is the draft room and tournament view.

## Language

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
A shareable URL based on the tournament's `web_slug` (e.g., `/tournament/abcd1234`). Any signed-in Discord user who opens the link can join while the tournament is **pending**. Not rotatable — if leaked, cancel and recreate.

**Kick**:
The **Organizer**'s removal of a **Participant** from a **pending** Tournament. Distinct from **Leave**, which is participant-initiated.

**Leave**:
A **Participant**'s self-removal from a **pending** Tournament. Available to all participants, including the **Organizer**.

### Notifications

**Announcement**:
A Discord message the bot posts into a guild's announce channel about a **Draft** or **Tournament** lifecycle event. Triggered _automatically_ (draft/tournament created, started, completed) or _manually_ by the **Organizer** via an "Announce in Discord" button. For a tournament it carries the name, **Format**, current participant count, organizer mention, and a link to the **Invite link**. User-visible; the manual trigger surfaces success/failure back to the Organizer.
_Avoid_: notification (reserved — see **Broadcast**)

**Broadcast**:
A fire-and-forget real-time state push to the WebSocket server (relayed to browser clients in a **Draft** or **Tournament** room) about a state change — a pick, resync, seat update, status, or completion. No user-visible Discord message; no result is awaited. Distinct from an **Announcement**.
_Avoid_: announcement, event

## Relationships

- A **Tournament** has exactly one **Organizer**.
- A **Tournament** has zero or more **Participants**. By default, the **Organizer** is auto-joined as a **Participant** at create time.
- An **Organizer** may **Leave** the participant list (becoming a non-playing host) while the **Tournament** is **pending**.
- Any **Participant** may **Leave** a **pending** **Tournament**; the **Organizer** may **Kick** any other **Participant**.
- A **Tournament** can only start when it has at least 2 **Participants**; the Start affordance is disabled below that threshold.

## Flagged ambiguities

- "Player" was used informally to mean both the broader `players` table row (a Discord user known to the bot) and a **Participant** in a tournament — resolved: **Player** = `players` row; **Participant** = `tournament_participants` row referencing a player in the context of one tournament.
