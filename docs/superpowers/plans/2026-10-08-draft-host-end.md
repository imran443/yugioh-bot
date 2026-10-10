# Draft host termination implementation plan

> Superseded on 2026-10-09 by the owner rule: a host stop cancels the whole draft. The end route and `endNow` are removed. The entries below record the old implementation, not the current contract. See `2026-10-09-draft-cancel-only.md` and `../../api/draft-host-end.md`.

**Goal:** Let hosts and app owners end an active draft or cancel a pending/active web draft.

**Architecture:** Reuse `completeDraft` and `cancel` inside immediate SQLite transactions. Add small terminal functions without changing pick/pass rotation. Web routes share guild-scoped authorization and post-commit notification through existing broadcasters and announcers.

**Stack:** TypeScript, better-sqlite3, Next.js App Router, Vitest; Node 22.

- [x] Inspect schema, shared lifecycle, `/draft cancel`, cleanup, timers, web routes and linked tournaments on fetched `origin/main`.
- [x] Add failing lifecycle tests in `packages/shared/tests/services/draft-terminal.test.ts` for lobby, uneven picks, theme/Extra, rollback, idempotence, bot/manual picks and tournament behavior.
- [x] Implement `endNow` and guarded, idempotent cancellation in `packages/shared/src/services/drafts.ts`, reusing completion/deck saving and lobby disarming.
- [x] Add failing route tests in `packages/web/tests/drafts-terminal-routes.test.ts` for host/non-host access, community isolation, response and broadcast contracts.
- [x] Initial Discord admin override superseded by review: revert `b5424fa38` and authorize the host or `isOwnerUser(actor.userId)` per the accepted Clerk alpha policy.
- [x] Add dedicated `POST /api/drafts/[slug]/end` and `/cancel` with a shared handler and existing WS `status`/Discord notifications.
- [x] Add concurrent SQLite connection tests against manual picks, bot picks and expiry; test stale snapshots and terminal behavior in both deployed worker and shelved bot timers.
- [x] Run only affected test files and TypeScript checks for shared/web/bot/worker; review the final changes. Initial validation: 242 targeted tests passed; four TypeScript checks passed; production/staging Compose validation passed.
- [x] Document the UI API contract in `docs/api/draft-host-end.md`, including the current auth/timer architecture and host-or-owner authorization.

## Review follow-up

Execute the supplied review fixes in this worktree, using new commits on the same branch and a normal push.

- [x] Reproduce the owner authorization, private-draft disclosure, double DELETE, linked-tournament error, and pending-end bugs with failing tests.
- [x] Revert all ten files from `b5424fa38` exactly, removing the Discord helpers/tests and web token configuration.
- [x] Use synchronous host-or-owner authorization in `src/lib/draft-terminal-api.ts`; apply `draftReadAccess` to other actors before returning 403.
- [x] Make DELETE retain cancelled drafts and map `DraftTerminalError` to its 409 response in `app/api/drafts/[slug]/route.ts`.
- [x] Reject pending `endNow` in the shared service with `DRAFT_NOT_STARTED`, preserving lobby state and schedules.
- [x] Verify the pick route's actual bot loop against end/cancel on another SQLite connection.
- [x] Run targeted tests and TypeScript checks for shared, web, worker and bot under Node 22 with core dumps disabled.
- [x] Review the complete diff, including the revised worker test for a rejected pending end preserving its countdown.

Follow-up validation: 742 targeted tests passed (shared 235, web 468, bot 27, worker 12), including `admin-removal.test.ts` and both bot-loop interleavings. All four `tsc --noEmit` checks passed. The web suite uses `--maxWorkers=2` to avoid a cold-import timeout under parallel suite load.

Delivery steps: commit each logical change with the requested trailers, push without PR/merge, then remove generated/dependency directories from the worktree.
