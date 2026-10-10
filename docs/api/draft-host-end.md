# Draft host cancellation

## Owner rule (2026-10-09)

When a host stops a draft early, the whole draft is cancelled: null and void. All players must do a new draft. The stopped draft cannot give decks, exports or a tournament. There is no host action to keep partial picks.

`POST /api/drafts/{slug}/end` and the shared `drafts.endNow` method are removed. This rule replaces the early-end feature from PR #312. No database migration is needed.

This patch does not change existing completed records or saved decks. The old early-end method stored no flag to distinguish its results from normal completion. Any such records still use completed-draft deck, export and tournament flows; a data repair needs a separate owner decision.

## HTTP contract

| Action | Method and route | Body | Successful status |
| --- | --- | --- | --- |
| Cancel a pending or active draft | `POST /api/drafts/{slug}/cancel` | None | `cancelled` |

The route uses the current Clerk web session and looks up the slug in configured `DISCORD_GUILD_ID`. Only the host or owner can cancel: the host has `draft.created_by_user_id === actor.userId`; an owner passes `isOwnerUser(actor.userId)` through `OWNER_USER_IDS`. They do not need linked Discord accounts. An owner can cancel a private draft without a seat.

For other actors, the route checks `draftReadAccess` before it denies the action. An unreadable private draft returns 404. A readable draft returns 403. There is no Discord permission lookup or web `DISCORD_TOKEN` requirement.

Success is HTTP 200:

```json
{
  "id": 123,
  "name": "Friday draft",
  "webSlug": "example-slug",
  "status": "cancelled",
  "changed": true,
  "pickDeadlineAt": null,
  "tournamentId": null
}
```

A repeated cancellation returns 200 and `changed: false`. It keeps the draft record and roster. A completed draft cannot be cancelled. Cancellation also refuses a live draft with a legacy or manual tournament link. Notification failures do not undo a committed cancellation or make its HTTP result fail.

| HTTP status | Meaning / JSON body |
| --- | --- |
| 401 | No authenticated session: `{ "error": "unauthorized" }` |
| 403 | Actor can read the draft but is neither host nor owner: `{ "error": "Only the host or owner can cancel a draft" }` |
| 404 | Draft is missing, belongs to another community, or is unreadable: `{ "error": "Draft not found" }` |
| 409 | Draft is completed: `{ "error": "Draft is already finished", "code": "DRAFT_ALREADY_FINISHED" }` |
| 409 | Live draft has a tournament link: `{ "error": "Draft has a linked tournament", "code": "DRAFT_HAS_TOURNAMENT" }` |
| 503 | Session resolution unavailable: `{ "error": "session_unavailable" }` |
| 500 | Unexpected database or server failure: `{ "error": "Failed to finish draft" }` |

`GET /api/drafts/{slug}` now gives the optional hint `canCancel: true` to the host or an owner. Other viewers do not get the field. It replaces `canEndOrCancel`. The route still checks access; the hint does not grant access.

## Stored state and live updates

Cancellation keeps its existing immediate SQLite transaction. It discards picks, passes, dealt cards, packs, undealt/deal data and theme claims. It resets player progress, clears the pick deadline and disarms lobby starts. It keeps the draft record and roster for access and the cancelled room.

Cancelled drafts cannot export a deck, create saved draft decks or create tournament participation and season awards. The pick and timer guards refuse further work on them.

After a changed cancellation commits, the route sends `{ kind: "status", slug, status: "cancelled" }` and `{ kind: "resync", slug, packRound, pickStep }`. The WS service sends `draft:status` and `draft:resync` to the room. A channel-backed draft also requests the existing Discord `draft-status` update. It sends no `draft-completed` announcement. Repeated requests send no new notices.

## DELETE and Discord behavior

`DELETE /api/drafts/{slug}` is unchanged. The creator can cancel a live draft with DELETE. That first DELETE keeps its record and roster. A later DELETE removes a completed or cancelled draft. Use POST `/cancel` for safe cancellation retries.

Discord `/draft cancel` remains creator-only and calls the same shared cancellation method. Bot cleanup and owner account tools do not complete a draft. The WS service only sends events; it does not write draft status. Bot and worker timers use normal pick expiry and check terminal state.

## Other partial-pool completion paths (unchanged)

The audit found existing automatic completion paths in `packages/shared/src/services/drafts.ts`. They are not host stop controls. Per this task's scope, they remain unchanged:

- `settleThemeRound` completes when all remaining theme rounds deal no packs. A thin Main or Extra pool, burned cards or copy limits can leave fewer picks than requested. The last `pickThemeCard` round also completes when all dealt players have picked; some other players may have exhausted their pools.
- `settleBoosterStep` advances a wave when no card is pickable or its rotation stays stuck. At the last configured wave, it completes with the committed pools, which can be smaller than the requested pick target.

These paths call `completeDraft`, which saves decks. A draft with that completed status can use the existing tournament creation flow. Manual/Discord picks and bot/worker expiry can reach them. Changing these rules requires a separate owner decision. There is no other host or admin command to force partial completion.

## Browser UI

The page reads `canCancel` and passes it to the lobby and room controls. The draft room shows one "Cancel draft" button in the room bar for the host or an owner. It opens a typed `cancel` confirm (`packages/web/src/components/draft/room/cancel-confirm.tsx`). The confirm says the draft is void, nobody keeps cards, and the players must start a new draft.

- `packages/web/src/lib/draft-terminal-client.ts` sends only `POST /api/drafts/[slug]/cancel` (`requestDraftCancel`). It has no end action.
- The WebSocket hook calls `onHostStopped` only for `"cancelled"`. Other players see the "The draft was cancelled" notice.
- There is no End now choice and no Host menu in the draft room.

The tournament sheet's separate End now action controls tournaments and is outside this draft task.

## Validation scope

Run only the touched service, concurrency, bot timer, worker timer, web cancellation route, pick race, visibility and page test files. Build shared first, then check shared and web types. Use Node 22.23.3 and `prlimit --core=0`.
