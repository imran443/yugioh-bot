# Draft Timer and Modal Metadata Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make draft auto-picks happen promptly at timer expiry and render effect text plus stats in the pick modal using snapshot-backed card metadata.

**Architecture:** The bot timer loop becomes near-real-time by checking overdue drafts every second. The web expiry-resync hook keeps polling after `0:00` until the server advances the draft. Catalog metadata expands once at the shared schema and snapshot layers, then flows through the seed script, API response builder, Zustand store, and modal UI.

**Tech Stack:** Node.js, Discord bot service, Next.js, React 19, Zustand, Vitest, SQLite, better-sqlite3

---

### Task 1: Add failing timer-resync regressions

**Files:**
- Modify: `packages/web/tests/components/use-draft-expiry-resync.test.tsx`
- Modify: `packages/bot/tests/services/draft-timer.test.ts`

**Step 1: Write the failing web hook test**

Cover this case:
- when the timer reaches zero and the first refetch still returns the same pick step with `isMyTurn: true`, the hook retries until a later response advances the draft or clears the turn

**Step 2: Run the web hook test to verify it fails**

Run: `npx vitest run tests/components/use-draft-expiry-resync.test.tsx`

**Step 3: Write the failing bot timer test**

Cover this case:
- `createDraftTimerService.start()` schedules checks every `1000ms`

**Step 4: Run the bot timer test to verify it fails**

Run: `npx vitest run tests/services/draft-timer.test.ts`

### Task 2: Implement the timer race fix

**Files:**
- Modify: `packages/bot/src/services/draft-timer.ts`
- Modify: `packages/web/src/lib/hooks/use-draft-expiry-resync.ts`

**Step 1: Implement the minimal bot fix**

Change the bot timer interval from `10000` to `1000`.

**Step 2: Implement the minimal web retry fix**

Retry zero-state refetches until one of these becomes true:
- `pickStep` changes
- `currentPack` changes
- `isMyTurn` becomes `false`
- `completed` becomes `true`

Keep the retry bounded and reset the retry state once fresh server state arrives.

**Step 3: Run the targeted timer tests**

Run:
- `npx vitest run tests/components/use-draft-expiry-resync.test.tsx`
- `npx vitest run tests/services/draft-timer.test.ts`

### Task 3: Add failing metadata persistence regressions

**Files:**
- Modify: `packages/web/tests/seed-script.test.ts`
- Modify: `packages/web/tests/components/card-grid.test.tsx`

**Step 1: Write the failing seed assertions**

Assert that a seeded snapshot card exposes:
- non-empty effect text
- `atk`, `def`, `attribute`, and `level` where applicable for a monster card

**Step 2: Write the failing modal rendering test**

Assert that the pick modal renders effect text and monster stats when the selected card has that metadata.

**Step 3: Run the tests to verify they fail**

Run:
- `npx vitest run tests/seed-script.test.ts`
- `npx vitest run tests/components/card-grid.test.tsx`

### Task 4: Extend the shared catalog schema and types

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/db/schema.ts`
- Modify: `packages/shared/tests/db/schema.test.ts`
- Modify: `packages/shared/src/services/card-catalog.ts`

**Step 1: Add the new fields**

Add nullable/shared fields for:
- `effectText`
- `atk`
- `def`
- `attribute`
- `level`

Persist them in `card_catalog` and map them through `Card` / `CardCatalogCard`.

**Step 2: Run shared schema tests**

Run: `npm test --workspace=@yugioh-discord-bot/bot -- tests/services/card-catalog.test.ts`

### Task 5: Extend snapshot generation and local seeding

**Files:**
- Modify: `scripts/generate-draft-catalog-snapshot.ts`
- Modify: `scripts/seed.ts`
- Modify: `scripts/data/draft-catalog-legendary.json`

**Step 1: Update generator output**

Capture the new metadata fields from YGOPRODeck and write them into the snapshot JSON.

**Step 2: Update seed ingestion**

Insert the new metadata columns during local seeding.

**Step 3: Refresh the committed snapshot**

Run: `npm run snapshot:draft-catalog`

**Step 4: Run the seed test**

Run: `npx vitest run tests/seed-script.test.ts`

### Task 6: Pass richer metadata through the draft API and modal

**Files:**
- Modify: `packages/web/app/api/drafts/[slug]/helpers.ts`
- Modify: `packages/web/src/lib/stores/draft-store.ts`
- Modify: `packages/web/src/components/draft/card-preview.tsx`
- Modify: `packages/web/tests/components/card-grid.test.tsx`

**Step 1: Update the API mapper**

Map real metadata from the catalog into `currentPack` and `myPool` responses.

**Step 2: Update the modal rendering**

Render a readable effect-text block and compact monster stat row/chips in the modal only.

**Step 3: Run the UI regression**

Run: `npx vitest run tests/components/card-grid.test.tsx`

### Task 7: Final targeted verification

**Files:**
- No new files

**Step 1: Run the full targeted suite**

Run:
- `npx vitest run tests/components/card-grid.test.tsx tests/components/draft-summary-view.test.tsx tests/components/use-draft-countdown.test.tsx tests/components/use-draft-expiry-resync.test.tsx tests/seed-script.test.ts tests/drafts-route.test.ts tests/draft-pick.test.ts`
- `npx vitest run tests/services/draft-timer.test.ts tests/services/drafts.test.ts`

**Step 2: Run typecheck**

Run: `npm run typecheck --workspace=@yugioh-discord-bot/web`

**Step 3: Refresh local runtime state**

Run: `npm run reset:test-data`

**Step 4: Manual verification**

Confirm that:
- timer expiry advances the draft without lingering at `0:00`
- the modal shows effect text and stats for supported cards
- no existing draft-room regressions reappear
