# My Cubes Grid Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the My Cubes card grid on `/cubes/new` and `/cubes/[id]` removal-first, disable preview behavior there, and render sharper card images.

**Architecture:** Keep a single shared `CardPoolGrid` and add a narrowly scoped cube-edit mode that changes only interaction and image selection. `CardPoolEditor` opts into that mode so create and edit pages share the same behavior without changing preview-oriented grid surfaces elsewhere.

**Tech Stack:** React, Next.js client components, Vitest, Testing Library, next/image

---

### Task 1: Add Failing Card Grid Mode Tests

**Files:**
- Modify: `packages/web/tests/components/card-pool-grid.test.tsx`
- Test: `packages/web/tests/components/card-pool-grid.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add tests that render `CardPoolGrid` in cube-edit mode and assert:

```tsx
it("does not open preview on hover in cube edit mode", () => {
  render(<CardPoolGrid cards={cards} cubeEditMode />);
  fireEvent.mouseEnter(screen.getByRole("button", { name: /preview mirror force/i }));
  expect(screen.getAllByText("Mirror Force")).toHaveLength(1);
});

it("does not open preview on click in cube edit mode", () => {
  render(<CardPoolGrid cards={cards} cubeEditMode />);
  fireEvent.click(screen.getByRole("button", { name: /preview mirror force/i }));
  expect(screen.getAllByText("Mirror Force")).toHaveLength(1);
});

it("prefers the large image in cube edit mode", () => {
  render(<CardPoolGrid cards={cards} cubeEditMode />);
  expect(screen.getByAltText("Bujingi Crane")).toHaveAttribute("src", "u1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL because `cubeEditMode` behavior does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Update `CardPoolGrid` to accept a `cubeEditMode?: boolean` prop and gate:

```tsx
const previewEnabled = !cubeEditMode && !onCardClick;
const hoverEnabled = !cubeEditMode;
const tileImageUrl = cubeEditMode ? card.imageUrl || card.imageUrlSmall : card.imageUrlSmall || card.imageUrl;
```

Also remove hover styling in cube-edit mode while keeping focus-visible styling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS

### Task 2: Opt Cube Pages Into Edit Mode

**Files:**
- Modify: `packages/web/src/components/cubes/card-pool-editor.tsx`
- Test: `packages/web/tests/components/cube-editor.test.tsx`

- [ ] **Step 1: Write the failing editor test**

Add a regression test that ensures the cube editor renders the large image URL through the shared grid:

```tsx
it("uses the sharper image URLs in the cube editor grid", async () => {
  const fetchMock = stubFetch();
  vi.stubGlobal("fetch", fetchMock);

  render(<CubeEditor poolId={7} />);

  await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
  expect(screen.getByAltText("Turtle Tiger")).toHaveAttribute("src", "u1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/cube-editor.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL because the editor has not enabled cube-edit mode yet.

- [ ] **Step 3: Write minimal implementation**

Pass the new prop from `CardPoolEditor`:

```tsx
<CardPoolGrid
  cards={cards}
  cubeEditMode
  onCardClick={removeOneCopy}
  cardActionLabel={(card) => `Remove ${card.name} from cube`}
/>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/components/cube-editor.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS

### Task 3: Verify Targeted Regression Coverage

**Files:**
- Test: `packages/web/tests/components/card-pool-grid.test.tsx`
- Test: `packages/web/tests/components/cube-editor.test.tsx`
- Test: `packages/web/tests/components/card-pool-editor-create.test.tsx`

- [ ] **Step 1: Run the targeted suite**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx packages/web/tests/components/cube-editor.test.tsx packages/web/tests/components/card-pool-editor-create.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS

- [ ] **Step 2: Check for type regressions**

Run: `npm run typecheck`
Expected: PASS
