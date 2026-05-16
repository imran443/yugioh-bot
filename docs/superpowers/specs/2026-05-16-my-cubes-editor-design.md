# My Cubes Editor Design

## Goal

Add a dedicated `My Cubes` area for managing saved card pools. Users should be able to open a saved pool, import a passcode text file or pasted passcode text, view the resolved cards in a grid, remove cards one copy at a time, and explicitly save changes.

## Current Context

The app already has saved card pools backed by `draft_templates`. Existing UI pieces include:

- `packages/web/src/components/settings/card-pool-manager.tsx` for listing, creating, editing, and deleting saved pools inside Settings.
- `packages/web/src/components/cards/pool-builder.tsx` for set selection, custom passcode text input, and card preview resolution.
- `packages/web/src/components/cards/card-pool-grid.tsx` for searchable/filterable/sortable card grid display.
- `packages/web/app/api/draft-templates/route.ts` for listing and creating saved pools.
- `packages/web/app/api/draft-templates/[id]/route.ts` for updating and deleting saved pools.
- `packages/web/src/lib/nav-items.ts` plus `Sidebar` and `MobileDrawer` for app navigation.

The approved product language for now is still `saved pools` / `card pools`. The new left-navigation entry is named `My Cubes` because that is the user-facing destination before editing a pool.

## Approved Approach

Use approach 1: add a new `My Cubes` list page and a dedicated edit page.

Do not create a separate backend entity for cubes. Reuse the existing saved pool data model and API routes. The new pages are a more focused editing workflow over the same saved pools.

## Navigation

Add a new left-nav item:

- label: `My Cubes`
- route: `/cubes`
- active state should cover `/cubes` and `/cubes/[id]`

The item should appear with the main app navigation next to Dashboard, Tournaments, Drafts, and Settings. It must also appear in the mobile drawer because both desktop and mobile navs consume the shared nav item list.

## `/cubes` List Page

The list page shows all existing saved pools from `/api/draft-templates`.

Each saved pool card should show:

- pool name
- imported passcode count from `customCardIds.length`
- set count from `setNames.length`
- custom passcode count from `customCardIds.length`

Clicking a saved pool card opens `/cubes/[id]` for that pool. A small explicit delete action can be included if it follows the existing confirmation pattern, but deletion is not the core v1 requirement.

Empty state should explain that saved pools created elsewhere will appear here.

## `/cubes/[id]` Editor Page

The editor page is focused on one saved pool.

Required behavior:

- Load the selected saved pool by id from the existing saved-pool list response.
- If the id does not exist, show a not-found or clear error state.
- Maintain local unsaved editor state for the pool name, selected sets, and custom passcodes.
- Show an explicit `Save Changes` button.
- Show an unsaved-changes indicator when local state differs from the loaded saved pool.
- Save through `PUT /api/draft-templates/[id]`.

The first implementation can keep set editing minimal if needed. Normal card-removal edits must not discard existing `setNames`. Import replacement is the one exception because importing a passcode file intentionally replaces the cube source.

## Import Behavior

Import supports passcodes only.

Accepted input sources:

- upload a `.txt` file
- paste text into a textarea

Accepted separators:

- new lines
- commas
- spaces

Import behavior is replace, not append:

- Applying an import replaces the current custom passcode list in the unsaved editor state.
- Applying an import clears selected sets in the unsaved editor state, because imported cube files are passcode-only for v1.
- The user must still click `Save Changes` to persist it.

Invalid tokens should be surfaced using the existing parser behavior where possible. The importer should not attempt fuzzy card-name matching in v1.

## Card Grid Editing

The editor page should show resolved cards in a grid using the existing card pool grid visual language.

V1 layout target:

- six cards wide on large desktop for testing
- responsive fallback on smaller widths

Interaction:

- left-clicking a card removes one copy of that card passcode from the unsaved editor state.
- if multiple copies exist, only one copy is removed per click.
- if the last copy is removed, the card disappears from the resolved grid.

This is a destructive local action, but it is not persisted until `Save Changes`.

The existing `CardPoolGrid` currently uses click for mobile/tap preview. The implementation should either add an explicit editable mode with an `onCardClick` callback or wrap it with a dedicated editable grid component. The chosen implementation should preserve existing draft preview behavior outside the cube editor.

## Save And Cancel

`Save Changes` validates:

- pool name is present
- at least one set or one custom passcode exists
- all passcode tokens are valid integers

On success:

- update via existing `PUT /api/draft-templates/[id]`
- reset the unsaved-changes baseline to the saved state
- show a short success message

On failure:

- show the API error or a generic save failure message
- keep local editor state intact

Cancel/back behavior for v1:

- navigating away can discard unsaved state
- if simple, show a browser-level or inline unsaved warning later, but it is not required for v1

## Testing

Add focused tests for the new behavior:

- nav item list includes `My Cubes` and marks `/cubes/[id]` active through prefix matching
- `/cubes` list page renders saved pools from the API data shape
- clicking a saved pool navigates to `/cubes/[id]`
- importer parses passcodes from pasted text
- importer replaces the current custom passcode list rather than appending
- card click removes one copy of a duplicate passcode
- save calls `PUT /api/draft-templates/[id]` with preserved `setNames` and updated `customCardIds`
- import replacement saves with cleared `setNames` and imported `customCardIds`

Existing tests around Settings card pool management and draft creation should keep passing.

## Out Of Scope

The first version does not add card-name import, drag-and-drop reordering, bulk select, undo stack, per-card sideboard metadata, cube visibility/sharing, or a separate cube database table.
