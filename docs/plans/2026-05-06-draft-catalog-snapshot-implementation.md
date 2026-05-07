# Draft Catalog Snapshot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Design doc:** `docs/plans/2026-05-06-draft-catalog-snapshot-design.md`

**Goal:** Replace the tiny handwritten draft catalog seed with an offline snapshot-backed catalog so Legendary Draft uses complete and consistent real card metadata.

**Architecture:** Add a one-time snapshot generator that fetches the allowed YGOPRODeck sets and writes a normalized JSON asset into the repo. Update `scripts/seed.ts` to load that snapshot offline and upsert every card into `card_catalog`, then verify the seeded catalog and draft API behavior with targeted tests.

**Tech Stack:** Node.js, TypeScript, `tsx`, better-sqlite3, Vitest, `@yugidraft/shared`

---

### Task 1: Add regression coverage for the offline catalog expectations

**Files:**
- Modify: `packages/web/tests/seed-script.test.ts`
- Modify: `packages/web/tests/drafts-route.test.ts`

**Step 1: Write the failing seed catalog assertions**

In `packages/web/tests/seed-script.test.ts`, add assertions that prove the seeded `card_catalog` is no longer the tiny demo list:

1. Query `select count(*) as count from card_catalog`
2. Assert the count is meaningfully larger than the current demo catalog, for example `expect(count).toBeGreaterThan(100)`
3. Query for `Limiter Removal`
4. Assert it exists and has non-empty `image_url` and `image_url_small`

Keep the existing `Mirror Force` assertion in the same test file.

**Step 2: Run the seed test to verify it fails**

Run: `npx vitest run tests/seed-script.test.ts`

Expected: FAIL because the current handwritten seed only inserts about 16 catalog rows and does not contain `Limiter Removal`.

**Step 3: Write a draft route assertion tied to the real seeded catalog**

In `packages/web/tests/drafts-route.test.ts`, add one focused assertion that the active draft route can return cards whose metadata comes from the larger catalog snapshot rather than the tiny hardcoded list.

Do not overfit to a random pack result. Keep the check structural:

1. Start a seeded draft in the temp DB
2. Fetch `GET /api/drafts/[slug]`
3. Assert every card in `payload.currentPack` has non-empty `name`, `imageUrl`, and `imageUrlSmall`

**Step 4: Run the focused route test to verify current behavior**

Run: `npx vitest run tests/drafts-route.test.ts -t "returns active draft cards with complete metadata"`

Expected: This may already pass. If it does, keep it as a guard for the final seeded behavior and continue. The required red test is the seed catalog coverage from Step 2.

---

### Task 2: Add the snapshot generator script

**Files:**
- Create: `scripts/generate-draft-catalog-snapshot.ts`
- Create: `scripts/data/draft-catalog-legendary.json`
- Reference: `packages/shared/src/services/card-catalog.ts`

**Step 1: Create the generator entrypoint**

Create `scripts/generate-draft-catalog-snapshot.ts`.

The script should:

1. Fetch only the three approved sets:
   - `Legend of Blue Eyes White Dragon`
   - `Metal Raiders`
   - `Spell Ruler`
2. Reuse the same normalization rules already used by the shared card catalog service:
   - dedupe by YGOPRODeck id
   - keep `name`, `type`, `frameType`, `imageUrl`, `imageUrlSmall`, `cardSets`
   - exclude extra deck cards using the same frame/type logic already in `packages/shared/src/services/card-catalog.ts`
3. Sort output by `ygoprodeckId` ascending for deterministic diffs

**Step 2: Implement the snapshot JSON shape**

Write the generated file to `scripts/data/draft-catalog-legendary.json` with this structure:

```json
{
  "generatedAt": "2026-05-06T00:00:00.000Z",
  "sourceSets": [
    "Legend of Blue Eyes White Dragon",
    "Metal Raiders",
    "Spell Ruler"
  ],
  "cards": [
    {
      "ygoprodeckId": 23171610,
      "name": "Pot of Greed",
      "type": "Spell Card",
      "frameType": "spell",
      "imageUrl": "https://images.ygoprodeck.com/images/cards/23171610.jpg",
      "imageUrlSmall": "https://images.ygoprodeck.com/images/cards_small/23171610.jpg",
      "cardSets": [{ "set_name": "Spell Ruler" }]
    }
  ]
}
```

Use exact field names that make seeding straightforward. Avoid adding fields the app does not use.

**Step 3: Add a package script for manual refresh**

Update the root `package.json` to add a script such as:

```json
"snapshot:draft-catalog": "tsx scripts/generate-draft-catalog-snapshot.ts"
```

This script is for explicit manual refresh only. Do not call it from `seed.ts`.

**Step 4: Generate the first snapshot file**

Run: `npm run snapshot:draft-catalog`

Expected: `scripts/data/draft-catalog-legendary.json` is created and contains a deterministic set of normalized cards.

---

### Task 3: Switch seed.ts to use the offline snapshot

**Files:**
- Modify: `scripts/seed.ts`
- Reference: `scripts/data/draft-catalog-legendary.json`

**Step 1: Remove the handwritten demo catalog array**

In `scripts/seed.ts`, delete the current small `const cards = [...]` catalog section used to insert about 15-16 demo cards.

Do not change the player, tournament, or draft seed sections yet.

**Step 2: Load the snapshot file from disk**

At the top of `scripts/seed.ts`:

1. Import `readFileSync` from `node:fs`
2. Import `resolve` or `join` from `node:path`
3. Read `scripts/data/draft-catalog-legendary.json`
4. Parse it into a typed object with `cards`

Keep the path repo-relative and deterministic so the script works from the repo root.

**Step 3: Seed card_catalog from snapshot cards**

Replace the existing loop with a new loop over `snapshot.cards`.

Each inserted row should use:

1. `ygoprodeck_id` = `card.ygoprodeckId`
2. `name` = `card.name`
3. `type` = `card.type`
4. `frame_type` = `card.frameType`
5. `image_url` = `card.imageUrl`
6. `image_url_small` = `card.imageUrlSmall`
7. `card_sets_json` = `JSON.stringify(card.cardSets)`

Use `insert or ignore` only if the current seed behavior still requires preserving preexisting rows. If the script is meant to build a fresh local DB, prefer a clean deterministic seed and make sure stale rows are not left behind in a reused DB file.

**Step 4: Keep the draft config pointing at the same sets**

Leave the Legendary Draft config unchanged:

```ts
setNames: [
  "Legend of Blue Eyes White Dragon",
  "Metal Raiders",
  "Spell Ruler",
]
```

That ensures draft pool generation and the offline snapshot stay aligned.

**Step 5: Run the seed script locally**

Run: `npm run seed`

Expected: the seed completes successfully and inserts a much larger `card_catalog` than the tiny demo list.

---

### Task 4: Verify the new seed data and fix any stale-row behavior

**Files:**
- Modify: `scripts/seed.ts` only if verification exposes stale rows
- Verify: `data/bot.sqlite`

**Step 1: Inspect the seeded catalog size**

Run:

```bash
node -e 'const Database=require("better-sqlite3");const db=new Database("data/bot.sqlite");console.log(db.prepare("select count(*) as count from card_catalog").get())'
```

Expected: count is comfortably above the old demo catalog size.

**Step 2: Inspect specific missing-card coverage**

Run:

```bash
node -e 'const Database=require("better-sqlite3");const db=new Database("data/bot.sqlite");console.log(db.prepare("select ygoprodeck_id,name,image_url_small from card_catalog where lower(name)=lower(?)").all("Limiter Removal"))'
```

Expected: at least one `Limiter Removal` row exists with a real image URL.

**Step 3: If stale rows remain, make the seed deterministic**

If verification shows stale or duplicate rows from previous runs, update `scripts/seed.ts` so the seeded DB is deterministic. Minimal acceptable options:

1. delete and recreate the DB before seeding, or
2. clear `card_catalog` before reinserting snapshot rows, or
3. switch to an `insert ... on conflict do update` pattern for the seed path

Prefer the smallest deterministic fix that matches current seed expectations.

**Step 4: Re-run seed after the determinism fix**

Run: `npm run seed`

Expected: repeated runs produce the same catalog contents.

---

### Task 5: Run the targeted regression suite

**Files:**
- Verify only

**Step 1: Re-run the seed regression test**

Run: `npx vitest run tests/seed-script.test.ts`

Expected: PASS. The catalog count assertion and `Limiter Removal` assertion should now succeed.

**Step 2: Re-run the draft route regression tests**

Run: `npx vitest run tests/drafts-route.test.ts`

Expected: PASS. The draft route still resolves current pack metadata correctly from the snapshot-backed catalog.

**Step 3: Re-run the draft pick regression tests**

Run: `npx vitest run tests/draft-pick.test.ts`

Expected: PASS. The draft flow still works with the larger offline catalog.

**Step 4: Re-run the current UI regressions related to the draft room**

Run: `npx vitest run tests/components/use-draft-countdown.test.tsx tests/components/use-draft-expiry-resync.test.tsx tests/components/card-grid.test.tsx`

Expected: PASS. The catalog swap should not break countdown, expiry resync, or grid rendering.

---

### Task 6: Refresh running services and manually verify the live room

**Files:**
- Verify only

**Step 1: Restart the web and bot containers**

Run: `docker compose restart web bot`

Expected: both services come back up against the newly seeded SQLite file.

**Step 2: Verify service status**

Run: `docker compose ps web bot`

Expected: both services show `Up`.

**Step 3: Manual live-room verification**

Open `http://localhost:3000/draft/legendary-draft` and confirm:

1. Pack cards display correct names and matching images
2. Cards outside the old handwritten demo list appear normally
3. The prior mismatch case no longer shows `Limiter Removal` art with `Pot of Greed` text
4. Timer countdown and expiry resync still behave as expected

**Step 4: Optional cleanup note**

If the snapshot file is large, do not try to hand-edit it later. Refresh it only through `npm run snapshot:draft-catalog` so changes stay deterministic and reviewable.
