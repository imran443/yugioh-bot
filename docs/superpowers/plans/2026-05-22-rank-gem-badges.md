# Animated Rank Gem Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain text rank pills with a reusable animated gem `RankBadge` — a faceted gem icon plus a per-tier idle animation that escalates with rank — across the leaderboard, profile, and dashboard.

**Architecture:** One client component `RankBadge` backed by two pure modules (`rank-visuals` for colors/gradients/idle-class, `rank-up` for tier-ordering + celebration logic). Idle/hover/celebration motion is CSS keyframes in `globals.css`; the existing global `prefers-reduced-motion` reset disables it automatically. The three current surfaces drop their duplicated local badge and import the shared one.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (`@theme` in `globals.css`), Vitest + @testing-library/react (jsdom opt-in via `// @vitest-environment jsdom`).

---

## File Structure

- Create: `packages/web/src/components/rank/rank-visuals.ts` — tier → `{ color, gradientFrom, gradientTo, idleClass, twinkle }` map + `visualForRank()` lookup. Single source of truth, replaces two duplicated `RANK_COLORS` maps.
- Create: `packages/web/src/components/rank/rank-up.ts` — `rankIndex()` + `didRankUp()` pure helpers (tier ordering from `RANK_THRESHOLDS`).
- Create: `packages/web/src/components/rank/rank-badge.tsx` — the reusable client component.
- Create tests: `packages/web/tests/components/rank-visuals.test.ts`, `rank-up.test.ts`, `rank-badge.test.tsx`, `rank-badge-celebration.test.tsx`.
- Modify: `packages/web/app/globals.css` — append rank keyframes + idle classes.
- Modify: `packages/web/src/components/leaderboard/leaderboard-table.tsx` — delete local `RankBadge` + `RANK_COLORS`, use shared.
- Modify: `packages/web/src/components/player/profile-view.tsx` — delete local `RankBadge` + `RANK_COLORS`, use shared (`size="lg"`, `celebrate`), derive avatar `rankColor` from `visualForRank`.
- Modify: `packages/web/app/(app)/dashboard/page.tsx` — render `<RankBadge>` in the Rank stat card instead of plain text.

Test commands (from repo root):
- A single web test file: `npx vitest run packages/web/tests/components/<file> -c packages/web/vitest.config.ts`
- All web tests: `npm test --workspace=packages/web`
- Typecheck everything: `npm run typecheck`

---

### Task 1: `rank-visuals` module

**Files:**
- Create: `packages/web/src/components/rank/rank-visuals.ts`
- Test: `packages/web/tests/components/rank-visuals.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/components/rank-visuals.test.ts
import { describe, it, expect } from "vitest";
import { RANK_THRESHOLDS } from "@yugidraft/shared/scoring";
import { RANK_VISUALS, FALLBACK_VISUAL, visualForRank } from "../../src/components/rank/rank-visuals";

describe("rank-visuals", () => {
  it("has a visual for every tier in RANK_THRESHOLDS", () => {
    for (const t of RANK_THRESHOLDS) {
      expect(RANK_VISUALS[t.name]).toBeDefined();
    }
  });

  it("gives only Bronze an empty idle class", () => {
    expect(RANK_VISUALS.Bronze.idleClass).toBe("");
    expect(RANK_VISUALS.Diamond.idleClass).not.toBe("");
    expect(RANK_VISUALS.Diamond.twinkle).toBe(true);
  });

  it("falls back to a neutral visual for unknown ranks", () => {
    expect(visualForRank("Unranked")).toBe(FALLBACK_VISUAL);
    expect(visualForRank("Gold")).toBe(RANK_VISUALS.Gold);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/tests/components/rank-visuals.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — cannot resolve `../../src/components/rank/rank-visuals`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web/src/components/rank/rank-visuals.ts
export interface RankVisual {
  /** text + border base color */
  color: string;
  /** gem gradient top stop */
  gradientFrom: string;
  /** gem gradient bottom stop */
  gradientTo: string;
  /** idle-animation utility class, "" for the calm entry tier */
  idleClass: string;
  /** render the in-place twinkle sparkles (top tier only) */
  twinkle?: boolean;
}

export const RANK_VISUALS: Record<string, RankVisual> = {
  Diamond: { color: "#a78bfa", gradientFrom: "#c4b5fd", gradientTo: "#a78bfa", idleClass: "rank-idle-diamond", twinkle: true },
  Platinum: { color: "#7dd3fc", gradientFrom: "#bae6fd", gradientTo: "#7dd3fc", idleClass: "rank-idle-platinum" },
  Gold: { color: "#f5c451", gradientFrom: "#ffe9a8", gradientTo: "#f5c451", idleClass: "rank-idle-gold" },
  Silver: { color: "#cbd5e1", gradientFrom: "#f1f5f9", gradientTo: "#cbd5e1", idleClass: "rank-idle-silver" },
  Bronze: { color: "#d6a06a", gradientFrom: "#e8c39e", gradientTo: "#d6a06a", idleClass: "" },
};

export const FALLBACK_VISUAL: RankVisual = {
  color: "#9aa0b8",
  gradientFrom: "#c7ccda",
  gradientTo: "#9aa0b8",
  idleClass: "",
};

export function visualForRank(rank: string): RankVisual {
  return RANK_VISUALS[rank] ?? FALLBACK_VISUAL;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/tests/components/rank-visuals.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/rank/rank-visuals.ts packages/web/tests/components/rank-visuals.test.ts
git commit -m "feat(web): rank visual map (gem colors + per-tier idle class)"
```

---

### Task 2: `rank-up` tier-ordering + celebration logic

**Files:**
- Create: `packages/web/src/components/rank/rank-up.ts`
- Test: `packages/web/tests/components/rank-up.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/tests/components/rank-up.test.ts
import { describe, it, expect } from "vitest";
import { rankIndex, didRankUp } from "../../src/components/rank/rank-up";

describe("rank-up", () => {
  it("orders tiers ascending (Bronze lowest, Diamond highest)", () => {
    expect(rankIndex("Bronze")).toBe(0);
    expect(rankIndex("Diamond")).toBe(4);
    expect(rankIndex("Gold")).toBeGreaterThan(rankIndex("Silver"));
  });

  it("returns -1 for an unknown rank", () => {
    expect(rankIndex("Nope")).toBe(-1);
  });

  it("celebrates only on a genuine increase", () => {
    expect(didRankUp("Silver", "Gold")).toBe(true);
    expect(didRankUp("Gold", "Gold")).toBe(false);
    expect(didRankUp("Diamond", "Gold")).toBe(false);
  });

  it("never celebrates a first-ever view", () => {
    expect(didRankUp(null, "Diamond")).toBe(false);
  });

  it("never celebrates when either rank is unknown", () => {
    expect(didRankUp("Garbage", "Gold")).toBe(false);
    expect(didRankUp("Gold", "Garbage")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/tests/components/rank-up.test.ts -c packages/web/vitest.config.ts`
Expected: FAIL — cannot resolve `../../src/components/rank/rank-up`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web/src/components/rank/rank-up.ts
import { RANK_THRESHOLDS } from "@yugidraft/shared/scoring";

// ascending by rating: index 0 = lowest tier (Bronze) ... highest = Diamond
const ORDER: string[] = [...RANK_THRESHOLDS]
  .sort((a, b) => a.min - b.min)
  .map((t) => t.name);

export function rankIndex(rank: string): number {
  return ORDER.indexOf(rank);
}

export function didRankUp(prev: string | null, curr: string): boolean {
  if (prev === null) return false;
  const p = rankIndex(prev);
  const c = rankIndex(curr);
  if (p < 0 || c < 0) return false;
  return c > p;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/tests/components/rank-up.test.ts -c packages/web/vitest.config.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/rank/rank-up.ts packages/web/tests/components/rank-up.test.ts
git commit -m "feat(web): rank-up tier ordering + celebration predicate"
```

---

### Task 3: CSS keyframes + idle/hover/pop classes

**Files:**
- Modify: `packages/web/app/globals.css` (append at end of file, after line 94)

No unit test (CSS); verified by typecheck/build in later tasks and a manual dev-server check noted at the end.

- [ ] **Step 1: Append the rank animation block to `globals.css`**

Add to the very end of `packages/web/app/globals.css`:

```css

/* ---------- Rank badge animations ---------- */

/* keep gem + label above the gloss streak */
.rank-gem,
.rank-label {
  position: relative;
  z-index: 1;
}

/* gloss sweep streak (Silver, Gold, Platinum, Diamond) */
.rank-idle-silver::after,
.rank-idle-gold::after,
.rank-idle-platinum::after,
.rank-idle-diamond::after {
  content: "";
  position: absolute;
  top: 0;
  left: -60%;
  width: 45%;
  height: 100%;
  background: linear-gradient(110deg, transparent, rgba(255, 255, 255, 0.33), transparent);
  transform: skewX(-18deg);
  pointer-events: none;
  z-index: 0;
}
.rank-idle-silver::after {
  animation: rank-sweep 5s ease-in-out infinite;
}
.rank-idle-gold::after,
.rank-idle-platinum::after,
.rank-idle-diamond::after {
  animation: rank-sweep 3.2s ease-in-out infinite;
}
@keyframes rank-sweep {
  0% { left: -60%; }
  35%, 100% { left: 130%; }
}

/* aura glow on the pill (Gold warm, Platinum cool) */
.rank-idle-gold {
  animation: rank-glow-gold 2.8s ease-in-out infinite;
}
@keyframes rank-glow-gold {
  0%, 100% { box-shadow: 0 0 0 rgba(245, 196, 81, 0); }
  50% { box-shadow: 0 0 14px rgba(245, 196, 81, 0.33); }
}
.rank-idle-platinum {
  animation: rank-glow-plat 3s ease-in-out infinite;
}
@keyframes rank-glow-plat {
  0%, 100% { box-shadow: 0 0 4px rgba(125, 211, 252, 0.13); }
  50% { box-shadow: 0 0 16px rgba(125, 211, 252, 0.4); }
}

/* gem motion: Platinum bobs, Diamond breathes */
.rank-idle-platinum .rank-gem {
  animation: rank-bob 2.4s ease-in-out infinite;
}
@keyframes rank-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
.rank-idle-diamond .rank-gem {
  animation: rank-breathe 2.6s ease-in-out infinite;
}
@keyframes rank-breathe {
  0%, 100% { filter: drop-shadow(0 0 2px rgba(167, 139, 250, 0.4)); transform: scale(1); }
  50% { filter: drop-shadow(0 0 10px rgba(167, 139, 250, 0.87)); transform: scale(1.05); }
}

/* Diamond twinkles — in-place, kept inside the pill bounds */
.rank-twinkle {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  z-index: 1;
}
.rank-twinkle-1 {
  top: 4px;
  left: 6px;
  animation: rank-twinkle 2.2s ease-in-out infinite;
}
.rank-twinkle-2 {
  bottom: 4px;
  left: 13px;
  animation: rank-twinkle 2.2s ease-in-out 1.1s infinite;
}
@keyframes rank-twinkle {
  0%, 100% { opacity: 0; transform: scale(0.3); }
  50% { opacity: 1; transform: scale(1); }
}

/* rank-up celebration pop (overrides idle while playing) */
.rank-pop {
  animation: rank-pop 0.7s cubic-bezier(0.2, 1.4, 0.4, 1);
}
@keyframes rank-pop {
  0% { transform: scale(1); }
  30% { transform: scale(1.4) rotate(-8deg); }
  55% { transform: scale(0.92); }
  100% { transform: scale(1); }
}
```

- [ ] **Step 2: Verify the stylesheet still compiles**

Run: `npm run typecheck`
Expected: PASS (typecheck does not parse CSS, but confirms nothing else broke). A full visual check happens in Task 9.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/globals.css
git commit -m "feat(web): rank badge keyframes (gloss, glow, bob, breathe, twinkle, pop)"
```

---

### Task 4: `RankBadge` component — render behavior

**Files:**
- Create: `packages/web/src/components/rank/rank-badge.tsx`
- Test: `packages/web/tests/components/rank-badge.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/rank-badge.test.tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RankBadge } from "../../src/components/rank/rank-badge";

describe("RankBadge", () => {
  it("renders the tier name", () => {
    render(<RankBadge rank="Gold" />);
    expect(screen.getByText("Gold")).toBeInTheDocument();
  });

  it("applies the per-tier idle class when animated", () => {
    render(<RankBadge rank="Diamond" />);
    expect(screen.getByTestId("rank-badge").className).toContain("rank-idle-diamond");
  });

  it("gives Bronze no idle class", () => {
    render(<RankBadge rank="Bronze" />);
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-idle");
  });

  it("omits idle animation when animate is false", () => {
    render(<RankBadge rank="Diamond" animate={false} />);
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-idle");
  });

  it("renders two twinkles only for Diamond", () => {
    const { container, rerender } = render(<RankBadge rank="Diamond" />);
    expect(container.querySelectorAll(".rank-twinkle").length).toBe(2);
    rerender(<RankBadge rank="Gold" />);
    expect(container.querySelectorAll(".rank-twinkle").length).toBe(0);
  });

  it("falls back to a gray badge for an unknown rank", () => {
    render(<RankBadge rank="Unranked" />);
    const el = screen.getByTestId("rank-badge");
    expect(el).toHaveTextContent("Unranked");
    expect(el.className).not.toContain("rank-idle");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/tests/components/rank-badge.test.tsx -c packages/web/vitest.config.ts`
Expected: FAIL — cannot resolve `../../src/components/rank/rank-badge`.

- [ ] **Step 3: Write the implementation**

```tsx
// packages/web/src/components/rank/rank-badge.tsx
"use client";

import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { visualForRank } from "./rank-visuals";
import { didRankUp } from "./rank-up";

export interface RankBadgeProps {
  rank: string;
  /** sm = table + dashboard (default), lg = profile header */
  size?: "sm" | "lg";
  /** run idle + hover animation (default true) */
  animate?: boolean;
  /** play the one-shot rank-up pop on mount when the tier increased */
  celebrate?: boolean;
  /** required when celebrate is true — scopes the localStorage key */
  playerId?: number;
}

export function RankBadge({
  rank,
  size = "sm",
  animate = true,
  celebrate = false,
  playerId,
}: RankBadgeProps) {
  const visual = visualForRank(rank);
  const gradientId = useId();
  const [popping, setPopping] = useState(false);

  useEffect(() => {
    if (!celebrate || playerId == null) return;
    const key = `rank:lastSeen:${playerId}`;
    let prev: string | null = null;
    try {
      prev = window.localStorage.getItem(key);
    } catch {
      return; // storage unavailable (private mode etc.)
    }
    if (didRankUp(prev, rank)) setPopping(true);
    try {
      window.localStorage.setItem(key, rank);
    } catch {
      // ignore write failures
    }
  }, [celebrate, playerId, rank]);

  const gemSize = size === "lg" ? 22 : 15;
  const sizing = size === "lg" ? "px-3 py-1 text-sm gap-2" : "px-2.5 py-0.5 text-xs gap-1.5";

  return (
    <span
      data-testid="rank-badge"
      className={cn(
        "relative inline-flex items-center overflow-hidden rounded-full font-semibold",
        sizing,
        animate && !popping && visual.idleClass,
        animate &&
          "motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-0.5 motion-safe:hover:scale-105",
        popping && "rank-pop",
      )}
      style={{
        color: visual.color,
        background: `${visual.color}18`,
        border: `1px solid ${visual.color}40`,
      }}
      onAnimationEnd={() => setPopping(false)}
    >
      <svg
        className="rank-gem flex-shrink-0"
        width={gemSize}
        height={gemSize}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={visual.gradientFrom} />
            <stop offset="1" stopColor={visual.gradientTo} />
          </linearGradient>
        </defs>
        <path fill={`url(#${gradientId})`} d="M6 3h12l4 6-10 13L2 9Z" />
        <path fill="#ffffff44" d="M6 3h12l-6 6Z" />
      </svg>
      {animate && visual.twinkle && (
        <>
          <i className="rank-twinkle rank-twinkle-1" aria-hidden="true" />
          <i className="rank-twinkle rank-twinkle-2" aria-hidden="true" />
        </>
      )}
      <span className="rank-label">{rank}</span>
    </span>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/tests/components/rank-badge.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/rank/rank-badge.tsx packages/web/tests/components/rank-badge.test.tsx
git commit -m "feat(web): reusable animated RankBadge component"
```

---

### Task 5: `RankBadge` rank-up celebration behavior

**Files:**
- Test: `packages/web/tests/components/rank-badge-celebration.test.tsx` (the component logic already exists from Task 4; this task locks the behavior with tests)

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/tests/components/rank-badge-celebration.test.tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RankBadge } from "../../src/components/rank/rank-badge";

beforeEach(() => {
  window.localStorage.clear();
});

describe("RankBadge celebration", () => {
  it("pops and records the tier when the player ranked up", async () => {
    window.localStorage.setItem("rank:lastSeen:7", "Silver");
    render(<RankBadge rank="Gold" celebrate playerId={7} />);
    await waitFor(() =>
      expect(screen.getByTestId("rank-badge").className).toContain("rank-pop"),
    );
    expect(window.localStorage.getItem("rank:lastSeen:7")).toBe("Gold");
  });

  it("does not pop on a first-ever view but still records the tier", async () => {
    render(<RankBadge rank="Diamond" celebrate playerId={9} />);
    await waitFor(() =>
      expect(window.localStorage.getItem("rank:lastSeen:9")).toBe("Diamond"),
    );
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-pop");
  });

  it("does not touch storage or pop when celebrate is off", () => {
    window.localStorage.setItem("rank:lastSeen:3", "Bronze");
    render(<RankBadge rank="Diamond" playerId={3} />);
    expect(window.localStorage.getItem("rank:lastSeen:3")).toBe("Bronze");
    expect(screen.getByTestId("rank-badge").className).not.toContain("rank-pop");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run packages/web/tests/components/rank-badge-celebration.test.tsx -c packages/web/vitest.config.ts`
Expected: PASS (3 tests). If any fail, fix `rank-badge.tsx` from Task 4 (do not weaken the tests).

- [ ] **Step 3: Commit**

```bash
git add packages/web/tests/components/rank-badge-celebration.test.tsx
git commit -m "test(web): lock RankBadge rank-up celebration behavior"
```

---

### Task 6: Wire the leaderboard table

**Files:**
- Modify: `packages/web/src/components/leaderboard/leaderboard-table.tsx`

- [ ] **Step 1: Replace the import block**

Change the top imports (lines 1-6) from:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trophy, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
```

to:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trophy, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { RankBadge } from "@/components/rank/rank-badge";
```

- [ ] **Step 2: Delete the local `RANK_COLORS` map and `RankBadge` function**

Remove the `RANK_COLORS` constant (lines 27-33) and the entire local `RankBadge` function (lines 35-49). Leave `PositionNumber` untouched (it uses literal hex, not the map).

- [ ] **Step 3: Confirm the usage site is unchanged**

The existing call `<RankBadge rank={row.rank} />` (around line 169) now resolves to the imported component (default `size="sm"`, animated). No change needed there.

- [ ] **Step 4: Typecheck + run leaderboard tests**

Run: `npm run typecheck`
Then: `npx vitest run packages/web/tests/leaderboard-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS, no unused-symbol errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/leaderboard/leaderboard-table.tsx
git commit -m "feat(web): use shared RankBadge in leaderboard table"
```

---

### Task 7: Wire the profile header

**Files:**
- Modify: `packages/web/src/components/player/profile-view.tsx`

- [ ] **Step 1: Add the shared imports**

After the existing `import { cn } from "@/lib/utils";` (line 13), add:

```tsx
import { RankBadge } from "@/components/rank/rank-badge";
import { visualForRank } from "@/components/rank/rank-visuals";
```

- [ ] **Step 2: Delete the local `RANK_COLORS` map and `RankBadge` function**

Remove the `RANK_COLORS` constant (lines 28-34) and the entire local `RankBadge` function (lines 47-61). Keep `LUCIDE_ICONS`, `StatCard`, `ScopeToggle`, etc.

- [ ] **Step 3: Derive `rankColor` from the shared map**

Replace the existing line (around line 156):

```tsx
  const rankColor = RANK_COLORS[profile.rank.name] ?? "#9aa0b8";
```

with:

```tsx
  const rankColor = visualForRank(profile.rank.name).color;
```

- [ ] **Step 4: Use the shared badge with celebration in the header**

Replace the existing usage (around line 183):

```tsx
            <RankBadge rank={profile.rank.name} />
```

with:

```tsx
            <RankBadge rank={profile.rank.name} size="lg" celebrate playerId={profile.playerId} />
```

(`profile.playerId` exists on the `getProfile` return type.)

- [ ] **Step 5: Typecheck + run profile tests**

Run: `npm run typecheck`
Then: `npx vitest run packages/web/tests/player-route.test.ts -c packages/web/vitest.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/player/profile-view.tsx
git commit -m "feat(web): use shared RankBadge in profile header with rank-up celebration"
```

---

### Task 8: Wire the dashboard Rank card

**Files:**
- Modify: `packages/web/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Import the shared badge**

Add to the existing imports at the top of the file:

```tsx
import { RankBadge } from "@/components/rank/rank-badge";
```

- [ ] **Step 2: Render the badge in the Rank stat card**

Replace the Rank `StatCard` (around lines 142-146):

```tsx
        <StatCard
          icon={<Star className="h-5 w-5 text-accent-primary" />}
          label="Rank"
          value={rankName !== null ? rankName : "—"}
        />
```

with:

```tsx
        <StatCard
          icon={<Star className="h-5 w-5 text-accent-primary" />}
          label="Rank"
          value={rankName !== null ? <RankBadge rank={rankName} /> : "—"}
        />
```

(The dashboard is a server component; `RankBadge` is a client component and renders fine as a child. No `celebrate` here — the profile is the celebration surface.)

- [ ] **Step 3: Typecheck + run web tests**

Run: `npm run typecheck`
Then: `npm test --workspace=packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "packages/web/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): show gem RankBadge in dashboard rank card"
```

---

### Task 9: Simplify pass + full verification

**Files:** any of the new/modified files, as the simplify pass directs.

- [ ] **Step 1: Run the simplify skill over the new code**

Invoke the `simplify` skill on the rank module + the three wired files. Apply only changes that preserve behavior (tighten the component, drop any incidental duplication, clarify names). Keep all tests green.

- [ ] **Step 2: Full typecheck + test suite**

Run: `npm run typecheck`
Then: `npm test`
Expected: all packages PASS.

- [ ] **Step 3: Manual visual check (the part tests can't cover)**

Run: `npm run dev:web`, open the leaderboard, a player profile, and the dashboard. Confirm:
- Each tier shows its gem with the right color.
- Idle animation escalates Bronze (static) → Diamond (breathe + twinkle + gloss).
- Hover lifts/glows a badge.
- Rank-up pop: in devtools set `localStorage["rank:lastSeen:<yourPlayerId>"] = "Bronze"`, reload your profile (with a higher current tier), confirm the pop plays once and the value updates.
- Toggle OS "reduce motion" and confirm animations stop.

- [ ] **Step 4: Final commit (if simplify changed anything)**

```bash
git add -A
git commit -m "refactor(web): simplify rank badge implementation"
```

---

## Self-Review

**Spec coverage:**
- Reusable component → Task 4. De-dup of two `RankBadge` copies → Tasks 6, 7. Dashboard plain-text → badge → Task 8. ✓
- Faceted gem (Option B) with gradient + facet → Task 4 SVG. ✓
- Per-tier escalating idle ladder → Task 3 CSS + Task 1 `idleClass`/`twinkle`. ✓
- Universal hover → Task 4 `motion-safe:` classes. ✓
- Rank-up celebration via localStorage last-seen → Tasks 2, 4, 5. ✓
- All three surfaces → Tasks 6, 7, 8. ✓
- Reduced-motion handled by existing global reset → noted (Task 3) + verified (Task 9). ✓
- Testing: `didRankUp`/`rankIndex`, visuals coverage, per-tier render, fallback → Tasks 1, 2, 4, 5. ✓
- Simplify pass → Task 9. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `visualForRank` / `RANK_VISUALS` / `FALLBACK_VISUAL` (Task 1) used identically in Tasks 4 & 7. `rankIndex` / `didRankUp` (Task 2) used in Task 4. `RankBadgeProps` (`rank`, `size`, `animate`, `celebrate`, `playerId`) consistent across Tasks 4–8. CSS class names (`rank-gem`, `rank-label`, `rank-twinkle`, `rank-idle-*`, `rank-pop`) match between Task 3 CSS and Task 4 JSX.

**Out of scope (unchanged):** leaderboard position numbers (#1/#2/#3), bot/Discord, tier thresholds/colors.
