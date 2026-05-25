# Draft UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six small draft-experience improvements: smaller preview tiles, per-tier tribute counts, a clear-filters button, an attribute/type breakdown of the drafted pool, a "view full pool used" section on completed drafts, and removing the image flicker when a new pack appears.

**Architecture:** All changes are in `packages/web`. Most touch `CardPoolGrid` (the shared filterable card grid) or the draft views. Pure logic (tribute counts, breakdown aggregation) is extracted into helpers/`useMemo` so it can be unit-tested; CSS-only changes (tile size, flicker) are verified visually. No `@yugidraft/shared` changes.

**Tech Stack:** Next.js 16 App Router (client components), React 19, Zustand, `@tanstack/react-virtual`, Vitest + @testing-library/react (jsdom).

**Covers:** Tasks #9 (smaller cards), #10 (pack flicker), #11 (tribute counter), #12 (attributes/types drafted), #13 (clear-filter), #14 (view full pool on completed draft).

> **Important harness note:** `packages/web/tests/components/card-pool-grid.test.tsx` pins column-math expectations to `TILE_MIN = 144` and matches tribute buttons by **exact** accessible name (`/^no trib$/i`). Task 1 updates the column math; Task 2 preserves the accessible names via `aria-label`. Read those tasks before touching `card-pool-grid.tsx`.

---

### Task 1: Smaller preview tiles

**Decision:** Reduce the non-cube-edit `TILE_MIN` from 144 to 120 px (cube-edit stays 200). This is a CSS/layout constant; correctness is verified by the existing column-math tests, which must be updated to the new constant.

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx:160` (and the `144` fallback at line 185)
- Test: `packages/web/tests/components/card-pool-grid.test.tsx:199-224` (column-math expectations) and `:158-175` (windowing assertion)

- [ ] **Step 1: Update the column-math test expectations (they will fail first)**

In `card-pool-grid.test.tsx`, update the `describe.each` table (lines 199-203) to the values for `TILE_MIN = 120`, where `columns = floor((width - 12) / 132)`:

```ts
describe.each([
  { width: 480, columns: 3 }, // floor((480-12)/132) = floor(3.54)
  { width: 900, columns: 6 }, // floor((900-12)/132) = floor(6.72)
  { width: 1600, columns: 12 }, // floor((1600-12)/132) = floor(12.03)
])("CardPoolGrid column math at $width px", ({ width, columns }) => {
```

Update the comment above it (lines 197-198) to read `TILE_MIN=120 (default) / 200 (cube edit)`.

In the windowing test (lines 158-175), the default jsdom width is 900 → now 6 columns. Update the final assertion and its comment:

```ts
    // windowed rows are full rows: at 900px the grid is 6 columns, so the
    // rendered tile count is an exact multiple of 6 (no partial top/bottom row).
    expect(rendered.length % 6).toBe(0);
```

(The cube-edit math block at lines 214-224 stays `4` — cube-edit `TILE_MIN` is unchanged.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — column-math cases compute 5/10 (old 144), windowing expects `% 5`, against the new `% 6` / 6 / 12 assertions.

- [ ] **Step 3: Lower TILE_MIN**

In `packages/web/src/components/cards/card-pool-grid.tsx`, line 160:

```ts
    const TILE_MIN = cubeEditMode ? 200 : 120;
```

And align the `estimatedRowHeight` fallback tile width (line 185) from `144` to `120`:

```ts
    const tileW = innerWidth > 0 ? (innerWidth - (columns - 1) * GAP) / columns : 120;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Verify in the browser**

Run `npm run dev:web`. Open the create-draft form and a draft manage view; confirm the preview pool shows more, smaller tiles per row and remains readable. (Pixel sizing is not unit-testable; the column math above is the proxy.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): shrink preview pool tiles for higher density"
```

---

### Task 2: Per-tier count beside each tribute filter

**Decision:** Show a count next to each tribute button (Any = all cards; No/1/2 Trib = monsters in that level tier). Keep the button's accessible name unchanged via `aria-label` so existing tests and screen readers stay stable; the count is visible text.

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx` (count memo near line 116-120; render near line 238-245)
- Test: `packages/web/tests/components/card-pool-grid.test.tsx` (add case)

- [ ] **Step 1: Write the failing test**

Add to the `describe("CardPoolGrid", ...)` block in `card-pool-grid.test.tsx` (`leveledCards` already exists: lvl4 monster, lvl6 monster, lvl8 monster, a spell):

```ts
  it("shows a per-tier count beside each tribute filter", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    // none = 1 (lvl4), one = 1 (lvl6), two = 1 (lvl8); spell is not counted in any tier.
    expect(screen.getByRole("button", { name: /^no trib$/i }).textContent).toMatch(/1/);
    expect(screen.getByRole("button", { name: /^1 trib$/i }).textContent).toMatch(/1/);
    expect(screen.getByRole("button", { name: /^2 trib$/i }).textContent).toMatch(/1/);
    // Any counts every card.
    expect(screen.getByRole("button", { name: /^any$/i }).textContent).toMatch(/4/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — the tribute buttons render no counts.

- [ ] **Step 3: Compute the tier counts**

In `card-pool-grid.tsx`, `tributeTierForLevel` is already imported. Add a memo next to the existing `monsterCount` memo (after line 120):

```ts
  const tributeCounts = useMemo(() => {
    const c: Record<PoolTribute, number> = { any: cards.length, none: 0, one: 0, two: 0 };
    for (const card of cards) {
      const tier = tributeTierForLevel(card.level);
      if (tier) c[tier] += 1;
    }
    return c;
  }, [cards]);
```

- [ ] **Step 4: Render the count and pin the accessible name**

Replace the tribute button map (lines 239-244) with:

```tsx
        {TRIBUTE_BUTTONS.map((tb) => (
          <Button key={tb.value} type="button" size="sm" variant={activeTribute === tb.value ? "secondary" : "ghost"}
            onClick={() => setActiveTribute(tb.value)} aria-pressed={activeTribute === tb.value} aria-label={tb.label}
            className="rounded-full px-3 text-xs">
            {tb.label}
            <span className="ml-1.5 tabular-nums text-text-muted">{tributeCounts[tb.value]}</span>
          </Button>
        ))}
```

(`aria-label={tb.label}` keeps the accessible name as `No Trib`/`1 Trib`/etc., so the existing `/^no trib$/i` queries and the new count check both pass.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (new count test and all existing tribute-filter tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): show per-tier card counts beside tribute filters"
```

---

### Task 3: Clear-filters button

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx` (derive `filtersActive` + `clearFilters`; render the button)
- Test: `packages/web/tests/components/card-pool-grid.test.tsx` (add case)

- [ ] **Step 1: Write the failing test**

Add to the `describe("CardPoolGrid", ...)` block:

```ts
  it("clears all filters when Clear is clicked, and hides the button at defaults", () => {
    render(<CardPoolGrid cards={cards} />);
    // No clear button at defaults.
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
    // Apply a filter that hides a card.
    fireEvent.click(screen.getByRole("button", { name: /^traps$/i }));
    expect(screen.queryByRole("button", { name: /preview monster reborn/i })).toBeNull();
    // Clear restores everything and the button disappears again.
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByRole("button", { name: /preview monster reborn/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — no "Clear filters" button exists.

- [ ] **Step 3: Derive active-state and a reset handler**

In `card-pool-grid.tsx`, after the filter `useState` declarations (after line 107), add:

```ts
  const filtersActive =
    searchTerm !== "" || activeFilter !== "all" || activeSort !== "newest" || activeTribute !== "any";
  const clearFilters = useCallback(() => {
    setSearchTerm("");
    setActiveFilter("all");
    setActiveSort("newest");
    setActiveTribute("any");
  }, []);
```

(`useCallback` is already imported — it is used at line 109.)

- [ ] **Step 4: Render the button**

Add it at the end of the sort row, inside the `<div className="flex flex-wrap items-center gap-1.5">` that holds the sort buttons (after the `SORT_BUTTONS.map(...)` block, before that div closes around line 255):

```tsx
        {filtersActive && (
          <Button type="button" size="sm" variant="ghost" onClick={clearFilters}
            className="ml-auto rounded-full px-3 text-xs text-text-muted">
            Clear filters
          </Button>
        )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): add clear-filters button to the card pool grid"
```

---

### Task 4: Attribute/type breakdown of the drafted pool

**Decision:** Show two rows of count chips for the drafted cards: **attributes** (DARK ×4, LIGHT ×3 …, excluding the SPELL/TRAP pseudo-attributes) and **type categories** (the `CardSummary.type` field, e.g. `Effect Monster ×5`, `Spell Card ×3`). Shown in both the live `PoolPanel` and the completed `DraftSummaryView`.

> **Data note:** `card_catalog` has no `race` column (only `type`, `frame_type`, `attribute`), and `CardSummary` carries no race, so monster *races* (Dragon/Spellcaster) cannot be shown without adding a `race` column to the catalog + a ygoprodeck re-sync + plumbing it through `CardSummary`. That is out of scope here; "type" means the ygoprodeck card category. Flag to the user if races are specifically wanted.

**Files:**
- Create: `packages/web/src/lib/pool-breakdown.ts` (pure aggregation)
- Create: `packages/web/src/components/draft/pool-breakdown.tsx` (chips)
- Modify: `packages/web/src/components/draft/pool-panel.tsx` (render in `panelContent`)
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx` (render under the "Your Pool" header, ~line 266)
- Test: `packages/web/tests/pool-breakdown.test.ts` (pure) and `packages/web/tests/components/draft-summary-view.test.tsx` (add a render case)

- [ ] **Step 1: Write the failing unit test for the aggregation**

Create `packages/web/tests/pool-breakdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attributeBreakdown, typeBreakdown } from "../src/lib/pool-breakdown";
import type { CardSummary } from "../src/lib/card-types";

const card = (over: Partial<CardSummary>): CardSummary => ({
  id: 0, name: "x", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "", imageUrlSmall: "", ...over,
});

const cards: CardSummary[] = [
  card({ id: 1, type: "Effect Monster", attribute: "DARK" }),
  card({ id: 2, type: "Effect Monster", attribute: "DARK" }),
  card({ id: 3, type: "Normal Monster", attribute: "LIGHT" }),
  card({ id: 4, type: "Spell Card", attribute: "SPELL" }),
  card({ id: 5, type: "Trap Card", attribute: "TRAP" }),
];

describe("pool breakdown", () => {
  it("counts attributes, excluding SPELL/TRAP, sorted by count desc", () => {
    expect(attributeBreakdown(cards)).toEqual([
      { label: "DARK", count: 2 },
      { label: "LIGHT", count: 1 },
    ]);
  });

  it("counts type categories, sorted by count desc", () => {
    expect(typeBreakdown(cards)).toEqual([
      { label: "Effect Monster", count: 2 },
      { label: "Normal Monster", count: 1 },
      { label: "Spell Card", count: 1 },
      { label: "Trap Card", count: 1 },
    ]);
  });

  it("returns empty arrays for no cards", () => {
    expect(attributeBreakdown([])).toEqual([]);
    expect(typeBreakdown([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/pool-breakdown.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — module `../src/lib/pool-breakdown` does not exist.

- [ ] **Step 3: Implement the aggregation**

Create `packages/web/src/lib/pool-breakdown.ts`:

```ts
import type { CardSummary } from "@/lib/card-types";

export interface BreakdownEntry {
  label: string;
  count: number;
}

function sortedEntries(counts: Map<string, number>): BreakdownEntry[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}

export function attributeBreakdown(cards: CardSummary[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const a = c.attribute;
    if (!a || a === "SPELL" || a === "TRAP") continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return sortedEntries(counts);
}

export function typeBreakdown(cards: CardSummary[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const t = c.type.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return sortedEntries(counts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/pool-breakdown.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Create the chips component**

Create `packages/web/src/components/draft/pool-breakdown.tsx`:

```tsx
"use client";

import { memo } from "react";
import type { CardSummary } from "@/lib/card-types";
import { attributeBreakdown, typeBreakdown, type BreakdownEntry } from "@/lib/pool-breakdown";

function Chip({ entry }: { entry: BreakdownEntry }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-bg-elevated px-2 py-0.5 text-xs text-text-secondary">
      {entry.label}
      <span className="font-semibold tabular-nums text-text-primary">{entry.count}</span>
    </span>
  );
}

function PoolBreakdownBase({ cards }: { cards: CardSummary[] }) {
  const attrs = attributeBreakdown(cards);
  const types = typeBreakdown(cards);
  if (attrs.length === 0 && types.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {attrs.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Attributes drafted">
          {attrs.map((e) => (
            <Chip key={e.label} entry={e} />
          ))}
        </div>
      )}
      {types.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Types drafted">
          {types.map((e) => (
            <Chip key={e.label} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

export const PoolBreakdown = memo(PoolBreakdownBase);
```

- [ ] **Step 6: Write the failing render test for the summary view**

Add to `packages/web/tests/components/draft-summary-view.test.tsx` (`samplePool` has a LIGHT Normal Monster, a Spell, and a Trap):

```ts
  it("renders an attribute/type breakdown of the pool", () => {
    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />,
    );
    const attrs = screen.getByLabelText("Attributes drafted");
    expect(attrs.textContent).toContain("LIGHT");
    const types = screen.getByLabelText("Types drafted");
    expect(types.textContent).toContain("Normal Monster");
    expect(types.textContent).toContain("Spell Card");
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/draft-summary-view.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — no element labelled "Attributes drafted".

- [ ] **Step 8: Render the breakdown in the summary view**

In `packages/web/src/components/draft/draft-summary-view.tsx`, add the import:

```ts
import { PoolBreakdown } from "@/components/draft/pool-breakdown";
```

Inside the "Your Pool" block, immediately after the `<h2>` (after line 267, before the `<ul>`), add:

```tsx
          <PoolBreakdown cards={myPool} />
```

(`myPool` is in scope and already guarded by `myPool && myPool.length > 0` at line 262.)

- [ ] **Step 9: Render the breakdown in the live pool panel**

In `packages/web/src/components/draft/pool-panel.tsx`, add the import:

```ts
import { PoolBreakdown } from "@/components/draft/pool-breakdown";
```

In `panelContent`, after the "Drafted so far" header div (after line 38, before the Export button), add:

```tsx
      <PoolBreakdown cards={myPool} />
```

(`myPool` here is the raw store array, so chips count occurrences — duplicates are counted.)

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/pool-breakdown.test.ts packages/web/tests/components/draft-summary-view.test.tsx packages/web/tests/components/pool-panel.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (new tests plus existing pool-panel/summary tests).

- [ ] **Step 11: Verify in the browser**

Run the three dev servers (`npm run dev:bot`, `npm run dev:ws`, `npm run dev:web`). During a live draft, confirm the Your Pool panel shows attribute and type chips that update as you pick; on a completed draft, confirm the same breakdown appears under "Your Pool".

- [ ] **Step 12: Commit**

```bash
git add packages/web/src/lib/pool-breakdown.ts packages/web/src/components/draft/pool-breakdown.tsx packages/web/src/components/draft/pool-panel.tsx packages/web/src/components/draft/draft-summary-view.tsx packages/web/tests/pool-breakdown.test.ts packages/web/tests/components/draft-summary-view.test.tsx
git commit -m "feat(web): show attribute/type breakdown of the drafted pool"
```

---

### Task 5: View full pool used on a completed draft

**Decision:** A collapsible "View full pool used" section on the completed `DraftSummaryView` that lazily fetches `/api/drafts/[slug]/pool` (returns `{ cards }`) on first open and renders the existing `CardPoolPanel` with `countMode="copies"`.

**Files:**
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx` (state + toggle + section)
- Test: `packages/web/tests/components/draft-summary-view.test.tsx` (add a case with `fetch` mocked)

- [ ] **Step 1: Write the failing test**

Add to `draft-summary-view.test.tsx`:

```ts
  it("lazily loads and shows the full pool when expanded", async () => {
    const cards = [
      { id: 1, name: "Pot of Greed", type: "Spell Card", frameType: "spell", attribute: "SPELL", effectText: "Draw 2.", imageUrl: "u1", imageUrlSmall: "s1", qty: 3 },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cards }) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DraftSummaryView
        draft={baseDraft as any}
        isParticipant={true}
        isCreator={false}
        slug="test-draft"
        onExportYdk={vi.fn().mockResolvedValue("#main")}
        onDelete={vi.fn()}
        myPool={samplePool}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view full pool used/i }));
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/test-draft/pool");
    expect(await screen.findByText("Pot of Greed")).toBeTruthy();

    vi.unstubAllGlobals();
  });
```

(Add `fireEvent` to the existing `@testing-library/react` import at the top of the file if it is not already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/components/draft-summary-view.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — no "View full pool used" button.

- [ ] **Step 3: Add lazy-load state and a toggle**

In `draft-summary-view.tsx`, add imports:

```ts
import { CardPoolPanel } from "@/components/cards/card-pool-panel";
import type { CardSummary } from "@/lib/card-types";
```

Inside the component (near the other `React.useState` calls, ~line 66-70), add:

```ts
  const [poolOpen, setPoolOpen] = React.useState(false);
  const [fullPool, setFullPool] = React.useState<CardSummary[] | null>(null);
  const [poolLoading, setPoolLoading] = React.useState(false);

  const toggleFullPool = React.useCallback(async () => {
    const next = !poolOpen;
    setPoolOpen(next);
    if (next && fullPool === null) {
      setPoolLoading(true);
      try {
        const res = await fetch(`/api/drafts/${slug}/pool`);
        if (res.ok) {
          const data = (await res.json()) as { cards: CardSummary[] };
          setFullPool(data.cards ?? []);
        }
      } finally {
        setPoolLoading(false);
      }
    }
  }, [poolOpen, fullPool, slug]);
```

- [ ] **Step 4: Render the collapsible section**

Add this block on the completed view — a good spot is right after the "Your Pool" block closes (after line 344), so it is available to any viewer of a completed draft:

```tsx
      <div className="rounded-xl border border-border bg-surface p-6">
        <button
          type="button"
          onClick={toggleFullPool}
          aria-expanded={poolOpen}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2 font-display text-lg text-text-primary">
            <Layers className="h-5 w-5 text-accent-primary" aria-hidden="true" />
            View full pool used{fullPool ? ` (${fullPool.length})` : ""}
          </span>
          <span className="text-sm text-text-muted">{poolOpen ? "Hide" : "Show"}</span>
        </button>
        {poolOpen && (
          <div className="mt-4">
            <CardPoolPanel
              title="Full pool"
              cards={fullPool ?? []}
              loading={poolLoading}
              countMode="copies"
              showSummary
              emptyMessage="No pool data."
            />
          </div>
        )}
      </div>
```

(`Layers` is already imported at line 5.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/draft-summary-view.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS. If `CardPoolPanel`'s virtualizer needs jsdom measurement, import and call `installVirtualizerJsdomEnv()` in a `beforeEach` for this file (see `card-pool-grid.test.tsx:6,31`).

- [ ] **Step 6: Verify in the browser**

On a completed draft page, click "View full pool used"; confirm it fetches once, shows the full cube with `×N` copy counts via `CardPoolPanel`, and toggles closed/open without refetching.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/draft/draft-summary-view.tsx packages/web/tests/components/draft-summary-view.test.tsx
git commit -m "feat(web): add collapsible full-pool view to completed drafts"
```

---

### Task 6: Remove the image flicker when a new pack appears

**Root cause (confirmed):** Each pick step replaces `currentPack` with an all-new set of card ids. `CardGrid` keys each tile by `card.id` (`card-grid.tsx:203`), so every tile unmounts and its `next/image` remounts and re-requests; the tile shows the empty `bg-bg-elevated` placeholder until the new image decodes — a per-pack flash. The fix is to ensure every pack's image is already in the browser cache before it is shown, and to render from that same cache.

**Approach:** On mount of an active draft, fetch the full pool once and warm the browser cache for every card's small image. Render `CardGrid` tiles from that same raw URL (a plain cached `<img>`) so warmed images are instant cache hits. This is empirical — verify visually.

**Files:**
- Create: `packages/web/src/lib/hooks/use-pool-image-prefetch.ts`
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx` (call the hook in the active branch)
- Modify: `packages/web/src/components/draft/card-grid.tsx:231-245` (render warmed `<img>` instead of `next/image`)
- Test: visual only (flicker is not unit-testable); keep `packages/web/tests/components/card-grid.test.tsx` green.

- [ ] **Step 1: Reproduce the flicker**

Run `npm run dev:bot`, `npm run dev:ws`, `npm run dev:web`. Start a draft with ≥2 seats (use "Add bot" in dev), pick through several steps, and observe the card images blank-then-reappear each time a new pack arrives. Confirm this is the behavior being fixed.

- [ ] **Step 2: Create the prefetch hook**

Create `packages/web/src/lib/hooks/use-pool-image-prefetch.ts`:

```ts
import { useEffect } from "react";

// Warms the browser image cache for every card in a draft's pool so that when
// a new pack is shown its images are cache hits (no blank-frame flicker).
// Fetches the pool once per slug; failures are non-fatal (best-effort).
export function usePoolImagePrefetch(slug: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !slug || typeof window === "undefined") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/drafts/${slug}/pool`);
        if (!res.ok) return;
        const data = (await res.json()) as { cards: Array<{ imageUrl: string; imageUrlSmall: string }> };
        if (cancelled) return;
        for (const c of data.cards) {
          const img = new window.Image();
          img.decoding = "async";
          img.src = c.imageUrlSmall || c.imageUrl;
        }
      } catch {
        // best-effort prefetch; ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled]);
}
```

- [ ] **Step 3: Call the hook for active drafts**

In `packages/web/app/(app)/draft/[slug]/page.tsx`, add the import:

```ts
import { usePoolImagePrefetch } from "@/lib/hooks/use-pool-image-prefetch";
```

Call it unconditionally (hooks can't be conditional) near the other hook calls (~line 154), enabled only while active:

```ts
  usePoolImagePrefetch(slug, draft?.status === "active");
```

- [ ] **Step 4: Render CardGrid tiles from the warmed cache**

In `packages/web/src/components/draft/card-grid.tsx`, replace the `next/image` element (lines 236-245) with a plain `<img>` that hits the same raw URL the hook warmed:

```tsx
                ) : (
                  <img
                    src={card.imageUrlSmall || card.imageUrl}
                    alt={card.name}
                    loading="eager"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-contain motion-safe:transition-opacity motion-safe:duration-300 group-hover:opacity-95"
                    onError={() => handleImageError(card.id)}
                  />
                )}
```

Remove the now-unused `import Image from "next/image";` (line 4) if nothing else in the file uses it.

- [ ] **Step 5: Keep the card-grid component test green**

Run: `npx vitest run packages/web/tests/components/card-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS. The test queries images by role/alt (`card.name`), which a plain `<img alt>` satisfies. If any assertion depended on the `next/image` mock specifically, update it to match the plain `<img>` (same `src` = `imageUrlSmall`, same `alt`).

- [ ] **Step 6: Verify the fix visually**

Repeat the Step 1 reproduction. Confirm new packs now appear without the blank-frame flash (images are cache hits). Check a cold load too (hard-refresh): the very first pack may still warm as the prefetch runs, but subsequent packs are smooth.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/hooks/use-pool-image-prefetch.ts "packages/web/app/(app)/draft/[slug]/page.tsx" packages/web/src/components/draft/card-grid.tsx
git commit -m "fix(web): prefetch pool images to remove new-pack flicker"
```

---

## Self-Review

**Spec coverage:**
- #9 smaller cards → Task 1. ✓
- #11 tribute counter → Task 2. ✓
- #13 clear-filter → Task 3. ✓
- #12 attributes/types drafted → Task 4 (with race-data limitation flagged). ✓
- #14 view full pool on completed → Task 5. ✓
- #10 pack flicker → Task 6 (root cause + prefetch fix, visual verification). ✓

**Placeholder scan:** No TBDs. CSS-only/empirical work (Tasks 1, 6) is explicitly marked visual-verify with concrete code; everything else has unit/component tests. ✓

**Type consistency:** `BreakdownEntry { label, count }` is defined once in `pool-breakdown.ts` and consumed by `pool-breakdown.tsx` and the unit test; `attributeBreakdown`/`typeBreakdown` signatures match across test and component. `PoolTribute` (used in `tributeCounts`) is the existing type backing `TRIBUTE_BUTTONS`. The pool route's `{ cards }` shape (`pool/route.ts:53`) matches Task 5's fetch parse. ✓

**Cross-task interaction:** Tasks 1, 2, 3 all edit `card-pool-grid.tsx`; if run as separate subagents, execute in order (1 → 2 → 3) and re-run the full `card-pool-grid.test.tsx` after each. Task 4 and Task 5 both edit `draft-summary-view.tsx` (different regions: Task 4 inside the Your Pool block, Task 5 after it) — run Task 4 before Task 5 to avoid an overlapping edit.

**Note on pack-variety overlap:** Task 5 consumes `/api/drafts/[slug]/pool`, which the pack-variety Phase-0 rename will change internally (`poolCardIds`→`cubeCardIds`) but keep returning `{ cards }`; no conflict. No other task touches pack-variety files.
