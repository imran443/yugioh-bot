# Draft UI Enhancements & Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two production bugs (YDK `.crdownload`, timer expiry stalling), move timer to top-center, and upgrade the pool panel and summary screen with card images, hover previews, and sort controls.

**Architecture:** All UI changes live in `packages/web`. The timer layout change is a restructure of `app/(app)/draft/[slug]/page.tsx`. A new shared `CardHoverPopup` component is extracted so pool panel and summary both get identical hover previews without duplication. The bot-side timer bug fix adds a `packages/bot/src/lib/notify-ws.ts` that mirrors the web app's equivalent and calls the WS server after auto-expiry.

**Tech Stack:** Next.js 15 App Router, React, Zustand, Tailwind CSS, Lucide icons, better-sqlite3, Socket.IO internal HTTP

**Design system (ui-ux-pro-max):** Gaming/esports tone — dark surfaces, touch targets ≥44px, hover state 150–300ms transitions, hover-only interactions paired with focus/blur equivalents for keyboard accessibility.

---

## File Map

| File | Change |
|------|--------|
| `packages/web/src/lib/ydk.ts` | Extend `URL.revokeObjectURL` delay from 0ms → 60s |
| `packages/web/src/components/draft/draft-summary-view.tsx` | Fix sync revoke; add images, attributes, ATK/DEF, hover preview |
| `packages/web/src/lib/hooks/use-draft-expiry-resync.ts` | Remove `!isMyTurn` guard so all players poll on timer expiry |
| `packages/bot/src/lib/notify-ws.ts` | **New** — HMAC-signed WS notifier for the bot |
| `packages/bot/src/services/draft-timer.ts` | Accept `wsCfg`, broadcast `draft:resync` after auto-expiry |
| `packages/bot/src/index.ts` | Pass `wsCfg` to timer service |
| `.env.example` | Document `WS_INTERNAL_URL` / `WS_INTERNAL_SECRET` for bot |
| `packages/web/app/(app)/draft/[slug]/page.tsx` | Move `TimerBar` from left aside → full-width sticky top bar |
| `packages/web/src/components/draft/card-hover-popup.tsx` | **New** — shared hover preview popup |
| `packages/web/src/components/draft/pool-panel.tsx` | Thumbnails, attribute, hover preview, sort controls |

---

## Task 1: Fix YDK `.crdownload` — revokeObjectURL timing

**Root cause:** Chrome creates a `.crdownload` temp file and needs time to read the blob before the URL is revoked. `draft-summary-view.tsx` calls `URL.revokeObjectURL(url)` synchronously right after `a.click()`. `ydk.ts` uses `setTimeout(0)` which is also too short in some cases.

**Files:**
- Modify: `packages/web/src/lib/ydk.ts:45`
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx:92`

- [ ] **Step 1: Fix `ydk.ts` — extend delay from 0ms to 60s**

In `packages/web/src/lib/ydk.ts`, line 45, change:
```ts
// BEFORE:
setTimeout(() => URL.revokeObjectURL(url), 0);

// AFTER:
setTimeout(() => URL.revokeObjectURL(url), 60000);
```

Full function after change:
```ts
export function downloadYdk(cards: YdkCard[], filename: string): void {
  const content = generateYdk(cards);
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
```

- [ ] **Step 2: Fix `draft-summary-view.tsx` `handleExport` — add 60s delay**

In `packages/web/src/components/draft/draft-summary-view.tsx`, change `handleExport` (around lines 79–98):
```ts
const handleExport = async () => {
  setExporting(true);
  setError(null);
  try {
    const ydkContent = await onExportYdk();
    const blob = new Blob([ydkContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draft.name.replace(/\s+/g, "_")}.ydk`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to export YDK");
  } finally {
    setExporting(false);
  }
};
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/ydk.ts packages/web/src/components/draft/draft-summary-view.tsx
git commit -m "fix(web): defer revokeObjectURL 60s to prevent .crdownload incomplete download"
```

---

## Task 2: Fix timer expiry — client-side resync for already-picked players

**Root cause:** `useDraftExpiryResync` only polls when `isMyTurn === true`. Players who already picked (`isMyTurn = false`) never resync when the timer fires and the bot auto-picks remaining players. They are stuck on the old pack until someone else's pick WS event arrives.

**Files:**
- Modify: `packages/web/src/lib/hooks/use-draft-expiry-resync.ts`

- [ ] **Step 1: Remove `!isMyTurn` from the guard condition and dependency array**

Replace the entire file content:
```ts
"use client";

import { useEffect } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftExpiryResync(slug: string) {
  const packRound = useDraftStore((s) => s.packRound);
  const pickStep = useDraftStore((s) => s.pickStep);
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const completed = useDraftStore((s) => s.completed);
  const setFromServer = useDraftStore((s) => s.setFromServer);

  useEffect(() => {
    // Poll whenever the timer hits 0 on an active draft — including for players who have
    // already picked this step, because the bot auto-picks remaining players and the pack
    // then advances. Without this, already-picked players get stuck until a WS event arrives.
    if (!slug || completed || timerSeconds > 0) {
      return;
    }

    let cancelled = false;

    const syncDraftState = () => {
      void fetch(`/api/drafts/${slug}`)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to refetch draft state: ${response.status}`);
          }
          return response.json();
        })
        .then((data) => {
          if (cancelled) return;
          setFromServer({
            slug,
            packRound: data.packRound ?? data.currentPackRound ?? 1,
            pickStep: data.pickStep ?? data.currentPickStep ?? 1,
            currentPack: data.currentPack ?? [],
            myPool: data.myPool ?? [],
            seats: data.seats ?? [],
            timerSeconds: data.timerSeconds ?? 0,
            isMyTurn: data.isMyTurn ?? false,
            completed: data.completed ?? false,
            pickSeconds: data.pickSeconds ?? data.config?.pickSeconds ?? 60,
          });
        })
        .catch((error) => {
          console.warn("Draft expiry resync failed:", error);
        });
    };

    syncDraftState();
    const intervalId = window.setInterval(syncDraftState, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [completed, packRound, pickStep, setFromServer, slug, timerSeconds]);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/lib/hooks/use-draft-expiry-resync.ts
git commit -m "fix(web): resync draft state on timer expiry for all players, not only active pickers"
```

---

## Task 3: Fix timer expiry — bot broadcasts draft:resync to WS after auto-pick

**Root cause (server side):** Bot timer calls `expireCurrentPickStep` and updates Discord but never notifies the WS server. Web clients rely on polling (Task 2) or incoming pick events. This task adds an immediate WS push so stuck clients don't need to wait a full poll cycle.

**Files:**
- Create: `packages/bot/src/lib/notify-ws.ts`
- Modify: `packages/bot/src/services/draft-timer.ts`
- Modify: `packages/bot/src/index.ts:179`
- Modify: `.env.example`

- [ ] **Step 1: Create `packages/bot/src/lib/notify-ws.ts`**

```ts
import { createHmac } from "node:crypto";

export async function notifyWs(
  cfg: { url: string; secret: string },
  kind: string,
  slug: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!cfg.url || !cfg.secret) return;
  const body = JSON.stringify({ slug, ...extra });
  const sig = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(`${cfg.url}/internal/draft/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announce-signature": sig,
      },
      body,
    });
    if (!res.ok) console.warn(`[bot/notify-ws] non-2xx for ${kind}: ${res.status}`);
  } catch (err) {
    console.warn(`[bot/notify-ws] failed for ${kind}:`, err);
  }
}
```

- [ ] **Step 2: Update `packages/bot/src/services/draft-timer.ts`**

Replace the entire file:
```ts
import type { DraftMessenger } from "../commands/handlers.js";
import type { DraftService } from "./drafts.js";
import { notifyWs } from "../lib/notify-ws.js";

export function createDraftTimerService({
  drafts,
  messenger,
  wsCfg,
}: {
  drafts: DraftService;
  messenger: DraftMessenger;
  wsCfg: { url: string; secret: string };
}) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(now = new Date()) {
    const activeDrafts = drafts.listActive();

    for (const draft of activeDrafts) {
      if (!draft.pickDeadlineAt) {
        continue;
      }

      const deadline = new Date(draft.pickDeadlineAt);

      if (deadline > now) {
        continue;
      }

      try {
        drafts.expireCurrentPickStep(draft.id, now);
        const updatedDraft = drafts.findById(draft.id);
        await messenger.updateStatus(updatedDraft);

        if (!updatedDraft.webSlug) continue;

        if (updatedDraft.status === "completed") {
          await notifyWs(wsCfg, "complete", updatedDraft.webSlug);
        } else {
          await notifyWs(wsCfg, "resync", updatedDraft.webSlug, {
            packRound: updatedDraft.currentPackRound,
            pickStep: updatedDraft.currentPickStep,
          });
        }
      } catch (error) {
        console.warn(`Draft timer failed to expire pick step for draft ${draft.id}`, error);
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      intervalId = setInterval(() => tick(), 1000);
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    tick,
  };
}

export type DraftTimerService = ReturnType<typeof createDraftTimerService>;
```

- [ ] **Step 3: Update `packages/bot/src/index.ts` line ~179 — pass `wsCfg` to the timer**

Find the line:
```ts
const draftTimer = createDraftTimerService({ drafts: deps.drafts, messenger: deps.messenger });
```

Replace with:
```ts
const draftTimer = createDraftTimerService({
  drafts: deps.drafts,
  messenger: deps.messenger,
  wsCfg: {
    url: process.env.WS_INTERNAL_URL ?? "",
    secret: process.env.WS_INTERNAL_SECRET ?? "",
  },
});
```

- [ ] **Step 4: Add `.env.example` documentation**

In `.env.example`, add after the `# --- WebSocket Server (packages/ws) ---` section:
```
# --- Bot → WS Server broadcast (pick expiry) ---
# Use the same values as WS_INTERNAL_URL / WS_INTERNAL_SECRET in the web app
WS_INTERNAL_URL=http://localhost:3002
WS_INTERNAL_SECRET=
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc -p packages/bot/tsconfig.json --noEmit 2>/dev/null || echo "check bot tsconfig path"`

Expected: 0 errors. If no tsconfig, check `packages/bot/` for the config file name.

- [ ] **Step 6: Commit**

```bash
git add packages/bot/src/lib/notify-ws.ts packages/bot/src/services/draft-timer.ts packages/bot/src/index.ts .env.example
git commit -m "fix(bot): broadcast draft:resync to WS server after timer auto-expiry"
```

---

## Task 4: Move timer bar to full-width top-center sticky

**Current layout (desktop xl):** `TimerBar` sits in the left `<aside>` at top-left of the 3-column grid.
**New layout:** A single sticky `TimerBar` spans the full page width at the top, visible at all breakpoints. The left aside becomes SeatList-only.

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

- [ ] **Step 1: Replace the active draft `return` block**

Find the block starting at `if (draft.status === "active") {` (around line 282). Replace the entire block with:

```tsx
if (draft.status === "active") {
  return (
    <div>
      {/* Full-width sticky timer — visible at ALL screen sizes, centered */}
      <div className="sticky top-0 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3">
        <div className="mx-auto max-w-[1600px]">
          <TimerBar />
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
        <div className="mb-6 sm:hidden">
          <SeatList />
        </div>

        <div className="grid gap-8 xl:grid-cols-[15rem_minmax(0,1fr)_17.5rem]">
          {/* Left aside — SeatList only (TimerBar moved to sticky top) */}
          <aside className="hidden flex-col gap-4 xl:flex">
            <SeatList />
          </aside>

          <section className="min-w-0">
            <div className="mb-6">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                Live Draft Room
              </p>
              <h1 className="mt-1 font-display text-2xl leading-tight text-text-primary sm:text-3xl">
                {draft.name}
              </h1>

              {draft.config.setNames && draft.config.setNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {draft.config.setNames.map((setName) => (
                    <span
                      key={setName}
                      className="rounded-full border border-accent-primary/25 bg-accent-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-primary"
                    >
                      {setName}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/50 pt-3 text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  Pack {draft.packRound ?? draft.currentPackRound ?? 1} · Pick{" "}
                  {draft.pickStep ?? draft.currentPickStep ?? 1}
                </span>
                <span>{draft.currentPack?.length ?? 0} cards in pack</span>
                <span>{draft.playerCount} players</span>
                <span>{draft.pickSeconds ?? draft.config.pickSeconds ?? 60}s timer</span>
              </div>
            </div>
            <CardGrid />
          </section>

          {/* sm–xl intermediate aside — TimerBar removed, SeatList + PoolPanel kept */}
          <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex xl:hidden">
            <SeatList />
            <PoolPanel />
          </aside>

          <aside className="hidden xl:block">
            <PoolPanel />
          </aside>
        </div>

        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-deep/95 backdrop-blur-sm p-4 sm:hidden">
          <PoolPanel />
        </div>

        <div className="h-20 sm:hidden" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify visually**

Start the dev server: `npx turbo dev --filter=web`

Open an active draft. Confirm:
- Timer bar spans the full top of the screen (not the left column)
- Left column on xl now shows only the seat list
- Timer is still visible on mobile (it replaces the old mobile-only sticky)

- [ ] **Step 3: Commit**

```bash
git add "packages/web/app/(app)/draft/[slug]/page.tsx"
git commit -m "feat(web): move timer bar to full-width sticky top on all breakpoints"
```

---

## Task 5: Extract CardHoverPopup shared component

Both the pool panel (Task 6) and summary screen (Task 7) need an identical hover preview popup. Create it once here.

**Files:**
- Create: `packages/web/src/components/draft/card-hover-popup.tsx`

- [ ] **Step 1: Create the file**

```tsx
import Image from "next/image";
import { Shield, Swords } from "lucide-react";
import type { DraftCardDetail } from "@/lib/stores/draft-store";

interface CardHoverPopupProps {
  card: DraftCardDetail;
  position: { left: number; top: number };
  imageError: boolean;
  onImageError: () => void;
}

export function CardHoverPopup({ card, position, imageError, onImageError }: CardHoverPopupProps) {
  const isMonster = card.type.toLowerCase().includes("monster");

  return (
    <div
      className="pointer-events-none fixed z-50 hidden lg:block"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <div className="max-h-[calc(100vh-2rem)] w-72 overflow-auto rounded-xl border border-border bg-bg-surface shadow-card">
        <div className="relative isolate aspect-[3/4] w-full overflow-hidden rounded-t-xl bg-bg-elevated">
          {imageError ? (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              No image
            </div>
          ) : (
            <Image
              src={card.imageUrl}
              alt={card.name}
              fill
              className="object-contain"
              sizes="288px"
              onError={onImageError}
            />
          )}
        </div>
        <div className="space-y-3 p-4">
          <h3 className="mb-1 font-display text-lg text-text-primary">{card.name}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            {card.attribute && (
              <span className="rounded-md bg-bg-elevated px-2 py-1">{card.attribute}</span>
            )}
            {card.level !== undefined && (
              <span className="rounded-md bg-bg-elevated px-2 py-1">Level {card.level}</span>
            )}
            <span className="rounded-md bg-bg-elevated px-2 py-1">{card.type}</span>
            <span className="rounded-md bg-bg-elevated px-2 py-1 capitalize">{card.frameType}</span>
          </div>
          <p className="text-sm leading-relaxed text-text-secondary">{card.effectText}</p>
          {isMonster && (card.atk !== undefined || card.def !== undefined) && (
            <div className="flex items-center gap-4 text-sm font-semibold text-text-primary">
              {card.atk !== undefined && (
                <div className="flex items-center gap-1.5">
                  <Swords className="h-4 w-4 text-accent-cta" aria-hidden="true" />
                  <span>ATK {card.atk}</span>
                </div>
              )}
              {card.def !== undefined && (
                <div className="flex items-center gap-1.5">
                  <Shield className="h-4 w-4 text-accent-primary" aria-hidden="true" />
                  <span>DEF {card.def}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/draft/card-hover-popup.tsx
git commit -m "feat(web): add CardHoverPopup shared component for pool panel and summary"
```

---

## Task 6: Pool panel — thumbnails, attribute, hover preview, sort controls

**Files:**
- Modify: `packages/web/src/components/draft/pool-panel.tsx`

Current card row: `[M/S/T badge] [name] [type text]`
New card row: `[28×40px thumbnail] [name + colored type badge + attribute + level] [hover preview on lg]`
New controls: Sort by Newest (default) / Oldest / Name / Type, alongside existing filter pills.

- [ ] **Step 1: Replace `pool-panel.tsx` with the full enhanced version**

```tsx
"use client";

import { useDeferredValue, useMemo, useState, useCallback } from "react";
import Image from "next/image";
import { useDraftStore, type DraftCardDetail } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import { Layers, Swords, Scroll, ShieldAlert, ChevronUp, Download, ArrowUpDown } from "lucide-react";

type PoolFilter = "all" | "monster" | "spell" | "trap";
type PoolSort = "newest" | "oldest" | "name" | "type";

interface PoolPanelProps {
  className?: string;
}

const POPUP_WIDTH = 288;
const POPUP_HEIGHT = 560;
const POPUP_MARGIN = 16;

function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Panel is on the right side — prefer showing popup to the left
  const leftOfItem = rect.left - POPUP_WIDTH - POPUP_MARGIN;
  const left = Math.max(POPUP_MARGIN, leftOfItem);
  const top = Math.min(
    vh - POPUP_HEIGHT - POPUP_MARGIN,
    Math.max(POPUP_MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2),
  );
  return { left, top };
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const [activeSort, setActiveSort] = useState<PoolSort>("newest");
  const [hoveredCard, setHoveredCard] = useState<DraftCardDetail | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const isMonster = (type: string) => type.trim().toLowerCase().includes("monster");
  const isSpell = (type: string) => type.trim().toLowerCase().includes("spell card");
  const isTrap = (type: string) => type.trim().toLowerCase().includes("trap card");

  const getTypeBadgeClass = (type: string) =>
    isMonster(type)
      ? "bg-accent-primary/10 text-accent-primary"
      : isSpell(type)
        ? "bg-accent-gold/10 text-accent-gold"
        : "bg-accent-cta/10 text-accent-cta";

  const getTypeLabel = (type: string) =>
    isMonster(type) ? "Monster" : isSpell(type) ? "Spell" : isTrap(type) ? "Trap" : "Other";

  const monsterCount = myPool.filter((c) => isMonster(c.type)).length;
  const spellCount = myPool.filter((c) => isSpell(c.type)).length;
  const trapCount = myPool.filter((c) => isTrap(c.type)).length;

  const handleImageError = useCallback(
    (id: number) => setImageErrors((prev) => new Set(prev).add(id)),
    [],
  );

  const handleMouseEnter = useCallback((card: DraftCardDetail, rect: DOMRect) => {
    setHoveredCard(card);
    setPopupPosition(getPopupPosition(rect));
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredCard(null);
    setPopupPosition(null);
  }, []);

  const filteredAndSorted = useMemo(() => {
    const needle = deferredSearchTerm.trim().toLowerCase();
    let cards = myPool.filter((card) => {
      const matchesSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "monster" && isMonster(card.type)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      return matchesSearch && matchesFilter;
    });

    if (activeSort === "newest") {
      cards = [...cards].reverse(); // myPool is oldest-first; reverse = newest first
    } else if (activeSort === "name") {
      cards = [...cards].sort((a, b) => a.name.localeCompare(b.name));
    } else if (activeSort === "type") {
      const order = (c: DraftCardDetail) =>
        isMonster(c.type) ? 0 : isSpell(c.type) ? 1 : isTrap(c.type) ? 2 : 3;
      cards = [...cards].sort((a, b) => order(a) - order(b));
    }
    // "oldest" = natural array order (no-op)
    return cards;
  }, [activeFilter, activeSort, deferredSearchTerm, myPool]);

  const filterButtons: Array<{ label: string; value: PoolFilter }> = [
    { label: "All", value: "all" },
    { label: "Monsters", value: "monster" },
    { label: "Spells", value: "spell" },
    { label: "Traps", value: "trap" },
  ];

  const sortButtons: Array<{ label: string; value: PoolSort }> = [
    { label: "Newest", value: "newest" },
    { label: "Oldest", value: "oldest" },
    { label: "Name", value: "name" },
    { label: "Type", value: "type" },
  ];

  const panelContent = (
    <div className="flex flex-col gap-4">
      {/* Drafted count */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated/40 px-3 py-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-text-muted">
          Drafted so far
        </span>
        <span className="font-display text-xl text-text-primary">{myPool.length}</span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-1.5">
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <Swords className="mb-1 h-4 w-4 text-accent-primary" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{monsterCount}</span>
          <span className="text-xs text-text-secondary">Monsters</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <Scroll className="mb-1 h-4 w-4 text-accent-gold" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{spellCount}</span>
          <span className="text-xs text-text-secondary">Spells</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <ShieldAlert className="mb-1 h-4 w-4 text-accent-cta" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{trapCount}</span>
          <span className="text-xs text-text-secondary">Traps</span>
        </div>
      </div>

      {/* Export */}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => downloadYdk(myPool, "draft-pool.ydk")}
        disabled={myPool.length === 0}
        className="w-full"
      >
        <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Export YDK
      </Button>

      {/* Search + filter + sort */}
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <div className="flex flex-col gap-3">
          <input
            type="text"
            aria-label="Search cards"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search cards..."
            className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/60"
          />

          {/* Type filter pills */}
          <div className="flex flex-wrap gap-1.5">
            {filterButtons.map((fb) => (
              <Button
                key={fb.value}
                type="button"
                size="sm"
                variant={activeFilter === fb.value ? "secondary" : "ghost"}
                onClick={() => setActiveFilter(fb.value)}
                aria-pressed={activeFilter === fb.value}
                className="rounded-full px-3 text-xs"
              >
                {fb.label}
              </Button>
            ))}
          </div>

          {/* Sort pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            {sortButtons.map((sb) => (
              <Button
                key={sb.value}
                type="button"
                size="sm"
                variant={activeSort === sb.value ? "secondary" : "ghost"}
                onClick={() => setActiveSort(sb.value)}
                aria-pressed={activeSort === sb.value}
                className="rounded-full px-3 text-xs"
              >
                {sb.label}
              </Button>
            ))}
          </div>

          {/* Card list */}
          <div className="h-72 overflow-y-auto rounded-lg border border-border bg-surface/70">
            {myPool.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">No cards drafted yet.</p>
            ) : filteredAndSorted.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">No cards match.</p>
            ) : (
              <div className="flex flex-col p-2">
                {filteredAndSorted.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                    onMouseEnter={(e) => handleMouseEnter(card, e.currentTarget.getBoundingClientRect())}
                    onMouseLeave={handleMouseLeave}
                    onFocus={(e) => handleMouseEnter(card, e.currentTarget.getBoundingClientRect())}
                    onBlur={handleMouseLeave}
                  >
                    {/* 28×40 thumbnail */}
                    <div className="relative h-10 w-7 shrink-0 overflow-hidden rounded bg-bg-elevated">
                      {imageErrors.has(card.id) ? (
                        <div className="flex h-full w-full items-center justify-center text-[0.5rem] text-text-muted">
                          ?
                        </div>
                      ) : (
                        <Image
                          src={card.imageUrlSmall || card.imageUrl}
                          alt=""
                          fill
                          className="object-cover"
                          sizes="28px"
                          onError={() => handleImageError(card.id)}
                        />
                      )}
                    </div>

                    {/* Name + type badge + attribute + level */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{card.name}</p>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-[0.6rem] font-semibold uppercase",
                            getTypeBadgeClass(card.type),
                          )}
                        >
                          {getTypeLabel(card.type)}
                        </span>
                        {card.attribute && !["SPELL", "TRAP"].includes(card.attribute) && (
                          <span className="text-[0.65rem] text-text-muted">{card.attribute}</span>
                        )}
                        {card.level !== undefined && (
                          <span className="text-[0.65rem] text-text-muted">Lv{card.level}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hover preview */}
      {hoveredCard && popupPosition && (
        <CardHoverPopup
          card={hoveredCard}
          position={popupPosition}
          imageError={imageErrors.has(hoveredCard.id)}
          onImageError={() => handleImageError(hoveredCard.id)}
        />
      )}
    </div>
  );

  return (
    <>
      {/* Desktop/Tablet */}
      <div
        className={cn("hidden rounded-xl border border-border bg-surface p-3 sm:block", className)}
      >
        <h3 className="mb-3 font-display text-lg text-text-primary">Your Pool</h3>
        {panelContent}
      </div>

      {/* Mobile trigger */}
      <div className="sm:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className={cn(
            "flex w-full items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-card",
            className,
          )}
        >
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-text-secondary" aria-hidden="true" />
            <span className="font-semibold text-text-primary">Your Pool ({myPool.length})</span>
          </div>
          <ChevronUp className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </button>
      </div>

      {/* Mobile sheet */}
      <Sheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Your Pool">
        {panelContent}
      </Sheet>
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/draft/pool-panel.tsx
git commit -m "feat(web): add thumbnails, attribute, hover preview, and sort controls to pool panel"
```

---

## Task 7: Summary screen — card thumbnails, ATK/DEF, hover preview

**Files:**
- Modify: `packages/web/src/components/draft/draft-summary-view.tsx`

Current pool row in summary: `[M/S/T badge] [name] [attribute text]`
New pool row: `[36×48px thumbnail] [name, full type, attribute, level] [ATK/DEF badge] [hover preview on lg]`

- [ ] **Step 1: Add imports at the top of `draft-summary-view.tsx`**

After the existing imports, add:
```tsx
import Image from "next/image";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
```

- [ ] **Step 2: Add hover state variables inside the component function**

Add these after the existing `useState` calls (around line 68):
```tsx
const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
const [popupPosition, setPopupPosition] = React.useState<{ left: number; top: number } | null>(null);
const [imageErrors, setImageErrors] = React.useState<Set<number>>(new Set());

const handleCardHover = React.useCallback((card: DraftCardDetail, rect: DOMRect) => {
  const POPUP_WIDTH = 288;
  const POPUP_HEIGHT = 560;
  const MARGIN = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rightLeft = rect.right + MARGIN;
  const leftLeft = rect.left - POPUP_WIDTH - MARGIN;
  const left =
    rightLeft + POPUP_WIDTH + MARGIN <= vw ? rightLeft : Math.max(MARGIN, leftLeft);
  const top = Math.min(
    vh - POPUP_HEIGHT - MARGIN,
    Math.max(MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2),
  );
  setHoveredCard(card);
  setPopupPosition({ left, top });
}, []);

const handleCardLeave = React.useCallback(() => {
  setHoveredCard(null);
  setPopupPosition(null);
}, []);
```

- [ ] **Step 3: Replace the pool section JSX**

Find the block starting at `{isParticipant && myPool && myPool.length > 0 && (` (around line 209) and replace with:

```tsx
{isParticipant && myPool && myPool.length > 0 && (
  <div className="rounded-xl border border-border bg-surface p-6">
    <h2 className="mb-4 font-display text-lg text-text-primary">
      <Package className="mr-2 inline h-5 w-5 text-accent-primary" />
      Your Pool ({myPool.length} cards)
    </h2>
    <ul className="flex flex-col gap-0.5" role="list">
      {myPool.map((card) => {
        const isMonster = card.type.toLowerCase().includes("monster");
        return (
          <li key={card.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors duration-150 hover:border-border hover:bg-bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
              onMouseEnter={(e) =>
                handleCardHover(card, e.currentTarget.getBoundingClientRect())
              }
              onMouseLeave={handleCardLeave}
              onFocus={(e) =>
                handleCardHover(card, e.currentTarget.getBoundingClientRect())
              }
              onBlur={handleCardLeave}
            >
              {/* 36×48 thumbnail */}
              <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded bg-bg-elevated">
                {imageErrors.has(card.id) ? (
                  <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">
                    ?
                  </div>
                ) : (
                  <Image
                    src={card.imageUrlSmall || card.imageUrl}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="36px"
                    onError={() =>
                      setImageErrors((prev) => new Set(prev).add(card.id))
                    }
                  />
                )}
              </div>

              {/* Name + type + attribute + level */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">
                  {card.name}
                </p>
                <p className="truncate text-xs text-text-muted">
                  {card.type}
                  {card.attribute &&
                    card.attribute !== "SPELL" &&
                    card.attribute !== "TRAP" &&
                    ` · ${card.attribute}`}
                  {card.level !== undefined && ` · Lv ${card.level}`}
                </p>
              </div>

              {/* ATK/DEF for monsters */}
              {isMonster && card.atk !== undefined && (
                <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">
                  {card.atk}/{card.def ?? "?"}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>

    {/* Hover preview */}
    {hoveredCard && popupPosition && (
      <CardHoverPopup
        card={hoveredCard}
        position={popupPosition}
        imageError={imageErrors.has(hoveredCard.id)}
        onImageError={() =>
          setImageErrors((prev) => new Set(prev).add(hoveredCard.id))
        }
      />
    )}
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-summary-view.tsx
git commit -m "feat(web): add card thumbnails, ATK/DEF, and hover preview to summary pool list"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Right-side list: type + attribute + small image + hover preview | Task 5 (component), Task 6 (pool panel) |
| Summary screen: images + info | Task 7 |
| Pool panel sort by last pick / filter controls | Task 6 |
| Timer expiry stuck for other players | Task 2 + Task 3 |
| YDK `.crdownload` bug | Task 1 |
| Move timer to top-center | Task 4 |

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency:** `DraftCardDetail` used consistently across all tasks (imported from `@/lib/stores/draft-store`). `CardHoverPopup` interface defined in Task 5 and used identically in Tasks 6 and 7. `PoolSort`/`PoolFilter` types are local to pool-panel.tsx. The `notifyWs` in bot's `notify-ws.ts` is a standalone function matching the web app's pattern.
