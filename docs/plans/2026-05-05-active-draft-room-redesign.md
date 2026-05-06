# Active Draft Room Redesign — Arena Table

## Goal

Fix the broken active draft room layout so the current pack dominates the screen, the side rails are compact and stable, and the fallback state no longer collapses the center stage into a narrow vertical strip.

## Design Context

See `.impeccable.md`.

Competitive Yu-Gi-Oh players drafting in organized Discord communities need a sharp, focused, tournament-grade interface. The draft room must feel like sitting at a table, not filling out a form.

## Problem Summary

The current implementation has three structural layout problems:

1. **Center stage collapses** when `currentPack` is empty. The fallback copy is left-aligned inside a rounded container with no width constraints, forcing the entire center column to shrink to a narrow text column.
2. **Nested card containers** create visual clutter: the title, pack metadata, and card grid each sit inside separate rounded cards, which breaks the "pack dominates the screen" goal.
3. **Side rails are too visually heavy** relative to the center stage, making the page feel unbalanced.

## Chosen Direction

**Arena table with wide center, fixed rails (Option A).**

- Left rail: compact timer + seat list
- Center stage: clean left-aligned header, metadata strip, large responsive card grid
- Right rail: compact pool summary + actions

All critical info is always visible without clicks. The center stage gets ~60% of viewport width on desktop.

## Rejected Alternatives

- **Collapsible rails (Option B)**: adds clicks during timed picks; unacceptable for competitive use.
- **Floating overlays (Option C)**: risks obscuring cards; too much like a game UI, not a competitive tool.

## Layout Structure

### Desktop

```css
grid-template-columns: 240px minmax(0, 1fr) 280px;
```

- **Left rail (240px)**: `TimerBar` stacked above `SeatList` in a single `flex-col` container. Fixed width, always visible.
- **Center stage**: title header → pack metadata strip → card grid. No outer rounded container. Sits directly on `bg-bg-deep`.
- **Right rail (280px)**: `PoolPanel` with stats and actions. Fixed width, always visible.

### Tablet (lg breakpoint)

- Collapse to single column.
- Left rail becomes a compact horizontal strip (timer + seat count) above the center stage.
- Right rail sits below the center stage.

### Mobile (sm breakpoint)

- Sticky top: compact `TimerBar` (horizontal).
- Below: `SeatList` (horizontal scroll or collapsed).
- Center: card grid or fallback state.
- Fixed bottom: `PoolPanel` trigger (current behavior preserved).

## Center Stage

### Title Header

Remove the rounded card container around the title and set chips. Instead, use a clean left-aligned block:

- `Live Draft Room` label: `text-xs`, `text-text-muted`, uppercase, tracking-wide
- Draft name: `font-display`, `text-2xl` → `text-3xl` on `sm`
- Set chips: inline flex wrap directly below the name, compact (`px-2.5 py-0.5`, `text-xs`)

### Pack Metadata Strip

Single horizontal row below the title, separated by a subtle top border (`border-t border-border/50`):

- Left: `Pack X · Pick Y`
- Center: `N cards in pack`
- Right: `N players`

All `text-sm`, muted colors. No background container.

### Card Grid

- Remove the outer rounded container — let cards sit directly on the page background.
- Grid: `grid-cols-2 sm:grid-cols-3 xl:grid-cols-4`, `gap-4`
- Card minimum width: `minmax(180px, 1fr)` to prevent collapse
- Cards keep current styling (rounded-xl, border, hover states)

### Fallback State (No Pack)

When `currentPack` is empty:

- Center the content vertically and horizontally within the stage.
- Use a short heading: "Waiting for pack..."
- Remove the long paragraph and tag pills to reduce noise.
- Keep a subtle card-back or pack icon placeholder.

## Left Rail

### TimerBar

- Reduce padding to `p-3`.
- Remove "Draft Clock" text label; use only the icon + time.
- Keep progress bar and urgent/critical states.

### SeatList

- Reduce row padding to `p-2`.
- Remove heavy outer shadow; keep subtle border only.
- Keep current player highlighting (accent border/background).

## Right Rail

### PoolPanel

- Tighten spacing: stats grid uses `gap-2` and smaller padding.
- Remove redundant "Total cards" row (duplicate of "Drafted so far" count).
- Keep Export YDK and View Full Pool actions.

## Visual Treatment

- **No nested cards**: Use spacing and borders for separation, not card containers.
- **Center stage background**: `bg-bg-deep` (same as page), so the pack feels like the main surface.
- **Rails background**: `bg-surface` with subtle border, to recede visually.
- **Accent colors**: Only for active states (current player, urgent timer, highlighted card).
- **No glassmorphism, no decorative gradients, no rounded-everywhere grids**.

## Component Changes

### `app/(app)/draft/[slug]/page.tsx`

- Restructure the active layout grid to `grid-cols-[240px_minmax(0,1fr)_280px]`.
- Remove the rounded card container around the title header.
- Move title, set chips, and metadata strip into a flat header block above `CardGrid`.
- Ensure `CardGrid` has no outer wrapper card.
- Keep mobile sticky header and bottom pool trigger.

### `components/draft/card-grid.tsx`

- Remove outer `rounded-2xl border bg-surface` container.
- Increase card grid minimum size to prevent collapse.
- Redesign fallback state: centered, shorter copy, no tag pills.

### `components/draft/timer-bar.tsx`

- Reduce padding.
- Remove "Draft Clock" label.

### `components/draft/seat-list.tsx`

- Reduce row padding.
- Lighten outer shadow.

### `components/draft/pool-panel.tsx`

- Tighten spacing.
- Remove redundant "Total cards" row.

## Responsive Strategy

| Breakpoint | Layout |
|---|---|
| `xl` (1280px+) | Three-column arena table |
| `lg` (1024px–1279px) | Single column: compact top strip → center stage → pool |
| `sm` (640px–1023px) | Sticky timer, horizontal seats, center grid, bottom pool trigger |
| `< sm` | Same as `sm` with tighter spacing |

## Testing Strategy

1. Visual regression: screenshot `/draft/legendary-draft` at `xl`, `lg`, and `sm` breakpoints.
2. Confirm fallback state does not collapse center stage width.
3. Re-run `packages/web` test suite after layout changes.
4. Verify seeded demo still shows set chips and pack metadata immediately.

## Success Criteria

- `/draft/legendary-draft` shows a wide, stable center stage that does not collapse when the pack is empty.
- The card grid dominates the desktop viewport.
- Side rails are compact and do not compete visually with the pack.
- The layout feels like a competitive draft client, not a sparse dashboard.
- No nested card containers; spacing and borders create hierarchy instead.
