# Draft Pool Tribute/Level Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tribute-tier (monster level) filter to the draft pool panel so drafters can filter their pool by summon cost: No Tribute (Lv 1–4), 1 Tribute (Lv 5–6), 2 Tributes (Lv 7+).

**Architecture:** Pure UI feature in the web package. A new pure helper `tributeTierForLevel` in `card-types.ts` maps a monster level to a tier. The shared `CardPoolGrid` component gains a single-select tribute-filter row beneath the existing type-filter row; the tier is ANDed with the existing type filter + search inside the current `visible` `useMemo`. `level` already flows DB → API → store → component, so no backend/DB/API changes.

**Tech Stack:** TypeScript, React, Next.js, Vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-05-20-draft-pool-tribute-filter-design.md`

---

## File Structure

- `packages/web/src/lib/card-types.ts` — add `TributeTier` type + `tributeTierForLevel` helper (pure, alongside existing `isMonster`/`isEffectMonster` predicates).
- `packages/web/tests/card-types.test.ts` — unit tests for the helper.
- `packages/web/src/components/cards/card-pool-grid.tsx` — add tribute filter state, button row, and predicate.
- `packages/web/tests/components/card-pool-grid.test.tsx` — component tests for the new filter.

---

## Task 1: `tributeTierForLevel` helper

**Files:**
- Modify: `packages/web/src/lib/card-types.ts`
- Test: `packages/web/tests/card-types.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/web/tests/card-types.test.ts`, add `tributeTierForLevel` to the import block at the top (it currently imports `isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeLabel, type CardSummary`):

```ts
import {
  isMonster,
  isSpell,
  isTrap,
  isEffectMonster,
  isNormalMonster,
  getTypeLabel,
  tributeTierForLevel,
  type CardSummary,
} from "../src/lib/card-types";
```

Then add this test inside the existing `describe("card-types", () => { ... })` block, after the `"labels card types"` test:

```ts
  it("maps monster level to a tribute tier", () => {
    expect(tributeTierForLevel(undefined)).toBeNull();
    expect(tributeTierForLevel(null)).toBeNull();
    expect(tributeTierForLevel(1)).toBe("none");
    expect(tributeTierForLevel(4)).toBe("none");
    expect(tributeTierForLevel(5)).toBe("one");
    expect(tributeTierForLevel(6)).toBe("one");
    expect(tributeTierForLevel(7)).toBe("two");
    expect(tributeTierForLevel(12)).toBe("two");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/card-types.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — `tributeTierForLevel is not a function` (or an import/type error).

- [ ] **Step 3: Write minimal implementation**

In `packages/web/src/lib/card-types.ts`, add at the end of the file (after `getTypeLabel`):

```ts
export type TributeTier = "none" | "one" | "two";

// null = not a leveled monster (spells/traps, or no level), so it only ever
// matches the "Any" tribute selection.
export function tributeTierForLevel(level: number | null | undefined): TributeTier | null {
  if (level == null) return null;
  if (level <= 4) return "none";
  if (level <= 6) return "one";
  return "two";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/card-types.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (all `card-types` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/card-types.ts packages/web/tests/card-types.test.ts
git commit -m "feat(web): add tributeTierForLevel helper for draft pool filtering"
```

---

## Task 2: Tribute filter row in `CardPoolGrid`

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx`
- Test: `packages/web/tests/components/card-pool-grid.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `packages/web/tests/components/card-pool-grid.test.tsx`, add this leveled-card fixture immediately after the existing `const cards: CardSummary[] = [ ... ];` block (around line 21):

```tsx
const leveledCards: CardSummary[] = [
  { id: 10, name: "Low Monster", type: "Beast / Normal Monster", frameType: "normal", level: 4, effectText: "...", imageUrl: "u10", imageUrlSmall: "s10" },
  { id: 11, name: "Mid Monster", type: "Beast / Effect Monster", frameType: "effect", level: 6, effectText: "...", imageUrl: "u11", imageUrlSmall: "s11" },
  { id: 12, name: "High Monster", type: "Dragon / Effect Monster", frameType: "effect", level: 8, effectText: "...", imageUrl: "u12", imageUrlSmall: "s12" },
  { id: 13, name: "Plain Spell", type: "Spell Card", frameType: "spell", effectText: "...", imageUrl: "u13", imageUrlSmall: "s13" },
];
```

Then add these tests inside the existing `describe("CardPoolGrid", () => { ... })` block (e.g. after the `"narrows by type filter"` test near line 44):

```tsx
  it("narrows by tribute tier: No Trib shows only level 1-4 monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^no trib$/i }));
    expect(screen.getByRole("button", { name: /preview low monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview mid monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview high monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview plain spell/i })).toBeNull();
  });

  it("narrows by tribute tier: 1 Trib shows only level 5-6 monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^1 trib$/i }));
    expect(screen.getByRole("button", { name: /preview mid monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview low monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview high monster/i })).toBeNull();
  });

  it("narrows by tribute tier: 2 Trib shows only level 7+ monsters", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^2 trib$/i }));
    expect(screen.getByRole("button", { name: /preview high monster/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preview low monster/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview mid monster/i })).toBeNull();
  });

  it("ANDs the tribute tier with the type filter, yielding the no-match message for impossible combos", () => {
    render(<CardPoolGrid cards={leveledCards} />);
    fireEvent.click(screen.getByRole("button", { name: /^spells$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^1 trib$/i }));
    expect(screen.getByText(/no cards match/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — `getByRole("button", { name: /^no trib$/i })` finds no matching element (the tribute buttons don't exist yet).

- [ ] **Step 3: Add the import**

In `packages/web/src/components/cards/card-pool-grid.tsx`, replace the existing card-types import (lines 10–13):

```tsx
import {
  isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeBadgeClass, getTypeLabel,
  type CardSummary,
} from "@/lib/card-types";
```

with:

```tsx
import {
  isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeBadgeClass, getTypeLabel,
  tributeTierForLevel,
  type CardSummary, type TributeTier,
} from "@/lib/card-types";
```

- [ ] **Step 4: Add the tribute type alias and button config**

In the same file, after the `type PoolSort = ...` line (line 16), add:

```tsx
type PoolTribute = "any" | TributeTier;
```

After the `SORT_BUTTONS` array (ends line 77), add:

```tsx
const TRIBUTE_BUTTONS: Array<{ label: string; value: PoolTribute }> = [
  { label: "Any", value: "any" },
  { label: "No Trib", value: "none" },
  { label: "1 Trib", value: "one" },
  { label: "2 Trib", value: "two" },
];
```

- [ ] **Step 5: Add the state hook**

In `CardPoolGridBase`, after the `const [activeSort, setActiveSort] = useState<PoolSort>("newest");` line (line 93), add:

```tsx
  const [activeTribute, setActiveTribute] = useState<PoolTribute>("any");
```

- [ ] **Step 6: Apply the tribute predicate in the `visible` memo**

In the `visible` `useMemo` (lines 113–132), update the per-card filter so the tribute tier is ANDed in. Replace:

```tsx
    let list = cards.filter((card) => {
      const matchSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchFilter =
        activeFilter === "all" ||
        (activeFilter === "effect" && isEffectMonster(card)) ||
        (activeFilter === "normal" && isNormalMonster(card)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      return matchSearch && matchFilter;
    });
```

with:

```tsx
    let list = cards.filter((card) => {
      const matchSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchFilter =
        activeFilter === "all" ||
        (activeFilter === "effect" && isEffectMonster(card)) ||
        (activeFilter === "normal" && isNormalMonster(card)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      const matchTribute =
        activeTribute === "any" || tributeTierForLevel(card.level) === activeTribute;
      return matchSearch && matchFilter && matchTribute;
    });
```

Then add `activeTribute` to the memo's dependency array. Replace:

```tsx
  }, [cards, deferredSearch, activeFilter, activeSort]);
```

with:

```tsx
  }, [cards, deferredSearch, activeFilter, activeSort, activeTribute]);
```

- [ ] **Step 7: Render the tribute filter row**

In the JSX, insert a new button row immediately after the existing type-filter `<div>` (which closes at line 225, right before the sort row at line 227). Add:

```tsx
      <div className="flex flex-wrap gap-1.5">
        {TRIBUTE_BUTTONS.map((tb) => (
          <Button key={tb.value} type="button" size="sm" variant={activeTribute === tb.value ? "secondary" : "ghost"}
            onClick={() => setActiveTribute(tb.value)} aria-pressed={activeTribute === tb.value} className="rounded-full px-3 text-xs">
            {tb.label}
          </Button>
        ))}
      </div>
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — all `CardPoolGrid` tests green, including the four new tribute tests.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat(web): add tribute-tier filter row to draft pool grid"
```

---

## Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full web test suite**

Run: `npm test --workspace=packages/web`
Expected: PASS — no regressions across the web package (card-types, card-pool-grid, and all other suites green).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no new type errors. (Note: `tributeTierForLevel` accepts `number | null | undefined`, and `CardSummary.level` is `number | undefined`, so `card.level` passes cleanly.)

- [ ] **Step 3: Manual UI check (cannot be automated)**

Start the web dev server (`npm run dev:web`), open an active draft, and confirm in the right-side "Your Pool" panel:
- A new row of buttons `Any / No Trib / 1 Trib / 2 Trib` appears beneath the `All / Effect Monsters / Normal Monsters / Spells / Traps` row.
- Clicking `1 Trib` shows only level 5–6 monsters; `Any` restores the full pool.
- The tribute filter combines with a type filter (e.g. `Normal Monsters` + `2 Trib`).
- Also spot-check the my-cubes editor (which reuses `CardPoolGrid`): the same row appears and defaults to `Any` with no behavior change.

---

## Self-Review notes

- **Spec coverage:** tier mapping (Task 1), button row + location beneath type filters (Task 2 Steps 4/7), independent AND with type filter (Task 2 Step 6), shared-component appearance in cube editor (Task 3 Step 3), no backend changes (no such tasks — by design). All covered.
- **Type consistency:** `TributeTier` = `"none" | "one" | "two"` defined in Task 1 and imported in Task 2; `PoolTribute` = `"any" | TributeTier`; `TRIBUTE_BUTTONS` values and `activeTribute` state both typed `PoolTribute`; `tributeTierForLevel(card.level)` compared against `activeTribute` (a `TributeTier` once narrowed past `"any"`). Consistent.
- **No placeholders:** every code step shows the full code and exact run command.
