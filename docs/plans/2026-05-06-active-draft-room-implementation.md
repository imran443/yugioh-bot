# Active Draft Room Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the active draft room show seeded demo content immediately and redesign the layout so the card stage feels like a competitive esports draft table.

**Architecture:** Extend the active draft API payload so the page can hydrate the Zustand draft store before websocket events arrive. Rebalance the active draft screen around a dominant center stage, while keeping timer, seats, and pool in supporting rails. Update the seed script so demo drafts expose meaningful set names in the active room.

**Tech Stack:** Next.js 16 App Router, React, Zustand, Tailwind CSS v4, better-sqlite3, Vitest

---

### Task 1: Add a failing test for active draft API hydration

**Files:**
- Modify: `packages/web/tests/` create a focused draft route test file if none exists
- Modify: `packages/web/app/api/drafts/[slug]/route.ts`

**Step 1: Write the failing test**

Create a test that exercises the active seeded draft route and expects the JSON payload to include initial active draft-room state for the logged-in participant.

Expected assertions:
- `currentPack` is present and non-empty for `legendary-draft`
- `seats` is present
- `pickSeconds` is present
- `setNames` already exist in `config`

**Step 2: Run test to verify it fails**

Run: `npx vitest run <new-draft-route-test-file>`

Expected: FAIL because `app/api/drafts/[slug]/route.ts` does not currently return active-room hydration fields.

**Step 3: Implement minimal route changes**

Update `packages/web/app/api/drafts/[slug]/route.ts` to:
- use `createDraftService(db)` for active drafts
- derive the current player id from the authenticated Discord user id
- return:
  - `currentPack`
  - `myPool`
  - `seats`
  - `packRound`
  - `pickStep`
  - `pickSeconds`
  - `timerSeconds`
  - `isMyTurn`

**Step 4: Run test to verify it passes**

Run: `npx vitest run <new-draft-route-test-file>`

Expected: PASS

### Task 2: Add a failing test for relative DB path handling in local web runs

**Files:**
- Existing: `packages/web/tests/db-path.test.ts`
- Existing: `packages/web/src/lib/db.ts`

**Step 1: Confirm failing test already exists**

The test is already present and should stay green.

**Step 2: Re-run it before broader active draft work if needed**

Run: `npx vitest run tests/db-path.test.ts`

Expected: PASS

### Task 3: Hydrate the active draft store from API data

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
- Modify: `packages/web/src/lib/stores/draft-store.ts` only if required for payload compatibility

**Step 1: Write the failing test**

Add a component-level regression test or targeted store/page test that proves the page writes initial active draft data into the store before websocket events arrive.

Expected assertion:
- active draft render shows pack cards or a hydrated card count immediately from fetch response

**Step 2: Run test to verify it fails**

Run: `npx vitest run <targeted-active-draft-test>`

Expected: FAIL because the page currently fetches draft metadata but does not hydrate store state.

**Step 3: Implement minimal hydration**

Update `packages/web/app/(app)/draft/[slug]/page.tsx` to:
- extend `DraftData` with active-room payload fields
- call `setFromServer(...)` after `fetchDraft()` succeeds for active drafts
- clear or reset the store appropriately when draft slug changes if necessary

**Step 4: Run test to verify it passes**

Run: `npx vitest run <targeted-active-draft-test>`

Expected: PASS

### Task 4: Redesign the active draft layout around a dominant center stage

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

**Step 1: Write a narrow visual behavior test if practical**

If a component test is practical, assert that the active draft screen renders:
- set chips from `draft.config.setNames`
- a pack-status header
- the card grid stage container

If not practical, document this as manual verification and keep the change scoped.

**Step 2: Implement layout changes**

Restructure the active view to:
- move `draft.name` and set chips into the center stage header
- add a compact pack-status strip above `CardGrid`
- reduce dead spacing and widen the center area
- preserve mobile/tablet usability

**Step 3: Verify layout behavior**

Run targeted tests if added.

Expected manual outcome:
- center stage is visually dominant
- left and right rails support the stage instead of competing with it

### Task 5: Improve empty and syncing states in `CardGrid`

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`

**Step 1: Write the failing test**

Add a component test covering the empty-pack fallback state.

Expected assertions:
- when `currentPack` is empty, the UI shows a draft-sync / waiting panel instead of blank whitespace

**Step 2: Run test to verify it fails**

Run: `npx vitest run <card-grid-test-file>`

Expected: FAIL because the component currently renders an empty grid container.

**Step 3: Implement minimal fallback**

Update `packages/web/src/components/draft/card-grid.tsx` to:
- render a competitive empty-state panel when `currentPack.length === 0`
- keep existing selection and keyboard logic intact when cards exist
- slightly enlarge card presentation and improve grid responsiveness

**Step 4: Run test to verify it passes**

Run: `npx vitest run <card-grid-test-file>`

Expected: PASS

### Task 6: Refine supporting rails for timer, seats, and pool

**Files:**
- Modify: `packages/web/src/components/draft/timer-bar.tsx`
- Modify: `packages/web/src/components/draft/seat-list.tsx`
- Modify: `packages/web/src/components/draft/pool-panel.tsx`

**Step 1: Make minimal styling-only changes**

Adjust these components to fit the arena-style layout:
- tighter but clearer status hierarchy
- stronger current-player emphasis in seats
- more tactical, compact pool summary

**Step 2: Run affected component tests if present**

Run any targeted tests created for these components.

Expected: PASS

### Task 7: Improve seeded demo data for active draft presentation

**Files:**
- Modify: `scripts/seed.ts`
- Existing: `packages/web/tests/seed-script.test.ts`

**Step 1: Write or extend the failing test**

Extend `packages/web/tests/seed-script.test.ts` to assert seeded demo drafts include meaningful `setNames` in `config_json`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed-script.test.ts`

Expected: FAIL because the current seed uses config without set names.

**Step 3: Implement minimal seed change**

Update `scripts/seed.ts` so the active and completed demo drafts include recognizable set names.

Suggested values:
- `Legend of Blue Eyes White Dragon`
- `Metal Raiders`
- `Spell Ruler`

Use whichever set names match the seeded catalog strategy and do not break draft generation.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/seed-script.test.ts`

Expected: PASS

### Task 8: Run full verification

**Files:**
- No new files

**Step 1: Run full web suite**

Run: `npx vitest run`

Expected: all tests pass

**Step 2: Re-run seed script**

Run: `npm run seed`

Expected: seed completes successfully and prints demo draft links

**Step 3: Manual browser verification**

Check:
- `/draft/legendary-draft` shows set chips
- center stage shows cards immediately on load
- card area no longer appears collapsed or squished
- timer, players, and pool remain readable on desktop and mobile widths

### Task 9: Commit

**Step 1: Commit the completed implementation**

Run after verification:

```bash
git add packages/web/app/(app)/draft/[slug]/page.tsx packages/web/app/api/drafts/[slug]/route.ts packages/web/src/components/draft/card-grid.tsx packages/web/src/components/draft/timer-bar.tsx packages/web/src/components/draft/seat-list.tsx packages/web/src/components/draft/pool-panel.tsx packages/web/src/lib/db.ts scripts/seed.ts packages/web/tests/db-path.test.ts packages/web/tests/seed-script.test.ts docs/plans/2026-05-06-active-draft-room-design.md docs/plans/2026-05-06-active-draft-room-implementation.md
git commit -m "improve active draft room hydration and layout"
```
