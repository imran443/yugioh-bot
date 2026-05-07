# Draft Pool Panel List and Filter Design

## Goal

Make the active draft room's right-side `Your Pool` panel useful during the draft itself by showing drafted cards directly in the rail instead of hiding them behind a secondary full-pool view.

## Problem

The current pool panel only shows counts and actions. A player can see how many monsters, spells, and traps they have drafted, but they cannot quickly inspect the actual card names without opening a separate sheet. That slows decision-making during live picks and makes the right rail feel less tactical than the rest of the draft room.

## Chosen Direction

Use an always-visible tactical list inside the existing right rail.

- Keep the current total drafted summary and type-count tiles.
- Add a compact local search input.
- Add local type pills for `All`, `Monsters`, `Spells`, and `Traps`.
- Render a fixed-height scrollable list of drafted cards directly in the panel.
- Preserve `Export YDK`.
- Reuse the same controls and list inside the mobile sheet.

This keeps the room dense, competitive, and easy to scan without adding new routes, new API calls, or a second browsing mode.

## Rejected Alternatives

### Expandable section inside the panel

This keeps the existing compact summary and reveals the card list only when expanded. It saves some vertical space, but it hides useful draft information behind another click and weakens the "always live" feel of the room.

### Modal-only full pool browsing

This keeps the existing right rail mostly unchanged and relies on the full-pool sheet for card visibility. It is the smallest UI change, but it does not solve the main problem that the drafted pool is not visible while actively drafting.

## Layout

### Desktop

- Keep the current `Your Pool` panel shell.
- Preserve the drafted-total summary block and the three type-count tiles.
- Add a search input under the summary area with placeholder text `Filter cards...`.
- Add a filter row with four pill buttons: `All`, `Monsters`, `Spells`, `Traps`.
- Show a stable-height scrollable list under the filters so the panel height does not grow with the pool.
- Keep `Export YDK` as the bottom action.
- Remove `View Full Pool` if the always-visible list makes it redundant.

### Mobile

- Keep the existing bottom-sheet entry point.
- Inside the sheet, show the same summary, search, filters, and card list so the interaction model matches desktop.

## Interaction Model

- Search matches `card.name` only.
- Search and type filters are local and instant; no server requests.
- Search and type filters combine.
- Default state is `All` with an empty search term.
- Preserve existing `myPool` ordering unless the data is already naturally most-recent-first.
- Summary counts are based on the full pool, not the filtered list.

## List Row Design

Each row should stay compact and readable in a narrow rail.

- Left: small type badge using `M`, `S`, or `T`.
- Center: card name as the primary label.
- Optional secondary text can show the full type string if it still fits cleanly.

The visual treatment should stay aligned with the existing draft-room style: dark surfaces, crisp borders, strong active-state contrast, and no decorative chrome.

## Empty States

- If `myPool` is empty: `No cards drafted yet.`
- If filters produce no matches: `No cards match this filter.`

## Implementation Scope

- Limit the main behavior change to `packages/web/src/components/draft/pool-panel.tsx`.
- Keep using `myPool` from the draft store.
- Add local UI state for search and active type filter.
- Use `useDeferredValue` for the search term so typing remains responsive as the list grows.
- No API, websocket, or persistence changes are required.

## Testing Strategy

Add component coverage for `PoolPanel` to verify:

1. Empty pool messaging.
2. Summary counts for monsters, spells, and traps.
3. Name-based filtering.
4. Type-pill filtering.
5. Combined search plus type filtering.

Manual verification should confirm:

1. The desktop right rail shows a visible scrollable drafted-card list.
2. The mobile sheet exposes the same search/filter/list UI.
3. `Export YDK` still works.
4. The three-column active draft layout does not overflow at desktop widths.

## Success Criteria

- Players can inspect drafted card names directly from the right rail while drafting.
- Players can narrow the visible list by card name and type without leaving the active room.
- The panel remains dense and tactical rather than expanding into a second full-page browser.
- Mobile and desktop behaviors remain consistent.
