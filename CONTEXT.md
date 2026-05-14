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

**Announcement**:
A Discord message posted by the bot into a guild's announce channel containing the tournament's name, format, current participant count, organizer mention, and a link to the **Invite link**. Triggered manually by the **Organizer** via an "Announce in Discord" button.

**Kick**:
The **Organizer**'s removal of a **Participant** from a **pending** Tournament. Distinct from **Leave**, which is participant-initiated.

**Leave**:
A **Participant**'s self-removal from a **pending** Tournament. Available to all participants, including the **Organizer**.

## Relationships

- A **Tournament** has exactly one **Organizer**.
- A **Tournament** has zero or more **Participants**. By default, the **Organizer** is auto-joined as a **Participant** at create time.
- An **Organizer** may **Leave** the participant list (becoming a non-playing host) while the **Tournament** is **pending**.
- Any **Participant** may **Leave** a **pending** **Tournament**; the **Organizer** may **Kick** any other **Participant**.
- A **Tournament** can only start when it has at least 2 **Participants**; the Start affordance is disabled below that threshold.

## Flagged ambiguities

- "Player" was used informally to mean both the broader `players` table row (a Discord user known to the bot) and a **Participant** in a tournament — resolved: **Player** = `players` row; **Participant** = `tournament_participants` row referencing a player in the context of one tournament.
