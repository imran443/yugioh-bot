# Tournament Timing & Report Enforcement — Design (Spec A)

**Date:** 2026-05-20
**Status:** Design for review
**Scope:** Spec A. The draft tribute filter (Spec B) is done. The player stats
dashboard (Spec C) is a separate, later spec.

## Goal

Make async, multi-day tournaments actually finish by adding two timer-driven
mechanisms:

1. **Report-confirm auto-approve** — once a player reports a match result, the
   opponent has a bounded window to approve/deny; if they don't, it
   auto-confirms in the reporter's favor.
2. **Whole-tournament deadline auto-close** — a tournament can carry an optional
   end date; when it passes, the tournament closes using results so far
   ("close as-is"), leaving any unfinished matches unresolved.

Both are driven by a single new bot poller and reuse existing approve / complete
/ announce code paths.

## Background (current behavior)

- A reported match is inserted with `status='pending'` and the claimed
  `winner_id` already set (`matches.report`, matches.ts:215). The opponent must
  actively `approve` (matches.ts:253) or `deny` (matches.ts:271). There is **no
  timeout** today — a pending report can sit forever.
- `approve` sets `status='approved'`, `approver_id`, `resolved_at`, then calls
  `completeTournamentMatch`, which advances/auto-completes the tournament.
- Tournaments (`tournaments` table, schema.ts:27) have no deadline; they only
  complete when every match resolves.
- A 1-second poller pattern already exists: `draft-timer.ts`
  (`createDraftTimerService`), wired and `.start()`ed in `bot/src/index.ts`.
- Tournament-completed announcements already exist and are race-safe via the
  `tournaments.completed_announced_at` claim column.

## Decisions (locked via brainstorming)

- Cadence: **async over days**.
- Deadline scope: **whole tournament** (one end date), resolution **close
  as-is**.
- Confirm window: **per tournament**, default **24h** when unset.
- Config model: both fields **optional + host-editable**.
- Edit surface: **web only** (Discord `/event create` can set them at creation;
  no bot edit command).
- Reminders/nudges and per-match coordination threads: **out of scope**.

## Architecture

```
                    ┌──────────────────────────────┐
                    │  bot tournament-timer (60s)   │
                    │  (new: tournament-timer.ts)   │
                    └───────────────┬───────────────┘
            auto-confirm overdue    │   auto-close overdue
            pending tourney matches │   active tournaments
                    ┌───────────────┴───────────────┐
                    ▼                                ▼
        matches.autoApprove(id)            tournaments.closeForDeadline(id)
        → reuse approve SQL                → status='completed', ended_at
        → completeTournamentMatch          → (no force-confirm of pendings)
        → deleteNotifyMessage              │
        → notifyWsTournament               │
        → (if tourney done) announce ──────┴──→ announceTournamentCompleted
                                                 (race-safe claim)
```

The poller is the only new runtime component. Everything it calls is either an
existing function or a thin new service function. Storage of the two config
values lives on the `tournaments` row.

## Data model

Add two nullable columns to `tournaments` using the existing
`addColumnIfMissing` pattern in `migrate()` (schema.ts; mirrors the existing
`web_slug` / `completed_announced_at` additions):

- `deadline_at TEXT` — ISO timestamp; `NULL` = no deadline (never auto-closes).
- `report_confirm_window_hours INTEGER` — `NULL` = use the default (24).

Extend the `Tournament` type (`packages/shared/src/types/index.ts`) and
`mapTournament` (tournaments.ts:27):

```ts
export interface Tournament {
  id: number;
  guildId: string;
  name: string;
  format: "round_robin" | "single_elim";
  status: "pending" | "active" | "cancelled" | "completed";
  createdByUserId: string;
  webSlug?: string;
  deadlineAt?: string;            // ISO; undefined = no deadline
  reportConfirmWindowHours?: number; // undefined = default (24)
}
```

A shared constant `DEFAULT_REPORT_CONFIRM_HOURS = 24` is the single source of the
default; the effective window is `reportConfirmWindowHours ?? DEFAULT_REPORT_CONFIRM_HOURS`.

No new column on `matches`: the confirm window start is the existing
`matches.created_at` (set to `current_timestamp` at report time); the deadline is
computed as `created_at + effectiveWindowHours`.

## Shared services

### `tournaments` service (tournaments.ts)

- **`create`** gains an optional 5th argument:
  ```ts
  create(
    guildId: string, name: string, format: TournamentFormat, createdByUserId: string,
    options?: { deadlineAt?: string | null; reportConfirmWindowHours?: number | null },
  ): Tournament
  ```
  Existing callers (bot handler, web route, tests) keep working unchanged; the
  INSERT includes the two new columns when provided, else `NULL`.

- **`updateSettings(tournamentId, patch)`** (new):
  ```ts
  updateSettings(
    tournamentId: number,
    patch: { deadlineAt?: string | null; reportConfirmWindowHours?: number | null },
  ): Tournament
  ```
  Updates only the provided keys. Throws if the tournament is `completed` or
  `cancelled` (editing a finished event is meaningless). Allowed while `pending`
  or `active`.

- **`closeForDeadline(tournamentId)`** (new):
  ```ts
  closeForDeadline(tournamentId: number): Tournament
  ```
  Sets `status='completed', ended_at=current_timestamp` **only if** currently
  `active` (idempotent/no-op otherwise). Does NOT touch unfinished matches
  (close as-is). Returns the updated tournament.

- **`findOverdueActive(now)`** (new, for the timer):
  ```ts
  findOverdueActive(now: string): Tournament[]
  ```
  Returns `active` tournaments with non-null `deadline_at <= now`.

### `matches` service (matches.ts)

- **`autoApprove(matchId)`** (new): same UPDATE as `approve` but with no
  opponent permission check and `approver_id = NULL` (the null approver is the
  audit signal that resolution was automatic). Sets
  `status='approved', resolved_at=current_timestamp`, then calls the existing
  `completeTournamentMatch(match)`. Returns the updated `Match`.

- **`findOverduePendingConfirmations(now)`** (new, for the timer): returns
  pending tournament matches whose confirm window has elapsed. SQL joins
  `matches` → `tournaments`:
  ```sql
  select m.* from matches m
  join tournaments t on t.id = m.tournament_id
  where m.status = 'pending'
    and m.source = 'tournament'
    and m.tournament_id is not null
    and t.status = 'active'
    and datetime(m.created_at,
        '+' || coalesce(t.report_confirm_window_hours, 24) || ' hours') <= :now
  ```
  (24 literal kept in sync with `DEFAULT_REPORT_CONFIRM_HOURS`.) The
  `t.status = 'active'` clause ensures we stop auto-confirming a tournament's
  matches once it has closed (consistent with "close as-is" — see Edge cases).

Casual matches (`source='casual'`, `tournament_id` null) are excluded — their
behavior is unchanged.

## Bot timer service

New `packages/bot/src/services/tournament-timer.ts`,
`createTournamentTimerService(deps)`, mirroring `draft-timer.ts`:

- `deps`: `{ tournaments, matches, onMatchAutoResolved(match), onTournamentClosed(tournament) }`
  where the two callbacks (provided by `index.ts`) handle Discord cleanup +
  announcement + ws notify, keeping discord.js out of the shared services.
- `tick(now = new Date())`:
  1. For each match in `matches.findOverduePendingConfirmations(nowIso)`:
     `matches.autoApprove(match.id)` → `await onMatchAutoResolved(updated)`.
     If that match's tournament is now `completed`, `onMatchAutoResolved` also
     announces completion (race-safe claim).
  2. For each tournament in `tournaments.findOverdueActive(nowIso)`:
     `tournaments.closeForDeadline(t.id)` → `await onTournamentClosed(closed)`.
  3. Each iteration wrapped in try/catch + `console.warn` so one failure can't
     stall the loop (same defensive pattern as draft-timer).
- `start()` uses `setInterval(tick, 60_000)`; `stop()` clears it; one initial
  `tick()` at startup then `start()` (mirrors index.ts:381 for the draft timer).

`onMatchAutoResolved` (in index.ts) reuses: `deleteNotifyMessage(match)` (the
existing approval-message cleanup), `notifyWsTournament({ kind: "match-resolved", slug })`,
and the existing completion-announce path (with the `completed_announced_at`
claim) when the tournament finished. `onTournamentClosed` reuses the completion
announce + `notifyWsTournament`.

## Surfaces

### Web — create

- `create-tournament-form.tsx`: add an optional **deadline** input
  (`<input type="datetime-local">`) and an optional **confirm window (hours)**
  number input. Submit them (as ISO string + integer) only when filled.
- POST `/api/tournaments` (route.ts): accept optional `deadlineAt` (ISO) and
  `reportConfirmWindowHours` (integer); validate (see Validation) and pass to
  `tournaments.create`.

### Web — edit (host only)

- PUT `/api/tournaments/[slug]` (route.ts:177): extend beyond the current
  name-only/pending-only behavior to also accept `deadlineAt` and
  `reportConfirmWindowHours`, allowed while `pending` or `active`, creator-only,
  via `tournaments.updateSettings`. (Name editing stays pending-only as today.)
- A small host-only "Tournament settings" edit control on the tournament page
  (e.g. an inline form/modal in the existing host area) to set/clear both
  fields. Shows current values; clearing the deadline sets it to `NULL`.

### Bot — create

- `/event create` (`definitions.ts:40`, `handlers.ts:453`): add two optional
  integer options — `confirm_hours` and `deadline_days` (days-from-now; Discord
  has no datetime option type). Handler converts `deadline_days` → ISO
  (`now + N days`) and passes both into `tournaments.create`. No bot edit
  command (web-only edits, per decision).

## Validation

- `reportConfirmWindowHours`: integer, `1 ≤ h ≤ 720` (30 days). Reject otherwise.
- `deadlineAt` (web): parseable ISO datetime and **in the future** at set time;
  reject past/invalid. Clearing (empty) → `NULL`.
- `deadline_days` (bot): integer `≥ 1`.
- `updateSettings` enforces the same field validation as create.

## Edge cases

- **Report just before the deadline:** if the confirm window would extend past
  the tournament deadline, the deadline wins. Tournament close is "as-is" and
  does **not** force-confirm pending matches. Because
  `findOverduePendingConfirmations` filters on `t.status = 'active'`, once a
  tournament closes its still-`pending` matches are simply left unresolved and
  never auto-confirmed — so no auto-approve can ever fire against a closed
  tournament and there is no risk of resurrecting a finished bracket.
- **Tick ordering:** auto-confirms are processed before deadline closes within a
  tick, so a match whose window genuinely elapsed is resolved (and can complete
  its tournament naturally) before any deadline sweep considers that tournament.
- **Idempotency:** `closeForDeadline` only acts on `active`; `autoApprove` only
  acts on `pending`. A duplicate tick can't double-resolve.
- **No deadline / no window:** null deadline never closes; null window uses 24h.
- **Bye / already-completed tournament_matches:** untouched — the timer only
  queries `matches` rows in `pending` and `active` tournaments.
- **Clock:** all timer functions take an injected `now` for deterministic tests.

## Testing

**Shared (vitest):**
- `matches.autoApprove`: pending tournament match → approved, `approver_id` null,
  `resolved_at` set, `completeTournamentMatch` effects (e.g. round advances /
  tournament completes).
- `matches.findOverduePendingConfirmations`: with a fake `now`, returns only
  matches past `created_at + window`; respects per-tournament window and the 24h
  default; excludes casual and non-pending matches.
- `tournaments.create` with options; `updateSettings` (partial patch, rejects
  completed/cancelled, validation); `closeForDeadline` (active→completed,
  no-op otherwise, leaves matches untouched); `findOverdueActive`.
- Migration test: new columns present (extend the shared-db schema table/column
  test).

**Bot (vitest):**
- `tournament-timer.tick`: seed a pending tournament match past its window →
  asserts `autoApprove` called + `onMatchAutoResolved` invoked; seed an active
  tournament past `deadline_at` → asserts `closeForDeadline` + `onTournamentClosed`;
  a try/catch test where one item throws and the loop continues. (Mirror the
  structure of `draft-timer.test.ts`.)
- `/event create` handler: passes `confirm_hours` / `deadline_days` through to
  `create` (converted correctly).

**Web (vitest):**
- POST `/api/tournaments`: accepts + validates `deadlineAt` /
  `reportConfirmWindowHours`; rejects past deadline and out-of-range window.
- PUT `/api/tournaments/[slug]`: edits both while active, creator-only,
  rejects on completed.

## Out of scope (YAGNI)

- Reminders/nudges before deadlines; per-match coordination threads; per-match
  or per-round deadlines.
- Bot edit command for the settings (web-only edits).
- Auto-resolution of unplayed matches at the deadline (we close as-is).
- Casual-match confirm timeouts.
- The player stats dashboard (Spec C).

## Suggested implementation phasing

The plan can be split into two independently shippable phases sharing the schema
+ timer scaffolding:
1. **Report-confirm timeout** (schema window column, `autoApprove`,
   `findOverduePendingConfirmations`, timer + bot wiring, create/edit window
   field).
2. **Tournament deadline** (deadline column, `closeForDeadline`,
   `findOverdueActive`, timer branch, create/edit deadline field).
