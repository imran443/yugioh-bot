# Draft Card Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active draft floating hover popup with a stable desktop left-side preview panel that uses full-resolution card images.

**Architecture:** Keep this change contained to `CardGrid` and its component tests. The grid remains the source of card interaction, while a new desktop-only preview region renders the active hovered/focused/keyboard-highlighted card without overlapping available picks.

**Tech Stack:** Next.js React client component, Zustand draft store, `next/image`, Tailwind CSS, Vitest, Testing Library, jsdom.

---

## File Structure

- Modify: `packages/web/tests/components/card-grid.test.tsx`
  - Owns regression coverage for pick behavior, grid density, and preview panel behavior.
- Modify: `packages/web/src/components/draft/card-grid.tsx`
  - Owns current pack rendering, card interaction, keyboard shortcuts, and the new desktop preview panel.
- Read-only reference: `docs/superpowers/specs/2026-05-10-draft-card-preview-design.md`
  - Approved behavior and scope.

## Task 1: Update CardGrid Preview Tests

**Files:**
- Modify: `packages/web/tests/components/card-grid.test.tsx`

- [ ] **Step 1: Replace the floating-popup regression test with a sticky preview-panel test**

Replace the existing test named `renders a fixed overlapping hover preview for desktop inspection` with this test:

```tsx
it("renders a sticky desktop preview panel that uses the full image", async () => {
  useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

  render(<CardGrid />);

  expect(screen.getByTestId("card-preview-empty")).toHaveTextContent(/hover a card/i);

  await act(async () => {
    fireEvent.mouseEnter(screen.getByRole("option", { name: /mirror force/i }));
  });

  const preview = screen.getByTestId("card-preview-panel");
  const previewArt = screen.getByTestId("card-preview-art");
  const previewImage = screen.getByTestId("card-preview-image");

  expect(document.querySelector(".pointer-events-none.fixed.z-30")).toBeNull();
  expect(preview).toHaveClass("sticky");
  expect(preview).toHaveClass("hidden");
  expect(preview).toHaveClass("lg:block");
  expect(previewArt).toHaveClass("aspect-[421/614]");
  expect(previewImage).toHaveAttribute("src", "https://img/full/101");
  expect(previewImage).toHaveClass("object-contain");
});
```

- [ ] **Step 2: Replace the hover details test name and assertions**

Replace the existing test named `shows effect text and monster stats in the hover preview` with this test:

```tsx
it("shows compact details under the desktop preview image", async () => {
  useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

  render(<CardGrid />);

  await act(async () => {
    fireEvent.mouseEnter(screen.getByRole("option", { name: /summoned skull/i }));
  });

  expect(screen.getByTestId("card-preview-panel")).toBeTruthy();
  expect(screen.getByTestId("card-preview-details")).toBeTruthy();
  expect(screen.getByText(/fiend with dark powers/i)).toBeTruthy();
  expect(screen.getByText("ATK 2500")).toBeTruthy();
  expect(screen.getByText("DEF 1200")).toBeTruthy();
  expect(screen.getByText("DARK")).toBeTruthy();
  expect(screen.getByText("Level 6")).toBeTruthy();
});
```

- [ ] **Step 3: Add keyboard/focus preview coverage**

Add this test after the compact details test:

```tsx
it("updates the preview from focus and keyboard highlighting", async () => {
  useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

  render(<CardGrid />);

  await act(async () => {
    fireEvent.focus(screen.getByRole("option", { name: /mystical space typhoon/i }));
  });

  expect(screen.getByTestId("card-preview-image")).toHaveAttribute("src", "https://img/full/202");

  await act(async () => {
    fireEvent.keyDown(window, { key: "3" });
  });

  expect(screen.getByTestId("card-preview-image")).toHaveAttribute("src", "https://img/full/303");

  await act(async () => {
    fireEvent.keyDown(window, { key: "Escape" });
  });

  expect(screen.getByTestId("card-preview-empty")).toBeTruthy();
});
```

- [ ] **Step 4: Add image failure fallback coverage**

Add this test after the keyboard/focus test:

```tsx
it("keeps preview details visible when the full image fails", async () => {
  useDraftStore.setState({ ...baseState, currentPack: samplePack, isMyTurn: true });

  render(<CardGrid />);

  await act(async () => {
    fireEvent.mouseEnter(screen.getByRole("option", { name: /summoned skull/i }));
  });

  await act(async () => {
    fireEvent.error(screen.getByTestId("card-preview-image"));
  });

  expect(screen.getByTestId("card-preview-art")).toHaveTextContent(/no image/i);
  expect(screen.getByTestId("card-preview-details")).toHaveTextContent(/summoned skull/i);
  expect(screen.getByTestId("card-preview-details")).toHaveTextContent(/fiend with dark powers/i);
});
```

- [ ] **Step 5: Run the targeted test file and verify the new tests fail**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/card-grid.test.tsx
```

Expected: FAIL because `card-preview-panel`, `card-preview-empty`, `card-preview-art`, `card-preview-image`, and `card-preview-details` are not implemented yet, and the old fixed overlay still exists.

## Task 2: Implement Sticky Desktop Preview Panel

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx`

- [ ] **Step 1: Remove floating preview positioning state and helpers**

In `packages/web/src/components/draft/card-grid.tsx`, delete these constants and function:

```tsx
const desktopPreviewWidth = 288;
const desktopPreviewHeight = 560;
const previewMargin = 16;
const previewOverlap = 36;

function getDesktopPreviewPosition(rect: DOMRect) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rightAlignedLeft = rect.right - previewOverlap;
  const leftAlignedLeft = rect.left - desktopPreviewWidth + previewOverlap;
  const centeredLeft = rect.left + rect.width / 2 - desktopPreviewWidth / 2;
  const left =
    rightAlignedLeft + desktopPreviewWidth + previewMargin <= viewportWidth
      ? rightAlignedLeft
      : leftAlignedLeft >= previewMargin
        ? leftAlignedLeft
        : Math.min(
            viewportWidth - desktopPreviewWidth - previewMargin,
            Math.max(previewMargin, centeredLeft)
          );
  const top = Math.min(
    viewportHeight - desktopPreviewHeight - previewMargin,
    Math.max(previewMargin, rect.top + rect.height / 2 - desktopPreviewHeight / 2)
  );

  return { left, top };
}
```

Then replace the hover state block:

```tsx
const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
const [hoveredRect, setHoveredRect] = React.useState<DOMRect | null>(null);
```

with:

```tsx
const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
```

- [ ] **Step 2: Simplify preview update and clear helpers**

Replace:

```tsx
const updateHoveredCard = React.useCallback((card: DraftCardDetail, element: HTMLElement | null) => {
  setHoveredCard(card);
  setHoveredRect(element?.getBoundingClientRect() ?? null);
}, []);

const clearHoveredCard = React.useCallback(() => {
  setHoveredCard(null);
  setHoveredRect(null);
}, []);
```

with:

```tsx
const updateHoveredCard = React.useCallback((card: DraftCardDetail) => {
  setHoveredCard(card);
}, []);

const clearHoveredCard = React.useCallback(() => {
  setHoveredCard(null);
}, []);
```

- [ ] **Step 3: Update keyboard and focus call sites**

In the keyboard shortcut handler, replace:

```tsx
const element = document.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
updateHoveredCard(card, element);
```

with:

```tsx
updateHoveredCard(card);
```

In the card button, replace these handlers:

```tsx
onMouseEnter={(event) => {
  updateHoveredCard(card, event.currentTarget);
}}
onMouseLeave={clearHoveredCard}
onFocus={(event) => {
  updateHoveredCard(card, event.currentTarget);
}}
```

with:

```tsx
onMouseEnter={() => {
  updateHoveredCard(card);
}}
onMouseLeave={clearHoveredCard}
onFocus={() => {
  updateHoveredCard(card);
}}
```

- [ ] **Step 4: Replace preview derived values**

Replace:

```tsx
const previewPosition = hoveredRect ? getDesktopPreviewPosition(hoveredRect) : null;
const hoveredCardIsMonster = hoveredCard?.type.toLowerCase().includes("monster") ?? false;
```

with:

```tsx
const previewCard = hoveredCard;
const previewCardIsMonster = previewCard?.type.toLowerCase().includes("monster") ?? false;
```

- [ ] **Step 5: Wrap the grid in a desktop two-column layout**

Replace the return wrapper opening:

```tsx
return (
  <div className={cn("relative", className)}>
    <div
      className={cn(
        "grid gap-3 sm:gap-4",
        "grid-cols-[repeat(2,minmax(140px,1fr))]",
        "sm:grid-cols-[repeat(3,minmax(140px,1fr))]",
        "lg:grid-cols-[repeat(4,minmax(130px,1fr))]",
        "2xl:grid-cols-[repeat(6,minmax(120px,1fr))]"
      )}
      role="listbox"
      aria-label="Current pack cards"
    >
```

with:

```tsx
return (
  <div className={cn("relative lg:grid lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:gap-5", className)}>
    <aside
      data-testid="card-preview-panel"
      className="sticky top-28 hidden self-start rounded-2xl border border-border bg-bg-surface p-3 shadow-card lg:block"
      aria-label="Card preview"
    >
      {previewCard ? (
        <>
          <div
            data-testid="card-preview-art"
            className="relative isolate aspect-[421/614] w-full overflow-hidden rounded-xl bg-bg-elevated"
          >
            {imageErrors.has(previewCard.id) ? (
              <div className="flex h-full items-center justify-center text-sm text-text-secondary">
                No image
              </div>
            ) : (
              <Image
                data-testid="card-preview-image"
                src={previewCard.imageUrl}
                alt={previewCard.name}
                fill
                className="object-contain"
                sizes="(max-width: 1536px) 320px, 340px"
                onError={() => handleImageError(previewCard.id)}
              />
            )}
          </div>
          <div data-testid="card-preview-details" className="mt-3 space-y-3">
            <h3 className="font-display text-lg text-text-primary">{previewCard.name}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              {previewCard.attribute && (
                <span className="rounded-md bg-bg-elevated px-2 py-1">{previewCard.attribute}</span>
              )}
              {previewCard.level !== undefined && (
                <span className="rounded-md bg-bg-elevated px-2 py-1">Level {previewCard.level}</span>
              )}
              <span className="rounded-md bg-bg-elevated px-2 py-1">{previewCard.type}</span>
              <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize">{previewCard.frameType}</span>
            </div>
            <p className="max-h-32 overflow-auto pr-1 text-sm leading-relaxed text-text-secondary">
              {previewCard.effectText}
            </p>
            {previewCardIsMonster && (previewCard.atk !== undefined || previewCard.def !== undefined) && (
              <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
                {previewCard.atk !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" />
                    <span>ATK {previewCard.atk}</span>
                  </div>
                )}
                {previewCard.def !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" />
                    <span>DEF {previewCard.def}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div
          data-testid="card-preview-empty"
          className="flex aspect-[421/614] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-elevated/40 p-6 text-center"
        >
          <p className="font-display text-lg text-text-primary">Inspect a card</p>
          <p className="mt-2 text-sm text-text-secondary">
            Hover a card, focus it, or press 1-9 to preview the full image here.
          </p>
        </div>
      )}
    </aside>

    <div
      className={cn(
        "grid gap-3 sm:gap-4",
        "grid-cols-[repeat(2,minmax(140px,1fr))]",
        "sm:grid-cols-[repeat(3,minmax(140px,1fr))]",
        "lg:grid-cols-[repeat(4,minmax(130px,1fr))]",
        "2xl:grid-cols-[repeat(6,minmax(120px,1fr))]"
      )}
      role="listbox"
      aria-label="Current pack cards"
    >
```

- [ ] **Step 6: Delete the old desktop hover preview block**

Delete the entire block starting with:

```tsx
{/* Desktop hover preview */}
{hoveredCard && previewPosition && (
```

and ending with its matching `)}` before the final wrapper `</div>`.

- [ ] **Step 7: Run CardGrid tests and verify they pass**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/card-grid.test.tsx
```

Expected: PASS for all `CardGrid` tests.

## Task 3: Run UI Regression Verification

**Files:**
- Verify only; no planned code edits.

- [ ] **Step 1: Run active draft component tests**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/card-grid.test.tsx tests/components/timer-bar.test.tsx tests/components/pool-panel.test.tsx
```

Expected: PASS for `card-grid`, `timer-bar`, and `pool-panel` component tests.

- [ ] **Step 2: Run the web build**

Run:

```bash
npm run build --workspace=@yugioh-discord-bot/web
```

Expected: Build succeeds. Existing Turbopack/worktree root warnings are acceptable if there are no new errors.

- [ ] **Step 3: Inspect the working tree**

Run:

```bash
git status --short
```

Expected: Changes are limited to the UI branch files already in progress plus the new design/plan docs. Do not stage or commit `package-lock.json` unless a package manager command intentionally changed dependencies.

## Self-Review

- Spec coverage: Task 2 implements the desktop sticky left panel, full-image preview, prompt state, image fallback, compact details, preserved mobile grid, preserved click behavior, and preserved keyboard shortcuts. Task 1 covers the new behavior with tests. Task 3 verifies targeted components and build.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: The plan uses existing `DraftCardDetail`, `imageErrors`, `handleImageError`, `Swords`, `Shield`, `Image`, and Zustand store methods already present in `CardGrid`.
