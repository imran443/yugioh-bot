# Draft Room Modal, Preview, and Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the right-side picker with a centered modal, make the desktop card preview viewport-aware, clear stale selection after server state changes, gate invalid YDK export actions, and add a one-command local reset flow.

**Architecture:** Keep websocket and API payloads as the source of truth. The draft store will normalize incoming server state and clear transient UI selection when the current pack or turn ownership changes. `CardGrid` will use the existing modal primitive for explicit pick confirmation and compute hover preview placement from the hovered card bounds plus viewport space.

**Tech Stack:** Next.js, React 19, Zustand, Vitest, Testing Library, SQLite seed script, Docker Compose

---

### Task 1: Add failing draft room regressions

**Files:**
- Modify: `packages/web/tests/components/card-grid.test.tsx`
- Create: `packages/web/tests/components/draft-summary-view.test.tsx`

**Step 1: Write the failing card grid tests**

Cover these cases:
- clicking a card opens a centered dialog-based picker
- when server state removes the selected card or flips `isMyTurn` to `false`, the picker closes and the stale preview state clears
- confirming a stale selection after a server refresh does not POST `/pick`

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/card-grid.test.tsx tests/components/draft-summary-view.test.tsx`

**Step 3: Write the failing summary test**

Cover that a completed draft with fewer than `40` picks does not show an active export button and instead shows explanatory copy.

**Step 4: Run tests to verify it fails**

Run: `npx vitest run tests/components/draft-summary-view.test.tsx`

### Task 2: Normalize transient draft UI state on server updates

**Files:**
- Modify: `packages/web/src/lib/stores/draft-store.ts`

**Step 1: Implement the minimal store normalization**

In `setFromServer`, detect pack identity changes and turn-loss updates. Clear `selectedCardId` and `highlightedIndex` whenever the selected card is no longer present, the pack changes, the draft completes, or `isMyTurn` becomes `false`.

**Step 2: Run tests to verify the stale-selection regression passes**

Run: `npx vitest run tests/components/card-grid.test.tsx`

### Task 3: Replace the picker sheet with a centered modal and stale-submit guard

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`
- Reuse: `packages/web/src/components/ui/modal.tsx`
- Reuse: `packages/web/src/components/draft/card-preview.tsx`

**Step 1: Write minimal implementation**

Replace `Sheet` with `Modal`. Keep hover preview for desktop inspection, but use the modal for explicit card confirmation. Before posting a pick, confirm that the selected card still exists in `currentPack`, `isMyTurn` is still `true`, and a request is not already in flight.

**Step 2: Run tests to verify modal and stale-submit behavior pass**

Run: `npx vitest run tests/components/card-grid.test.tsx`

### Task 4: Make desktop preview overlap safely within the viewport

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`

**Step 1: Implement viewport-aware preview placement**

Compute preview position from the hovered card bounds. Prefer rendering beside the card, but flip horizontally or vertically when there is not enough room. Keep the preview fixed and overlapping so it never pushes layout.

**Step 2: Run card grid tests again**

Run: `npx vitest run tests/components/card-grid.test.tsx`

### Task 5: Gate invalid YDK export for short completed drafts

**Files:**
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
- Modify: `packages/web/app/api/drafts/[slug]/helpers.ts`
- Modify: `packages/web/tests/components/draft-summary-view.test.tsx`

**Step 1: Expose enough summary data**

Derive the current participant's `pickCount` in the draft response and pass it through the page into `DraftSummaryView`.

**Step 2: Update summary rendering**

Only show an enabled export button when the completed participant has at least `40` picks. Otherwise show concise explanatory copy.

**Step 3: Run summary tests**

Run: `npx vitest run tests/components/draft-summary-view.test.tsx`

### Task 6: Add a one-command local reset flow

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Step 1: Add the reset command**

Add a script that reseeds local data and restarts `web` and `bot` so mounted SQLite handles reopen against the fresh DB.

**Step 2: Document the command**

Add the command to local development docs near the existing Docker workflow.

**Step 3: Verify manually**

Run: `npm run reset:test-data`
Expected: seed completes, `web` and `bot` restart successfully.

### Task 7: Final targeted verification

**Files:**
- No new files

**Step 1: Run all targeted regressions**

Run: `npx vitest run tests/components/card-grid.test.tsx tests/components/draft-summary-view.test.tsx tests/components/use-draft-countdown.test.tsx tests/components/use-draft-expiry-resync.test.tsx tests/seed-script.test.ts tests/drafts-route.test.ts tests/draft-pick.test.ts`

**Step 2: Restart runtime if needed**

Run: `docker compose restart web bot`

**Step 3: Manual verification**

Check that:
- hover preview overlaps without clipping below the viewport
- selecting a card opens a centered modal
- when the timer expires, the modal closes and no stale pick request is sent
- completed short drafts explain why YDK export is unavailable
