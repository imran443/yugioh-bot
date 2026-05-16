# My Cubes Grid Polish Design

## Goal

Polish the card grid used by `My Cubes` so both `/cubes/new` and `/cubes/[id]` behave like an edit surface instead of a preview surface. Card art should render more sharply, hovering should not open or imply preview behavior, and left-clicking a card should remove one copy from the local cube state.

## Current Context

`packages/web/src/components/cards/card-pool-grid.tsx` is a shared grid component that currently:

- renders searchable, filterable, sortable card tiles
- uses hover and focus to open `CardHoverPopup`
- uses click to open a dismissible tap preview when no click handler is provided
- prefers `imageUrlSmall || imageUrl` for tile art

`packages/web/src/components/cubes/card-pool-editor.tsx` already uses this grid with `onCardClick` so cube pages can remove cards. The remaining issues are presentation and interaction details specific to the cube editing workflow.

## Approved Approach

Use a cube-editor-specific mode on the existing `CardPoolGrid` instead of creating a second grid component.

This keeps filtering, sorting, quantities, loading states, and unknown-passcode placeholders in one place while letting cube pages opt into different interaction and image behavior.

## Component Design

### `CardPoolGrid`

Add a minimal prop that enables cube-edit behavior.

In cube-edit mode:

- left-click uses the existing `onCardClick` path to remove a card
- hover preview is disabled
- click/tap preview is disabled
- hover-emphasis styling is removed from the tile
- the grid prefers the larger image URL when available so visible card art is sharper

Outside cube-edit mode, the current preview behavior remains unchanged.

### `CardPoolEditor`

`CardPoolEditor` opts the grid into cube-edit mode for both create and edit pages:

- `/cubes/new`
- `/cubes/[id]`

The editor continues to own all pool mutation rules, including:

- removing one copy at a time
- preserving duplicate quantities until removed
- converting set-backed pools to explicit passcodes when needed

## Data Flow

The data model does not change.

Interaction flow in cube-edit mode:

1. The user left-clicks a card tile.
2. `CardPoolGrid` calls `onCardClick(card)` without opening any preview popup.
3. `CardPoolEditor` removes one visible copy from local editor state.
4. The grid re-renders with updated quantities.
5. Saving continues to persist through the existing draft-template API routes.

Image selection flow in cube-edit mode:

- prefer `card.imageUrl`
- fall back to `card.imageUrlSmall`
- keep the existing broken-image fallback state

## Visual Behavior

Cube-edit tiles should look interactive for removal, but not like hover-preview triggers.

That means:

- no hover popup
- no hover background shift that suggests preview affordance
- keep focus-visible styling for accessibility
- preserve quantity badges and card names exactly as they work today

The intent is that cube pages feel like a direct editing surface while other card-grid surfaces continue to feel like a browser/preview surface.

## Error Handling

- If the preferred large image is missing or fails, fall back to the existing image error placeholder.
- If only the small image exists, still render it rather than dropping the card tile.
- Unknown passcode placeholders remain unchanged because they are not image-backed cards.

## Testing

Add focused tests before implementation for cube-edit mode:

- hovering a cube-edit tile does not open `CardHoverPopup`
- clicking a cube-edit tile does not open the tap preview popup
- clicking a cube-edit tile still calls the supplied remove handler
- cube-edit mode prefers the larger image URL over `imageUrlSmall`

Keep existing cube editor tests covering:

- remove-one-copy behavior
- duplicate quantity display updates
- set-backed pool conversion on save

Non-cube grid tests should continue to verify the existing preview behavior so the new mode does not regress the rest of the app.

## Out Of Scope

This polish change does not add:

- a new cube-specific grid component
- alternate preview gestures such as right-click preview
- new card metadata overlays
- changes to draft-room or non-cube card grid interactions
