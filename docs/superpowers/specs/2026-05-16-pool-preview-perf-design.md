# Pool Preview Performance — Design

**Date:** 2026-05-16
**Status:** Approved (design), pending implementation plan
**Area:** `packages/web` — create-draft pool preview (`CardPoolGrid`, `CardHoverPopup`)

## Problem

On the create-draft page the pool preview has two performance problems:

1. **Card preview (hover/tap popup) is slow to show.** The popup renders a
   *different*, full-resolution `card.imageUrl` from scratch on hover, throwing
   away the small art the grid tile already downloaded. No placeholder, no
   prefetch — the popup image area is empty until the full JPEG round-trips
   through the Next image optimizer (cold-fetched from ygoprodeck).
2. **The grid renders every card.** A realistic cube preview is ~300–800
   distinct tiles. Even with the recently added `React.memo`, the first mount
   and any real pool change render every `<button>` + `next/image` node, and
   native `loading="lazy"` only defers the network fetch — not the React
   reconciliation, layout, or optimizer requests for 300–800 nodes.

Contributing config issue: `images.minimumCacheTTL` is unset, so Next defaults
to a 60s optimizer cache even though card art is immutable.

## Constraints & decisions (from brainstorming)

- **Measurement environment:** user has mostly tested in `npm run dev:web`,
  where the Next image optimizer is on-demand and effectively uncached (worse
  on WSL2 + sharp). A production build must be measured before/while optimizing
  so we fix real latency, not a dev artifact.
- **Realistic pool size:** ~300–800 distinct cards. Virtualization is justified
  at this size.
- **Preview UX:** "instant small → sharpen to full" — show the already-cached
  small image immediately, then swap to full-res when it loads.
- **Virtualization library:** `@tanstack/react-virtual` (headless, small,
  keeps the current Tailwind grid; derive columns from measured width and
  virtualize rows).
- **Image caching:** bump `images.minimumCacheTTL` and re-measure prod first;
  adopt the local disk-cache route origin only if cold-start still hurts.
- **Stack:** Next 16.2.4, React 19.2.5. Use `next/image` `onLoad` (Next 16;
  `onLoadingComplete` is deprecated).

## Architecture

One cohesive effort, four slices. Slice 0 is a non-code measurement gate. Data
flow is unchanged: resolve route → `poolCards: CardSummary[]` →
`CreateDraftForm` state → memoized `CardPoolPanel` → `CardPoolGrid` →
`CardArt` per tile; popup uses `CardArt` with the full-res upgrade.

### File structure

**New**

- `packages/web/src/components/cards/card-art.tsx` — `CardArt`, a deep module.
  - Props:
    `{ smallSrc: string; fullSrc: string; alt: string; sizes: string;
       loadFull?: boolean; priority?: boolean; className?: string;
       onError?: () => void }`
  - Always renders `smallSrc` as the base layer (`next/image`, `fill`), so it
    paints instantly (in the popup the small art is already in the browser
    cache from the grid tile).
  - **Only when `loadFull` is true**, also mounts the full-res `<Image>` as an
    absolutely-positioned overlay with `opacity-0`, transitioning to
    `opacity-100` on `onLoad`. This is the central interface decision: the grid
    passes `loadFull={false}` (network identical to today — small only, no
    doubled requests), the popup passes `loadFull` (instant cached small →
    sharpen).
  - `onError` on the full image delegates to the parent's existing error
    handling so the current "No image" fallback is preserved unchanged.
- `packages/web/tests/components/card-art.test.tsx` — behavior tests.

**Modified**

- `packages/web/src/components/cards/card-pool-grid.tsx`
  - Tile renders `<CardArt loadFull={false}>` instead of the inline `<Image>`.
  - Add `@tanstack/react-virtual` windowing over the existing memoized
    `visible` array (plus `unknownIds`).
  - Public props and behavior of `CardPoolGrid` do **not** change; windowing
    and `CardArt` are internal. The existing 16 tests + the memoization test
    remain green.
- `packages/web/src/components/draft/card-hover-popup.tsx`
  - Replace `<Image src={card.imageUrl}>` with
    `<CardArt smallSrc={card.imageUrlSmall} fullSrc={card.imageUrl} loadFull>`.
  - Preserve the existing `imageError` / `onImageError` "No image" fallback.
- `packages/web/next.config.ts`
  - Add `images.minimumCacheTTL: 31536000` (card art is immutable).
  - Keep WebP only (do **not** add AVIF — its slower cold encode is exactly
    the cold-start cost we are reducing).
- `packages/web/package.json` — add `@tanstack/react-virtual`.

**Conditional follow-up (NOT built now)**

- Serving card art via the existing local disk-cache route
  `/api/cards/[passcode]/image` so `next/image` optimizes from a local origin
  and reuses the bot's shared disk cache. Trigger: prod measurement after
  Slices 1+3 still shows painful cold-start. Documented here so the plan
  records the trigger, not the work.

## Slice behavior

### Slice 0 — Measure a prod build (gate, no code)

Run `next build && next start` (or Docker prod) and record a baseline for: time
for the popup full-res image to appear (cold and warm), and grid first-paint
with a ~500-card pool. Capture in the implementation notes. If prod is already
acceptable for the popup, Slices 1/3 narrow accordingly. This enforces the
"don't optimize a dev-only artifact" discipline.

### Slice 1 — CardArt progressive image

- Base layer: `<Image src={smallSrc} fill sizes={sizes}>` — instant paint.
- Overlay (only if `loadFull`): `<Image src={fullSrc} fill sizes={sizes}
  className="opacity-0 transition-opacity duration-200" onLoad={() =>
  setLoaded(true)}>`; `loaded` → `opacity-100`.
- Error: full image `onError` → call `onError` prop; parent toggles existing
  `imageError`, which shows "No image" exactly as today (small failing too
  yields the same fallback).
- `priority` passes through (tiles: false/lazy; popup: not priority).
- Used by both the grid tile (`loadFull={false}`) and the popup (`loadFull`),
  so the progressive behavior lives in one tested unit.

### Slice 2 — Virtualize the grid

- Keep all existing state (search/filter/sort) producing the memoized
  `visible: CardSummary[]`.
- Flatten into one indexable list `entries = [...visible, ...unknownTiles]` so
  windowing covers known cards and unknown-id placeholders together.
- A `ResizeObserver` on the scroll container measures inner content width;
  `columns = max(1, floor(width / TILE_MIN_PX))` where `TILE_MIN_PX ≈ 156`
  (≈ `9rem` min tile + `0.75rem` gap). Recompute on resize.
- `rowCount = ceil(entries.length / columns)`.
- `useVirtualizer({ count: rowCount, getScrollElement: () =>
  scrollRef.current, estimateSize: () => rowHeightPx, overscan: 4 })`.
  `rowHeightPx` is derived from the measured column width (tile image aspect
  `421/614` + label block + gap); deterministic per layout, recomputed on
  resize.
- Render: a spacer `div` of height `getTotalSize()`; each virtual row is
  absolutely positioned via `translateY(virtualRow.start)`, containing a
  Tailwind grid (`grid-template-columns: repeat(columns, 1fr)`) of that row's
  slice. Per-tile markup (button, `CardArt`, badges, hover/focus handlers)
  is unchanged, so `getPopupPosition(e.currentTarget.getBoundingClientRect())`
  still works on real DOM.
- The skeleton / empty / "No cards match" / loading branches are untouched —
  only the populated branch is windowed.
- Component is already `"use client"`. Until the container is measured, render
  with `columns = 1` (graceful, never permanently blank).
- The existing `memo(CardPoolGridBase)` wrapper is retained.

### Slice 3 — Image caching config

- `next.config.ts`: add `minimumCacheTTL: 31536000`; keep
  `formats` at WebP (omit AVIF).
- Document the conditional local-route origin swap (above) with its trigger
  and the accompanying `Cache-Control` bump on
  `/api/cards/[passcode]/image` (to 1-year immutable) for when/if adopted.

## Error handling

- No new error surfaces. `CardArt.onError` routes to the parent's existing
  `imageError`/`onImageError`; the "No image" fallback is byte-for-byte
  preserved in both tile and popup.
- Virtualization degrades safely: if width measurement is unavailable, render
  a single column rather than blanking; clamp `columns >= 1`.

## Testing

- `tests/components/card-art.test.tsx` (jsdom, mock `next/image`):
  small renders immediately; full overlay mounts **only** when `loadFull`;
  full is hidden (`opacity-0`) until `onLoad`, then shown; `onError` invokes
  the `onError` prop.
- `tests/components/card-pool-grid.test.tsx`:
  all existing 16 tests pass unchanged; the memoization test stays green;
  **new**: a ~400-card pool renders far fewer than 400 `Preview …` buttons
  (windowed); search/filter still narrow correctly with virtualization active.
- `card-hover-popup` tests stay green (name/effect/badges render; small src is
  the base image).
- **jsdom virtualization risk:** jsdom returns 0 for element sizes, so
  `@tanstack/react-virtual` renders nothing unless tests stub
  `clientWidth`/`clientHeight` (and `getBoundingClientRect`) on the scroll
  element and provide a `ResizeObserver` mock. The implementation plan must
  include a small shared test helper for this. This is the one real
  implementation risk; everything else is mechanical.
- Gate per slice and at the end: `npm run typecheck` (4/4), `npm test` (4/4
  via Turbo, scoped to avoid the stale-worktree recursion), `npm run build`
  clean. Slice 0 prod baseline recorded.

## Scope

Single spec → single implementation plan, ~4 slices (0 measure, 1 CardArt,
2 virtualize, 3 cache config). Not multiple independent subsystems; no
decomposition required.
