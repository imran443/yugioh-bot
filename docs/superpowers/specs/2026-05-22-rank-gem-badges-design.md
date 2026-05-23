# Animated Rank Gem Badges — Design

**Date:** 2026-05-22
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Surface:** `packages/web` only

## Goal

Replace the plain text rank pills with a faceted **gem icon** beside each tier name, and give
each tier its own **idle animation** that escalates with rank, so climbing the ladder visibly
"levels up" a player's badge. Extract the badge into a single reusable component (it is
currently duplicated).

## Background — current state

- Five rating tiers, defined in `packages/shared/src/scoring/constants.ts`:
  Diamond (1600+), Platinum (1350+), Gold (1100+), Silver (900+), Bronze (0+).
- Tier colors (hardcoded hex, duplicated): Diamond `#a78bfa`, Platinum `#7dd3fc`,
  Gold `#f5c451`, Silver `#cbd5e1`, Bronze `#d6a06a`.
- `RankBadge` is **copy-pasted** in:
  - `packages/web/src/components/leaderboard/leaderboard-table.tsx`
  - `packages/web/src/components/player/profile-view.tsx`
- The dashboard `Rank` stat card (`packages/web/app/(app)/dashboard/page.tsx`) renders the tier
  name as plain text, no badge.
- Styling: Tailwind v4 with `@theme` in `packages/web/app/globals.css` (no JS Tailwind config).
  `globals.css` already has a global `prefers-reduced-motion: reduce` reset that neutralizes all
  animations and transitions — so reduced-motion accessibility is handled for free.
- Icons: `lucide-react` already used across the app.

## Design decisions (settled during visual brainstorming)

1. **Icon style:** Option B — a solid **faceted gem** silhouette with a per-tier gradient fill +
   a white highlight facet. The tier color carries the meaning; the shape is uniform across tiers.
2. **Per-tier idle animation ladder** (escalating):
   - **Bronze** — static / matte, no idle motion.
   - **Silver** — rare slow gloss sweep (~5s cycle).
   - **Gold** — more frequent gloss sweep (~3s) + warm glow pulse.
   - **Platinum** — floating bob + gloss + cool aura glow.
   - **Diamond** — breathe glow + twinkling sparkles + gloss (fully alive).
3. **Universal hover** on every tier: lift + slight tilt + colored glow (`motion-safe:` only).
4. **Rank-up celebration:** a one-shot sparkle-pop, triggered on profile load when the viewer's
   tier is higher than the last tier they saw (localStorage comparison). No backend changes.
5. **Surfaces:** all three — leaderboard table, profile header, dashboard rank card.

## Component API

New: `packages/web/src/components/rank/rank-badge.tsx`

```tsx
interface RankBadgeProps {
  rank: string;             // tier name, e.g. "Diamond"
  size?: "sm" | "lg";       // sm = table + dashboard (default), lg = profile header
  animate?: boolean;        // default true; false renders the gem with no idle animation
  celebrate?: boolean;      // default false; when true, runs rank-up celebration logic on mount
  playerId?: number;        // required when celebrate is true (localStorage key scope)
}
```

- Renders: `<span class="badge"> <gem svg/> {rank} </span>`, pill styling matching the current
  badge (rounded-full, `${color}18` background, `${color}40` border, tier-colored text).
- `size="lg"` => larger gem + text for the profile header; `size="sm"` => current compact size.
- Unknown rank string falls back to a neutral gray gem (mirrors the existing `?? "#9aa0b8"`).

New: `packages/web/src/components/rank/rank-visuals.ts` — single source of truth, replaces both
duplicated `RANK_COLORS` maps:

```ts
export interface RankVisual {
  color: string;        // text/border base color
  gradientFrom: string; // gem gradient top
  gradientTo: string;   // gem gradient bottom
  idleClass: string;    // "" for Bronze, else "rank-idle-silver" etc.
}
export const RANK_VISUALS: Record<string, RankVisual> = { /* 5 tiers */ };
export const FALLBACK_VISUAL: RankVisual; // neutral gray, no idle
```

## Animations

Add to `packages/web/app/globals.css`:

- `@keyframes` `rank-sweep`, `rank-glow`, `rank-bob`, `rank-breathe`, `rank-twinkle`,
  `rank-pop`, `rank-spark`.
- Utility classes: `.rank-idle-silver`, `.rank-idle-gold`, `.rank-idle-platinum`,
  `.rank-idle-diamond` composing the keyframes per the ladder above. Bronze has no class.
- The gloss sweep needs `overflow:hidden` on the pill plus a `::after` streak element.
- Hover handled with Tailwind `motion-safe:` utilities on the component, not custom CSS.
- The existing reduced-motion reset disables all of the above automatically.

## Rank-up celebration logic

- Pure helper (unit-testable), e.g. `packages/web/src/components/rank/rank-up.ts`:
  ```ts
  export function rankIndex(rank: string): number;       // 0 = Bronze ... 4 = Diamond
  export function didRankUp(prev: string | null, curr: string): boolean;
  ```
  Ordering derived from `RANK_THRESHOLDS` (ascending), so it stays correct if thresholds change.
- localStorage key: `rank:lastSeen:<playerId>`.
- On mount of the profile badge (`celebrate` + `playerId`):
  read stored tier; if `didRankUp(stored, current)`, play `rank-pop` + sparkles once; then write
  `current` to storage regardless. First-ever view (no stored value) does **not** celebrate.
- Reduced-motion: skip the animation, still update storage.

## Surface wiring

- `leaderboard-table.tsx` — delete local `RankBadge`, import shared (`size="sm"`, animated).
- `profile-view.tsx` — delete local `RankBadge`, import shared
  (`size="lg"`, animated, `celebrate`, `playerId`). Keep the existing avatar gradient + "rating to
  next rank" subtitle.
- `dashboard/page.tsx` — render `<RankBadge size="sm" rank={rankName} />` in the Rank card instead
  of the plain text value; keep the "—" placeholder when the user has no player row.

## Testing

- Unit: `rankIndex` / `didRankUp` (including null-prev = no celebration, equal tiers = false,
  lower current = false).
- Unit: `RANK_VISUALS` has an entry for every tier in `RANK_THRESHOLDS`.
- Component render: each tier renders its label and applies the expected `idleClass`; unknown rank
  uses the fallback. CSS motion itself is not asserted.
- Existing `leaderboard-route.test.ts` / `player-route.test.ts` are data tests and should remain
  green.

## Post-implementation

- Run the **`simplify`** skill over the new/modified files to tighten the component and remove any
  incidental duplication before finishing.

## Out of scope

- Leaderboard position numbers (#1/#2/#3 trophy) stay as-is.
- No Discord/bot changes.
- No new tiers or threshold/color changes (colors are reused, just centralized).
