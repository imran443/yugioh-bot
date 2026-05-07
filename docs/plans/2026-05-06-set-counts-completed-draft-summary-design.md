## Overview

Fix two related draft UX issues:

1. Set search and set browser currently show `0 cards` because seeded local data repopulates `card_catalog` but does not repopulate filtered set counts.
2. When a draft completes, the active draft page can remain on the live-room layout and show an empty waiting state instead of a real completed summary with the participant's final pool.

The goal is to make both views read from stable server-backed data so refresh, revisit, and local reset all behave consistently.

## Goals

- Show draft-eligible card counts in the set dropdown and set browser after our filters are applied.
- Move completed drafts to a dedicated summary screen rather than leaving users on the live draft room.
- Show the participant's full drafted pool directly on the completed summary screen.
- Ensure users who revisit a completed draft later see the same summary screen again.

## Non-Goals

- Redesign the entire draft creation flow.
- Add cross-user pool visibility for non-participants.
- Add raw vendor set counts alongside filtered counts.

## Current Problems

### Set counts

The set picker and set browser render `set.cardCount`, which comes from `card_sets.card_count` via `/api/sets`. The seed flow clears and repopulates `card_catalog` from the local snapshot but does not repopulate `card_sets`, so the UI has incomplete metadata and falls back to `0`.

### Completed draft end state

The draft page chooses between pending, active, and summary layouts based on `draft.status`. In practice, completion can still leave the user looking at the live-room shell while the client store contains no current pack, producing the `Waiting for pack...` state from the active page. Even when the summary view renders, it only shows metadata and export actions, not the participant's full drafted pool inline.

## Chosen Approach

Use server-backed completed-summary rendering and snapshot-derived filtered set counts.

This keeps the data model deterministic and aligned with the offline local snapshot flow already adopted for draft testing. It avoids live API dependencies, ensures counts are stable after `npm run reset:test-data`, and makes completed draft revisits behave the same as the first completion transition.

## Data Design

### Filtered set counts

- Treat `card_sets.card_count` as the number of draft-eligible cards for that set after our filters, not the vendor's raw set size.
- Derive per-set counts from the same local snapshot data used to seed `card_catalog`.
- Seed both `card_catalog` and `card_sets` together during local reset so `/api/sets` returns meaningful counts immediately.
- Keep set preview counts consistent with the same filtered counts.

### Completed draft payload

- Expand completed draft responses to include the participant's final drafted pool when the viewer participated in the draft.
- Keep non-participant views safe by not returning another player's pool.
- Continue returning summary metadata such as players, pick counts, config, and completion timestamps.

## Page Rendering Design

- `pending` drafts render the manage view.
- `active` drafts render the live draft room.
- `completed` and `cancelled` drafts render the summary view.
- The summary view must render from server response data, not from the transient live draft store.
- A revisit to the same completed draft URL should render the same completed summary screen with the participant's final pool.

## Completed Summary UX

The completed summary screen should show:

- Draft title and completed status.
- Completion timestamp.
- Players and pick counts.
- Draft configuration and selected sets.
- The participant's full drafted pool inline on the page.
- YDK export when eligible.

The full drafted pool should no longer be hidden behind a secondary action as the primary way to inspect results. The page should feel like an end-of-draft recap, not a degraded live state.

For non-participants:

- Show the same summary shell.
- Do not show a personal pool section or export action.

## UI Direction

Use the existing visual language but make the completed screen feel deliberate and archival rather than temporary.

- Keep the current dark competitive aesthetic.
- Promote the final pool section to a first-class content block.
- Make card counts and deck composition easy to scan.
- Preserve mobile usability for revisits.

The implementation plan should incorporate `ui-ux-pro-max` and `frontend-design` guidance for the finished summary presentation.

## Resume Behavior

Closing and reopening during an active draft should continue to work as it does now because the page refetches draft state from the server on load. The completion change should improve the terminal state only: once the server marks the draft completed, the user should land on summary data rather than an empty active-room shell.

## Testing Strategy

Add coverage for:

- Filtered set counts seeded from snapshot data.
- Set search and set browser rendering non-zero filtered counts.
- Completed draft responses including the participant pool.
- Completed draft page rendering the full pool on initial load.
- Completed draft page rendering the same summary on later revisit.
- Non-participant completed views not exposing another player's pool.

## Risks

- If filtered counts are derived incorrectly, the UI may show misleading set sizes.
- If completed summary rendering still depends on live store state, the waiting-screen regression can remain.
- If completed payloads mix active-only and summary-only fields loosely, future UI branching can become brittle.

## Mitigations

- Derive set counts from the same snapshot source as seeded cards.
- Keep the completed summary driven by server data only.
- Add route and component tests that load completed drafts directly instead of only simulating in-session transitions.
