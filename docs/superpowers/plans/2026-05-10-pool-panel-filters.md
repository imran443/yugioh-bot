# Pool Panel Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the active draft pool panel, replace spell/trap summary icons with provided game SVGs, and add Normal Monster / Effect Monster filters.

**Architecture:** Keep changes focused to the active draft page layout, pool panel component, pool panel tests, and static SVG assets. Use public SVG files for authentic icons so their internal white text renders unchanged.

**Tech Stack:** Next.js React client components, Tailwind CSS, `next/image`, Vitest, Testing Library, jsdom.

---

## File Structure

- Create: `packages/web/public/icons/spell.svg`
  - Public spell icon copied from `/mnt/d/Libraries/Pictures/Screenshots/SPELL.svg`.
- Create: `packages/web/public/icons/trap.svg`
  - Public trap icon copied from `/mnt/d/Libraries/Pictures/Screenshots/TRAP.svg`.
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`
  - Widen desktop pool column from `17.5rem` to `22rem`.
- Modify: `packages/web/src/components/draft/pool-panel.tsx`
  - Add Normal Monster and Effect Monster filters and render provided SVG icons.
- Modify: `packages/web/tests/components/pool-panel.test.tsx`
  - Add regression coverage for width, SVG icons, and monster subtype filtering.

## Task 1: Add Failing Pool Panel Tests

**Files:**
- Modify: `packages/web/tests/components/pool-panel.test.tsx`

- [ ] **Step 1: Update base test state for current store shape**

Add `previewCardId: null` to `baseState` after `pickSeconds: 60`:

```ts
const baseState: DraftState = {
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
  previewCardId: null,
  selectedCardId: null,
  highlightedIndex: -1,
};
```

- [ ] **Step 2: Add an effect monster to draftedPool**

Append this card to `draftedPool` after `Summoned Skull`:

```ts
  {
    id: 505,
    name: "Breaker the Magical Warrior",
    type: "Spellcaster / Effect Monster",
    frameType: "effect",
    effectText: "If this card is Normal Summoned: Place 1 Spell Counter on it.",
    attribute: "DARK",
    level: 4,
    atk: 1600,
    def: 1000,
    imageUrl: "https://img/full/505",
    imageUrlSmall: "https://img/small/505",
  },
```

- [ ] **Step 3: Update full-pool summary count expectations**

In `shows full-pool summary counts`, change the drafted count and monster count expectations:

```ts
expectDraftedSoFarCount(5);
expectSummaryCount("Monsters", 3);
expectSummaryCount("Spells", 1);
expectSummaryCount("Traps", 1);
```

- [ ] **Step 4: Replace broad monster filter test coverage**

Replace the `combines name and type filters` test with:

```ts
it("filters visible cards by normal and effect monster pills", () => {
  renderPoolPanel(draftedPool);
  const poolPanel = getPoolPanelContainer();

  const normalButton = within(poolPanel).getByRole("button", { name: /normal monsters/i });
  const effectButton = within(poolPanel).getByRole("button", { name: /effect monsters/i });

  fireEvent.click(normalButton);

  expect(normalButton).toHaveAttribute("aria-pressed", "true");
  expect(within(poolPanel).getByText("Blue-Eyes White Dragon")).toBeTruthy();
  expect(within(poolPanel).getByText("Summoned Skull")).toBeTruthy();
  expect(within(poolPanel).queryByText("Breaker the Magical Warrior")).toBeNull();
  expect(within(poolPanel).queryByText("Mystical Space Typhoon")).toBeNull();
  expect(within(poolPanel).queryByText("Trap Hole")).toBeNull();

  fireEvent.click(effectButton);

  expect(effectButton).toHaveAttribute("aria-pressed", "true");
  expect(within(poolPanel).getByText("Breaker the Magical Warrior")).toBeTruthy();
  expect(within(poolPanel).queryByText("Blue-Eyes White Dragon")).toBeNull();
  expect(within(poolPanel).queryByText("Summoned Skull")).toBeNull();
});
```

- [ ] **Step 5: Update spellcaster monster test button name**

In `treats spellcaster monsters as monsters instead of spells`, replace:

```ts
fireEvent.click(within(poolPanel).getByRole("button", { name: /monsters/i }));
```

with:

```ts
fireEvent.click(within(poolPanel).getByRole("button", { name: /effect monsters/i }));
```

- [ ] **Step 6: Add SVG icon test**

Add this test after `shows full-pool summary counts`:

```ts
it("uses game spell and trap SVG icons in the summary cards", () => {
  renderPoolPanel(draftedPool);

  expect(screen.getByAltText("Spell cards")).toHaveAttribute("src", "/icons/spell.svg");
  expect(screen.getByAltText("Trap cards")).toHaveAttribute("src", "/icons/trap.svg");
});
```

- [ ] **Step 7: Run pool panel tests and verify failure**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/pool-panel.test.tsx
```

Expected: FAIL because `Effect Monsters` / `Normal Monsters` buttons and SVG image icons are not implemented yet.

## Task 2: Implement Pool Panel Filters And Icons

**Files:**
- Create: `packages/web/public/icons/spell.svg`
- Create: `packages/web/public/icons/trap.svg`
- Modify: `packages/web/src/components/draft/pool-panel.tsx`

- [ ] **Step 1: Copy SVG assets**

Copy the provided SVG files exactly:

```bash
mkdir -p packages/web/public/icons
cp /mnt/d/Libraries/Pictures/Screenshots/SPELL.svg packages/web/public/icons/spell.svg
cp /mnt/d/Libraries/Pictures/Screenshots/TRAP.svg packages/web/public/icons/trap.svg
```

- [ ] **Step 2: Update imports and filter types**

In `pool-panel.tsx`, remove `Scroll` and `ShieldAlert` from the Lucide import and update `PoolFilter`:

```ts
import { Layers, Swords, ChevronUp, Download, ArrowUpDown } from "lucide-react";

type PoolFilter = "all" | "effect" | "normal" | "spell" | "trap";
```

- [ ] **Step 3: Add monster subtype helpers**

Add these helpers after `isTrap`:

```ts
function isEffectMonster(card: DraftCardDetail) {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "effect" || card.type.toLowerCase().includes("effect monster"));
}

function isNormalMonster(card: DraftCardDetail) {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "normal" || card.type.toLowerCase().includes("normal monster"));
}
```

- [ ] **Step 4: Update filter predicate**

In the `matchesFilter` expression, replace the monster branch with effect and normal branches:

```ts
const matchesFilter =
  activeFilter === "all" ||
  (activeFilter === "effect" && isEffectMonster(card)) ||
  (activeFilter === "normal" && isNormalMonster(card)) ||
  (activeFilter === "spell" && isSpell(card.type)) ||
  (activeFilter === "trap" && isTrap(card.type));
```

- [ ] **Step 5: Update filter button definitions**

Replace `filterButtons` with:

```ts
const filterButtons: Array<{ label: string; value: PoolFilter }> = [
  { label: "All", value: "all" },
  { label: "Effect Monsters", value: "effect" },
  { label: "Normal Monsters", value: "normal" },
  { label: "Spells", value: "spell" },
  { label: "Traps", value: "trap" },
];
```

- [ ] **Step 6: Replace spell/trap summary icons**

Replace the spell summary icon:

```tsx
<Scroll className="mb-1 h-4 w-4 text-accent-gold" aria-hidden="true" />
```

with:

```tsx
<Image src="/icons/spell.svg" alt="Spell cards" width={20} height={20} className="mb-1 h-5 w-5" />
```

Replace the trap summary icon:

```tsx
<ShieldAlert className="mb-1 h-4 w-4 text-accent-cta" aria-hidden="true" />
```

with:

```tsx
<Image src="/icons/trap.svg" alt="Trap cards" width={20} height={20} className="mb-1 h-5 w-5" />
```

- [ ] **Step 7: Run pool panel tests and verify pass**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/pool-panel.test.tsx
```

Expected: PASS.

## Task 3: Widen Desktop Pool Column

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

- [ ] **Step 1: Update desktop grid column width**

Replace:

```tsx
<div className="grid gap-8 xl:grid-cols-[15rem_minmax(0,1fr)_17.5rem]">
```

with:

```tsx
<div className="grid gap-8 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
```

- [ ] **Step 2: Run active draft UI tests**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/card-grid.test.tsx tests/components/draft-card-preview.test.tsx tests/components/timer-bar.test.tsx tests/components/pool-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run web build**

Run:

```bash
npm run build --workspace=@yugioh-discord-bot/web
```

Expected: Build succeeds. Existing Turbopack/worktree root warnings are acceptable if there are no new errors.

## Self-Review

- Spec coverage: Tasks cover desktop width, SVG icon assets, SVG rendering, Normal Monster / Effect Monster filters, and regression verification.
- Placeholder scan: No placeholder or unspecified implementation steps remain.
- Type consistency: `PoolFilter` values in tests and implementation are `all`, `effect`, `normal`, `spell`, and `trap`.
