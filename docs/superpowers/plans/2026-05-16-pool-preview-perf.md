# Pool Preview Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the create-draft pool preview fast — instant progressive card images and a windowed grid that renders only on-screen tiles.

**Architecture:** Extract a `CardArt` deep module (instant cached small image, optional full-res overlay that fades in on load) used by both the grid tile and the hover popup. Virtualize `CardPoolGrid` with `@tanstack/react-virtual` (derive column count from measured width, virtualize rows). Bump the Next image optimizer cache TTL since card art is immutable. Public props/behaviour of `CardPoolGrid` and `CardHoverPopup` are unchanged.

**Tech Stack:** Next.js 16.2.4, React 19.2.5, `next/image`, `@tanstack/react-virtual`, Vitest + Testing Library (jsdom for component tests).

**Spec:** `docs/superpowers/specs/2026-05-16-pool-preview-perf-design.md`

---

## Conventions for every task

- Web tests MUST be run with the web vitest config and scoped to the package (running `npx vitest` from the repo root recurses into stale `.claude/worktrees/agent-*` copies):
  - Single file: `npx vitest run <path> -c packages/web/vitest.config.ts`
  - Full web suite: `npm test --workspace=packages/web`
- Final gate before marking a task done: `npm run typecheck --workspace=packages/web` clean, web suite green.
- Commit at the end of each task with the exact message shown.
- Branch: continue on `feat/finite-cube-multiplicity` (PR #25 is open on it).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/web/src/components/cards/card-art.tsx` (new) | Progressive card image: instant small base + optional full-res overlay that fades in on load. One unit, used by tile + popup. |
| `packages/web/tests/components/card-art.test.tsx` (new) | Behaviour tests for `CardArt`. |
| `packages/web/tests/helpers/virtualizer-jsdom.ts` (new) | Test helper: gives jsdom non-zero element sizes + a `ResizeObserver` mock so `@tanstack/react-virtual` renders in tests. |
| `packages/web/src/components/draft/card-hover-popup.tsx` (modify) | Use `CardArt` (`loadFull`) instead of a bare full-res `<Image>`. |
| `packages/web/src/components/cards/card-pool-grid.tsx` (modify) | Tile uses `CardArt`; grid body virtualized with `@tanstack/react-virtual`. |
| `packages/web/tests/components/card-pool-grid.test.tsx` (modify) | Install jsdom virtualizer env; replace the auto-fill test with a windowing test. |
| `packages/web/next.config.ts` (modify) | `images.minimumCacheTTL` for immutable card art. |
| `packages/web/package.json` (modify) | Add `@tanstack/react-virtual`. |

---

## Task 0: Measure a production build (gate, no code)

This enforces "don't optimize a dev-only artifact." Next's image optimizer is on-demand/uncached in `npm run dev:web`; we need a real prod baseline.

**Files:** none (records results in this plan).

- [ ] **Step 1: Build and start a production web server**

Run:
```bash
npm run build --workspace=packages/web
DATABASE_PATH=./data/bot.sqlite npx next start packages/web -p 3000
```
Expected: a production server on http://localhost:3000 (seed data present from `npm run reset:test-data` if needed).

- [ ] **Step 2: Record the baseline**

Open the create-draft page, add sets/IDs to build a ~500-card pool, and record below (Chrome DevTools → Network/Performance):

| Metric | Dev (`dev:web`) | Prod (`next start`) |
|---|---|---|
| Popup full-res image visible — cold (first ever) | | |
| Popup full-res image visible — warm (seen before) | | |
| Grid first contentful paint with ~500 cards | | |

- [ ] **Step 3: Decide scope**

If the prod popup is already acceptable warm but slow cold, Slices 1+3 still apply (they target exactly cold + perceived latency). If prod grid paint with ~500 cards is fine, Slice 2 still applies for scroll/interaction cost. Note any deviation here, then proceed. No commit (docs-only; commit with Task 1 if edited).

---

## Task 1: Bump the Next image optimizer cache TTL

Card art at `images.ygoprodeck.com` is immutable; the default 60s optimizer cache forces needless re-transcodes.

**Files:**
- Modify: `packages/web/next.config.ts`

- [ ] **Step 1: Edit the config**

Replace the whole file with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@yugidraft/shared"],
  serverExternalPackages: ["better-sqlite3", "sharp"],
  images: {
    // Card art is immutable — cache optimized variants for a year instead of
    // the 60s default so previews stay warm. WebP only: AVIF's slower cold
    // encode is exactly the cold-start cost we are trying to reduce.
    minimumCacheTTL: 31536000,
    formats: ["image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.ygoprodeck.com",
        pathname: "/images/cards/**",
      },
      {
        protocol: "https",
        hostname: "images.ygoprodeck.com",
        pathname: "/images/cards_small/**",
      },
    ],
  },
};

export default nextConfig;
```

- [ ] **Step 2: Verify typecheck + build config loads**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS (no output errors).

- [ ] **Step 3: Commit**

```bash
git add packages/web/next.config.ts docs/superpowers/plans/2026-05-16-pool-preview-perf.md
git commit -m "perf(web): cache optimized card art for a year (immutable)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CardArt component (progressive image)

**Files:**
- Create: `packages/web/src/components/cards/card-art.tsx`
- Test: `packages/web/tests/components/card-art.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/tests/components/card-art.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardArt } from "../../src/components/cards/card-art";

vi.mock("next/image", () => ({
  default: ({
    alt,
    src,
    fill: _fill,
    onLoad,
    onError,
    className,
  }: {
    alt: string;
    src: string;
    fill?: boolean;
    onLoad?: () => void;
    onError?: () => void;
    className?: string;
  }) => (
    <img
      alt={alt}
      src={src}
      className={className}
      onLoad={onLoad}
      onError={onError}
      data-testid={`img-${src}`}
    />
  ),
}));

describe("CardArt", () => {
  it("renders the small image immediately", () => {
    render(<CardArt smallSrc="s.jpg" fullSrc="f.jpg" alt="Dark Magician" sizes="100px" />);
    expect(screen.getByTestId("img-s.jpg")).toBeTruthy();
  });

  it("does not mount the full image unless loadFull is set", () => {
    render(<CardArt smallSrc="s.jpg" fullSrc="f.jpg" alt="DM" sizes="100px" />);
    expect(screen.queryByTestId("img-f.jpg")).toBeNull();
  });

  it("mounts the full image hidden, then reveals it once loaded", () => {
    render(<CardArt smallSrc="s.jpg" fullSrc="f.jpg" alt="DM" sizes="100px" loadFull />);
    const full = screen.getByTestId("img-f.jpg");
    expect(full.className).toContain("opacity-0");
    fireEvent.load(full);
    expect(full.className).toContain("opacity-100");
  });

  it("forwards object-fit class to the small image", () => {
    render(
      <CardArt smallSrc="s.jpg" fullSrc="f.jpg" alt="DM" sizes="100px" className="object-contain" />,
    );
    expect(screen.getByTestId("img-s.jpg").className).toContain("object-contain");
  });

  it("invokes onError when an image fails to load", () => {
    const onError = vi.fn();
    render(
      <CardArt smallSrc="s.jpg" fullSrc="f.jpg" alt="DM" sizes="100px" onError={onError} />,
    );
    fireEvent.error(screen.getByTestId("img-s.jpg"));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/components/card-art.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — `Failed to resolve import ".../card-art"` (module does not exist yet).

- [ ] **Step 3: Implement CardArt**

Create `packages/web/src/components/cards/card-art.tsx`:

```tsx
"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface CardArtProps {
  smallSrc: string;
  fullSrc: string;
  alt: string;
  sizes: string;
  /** When true, also load the full-res image and fade it in over the small one. */
  loadFull?: boolean;
  priority?: boolean;
  /** Object-fit / extra classes applied to both layers (e.g. "object-cover"). */
  className?: string;
  onError?: () => void;
}

export function CardArt({
  smallSrc,
  fullSrc,
  alt,
  sizes,
  loadFull = false,
  priority = false,
  className,
  onError,
}: CardArtProps): React.JSX.Element {
  const [fullLoaded, setFullLoaded] = React.useState(false);

  return (
    <>
      <Image
        src={smallSrc}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        className={cn(className)}
        onError={onError}
      />
      {loadFull && (
        <Image
          src={fullSrc}
          alt={alt}
          fill
          sizes={sizes}
          className={cn(
            className,
            "transition-opacity duration-200",
            fullLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setFullLoaded(true)}
          onError={onError}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/components/card-art.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/cards/card-art.tsx packages/web/tests/components/card-art.test.tsx
git commit -m "feat(web): CardArt — instant small image, optional full-res fade-in

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Use CardArt in the hover popup

**Files:**
- Modify: `packages/web/src/components/draft/card-hover-popup.tsx`

- [ ] **Step 1: Swap the popup image to CardArt**

In `packages/web/src/components/draft/card-hover-popup.tsx`:

Replace the import line:
```tsx
import Image from "next/image";
```
with:
```tsx
import { CardArt } from "@/components/cards/card-art";
```

Then replace this block:
```tsx
            {imageError ? (
              <div className="flex h-full items-center justify-center text-sm text-text-secondary">No image</div>
            ) : (
              <Image src={card.imageUrl} alt={card.name} fill className="object-contain" sizes="288px" onError={onImageError} />
            )}
```
with:
```tsx
            {imageError ? (
              <div className="flex h-full items-center justify-center text-sm text-text-secondary">No image</div>
            ) : (
              <CardArt
                smallSrc={card.imageUrlSmall || card.imageUrl}
                fullSrc={card.imageUrl}
                alt={card.name}
                sizes="288px"
                loadFull
                className="object-contain"
                onError={onImageError}
              />
            )}
```

- [ ] **Step 2: Run the web suite (popup behaviour must stay green)**

Run: `npm test --workspace=packages/web`
Expected: PASS — all existing tests still green (the popup still renders the card name, effect text, badges; `imageError` still shows "No image"). Note the total passing count.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/draft/card-hover-popup.tsx
git commit -m "perf(web): popup shows cached small art instantly, sharpens to full

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Use CardArt in the grid tile (no virtualization yet)

Isolates the image swap from the windowing change so each is independently verifiable.

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx`

- [ ] **Step 1: Swap the tile image to CardArt**

In `packages/web/src/components/cards/card-pool-grid.tsx`:

Remove this import line:
```tsx
import Image from "next/image";
```
Add this import (next to the other `@/components` import):
```tsx
import { CardArt } from "@/components/cards/card-art";
```

Replace this block (inside the `visible.map` tile):
```tsx
                  {imageErrors.has(card.id) ? (
                    <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                  ) : (
                    <Image src={card.imageUrlSmall || card.imageUrl} alt="" fill className="object-cover"
                      sizes="(min-width: 1536px) 120px, 160px" onError={() => handleImageError(card.id)} />
                  )}
```
with:
```tsx
                  {imageErrors.has(card.id) ? (
                    <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                  ) : (
                    <CardArt
                      smallSrc={card.imageUrlSmall || card.imageUrl}
                      fullSrc={card.imageUrl}
                      alt=""
                      sizes="(min-width: 1536px) 120px, 160px"
                      className="object-cover"
                      onError={() => handleImageError(card.id)}
                    />
                  )}
```
(`loadFull` is omitted — the grid loads only the small image, identical network to today.)

- [ ] **Step 2: Run the card-pool-grid tests**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — all 16 still green. The memoization test still passes (one `<Image>` per tile → the `imageRenders` counter behaves as before).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx
git commit -m "refactor(web): grid tile uses CardArt (small-only, behaviour unchanged)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add @tanstack/react-virtual + jsdom test helper

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/tests/helpers/virtualizer-jsdom.ts`

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install @tanstack/react-virtual@^3 --workspace=packages/web
```
Expected: `@tanstack/react-virtual` appears in `packages/web/package.json` `dependencies` and `package-lock.json` updates.

- [ ] **Step 2: Create the jsdom virtualizer helper**

jsdom reports every element size as `0`, so `@tanstack/react-virtual` would render nothing in tests. This helper gives a fixed viewport and a `ResizeObserver` mock so the virtualizer produces a realistic windowed subset.

Create `packages/web/tests/helpers/virtualizer-jsdom.ts`:

```ts
import { afterEach, vi } from "vitest";

const ROW_HEIGHT_PX = 360;

/**
 * Makes @tanstack/react-virtual usable under jsdom:
 * - a synchronous ResizeObserver mock,
 * - a fixed clientWidth/clientHeight viewport,
 * - getBoundingClientRect returning the viewport for the scroll element and a
 *   fixed row height for measured rows (elements with a data-index attribute).
 *
 * Call inside a `beforeEach`. State is restored automatically via afterEach.
 */
export function installVirtualizerJsdomEnv(
  viewport: { width: number; height: number } = { width: 900, height: 600 },
): void {
  class ResizeObserverMock {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element): void {
      this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(): number {
      return viewport.width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(): number {
      return viewport.height;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const isRow = (this as HTMLElement).dataset?.index !== undefined;
    const height = isRow ? ROW_HEIGHT_PX : viewport.height;
    return {
      width: viewport.width,
      height,
      top: 0,
      left: 0,
      right: viewport.width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDesc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json package-lock.json packages/web/tests/helpers/virtualizer-jsdom.ts
git commit -m "chore(web): add @tanstack/react-virtual + jsdom virtualizer test helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Virtualize the pool grid

Window the populated grid so only on-screen rows render. Skeleton / empty / "No cards match" / loading-overlay branches are untouched. Public props of `CardPoolGrid` are unchanged.

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx`
- Modify: `packages/web/tests/components/card-pool-grid.test.tsx`

- [ ] **Step 1: Update the existing test file — install jsdom env + replace the auto-fill test with a windowing test**

In `packages/web/tests/components/card-pool-grid.test.tsx`:

Change the vitest import line:
```tsx
import { describe, expect, it, vi } from "vitest";
```
to:
```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
```
Add this import after the existing component import:
```tsx
import { installVirtualizerJsdomEnv } from "../helpers/virtualizer-jsdom";
```
Immediately inside `describe("CardPoolGrid", () => {` add as the first line:
```tsx
  beforeEach(() => installVirtualizerJsdomEnv());
```
Inside `describe("CardPoolGrid memoization", () => {` add as the first line:
```tsx
  beforeEach(() => installVirtualizerJsdomEnv());
```

Replace this entire existing test:
```tsx
  it("uses an auto-fill responsive grid (no fixed column count)", () => {
    render(<CardPoolGrid cards={cards} />);
    const grid = screen.getByTestId("card-pool-grid");
    expect(grid.className).toContain("grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]");
    expect(grid.className).not.toContain("grid-cols-2");
  });
```
with:
```tsx
  it("windows the grid: renders only a subset of a large pool", () => {
    const many: CardSummary[] = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      name: `Card ${i + 1}`,
      type: "Spell Card",
      frameType: "spell",
      effectText: "...",
      imageUrl: `u${i}`,
      imageUrlSmall: `s${i}`,
    }));
    render(<CardPoolGrid cards={many} />);
    const rendered = screen.getAllByRole("button", { name: /^preview card/i });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(120); // far fewer than 400 → windowed
  });
```

- [ ] **Step 2: Run the test file to verify the new/affected tests fail**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — the new "windows the grid" test fails (current grid renders all 400 buttons, so `length` is 400, not `< 120`). Other tests still pass.

- [ ] **Step 3: Virtualize the grid component**

In `packages/web/src/components/cards/card-pool-grid.tsx`:

(3a) Change the React import:
```tsx
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
```
to:
```tsx
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
```
Add this import after the `react` import:
```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
```

(3b) Inside `CardPoolGridBase`, immediately after the existing `const showSkeleton = loading && cards.length === 0;` line, add:

```tsx
  const scrollRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ columns: number; innerWidth: number }>({
    columns: 1,
    innerWidth: 0,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const GAP = 12; // gap-3
    const TILE_MIN = 144; // 9rem
    const PAD_X = 24; // px-3 on each row, both sides
    const measure = (): void => {
      const inner = Math.max(0, el.clientWidth - PAD_X);
      const columns = Math.max(1, Math.floor((inner + GAP) / (TILE_MIN + GAP)));
      setLayout({ columns, innerWidth: inner });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  type GridEntry =
    | { kind: "card"; card: CardSummary }
    | { kind: "unknown"; id: number };

  const entries = useMemo<GridEntry[]>(
    () => [
      ...visible.map((card): GridEntry => ({ kind: "card", card })),
      ...unknownIds.map((id): GridEntry => ({ kind: "unknown", id })),
    ],
    [visible, unknownIds],
  );

  const { columns, innerWidth } = layout;
  const estimatedRowHeight = useMemo(() => {
    const GAP = 12;
    const tileW = innerWidth > 0 ? (innerWidth - (columns - 1) * GAP) / columns : 144;
    const imageH = (tileW * 614) / 421;
    // image + img/label gap (8) + label block (~64) + button padding (16) + row gap (12)
    return Math.round(imageH + 8 + 64 + 16 + GAP);
  }, [columns, innerWidth]);

  const rowCount = Math.ceil(entries.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 4,
  });
```

(3c) Add `ref={scrollRef}` to the scroll container. Change:
```tsx
      <div className={cn("relative overflow-y-auto rounded-lg border border-border bg-surface/70", heightClassName)}>
```
to:
```tsx
      <div ref={scrollRef} className={cn("relative overflow-y-auto rounded-lg border border-border bg-surface/70", heightClassName)}>
```

(3d) Replace the entire final populated branch — the block that currently starts with:
```tsx
        ) : (
          <div data-testid="card-pool-grid" className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-3">
```
and ends with its matching `</div>` immediately before:
```tsx
        )}
      </div>
```
— with this windowed implementation (keep the `)}` and outer `</div>` that follow):

```tsx
        ) : (
          <div
            data-testid="card-pool-grid"
            style={{ height: rowVirtualizer.getTotalSize() + 24, position: "relative" }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const start = vRow.index * columns;
              const rowEntries = entries.slice(start, start + columns);
              return (
                <div
                  key={vRow.key}
                  data-index={vRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="grid gap-3 px-3"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vRow.start + 12}px)`,
                    paddingBottom: 12,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  }}
                >
                  {rowEntries.map((entry) =>
                    entry.kind === "card" ? (
                      <button
                        key={entry.card.id}
                        type="button"
                        aria-label={`Preview ${entry.card.name}`}
                        className="group flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-bg-elevated/40 p-2 text-left transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                        onClick={(e) => {
                          setTapped(entry.card);
                          setPopupPosition(getPopupPosition(e.currentTarget.getBoundingClientRect()));
                        }}
                        onMouseEnter={(e) => handleEnter(entry.card, e.currentTarget.getBoundingClientRect())}
                        onMouseLeave={handleLeave}
                        onFocus={(e) => handleEnter(entry.card, e.currentTarget.getBoundingClientRect())}
                        onBlur={handleLeave}
                      >
                        <div className="relative aspect-[421/614] w-full overflow-hidden rounded-md bg-bg-elevated">
                          {imageErrors.has(entry.card.id) ? (
                            <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                          ) : (
                            <CardArt
                              smallSrc={entry.card.imageUrlSmall || entry.card.imageUrl}
                              fullSrc={entry.card.imageUrl}
                              alt=""
                              sizes="(min-width: 1536px) 120px, 160px"
                              className="object-cover"
                              onError={() => handleImageError(entry.card.id)}
                            />
                          )}
                          {(entry.card.qty ?? 1) > 1 && (
                            <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[0.65rem] font-bold tabular-nums text-white">
                              ×{entry.card.qty}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-medium leading-snug text-text-primary">
                            {entry.card.name}
                          </p>
                          <span
                            className={cn(
                              "mt-1 inline-flex rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase",
                              getTypeBadgeClass(entry.card.type),
                            )}
                          >
                            {getTypeLabel(entry.card.type)}
                          </span>
                        </div>
                      </button>
                    ) : (
                      <div
                        key={`unknown-${entry.id}`}
                        data-testid="card-pool-grid-unknown"
                        title={`Passcode ${entry.id} is not in the catalog yet`}
                        aria-label={`Passcode ${entry.id} not in catalog yet`}
                        className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 bg-bg-elevated/20 p-2 text-center"
                      >
                        <div className="flex aspect-[421/614] w-full items-center justify-center rounded-md bg-bg-elevated/40 font-mono text-xs text-text-muted">
                          {entry.id}
                        </div>
                        <p className="text-[0.65rem] text-text-muted">not in catalog yet</p>
                      </div>
                    ),
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
```

> Note: the `memo(CardPoolGridBase)` export at the bottom of the file stays exactly as-is. The skeleton branch (`grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-3`) is intentionally left unchanged.

- [ ] **Step 4: Run the card-pool-grid test file**

Run: `npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS — all tests including the new "windows the grid" test (renders > 0 and < 120 buttons for 400 cards). Search/filter/empty/skeleton/memoization tests still green.

- [ ] **Step 5: Run the full web suite + typecheck**

Run:
```bash
npm run typecheck --workspace=packages/web
npm test --workspace=packages/web
```
Expected: typecheck PASS; web suite PASS (count = previous total + new card-art tests + adjusted grid test).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "perf(web): virtualize the pool grid with @tanstack/react-virtual

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-stack gate + push

**Files:** none (verification + push).

- [ ] **Step 1: Monorepo gate**

Run:
```bash
npm run typecheck
npm test
npm run build
```
Expected: typecheck 4/4 packages clean; `npm test` 4/4 packages green (ws / shared / bot / web); `npm run build` all packages built clean.

- [ ] **Step 2: Manual smoke (dev) + record prod delta**

Run `npm run dev:web`, open the create-draft page, build a large pool:
- Grid scrolls smoothly; only on-screen tiles in the DOM (inspect: row count ≪ pool size).
- Hovering/tapping a tile: popup shows the small art instantly, then sharpens to full-res.
- Typing in "Draft Name" stays smooth (memoization from PR #25 still holds).

Optionally re-run the Task 0 prod build and fill the second column of the Task 0 table. If cold-start is still painful, open a follow-up for the conditional local-disk-cache-route origin (documented in the spec) — do not implement it here.

- [ ] **Step 3: Push to PR #25**

```bash
git push
```
Expected: branch `feat/finite-cube-multiplicity` updated; PR #25 reflects the new commits.

---

## Self-Review (completed by plan author)

**Spec coverage:** Slice 0 → Task 0; Slice 1 (`CardArt`) → Tasks 2–4; Slice 2 (virtualization) → Tasks 5–6; Slice 3 (cache TTL) → Task 1; conditional local-route follow-up → recorded in Task 7 Step 2 (not implemented, per spec). Testing requirements (card-art tests, windowing test, existing tests green, jsdom virtualizer risk + helper) → Task 2 / Task 5 / Task 6. Gate → Task 7.

**Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step shows complete code; every command shows expected output.

**Type consistency:** `CardArt` prop names (`smallSrc`, `fullSrc`, `alt`, `sizes`, `loadFull`, `priority`, `className`, `onError`) are identical across Tasks 2, 3, 4, 6. `GridEntry` discriminant (`kind: "card" | "unknown"`) defined in Task 6 Step 3b and used consistently in 3d. `installVirtualizerJsdomEnv` signature matches its call sites in Task 6. `CardSummary` is already imported in `card-pool-grid.tsx` and the test file.
