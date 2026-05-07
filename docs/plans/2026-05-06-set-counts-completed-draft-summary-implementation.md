# Set Counts And Completed Draft Summary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show filtered draft-eligible set counts in set search/browse and render a persistent completed-draft summary screen with the participant's full final pool.

**Architecture:** Keep one draft URL and make the server response the source of truth for both searchable set counts and completed draft recap data. Backfill filtered set counts into `card_sets` from local seed data when available, lazily hydrate missing counts for searched sets, and render completed drafts from summary payloads instead of the live draft store. Use `@ui-ux-pro-max` and `@frontend-design` guidance to keep the completed screen sharp, competitive, and archival without drifting into generic dashboard UI.

**Tech Stack:** Next.js App Router, React, TypeScript, better-sqlite3, Vitest, Testing Library

---

### Task 1: Hydrate filtered set counts in the catalog service

**Files:**
- Modify: `packages/shared/src/services/card-catalog.ts`
- Test: `packages/shared/tests/services/card-catalog.test.ts`

**Step 1: Write the failing test**

Add a test proving searched set counts are filtered and persisted:

```ts
it("hydrates missing searched set counts using filtered draft-eligible cards", async () => {
  const elementalHero = {
    id: 21844576,
    name: "Elemental HERO Avian",
    type: "Warrior / Normal Monster",
    frameType: "normal",
    card_images: [{ image_url: "https://img/full/avian", image_url_small: "https://img/small/avian" }],
    card_sets: [{ set_name: "Elemental Energy" }],
  };
  const fusionCard = {
    id: 35809262,
    name: "Elemental HERO Shining Flare Wingman",
    type: "Warrior / Fusion Monster",
    frameType: "fusion",
    card_images: [{ image_url: "https://img/full/wingman", image_url_small: "https://img/small/wingman" }],
    card_sets: [{ set_name: "Elemental Energy" }],
  };

  const app = setup({ "Elemental Energy": [elementalHero, fusionCard] });
  app.db
    .prepare("insert into card_sets (set_name, set_code, card_count, synced_at) values (?, ?, ?, datetime('now'))")
    .run("Elemental Energy", "EEN", null);

  const results = await app.catalog.listSets("elemental");

  expect(results).toEqual([
    expect.objectContaining({ setName: "Elemental Energy", setCode: "EEN", cardCount: 1 }),
  ]);
  expect(app.db.prepare("select card_count from card_sets where set_name = ?").get("Elemental Energy")).toEqual({ card_count: 1 });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/tests/services/card-catalog.test.ts`

Expected: FAIL because `listSets` returns `0` or raw counts and does not backfill filtered counts.

**Step 3: Write minimal implementation**

Implement an async `listSets` path that:

```ts
async function resolveFilteredCount(setName: string, existingCount: number | null) {
  if (typeof existingCount === "number" && existingCount > 0) {
    return existingCount;
  }

  const fetched = await fetchCards("cardset", setName);
  const filtered = fetched.filter((card) => !isExtraDeckCard(card));
  const count = filtered.length > 0 ? filtered.length : fetched.length;

  db.prepare("update card_sets set card_count = ? where set_name = ?").run(count, setName);
  return count;
}
```

Use this helper inside `listSets` for rows whose `card_count` is null/zero so searched results stop rendering `0 cards`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/tests/services/card-catalog.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/services/card-catalog.ts packages/shared/tests/services/card-catalog.test.ts
git commit -m "fix draft set counts for filtered search results"
```

### Task 2: Seed local filtered counts and expose them through `/api/sets`

**Files:**
- Modify: `scripts/seed.ts`
- Modify: `packages/web/app/api/sets/route.ts`
- Test: `packages/web/tests/seed-script.test.ts`
- Create: `packages/web/tests/sets-route.test.ts`

**Step 1: Write the failing tests**

Add one seed assertion and one route assertion:

```ts
const spellRulerSet = db
  .prepare("select set_code, card_count from card_sets where set_name = 'Spell Ruler'")
  .get() as { set_code: string; card_count: number } | undefined;

expect(spellRulerSet).toEqual({
  set_code: "SRL",
  card_count: expect.any(Number),
});
expect(spellRulerSet?.card_count).toBeGreaterThan(0);
```

```ts
const { GET } = await import("../app/api/sets/route");
const response = await GET(new NextRequest("http://localhost/api/sets?q=spell"));
const payload = await response.json();

expect(payload.sets).toContainEqual(
  expect.objectContaining({ setName: "Spell Ruler", setCode: "SRL", cardCount: expect.any(Number) })
);
expect(payload.sets[0].cardCount).toBeGreaterThan(0);
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/seed-script.test.ts packages/web/tests/sets-route.test.ts`

Expected: FAIL because `card_sets` is not fully seeded and `/api/sets` still returns zero-valued counts.

**Step 3: Write minimal implementation**

In `scripts/seed.ts`, derive filtered per-set counts from snapshot cards and repopulate `card_sets`:

```ts
const setCounts = new Map<string, { setCode: string; cardCount: number }>();

for (const card of draftCatalogSnapshot.cards) {
  for (const setName of card.cardSets) {
    const entry = setCounts.get(setName) ?? { setCode: deriveSetCode(setName), cardCount: 0 };
    entry.cardCount += 1;
    setCounts.set(setName, entry);
  }
}
```

Then insert rows into `card_sets` before the seed completes. In `packages/web/app/api/sets/route.ts`, await the new async `catalog.listSets(query)`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/seed-script.test.ts packages/web/tests/sets-route.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add scripts/seed.ts packages/web/app/api/sets/route.ts packages/web/tests/seed-script.test.ts packages/web/tests/sets-route.test.ts
git commit -m "seed filtered set counts for draft set search"
```

### Task 3: Return participant pool data for completed drafts

**Files:**
- Modify: `packages/web/app/api/drafts/[slug]/helpers.ts`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
- Test: `packages/web/tests/drafts-route.test.ts`

**Step 1: Write the failing test**

Add a completed-draft route test:

```ts
it("returns the participant pool for completed drafts", async () => {
  const response = await GET(new Request("http://localhost/api/drafts/retro-draft"), {
    params: Promise.resolve({ slug: "retro-draft" }),
  });

  const payload = await response.json();

  expect(payload.status).toBe("completed");
  expect(payload.myPool.length).toBeGreaterThan(0);
  expect(payload.participantPickCount).toBe(payload.myPool.length);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/drafts-route.test.ts`

Expected: FAIL because completed-draft payloads do not reliably surface the participant's final pool for summary rendering.

**Step 3: Write minimal implementation**

Keep pool hydration available for completed participants and simplify page branching:

```ts
const myPoolCards = currentPlayer && isParticipant
  ? drafts.pool(draft.id, currentPlayer.id).map((card) => ({
      draftCardId: card.draftCardId,
      catalogCardId: card.catalogCardId,
    }))
  : [];

const shouldRenderSummary = draft.status === "completed" || draft.status === "cancelled";
```

Make sure `page.tsx` uses only `draft.status` from the fresh fetch to choose the summary view, so completion refreshes to the right screen.

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/drafts-route.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/web/app/api/drafts/[slug]/helpers.ts packages/web/app/(app)/draft/[slug]/page.tsx packages/web/tests/drafts-route.test.ts
git commit -m "fix completed draft summary payload"
```

### Task 4: Render a real completed summary screen with the full pool inline

**Files:**
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx`
- Test: `packages/web/tests/components/draft-summary-view.test.tsx`
- Optional Test: `packages/web/tests/components/draft-detail-page.test.tsx`

**Step 1: Write the failing tests**

Add assertions for the inline pool section and participant-only visibility:

```tsx
it("shows the participant's full drafted pool inline on completed drafts", () => {
  render(
    <DraftSummaryView
      draft={{
        ...baseDraft,
        participantPickCount: 15,
        myPool: [
          { id: 1, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "", imageUrlSmall: "" },
        ],
      } as any}
      isParticipant={true}
      onExportYdk={vi.fn().mockResolvedValue("#main")}
    />
  );

  expect(screen.getByText(/your drafted pool/i)).toBeTruthy();
  expect(screen.getByText("Dark Magician")).toBeTruthy();
});

it("hides the pool section for non-participants", () => {
  render(<DraftSummaryView draft={{ ...baseDraft, myPool: [] } as any} isParticipant={false} onExportYdk={vi.fn()} />);
  expect(screen.queryByText(/your drafted pool/i)).toBeNull();
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/draft-summary-view.test.tsx`

Expected: FAIL because the completed summary does not render the drafted pool inline.

**Step 3: Write minimal implementation**

Update the summary component to add a first-class pool section that follows the current brand context from `.impeccable.md`:

```tsx
{isCompleted && isParticipant && draft.myPool?.length ? (
  <section className="rounded-xl border border-border bg-surface p-6">
    <h2 className="font-display text-lg text-text-primary">Your Drafted Pool</h2>
    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {draft.myPool.map((card) => (
        <div key={card.id} className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3">
          <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{card.name}</span>
        </div>
      ))}
    </div>
  </section>
) : null}
```

Apply `@ui-ux-pro-max` and `@frontend-design` constraints while implementing:
- preserve high contrast and visible focus states
- avoid modal-first recap UX
- keep layout responsive without horizontal scroll
- promote the pool block as a primary recap surface, not a secondary utility action

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/draft-summary-view.test.tsx`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-summary-view.tsx packages/web/tests/components/draft-summary-view.test.tsx
git commit -m "add completed draft recap with inline pool"
```

### Task 5: Verify integrated behavior end-to-end

**Files:**
- No code changes required unless verification exposes a bug

**Step 1: Run targeted tests**

Run:

```bash
npx vitest run packages/shared/tests/services/card-catalog.test.ts packages/web/tests/sets-route.test.ts packages/web/tests/seed-script.test.ts packages/web/tests/drafts-route.test.ts packages/web/tests/components/draft-summary-view.test.tsx
```

Expected: PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS

**Step 3: Reset local data and manually verify**

Run: `npm run reset:test-data`

Manual checks:
- Search sets like `elem` and confirm rows no longer show `0 cards` once hydrated.
- Finish `legendary-draft` and confirm the page switches to the completed summary screen.
- Revisit the completed draft URL and confirm the same summary renders again.
- Confirm participants see their full pool inline and non-participants do not.

**Step 4: Commit**

```bash
git add .
git commit -m "complete draft summary and filtered set count verification"
```
