# Active Draft Room Design

## Goal

Redesign the active draft screen so it feels like a competitive esports draft room: the current pack owns the screen, set context is always visible, and the seeded demo draft shows meaningful cards immediately instead of a blank center stage.

## Design Context

See `.impeccable.md`.

This screen is for competitive Yu-Gi-Oh players drafting in organized Discord communities. The experience should feel sharp, focused, and modern, with functional density over decorative chrome. The draft room must feel live and tournament-grade, not like a generic dashboard.

## Problem Summary

The current active draft room has two related issues:

1. The main card stage collapses when websocket state has not yet populated `currentPack`, leaving the entire center of the screen visually empty.
2. The seeded demo draft has valid draft data in SQLite, but the UI does not hydrate any initial pack or pool state from the API, so the screen looks broken even though seeded content exists.

This creates a false impression that the draft has no cards and causes the title and side panels to appear squished into a narrow middle band.

## Chosen Direction

Use an arena-style three-zone layout with a dominant center stage.

- Left rail: timer, pack metadata, live players/seats
- Center stage: draft title, set chips, current-pack header, large responsive card grid, empty/live sync state
- Right rail: pool summary, export actions, total drafted count

This preserves the current information architecture while making the pack itself the visual priority.

## Rejected Alternatives

### Compact command-center

This would compress all metadata into a dense top bar and put the card grid below it. It would save space, but it weakens the sense of a draft table and does not solve the “dead center” feeling as clearly.

### Broadcast-style showcase

This would introduce a feature card hero and more dramatic framing. It could look distinctive, but it adds design overhead and risks fighting the “competitive tool” direction.

## Layout Plan

### Desktop

- Use a wider center column with explicit min/max sizing so the card stage dominates the screen.
- Keep two fixed-width side rails, but reduce their visual weight.
- Move draft title and set chips into the center column above the pack.
- Add a compact pack-status strip above the grid showing:
  - pack number
  - pick number
  - turn status
  - card count remaining

### Tablet

- Stack the left rail above the center stage.
- Keep the pool panel pinned as the right-side block beneath or beside the pack depending on width.
- Preserve card size and reduce dead margin before collapsing columns.

### Mobile

- Keep timer and seats at the top.
- Keep the pack stage directly under the status area.
- Continue using the bottom pool trigger, but make the center pack layout feel intentional rather than inherited from desktop.

## Data Strategy

### Initial hydration

The API should return enough active-draft state for a seeded or server-rendered demo to show cards before websocket events arrive.

For active drafts, the API response should include:

- `currentPack`: the current player’s available pack options from the shared draft service
- `myPool`: the current player’s already-picked cards, if any
- `seats`: seat metadata with current player and picked-state information for the current step
- `pickSeconds`, `timerSeconds`, `isMyTurn`, `packRound`, `pickStep`

The page should hydrate the Zustand draft store from this initial payload immediately after fetch.

### Websocket truth

Websocket state remains authoritative once connected. Initial hydration exists to avoid blank state and to make seeded/demo drafts usable before realtime catches up.

### Demo set visibility

Surface `draft.config.setNames` directly in the active draft header as compact competitive chips. If the seeded draft config does not yet include meaningful set names, the seed script should populate them for the demo draft.

## Visual Treatment

- Dark, tournament-client look
- Crisp border hierarchy
- Minimal use of accent purple/gold for active state only
- No glassmorphism or decorative gradients
- Stronger card sizes and tighter horizontal rhythm
- Headline and pack state aligned left for competitive clarity

## Component Changes

### `app/(app)/draft/[slug]/page.tsx`

- Extend the fetched draft payload type to include active draft-room state.
- Hydrate the draft store from API data before websocket updates arrive.
- Recompose the active layout so the center stage gets the most width.

### `components/draft/card-grid.tsx`

- Increase layout flexibility and card prominence.
- Add a proper empty/live-sync state when `currentPack` is empty.
- Support a denser but larger responsive grid.

### `components/draft/timer-bar.tsx`

- Present timer as competitive status rather than a generic standalone card.
- Keep GPU-safe animation and clear urgent states.

### `components/draft/seat-list.tsx`

- Improve seat readability and current-player emphasis.
- Ensure this panel works as part of the “table state” rail.

### `components/draft/pool-panel.tsx`

- Keep the right rail compact, tactical, and scannable.
- Preserve existing actions, but better align them to the arena-style layout.

### `app/api/drafts/[slug]/route.ts`

- Reuse the shared draft service to compute current pack and pool information for active drafts.
- Return initial draft-room state in a shape the frontend can write into the store.

## Seeded Demo Improvements

The seeded active demo draft should include:

- real set names in `config.setNames`
- a valid active pack state already visible from the API

This makes `/draft/legendary-draft` useful as a stable product demo even when websocket timing is imperfect.

## Testing Strategy

1. Add API-level regression coverage for active draft payload hydration if test coverage exists around draft routes.
2. Add component tests for the active draft room fallback state and set chip rendering where practical.
3. Re-run the full web test suite after layout and seed updates.

## Success Criteria

- `/draft/legendary-draft` shows visible set chips and pack content immediately after load.
- The active draft screen no longer feels visually collapsed when websocket state is late.
- The card stage clearly dominates the layout on desktop.
- The experience feels like a competitive draft client, not a sparse dashboard.
