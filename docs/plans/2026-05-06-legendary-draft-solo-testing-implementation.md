# Legendary Draft Solo Testing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Design doc:** `docs/superpowers/specs/2026-05-06-legendary-draft-solo-testing-design.md`

**Goal:** Enable a complete solo test run of a Yu-Gi-Oh draft from the web UI — from pending lobby configuration through card picking with auto-picking fake players.

**Architecture:** Three targeted changes: (1) reset the seed to pending so the lobby is testable, (2) add inline config editing to the pending lobby, (3) create a pick endpoint and wire it to the card grid so picks persist and fake players auto-pick.

**Tech Stack:** Next.js 16 App Router, React, Zustand, Tailwind CSS v4, better-sqlite3, Vitest, @yugidraft/shared

---

### Task 1: Reset Legendary Draft seed to pending

**Files:**
- Modify: `scripts/seed.ts`

**Step 1: Update seed data**

In the Legendary Draft seed section of `scripts/seed.ts`:

1. Change `status` from `"active"` to `"pending"`
2. Remove `started_at` (set to `null` or omit)
3. Set `current_wave_number: 0` and `current_pick_step: 0`
4. Remove all `draft_packs` and `draft_cards` seed inserts for the Legendary Draft — these are only valid for an active draft with pre-generated packs. The `drafts.start()` method will generate them when the creator starts the draft from the lobby.
5. Keep the `draft_players` rows for fake players (`fake_yugi`, `fake_kaiba`, etc.) exactly as they are — the lobby needs to show them as joined participants.

Also update the `config_json` to include meaningful `setNames` if not already present (the spec references `Legend of Blue Eyes White Dragon`, `Metal Raiders`, `Spell Ruler` — these should already be in the seed config).

**Step 2: Run seed to verify**

Run: `npm run seed`

Expected: seed completes without error. The Legendary Draft entry in the database has `status: "pending"` and no pack/card rows.

**Step 3: Run existing seed tests**

Run: `npx vitest run tests/seed-script.test.ts` (or the relevant test path)

Expected: all tests pass with the updated seed data.

---

### Task 2: Add inline config editing to DraftManageView

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`

**Step 1: Add edit-mode state**

Add a boolean `isEditing` state (default `false`) to `DraftManageView`. When `isEditing` is `true`, render the edit form instead of the read-only config display.

Also add local state for the editable fields, initialized from `draft.config`:
- `editSetNames: string[]` (from `draft.config.setNames ?? []`)
- `editPackSize: number` (from `draft.config.packSize ?? 8`)
- `editPacksPerPlayer: number` (from `draft.config.packsPerPlayer ?? 5`)
- `editPickSeconds: number` (from `draft.config.pickSeconds ?? 45`)

Reset these to current `draft.config` values when entering or canceling edit mode.

**Step 2: Add "Edit Configuration" button**

Below the existing config display (read-only section), add an "Edit Configuration" button visible only to the creator (`isCreator` is already a prop). Clicking it sets `isEditing = true` and initializes edit state from current config.

The button should use a subtle style (outline variant) to avoid competing with the primary "Start Draft" action.

**Step 3: Build the edit form**

When `isEditing` is true, replace the config read-only display with an inline form:

- **Card Sets**: Use the existing `SetPicker` component (import from `./set-picker`). Pass `editSetNames` and a setter that updates local state.
- **Pack Size**: `<input type="number" min={1} max={45}>` bound to `editPackSize`
- **Packs / Player**: `<input type="number" min={1} max={10}>` bound to `editPacksPerPlayer`
- **Pick Timer**: `<input type="number" min={10} max={300}>` bound to `editPickSeconds`, with a "seconds" label

Style the form fields consistently with the existing draft creation form (`create-draft-form.tsx`).

**Step 4: Implement save and cancel**

Save flow:
1. "Save Configuration" button (or Enter in a field) calls `onUpdate({ config: { setNames: editSetNames, packSize: editPackSize, packsPerPlayer: editPacksPerPlayer, pickSeconds: editPickSeconds } })`
2. The `onUpdate` prop already exists and calls `PUT /api/drafts/[slug]` with the config object, then refetches the draft.
3. On success: set `isEditing = false` (the parent refetch will re-render with new data)
4. On error: display inline error message, stay in edit mode

Add error state: `editError: string | null`, cleared on save attempt, set on catch.

Cancel: "Cancel" button sets `isEditing = false` and resets edit state to current `draft.config`.

**Step 5: Validate inputs**

Before calling `onUpdate`, validate:
- `editSetNames.length >= 1` (at least one set required)
- `editPackSize` is integer 1–45
- `editPacksPerPlayer` is integer 1–10
- `editPickSeconds` is integer 10–300

If validation fails, set `editError` with descriptive message and don't call `onUpdate`.

**Step 6: Visual verification**

Manually verify in browser:
- Pending lobby shows "Edit Configuration" button for the creator
- Clicking it switches to inline edit form with current values pre-filled
- SetPicker works for adding/removing sets
- Save persists via PUT and re-renders with updated config
- Cancel resets to original values and exits edit mode
- Non-creator does not see "Edit Configuration" button

---

### Task 3: Create the pick API endpoint

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/pick/route.ts`

**Step 1: Create the route file**

Create `packages/web/app/api/drafts/[slug]/pick/route.ts` with a `POST` handler.

**Step 2: Implement authentication and validation**

```ts
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
)
```

1. Get auth session via `auth()`. Return 401 if no user.
2. Parse `{ cardId }` from request body. Return 400 if missing or non-numeric.
3. Look up draft by `web_slug`. Return 404 if not found.
4. Look up the current player via `players` table: `SELECT id FROM players WHERE guild_id = ? AND discord_user_id = ?` using `session.user.id`. Return 400 if not a participant.
5. Verify draft status is `"active"`. Return 400 if not.

**Step 3: Implement pick + auto-pick loop**

1. Call `drafts.pickCard(draft.id, player.id, cardId, "manual")` to persist the real player's pick. This is the existing transactional method in `@yugidraft/shared/services/drafts.ts` — it validates the draft is active, the player is joined, card is in their pack, etc. It also handles pack rotation and draft completion if all players have picked.

2. After the real player pick succeeds, run the auto-pick loop for fake players:

```ts
const fakePlayers = db
  .prepare(
    `SELECT dp.player_id FROM draft_players dp
     INNER JOIN players p ON p.id = dp.player_id
     WHERE dp.draft_id = ? AND p.discord_user_id LIKE 'fake_%'`
  )
  .all(draft.id);

const currentStep = drafts.findById(draft.id);
for (const fake of fakePlayers) {
  const hasPicked = db
    .prepare(
      `SELECT id FROM draft_picks
       WHERE draft_id = ? AND player_id = ? AND wave_number = ? AND pick_step = ?`
    )
    .get(draft.id, fake.player_id, currentStep.currentPackRound, currentStep.currentPickStep);

  if (!hasPicked) {
    const options = drafts.currentPackOptions(draft.id, fake.player_id);
    if (options.length > 0) {
      const randomCard = options[Math.floor(Math.random() * options.length)];
      drafts.pickCard(draft.id, fake.player_id, randomCard.id, "auto");
    }
  }
}
```

Note: After `pickCard` for the real player, the draft state may have advanced (pack rotation, wave change). Re-fetch the draft state before the auto-pick loop so `currentPackRound` and `currentPickStep` are current. The auto-pick loop only needs one pass per pick request because `pickCard` handles step advancement internally — if a fake player picks and all players are done for that step, `pickCard` will rotate packs again automatically.

3. After all picks (real + fake), build the full response using the same logic as the GET handler (draft data, players, seats, current pack, pool, timer, etc.). Extract this into a shared helper function if practical, or duplicate the response-building logic.

**Step 4: Error handling**

- `pickCard` throws on validation errors (e.g., not your turn, card not in pack, already picked). Catch these and return 400 with the error message.
- Return 500 for unexpected errors.
- Wrap the handler in a try/catch like the existing route handlers.

**Step 5: Test the endpoint**

Create a test file at `packages/web/tests/api/draft-pick.test.ts` (or add to an existing test file):

- Seed a pending draft, start it, and verify a POST to `/api/drafts/[slug]/pick` with a valid `cardId` persists the pick
- Verify auto-pick fires for fake players
- Verify 400 for invalid card, 401 for unauthenticated, 400 for non-participant

If Vitest API integration tests aren't set up yet, test manually by:
1. Running seed, starting the draft from the lobby
2. Picking a card from the web UI
3. Verifying the pick persists in the database and the auto-fake-player picks appear

---

### Task 4: Wire card-grid to the pick endpoint

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx` (if needed for error callback)

**Step 1: Add fetchPick function**

In `card-grid.tsx`, add a `fetchPick` function that:

1. Gets the draft slug from the page (either passed as a prop or read from the store)
2. POSTs to `/api/drafts/${slug}/pick` with `{ cardId }`
3. On success: calls `useDraftStore.getState().setFromServer(response)` to sync authoritative state
4. On error: refetches full draft state and calls `setFromServer` with the fresh data; optionally surfaces an error toast

The slug will need to be available. Options:
- Add a `slug` prop to `CardGrid` (the page already has the slug from params)
- Or read `useDraftStore((s) => s.slug)` (the store already tracks `slug`)

Prefer the store approach since `slug` is already in `DraftState`.

**Step 2: Call fetchPick after optimistic pick**

The current pick flow in `card-grid.tsx` works through `CardPreview`'s `onPick` callback and keyboard `Enter` handler, both of which call `pickCard(selectedCard.id)`.

After calling the optimistic `pickCard(cardId)`, immediately call `fetchPick(cardId)`:

```ts
const handleConfirmPick = (cardId: number) => {
  pickCard(cardId); // optimistic local update
  fetchPick(cardId); // persist to server
};
```

Wire `handleConfirmPick` into:
- The `CardPreview` onPick callback
- The keyboard `Enter` handler

**Step 3: Handle loading state**

Add a `picking` state (boolean) to prevent double-picks while a server request is in-flight. Set it `true` before the POST, set it `false` after the response. Disable the pick button and keyboard shortcut while `picking` is true.

**Step 4: Handle errors**

On fetch error:
1. Log the error
2. Re-fetch the full draft via `/api/drafts/${slug}` (the page's `fetchDraft` function, or an inline fetch)
3. Call `setFromServer(freshData)` to restore consistent state (overwriting the optimistic pick)
4. Display a brief error indicator (toast or inline text near the grid)

For now, use a `console.error` + state restoration approach. Toast infrastructure can be added later.

**Step 5: Verify the full flow**

Manually verify:
1. Start the Legendary Draft from the pending lobby
2. Pick a card from the web card grid
3. The card disappears from the pack immediately (optimistic)
4. After ~0.5s, the server response arrives with updated state including fake-player picks
5. The pack either shows new cards (after rotation) or shows "waiting" if all packs are done for this wave
6. The seat list updates to show which fake players have picked
7. The pool panel shows all picked cards including auto-picks

---

### Task 5: Run full verification

**Step 1: Re-run seed script**

Run: `npm run seed`

Expected: seed completes, Legendary Draft is in pending state with fake players joined.

**Step 2: Run full web test suite**

Run: `npx vitest run`

Expected: all tests pass.

**Step 3: End-to-end manual test**

Verify the complete solo test flow:
1. Navigate to `/draft/legendary-draft` — shows pending lobby with config
2. Click "Edit Configuration" — config fields become editable
3. Modify a field (e.g., change pick timer), click "Save Configuration" — config persists
4. Click "Start Draft" — draft transitions to active, packs generate, card grid appears
5. Pick a card — optimistic update + server persist, fake players auto-pick
6. Continue picking through packs — packs rotate, auto-picks happen each round
7. Complete the draft — summary view appears

**Step 4: Responsive check**

Verify the edit form and pick flow work on mobile widths.

---

### Task 6: Commit

```bash
git add scripts/seed.ts \
  packages/web/src/components/draft/draft-manage-view.tsx \
  packages/web/src/components/draft/card-grid.tsx \
  packages/web/app/api/drafts/[slug]/pick/route.ts \
  packages/web/app/(app)/draft/[slug]/page.tsx \
  docs/plans/2026-05-06-legendary-draft-solo-testing-implementation.md \
  docs/superpowers/specs/2026-05-06-legendary-draft-solo-testing-design.md

git commit -m "enable solo draft testing: seed fix, config edit, pick API with auto-pick"
```