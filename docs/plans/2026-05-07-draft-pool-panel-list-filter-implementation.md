# Draft Pool Panel List and Filter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the active draft room's right rail show an always-visible drafted-card list with local name filtering and local type pills for monsters, spells, and traps.

**Architecture:** Keep all data client-side inside `PoolPanel` by deriving filtered results from `useDraftStore((s) => s.myPool)`. Preserve the existing summary counts and `Export YDK`, replace the modal-first browsing flow with an in-panel searchable list, and reuse the same panel content inside the mobile sheet for consistent behavior.

**Tech Stack:** Next.js client components, React state and `useDeferredValue`, Zustand draft store, Vitest, Testing Library, Tailwind utility classes.

---

### Task 1: Add component tests for pool browsing behavior

**Files:**
- Create: `packages/web/tests/components/pool-panel.test.tsx`
- Reference: `packages/web/src/components/draft/pool-panel.tsx`
- Reference: `packages/web/src/lib/stores/draft-store.ts`

**Step 1: Write the failing test file**

Create `packages/web/tests/components/pool-panel.test.tsx` with store-backed tests modeled after `card-grid.test.tsx`.

Include these test cases:

```tsx
// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PoolPanel } from "../../src/components/draft/pool-panel";
import { useDraftStore } from "../../src/lib/stores/draft-store";

const baseState = {
  slug: "legendary-draft",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

const samplePool = [
  { id: 1, name: "Mystic Tomato", type: "Plant / Effect Monster", frameType: "effect", effectText: "", imageUrl: "", imageUrlSmall: "" },
  { id: 2, name: "Pot of Greed", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "", imageUrlSmall: "" },
  { id: 3, name: "Mirror Force", type: "Trap Card", frameType: "trap", effectText: "", imageUrl: "", imageUrlSmall: "" },
];

describe("PoolPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState(baseState);
  });

  afterEach(() => {
    useDraftStore.setState(baseState);
  });

  it("shows an empty state when no cards have been drafted", () => {
    render(<PoolPanel />);
    expect(screen.getByText(/no cards drafted yet/i)).toBeTruthy();
  });

  it("renders full-pool summary counts", () => {
    useDraftStore.setState({ ...baseState, myPool: samplePool });
    render(<PoolPanel />);
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/monsters/i)).toBeTruthy();
    expect(screen.getByText(/spells/i)).toBeTruthy();
    expect(screen.getByText(/traps/i)).toBeTruthy();
  });

  it("filters visible cards by name", () => {
    useDraftStore.setState({ ...baseState, myPool: samplePool });
    render(<PoolPanel />);
    fireEvent.change(screen.getByPlaceholderText(/filter cards/i), { target: { value: "tomato" } });
    expect(screen.getByText(/mystic tomato/i)).toBeTruthy();
    expect(screen.queryByText(/pot of greed/i)).toBeNull();
  });

  it("filters visible cards by type pill", () => {
    useDraftStore.setState({ ...baseState, myPool: samplePool });
    render(<PoolPanel />);
    fireEvent.click(screen.getByRole("button", { name: /spells/i }));
    expect(screen.getByText(/pot of greed/i)).toBeTruthy();
    expect(screen.queryByText(/mirror force/i)).toBeNull();
  });

  it("combines name and type filters", () => {
    useDraftStore.setState({
      ...baseState,
      myPool: [
        ...samplePool,
        { id: 4, name: "Trap Hole", type: "Trap Card", frameType: "trap", effectText: "", imageUrl: "", imageUrlSmall: "" },
      ],
    });
    render(<PoolPanel />);
    fireEvent.click(screen.getByRole("button", { name: /traps/i }));
    fireEvent.change(screen.getByPlaceholderText(/filter cards/i), { target: { value: "mirror" } });
    expect(screen.getByText(/mirror force/i)).toBeTruthy();
    expect(screen.queryByText(/trap hole/i)).toBeNull();
  });
});
```

**Step 2: Run the new test file and verify it fails**

Run from `packages/web`:

```bash
npx vitest run tests/components/pool-panel.test.tsx
```

Expected: FAIL because `PoolPanel` does not yet render a searchable in-panel list or filter pills.

**Step 3: Adjust tests if needed to avoid ambiguous text assertions**

If repeated numeric text makes assertions weak, tighten the tests to target nearby labels or visible card names instead of raw counts alone.

**Step 4: Re-run the test file to keep it failing for the right reason**

Run:

```bash
npx vitest run tests/components/pool-panel.test.tsx
```

Expected: FAIL only on missing pool-panel behavior, not on test setup issues.

**Step 5: Do not commit**

The user has not asked for a commit. Leave changes uncommitted.

### Task 2: Implement the always-visible pool list and local filters

**Files:**
- Modify: `packages/web/src/components/draft/pool-panel.tsx`
- Reference: `packages/web/src/components/ui/button.tsx`
- Reference: `packages/web/src/components/ui/sheet.tsx`

**Step 1: Add local filter state and derived list helpers**

Update the imports and local state in `pool-panel.tsx`:

```tsx
import { useDeferredValue, useMemo, useState } from "react";

type PoolFilter = "all" | "monster" | "spell" | "trap";

const [searchTerm, setSearchTerm] = useState("");
const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
const deferredSearchTerm = useDeferredValue(searchTerm);
```

Add small helpers for type detection and row badge generation:

```tsx
const isMonsterCard = (type: string) => type.toLowerCase().includes("monster");
const isSpellCard = (type: string) => type.toLowerCase().includes("spell");
const isTrapCard = (type: string) => type.toLowerCase().includes("trap");

const getTypeBadge = (type: string) => {
  if (isMonsterCard(type)) return "M";
  if (isSpellCard(type)) return "S";
  if (isTrapCard(type)) return "T";
  return "?";
};
```

Derive `filteredPool` from the full store pool:

```tsx
const normalizedSearch = deferredSearchTerm.trim().toLowerCase();

const filteredPool = useMemo(() => {
  return myPool.filter((card) => {
    const matchesSearch = normalizedSearch.length === 0 || card.name.toLowerCase().includes(normalizedSearch);
    const matchesType =
      activeFilter === "all" ||
      (activeFilter === "monster" && isMonsterCard(card.type)) ||
      (activeFilter === "spell" && isSpellCard(card.type)) ||
      (activeFilter === "trap" && isTrapCard(card.type));

    return matchesSearch && matchesType;
  });
}, [myPool, normalizedSearch, activeFilter]);
```

**Step 2: Replace the modal-first browsing block with in-panel controls**

Remove:

- `showFullPool` state
- the `View Full Pool` button
- the separate `Full Pool` sheet

Add a reusable panel block that contains:

```tsx
<label className="sr-only" htmlFor="pool-search">Filter cards</label>
<input
  id="pool-search"
  value={searchTerm}
  onChange={(e) => setSearchTerm(e.target.value)}
  placeholder="Filter cards..."
  className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
/>
```

And a pill row such as:

```tsx
{[
  { value: "all", label: "All" },
  { value: "monster", label: "Monsters" },
  { value: "spell", label: "Spells" },
  { value: "trap", label: "Traps" },
].map((filter) => (
  <button
    key={filter.value}
    type="button"
    onClick={() => setActiveFilter(filter.value as PoolFilter)}
    className={cn(
      "rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
      activeFilter === filter.value
        ? "border-accent-primary bg-accent-primary/15 text-text-primary"
        : "border-border bg-bg-elevated text-text-secondary hover:text-text-primary"
    )}
  >
    {filter.label}
  </button>
))}
```

**Step 3: Render the scrollable list and empty states**

Under the controls, render a stable-height list container:

```tsx
<div className="max-h-72 space-y-2 overflow-y-auto pr-1">
  {myPool.length === 0 ? (
    <p className="text-sm text-text-secondary">No cards drafted yet.</p>
  ) : filteredPool.length === 0 ? (
    <p className="text-sm text-text-secondary">No cards match this filter.</p>
  ) : (
    filteredPool.map((card) => (
      <div key={card.id} className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/50 p-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg-elevated text-xs font-semibold text-text-secondary">
          {getTypeBadge(card.type)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{card.name}</p>
          <p className="truncate text-[11px] text-text-muted">{card.type}</p>
        </div>
      </div>
    ))
  )}
</div>
```

Keep the summary counts based on `myPool`, not `filteredPool`.

**Step 4: Reuse the same content in desktop and mobile**

Keep `panelContent` as the shared body for:

- desktop right rail
- mobile `Sheet`

Do not introduce a separate mobile implementation.

**Step 5: Keep export behavior unchanged**

Retain:

```tsx
const handleExportYDK = () => {
  downloadYdk(myPool, "draft-pool.ydk");
};
```

and keep the `Export YDK` button disabled only when the full pool is empty.

**Step 6: Do not commit**

The user has not asked for a commit. Leave changes uncommitted.

### Task 3: Verify the component behavior and workspace health

**Files:**
- Test: `packages/web/tests/components/pool-panel.test.tsx`
- Verify: `packages/web/src/components/draft/pool-panel.tsx`

**Step 1: Run the focused component test**

Run from `packages/web`:

```bash
npx vitest run tests/components/pool-panel.test.tsx
```

Expected: PASS.

**Step 2: Run related component coverage if the new panel shares behavior with existing draft room tests**

Run from `packages/web`:

```bash
npx vitest run tests/components/pool-panel.test.tsx tests/components/card-grid.test.tsx tests/components/draft-summary-view.test.tsx
```

Expected: PASS.

**Step 3: Run workspace typecheck**

Run from the repo root:

```bash
npm run typecheck
```

Expected: PASS across all workspaces.

**Step 4: Manual verification in the browser**

Check the active draft room at desktop and mobile widths:

1. Desktop right rail shows search, type pills, and a visible drafted-card list.
2. Filtering by `tomato` or similar text narrows the list instantly.
3. `Monsters`, `Spells`, and `Traps` pills narrow the list correctly.
4. Combined filter plus search works.
5. Mobile sheet shows the same controls and list.
6. `Export YDK` still works.
7. No right-rail overflow breaks the `xl` three-column layout.

**Step 5: Do not commit**

The user has not asked for a commit. Leave changes uncommitted.
