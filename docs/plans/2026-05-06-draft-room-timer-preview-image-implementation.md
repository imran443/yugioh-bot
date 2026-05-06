# Draft Room Timer, Preview, and Image Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the active draft timer count down smoothly, keep the desktop card preview anchored beside the hovered card instead of overlapping the header, and restore the missing `Mirror Force` image in seeded drafts.

**Architecture:** Add a small client countdown hook used once by the active draft page so the timer decrements locally between websocket updates. Replace hard-coded preview placement with DOM-anchored fixed positioning derived from the hovered card element. Correct the `Mirror Force` seed metadata and update the live local SQLite rows that still reference the bad catalog id.

**Tech Stack:** Next.js, React 19, Zustand, Vitest, better-sqlite3, SQLite seed script

---

### Task 1: Add countdown regression coverage

**Files:**
- Create: `packages/web/tests/components/use-draft-countdown.test.tsx`
- Modify: `packages/web/src/lib/hooks/use-draft-countdown.ts`

**Step 1: Write the failing test**

Cover these cases:
- timer decrements by 1 after 1000ms while active
- timer stops at 0
- timer does not decrement when draft is completed

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/use-draft-countdown.test.tsx`

**Step 3: Write minimal implementation**

Add a hook that reads `timerSeconds` and `completed` from the store and schedules a single `setTimeout` to call `tick()` once per second while active.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/components/use-draft-countdown.test.tsx`

### Task 2: Wire countdown into the active draft page

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

**Step 1: Use the countdown hook once**

Call the hook in the page component so only one countdown loop runs regardless of how many `TimerBar` components are mounted for responsive layouts.

**Step 2: Verify active draft rendering still works**

Run: `npx vitest run tests/components/use-draft-countdown.test.tsx tests/components/card-grid.test.tsx`

### Task 3: Fix desktop hover preview placement

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`

**Step 1: Add a failing regression test or narrow coverage if feasible**

At minimum, cover that hovering a card renders the desktop preview container and that the preview no longer relies on the old absolute grid positioning.

**Step 2: Implement minimal positioning fix**

Track the hovered card element, read its bounding box, and position the preview with `position: fixed` beside the hovered card using viewport-aware left/top coordinates.

**Step 3: Verify card grid tests pass**

Run: `npx vitest run tests/components/card-grid.test.tsx`

### Task 4: Fix Mirror Force seed metadata

**Files:**
- Modify: `scripts/seed.ts`
- Modify: `packages/web/tests/seed-script.test.ts`

**Step 1: Write the failing seed assertion**

Assert that seeded `Mirror Force` uses YGOPRODeck id `44095762` and matching image URLs.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed-script.test.ts`

**Step 3: Write minimal implementation**

Update the hard-coded seed card id so future reseeds generate valid `Mirror Force` image URLs.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/seed-script.test.ts`

### Task 5: Repair the local seeded database and verify

**Files:**
- Modify: local `data/bot.sqlite` contents only

**Step 1: Update the existing local DB**

Run SQL to:
- update `card_catalog` `ygoprodeck_id`, `image_url`, and `image_url_small` for `Mirror Force`
- update `draft_cards.catalog_card_id` from `44095763` to `44095762`

**Step 2: Verify targeted tests**

Run: `npx vitest run tests/components/use-draft-countdown.test.tsx tests/components/card-grid.test.tsx tests/seed-script.test.ts`

**Step 3: Verify runtime**

Check the active draft page after HMR or restart `web` if required.
