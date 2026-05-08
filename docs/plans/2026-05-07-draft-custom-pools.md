# Draft Custom Pools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix web draft starts that can fail with `Draft pool is empty`, then add server-wide reusable custom draft pools imported from card ID text.

**Architecture:** Extend the existing draft configuration JSON with `customCardIds?: number[]` and reuse server-wide `draft_templates` for saved pools. The web start API syncs selected sets before starting, and the shared draft service includes explicit custom card IDs when opening packs.

**Tech Stack:** Next.js API routes and React components in `packages/web`, shared services in `packages/shared`, Vitest tests, SQLite via `better-sqlite3`.

---

### Task 1: Fix Web Start Draft Pool Sync Bug

**Files:**
- Modify: `packages/web/app/api/drafts/[slug]/route.ts`
- Test: `packages/web/tests/drafts-route.test.ts`

**Step 1: Write the failing test**

Add a test that creates a pending draft whose selected set is not yet cached in `card_catalog`, mocks YGOPRODeck fetch for that set, calls `POST /api/drafts/[slug]`, and expects a 200 active draft plus generated draft cards.

**Step 2: Run test to verify it fails**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests/drafts-route.test.ts`

Expected: FAIL with `Draft pool is empty` or no draft cards because the route starts without syncing.

**Step 3: Write minimal implementation**

In `POST` for `packages/web/app/api/drafts/[slug]/route.ts`, load the full draft through `createDraftService(db).findById(draft.id)`, then call `createCardCatalogService(db).syncDraftPool({ setNames, includeNames, excludeNames })` before `drafts.start(draft.id)`.

**Step 4: Run test to verify it passes**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests/drafts-route.test.ts`

Expected: PASS.

### Task 2: Add Custom Card IDs To Draft Config

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/services/card-catalog.ts`
- Modify: `packages/shared/src/services/drafts.ts`
- Test: `packages/shared/tests/services/drafts.test.ts`

**Step 1: Write the failing test**

Add a shared draft service test that creates a draft with `{ customCardIds: [1, 2] }`, inserts catalog cards with those passcodes, starts the draft, and expects opened `draft_cards.catalog_card_id` to come from only those custom IDs.

**Step 2: Run test to verify it fails**

Run: `npm test --workspace=@yugioh-discord-bot/shared -- tests/services/drafts.test.ts`

Expected: FAIL with `Draft pool is empty` because `customCardIds` is ignored.

**Step 3: Write minimal implementation**

Add `customCardIds?: number[]` to `DraftConfig`. In `catalogCardIdsForDraft()`, include rows whose `ygoprodeck_id` is in `customCardIds`, while still excluding Extra Deck cards and excluded names.

**Step 4: Run test to verify it passes**

Run: `npm test --workspace=@yugioh-discord-bot/shared -- tests/services/drafts.test.ts`

Expected: PASS.

### Task 3: Persist Custom IDs In Server-Wide Templates

**Files:**
- Modify: `packages/bot/tests/services/draft-templates.test.ts`
- Modify: `packages/bot/src/services/draft-templates.ts` if needed

**Step 1: Write the failing test**

Add a test that saves a template with `{ setNames: ["The Lost Millennium"], customCardIds: [123, 456] }`, reads it back with `findByName`, and expects `customCardIds` to persist.

**Step 2: Run test to verify behavior**

Run: `npm test --workspace=@yugioh-discord-bot/bot -- tests/services/draft-templates.test.ts`

Expected: It may already pass because config is JSON. If so, keep the test as coverage and do not change production code.

### Task 4: Add Shared Import Parser

**Files:**
- Create: `packages/web/src/lib/draft/custom-pool.ts`
- Test: `packages/web/tests/lib/custom-pool.test.ts`

**Step 1: Write the failing tests**

Test that parser accepts `123\n456`, `123,456`, and `123 456`; dedupes `123 123`; and rejects non-numeric tokens like `abc`.

**Step 2: Run test to verify it fails**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests/lib/custom-pool.test.ts`

Expected: FAIL because parser file does not exist.

**Step 3: Write minimal implementation**

Implement `parseCustomPoolCardIds(text: string): { cardIds: number[]; invalidTokens: string[] }` using `/[\s,]+/` splitting, positive integer validation, and stable dedupe.

**Step 4: Run test to verify it passes**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests/lib/custom-pool.test.ts`

Expected: PASS.

### Task 5: Add Web Custom Pool UI To Create And Manage Drafts

**Files:**
- Modify: `packages/web/src/components/draft/create-draft-form.tsx`
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`
- Test: `packages/web/tests/components/draft-manage-view.test.tsx`
- Test: existing or new `packages/web/tests/components/create-draft-form.test.tsx`

**Step 1: Write failing component tests**

Add tests for pasting custom pool text, seeing imported card ID count, and submitting/updating config containing `customCardIds` alongside `setNames`.

**Step 2: Run tests to verify they fail**

Run relevant component tests with `npm test --workspace=@yugioh-discord-bot/web -- tests/components/draft-manage-view.test.tsx` and the create form test.

Expected: FAIL because UI has no custom pool field.

**Step 3: Write minimal UI implementation**

Add a textarea and file input for custom pool card IDs. On paste/file import, parse IDs, show count and invalid-token errors, and include `customCardIds` in config POST/PUT.

**Step 4: Run tests to verify they pass**

Run the same component tests.

Expected: PASS.

### Task 6: Add Template Load/Save In Web Draft UI

**Files:**
- Add or modify: `packages/web/app/api/draft-templates/route.ts`
- Add or modify: `packages/web/app/api/draft-templates/[name]/route.ts`
- Modify: `packages/web/src/components/draft/create-draft-form.tsx`
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`
- Test: new web API/component tests as needed

**Step 1: Write failing tests**

Add API tests that save a server-wide template with `customCardIds`, list templates, and load one by name. Add UI tests that loading a template applies selected sets and custom card IDs.

**Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests`

Expected: FAIL because web template API/UI does not exist.

**Step 3: Write minimal implementation**

Use existing `draft_templates` table. Scope by `env.discordGuildId`; require auth for save/delete; allow authenticated users to list/load server-wide templates. Wire create/edit draft UI to save and load templates.

**Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@yugioh-discord-bot/web -- tests`

Expected: PASS.

### Task 7: Final Verification

**Files:**
- All changed files

**Step 1: Run focused tests**

Run:
- `npm test --workspace=@yugioh-discord-bot/shared -- tests/services/drafts.test.ts`
- `npm test --workspace=@yugioh-discord-bot/bot -- tests/services/draft-templates.test.ts`
- `npm test --workspace=@yugioh-discord-bot/web -- tests/drafts-route.test.ts`
- Web component/API tests added above

**Step 2: Run broader checks**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: PASS or document unrelated existing failures.
