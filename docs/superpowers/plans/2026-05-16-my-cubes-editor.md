# My Cubes Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `My Cubes` navigation area where users list saved card pools, open one pool on a dedicated editor page, replace its contents from passcode-only text import, remove cards one copy at a time, and explicitly save changes.

**Architecture:** Reuse the existing `draft_templates` saved-pool API and data model. Add new route-level pages under `/cubes`, new focused cube UI components, and one small extension point in `CardPoolGrid` so the editor can use card clicks for removal without changing existing preview behavior.

**Tech Stack:** Next.js 16 App Router, React client components, TypeScript, Tailwind, Vitest, Testing Library, existing `/api/draft-templates` and `/api/cards/resolve` routes.

---

## File Structure

- Modify `packages/web/src/lib/nav-items.ts`: add `My Cubes` nav item with prefix matching.
- Create `packages/web/tests/nav-items.test.ts`: verify nav entry and prefix route behavior data.
- Create `packages/web/app/(app)/cubes/page.tsx`: server route shell for the list page.
- Create `packages/web/src/components/cubes/my-cubes-list.tsx`: client component that fetches saved pools and renders clickable cards.
- Create `packages/web/tests/components/my-cubes-list.test.tsx`: component coverage for list rendering and links.
- Modify `packages/web/src/components/cards/card-pool-grid.tsx`: add optional edit-click props while preserving default preview click behavior.
- Modify `packages/web/tests/components/card-pool-grid.test.tsx`: regression coverage for custom click action.
- Create `packages/web/app/(app)/cubes/[id]/page.tsx`: server route shell for one pool editor.
- Create `packages/web/src/components/cubes/cube-editor.tsx`: client editor state, import replacement, one-copy removal, and save behavior.
- Create `packages/web/tests/components/cube-editor.test.tsx`: importer, one-copy removal, and save payload coverage.

## Task 1: Add `My Cubes` Navigation

**Files:**
- Modify: `packages/web/src/lib/nav-items.ts`
- Create: `packages/web/tests/nav-items.test.ts`

- [ ] **Step 1: Write the failing nav test**

Create `packages/web/tests/nav-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { navItems } from "../src/lib/nav-items";

describe("navItems", () => {
  it("includes My Cubes with prefix matching", () => {
    expect(navItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/cubes", label: "My Cubes", match: "prefix" }),
      ]),
    );
  });

  it("keeps My Cubes before Settings", () => {
    const labels = navItems.map((item) => item.label);
    expect(labels.indexOf("My Cubes")).toBeGreaterThan(labels.indexOf("Drafts"));
    expect(labels.indexOf("My Cubes")).toBeLessThan(labels.indexOf("Settings"));
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npx vitest run packages/web/tests/nav-items.test.ts -c packages/web/vitest.config.ts
```

Expected: FAIL because `My Cubes` is not present in `navItems`.

- [ ] **Step 3: Add the nav item**

Modify `packages/web/src/lib/nav-items.ts` to import a cube-like icon and add the new entry:

```ts
import { LayoutDashboard, Trophy, Layers, Boxes, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: "exact" | "prefix";
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, match: "exact" },
  { href: "/tournaments", label: "Tournaments", icon: Trophy, match: "prefix" },
  { href: "/drafts", label: "Drafts", icon: Layers, match: "prefix" },
  { href: "/cubes", label: "My Cubes", icon: Boxes, match: "prefix" },
  { href: "/settings", label: "Settings", icon: Settings, match: "exact" },
];
```

- [ ] **Step 4: Verify nav test passes**

Run:

```bash
npx vitest run packages/web/tests/nav-items.test.ts -c packages/web/vitest.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add packages/web/src/lib/nav-items.ts packages/web/tests/nav-items.test.ts
git commit -m "feat: add my cubes navigation"
```

## Task 2: Add `/cubes` Saved Pools List Page

**Files:**
- Create: `packages/web/app/(app)/cubes/page.tsx`
- Create: `packages/web/src/components/cubes/my-cubes-list.tsx`
- Create: `packages/web/tests/components/my-cubes-list.test.tsx`

- [ ] **Step 1: Write the failing list component tests**

Create `packages/web/tests/components/my-cubes-list.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyCubesList } from "../../src/components/cubes/my-cubes-list";

describe("MyCubesList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists saved pools as links to their editor pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          templates: [
            { id: 7, name: "Clara Pool", setNames: [], customCardIds: [1, 2, 3] },
            { id: 8, name: "Goat Cube", setNames: ["Metal Raiders"], customCardIds: [4] },
          ],
        }),
      ),
    );

    render(<MyCubesList />);

    await waitFor(() => expect(screen.getByRole("link", { name: /clara pool/i })).toBeTruthy());
    expect(screen.getByRole("link", { name: /clara pool/i })).toHaveAttribute("href", "/cubes/7");
    expect(screen.getByText(/3 passcodes/i)).toBeTruthy();
    expect(screen.getByText(/1 set/i)).toBeTruthy();
  });

  it("shows an empty state when there are no saved pools", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ templates: [] })));

    render(<MyCubesList />);

    await waitFor(() => expect(screen.getByText(/no saved pools yet/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run packages/web/tests/components/my-cubes-list.test.tsx -c packages/web/vitest.config.ts
```

Expected: FAIL because `MyCubesList` does not exist.

- [ ] **Step 3: Implement `MyCubesList`**

Create `packages/web/src/components/cubes/my-cubes-list.tsx`:

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { Boxes, ChevronRight } from "lucide-react";

interface SavedPool {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function MyCubesList() {
  const [pools, setPools] = React.useState<SavedPool[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { templates?: SavedPool[] }) => {
        if (!cancelled) setPools(data.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load saved pools.");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>;
  }

  if (!loaded) {
    return <p className="text-sm text-text-secondary">Loading saved pools...</p>;
  }

  if (pools.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <Boxes className="mx-auto mb-4 h-12 w-12 text-text-muted" />
        <p className="text-lg font-semibold text-text-primary">No saved pools yet</p>
        <p className="mt-2 text-sm text-text-secondary">Saved card pools created in drafts or settings will appear here.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {pools.map((pool) => (
        <Link
          key={pool.id}
          href={`/cubes/${pool.id}`}
          className="group rounded-xl border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent-primary/70 hover:bg-bg-elevated/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg text-text-primary">{pool.name}</h2>
              <p className="mt-2 text-sm text-text-secondary">
                {plural(pool.customCardIds.length, "passcode")} · {plural(pool.setNames.length, "set")}
              </p>
            </div>
            <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-primary" />
          </div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add the `/cubes` page**

Create `packages/web/app/(app)/cubes/page.tsx`:

```tsx
import { MyCubesList } from "@/components/cubes/my-cubes-list";

export default function CubesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">My Cubes</h1>
        <p className="mt-2 text-sm text-text-secondary">Open a saved card pool to import, review, and edit its cards.</p>
      </div>
      <MyCubesList />
    </div>
  );
}
```

- [ ] **Step 5: Verify list tests pass**

Run:

```bash
npx vitest run packages/web/tests/components/my-cubes-list.test.tsx -c packages/web/vitest.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add 'packages/web/app/(app)/cubes/page.tsx' packages/web/src/components/cubes/my-cubes-list.tsx packages/web/tests/components/my-cubes-list.test.tsx
git commit -m "feat: add my cubes list page"
```

## Task 3: Add Editable Click Support To `CardPoolGrid`

**Files:**
- Modify: `packages/web/src/components/cards/card-pool-grid.tsx`
- Modify: `packages/web/tests/components/card-pool-grid.test.tsx`

- [ ] **Step 1: Write failing editable-click test**

Append to `packages/web/tests/components/card-pool-grid.test.tsx` inside the existing `describe("CardPoolGrid", ...)` block:

```tsx
  it("uses the custom card click action when provided", () => {
    const onCardClick = vi.fn();
    render(<CardPoolGrid cards={cards} onCardClick={onCardClick} cardActionLabel={(card) => `Remove ${card.name} from cube`} />);

    fireEvent.click(screen.getByRole("button", { name: /remove mirror force from cube/i }));

    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick).toHaveBeenCalledWith(cards[1]);
    expect(screen.getAllByText("Mirror Force")).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the grid test and verify it fails**

Run:

```bash
npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts
```

Expected: FAIL because `onCardClick` and `cardActionLabel` props do not exist.

- [ ] **Step 3: Add optional edit-click props**

Modify the props interface in `packages/web/src/components/cards/card-pool-grid.tsx`:

```ts
interface CardPoolGridProps {
  cards: CardSummary[];
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  className?: string;
  heightClassName?: string;
  gridClassName?: string;
  showSummary?: boolean;
  onCardClick?: (card: CardSummary) => void;
  cardActionLabel?: (card: CardSummary) => string;
}
```

Update destructuring defaults:

```ts
export function CardPoolGrid({
  cards,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  className,
  heightClassName = "h-[26rem]",
  gridClassName = "grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3",
  showSummary = true,
  onCardClick,
  cardActionLabel,
}: CardPoolGridProps) {
```

Replace the hardcoded grid class on the card grid container:

```tsx
<div data-testid="card-pool-grid" className={gridClassName}>
```

Change the card button accessible label and click handler:

```tsx
aria-label={onCardClick ? cardActionLabel?.(card) ?? `Select ${card.name}` : `Preview ${card.name}`}
onClick={(e) => {
  if (onCardClick) {
    onCardClick(card);
    return;
  }
  setTapped(card);
  setPopupPosition(getPopupPosition(e.currentTarget.getBoundingClientRect()));
}}
```

- [ ] **Step 4: Verify grid tests pass**

Run:

```bash
npx vitest run packages/web/tests/components/card-pool-grid.test.tsx -c packages/web/vitest.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add packages/web/src/components/cards/card-pool-grid.tsx packages/web/tests/components/card-pool-grid.test.tsx
git commit -m "feat: support editable card grid clicks"
```

## Task 4: Add Cube Editor Page And Behavior

**Files:**
- Create: `packages/web/app/(app)/cubes/[id]/page.tsx`
- Create: `packages/web/src/components/cubes/cube-editor.tsx`
- Create: `packages/web/tests/components/cube-editor.test.tsx`

- [ ] **Step 1: Write failing editor tests**

Create `packages/web/tests/components/cube-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CubeEditor } from "../../src/components/cubes/cube-editor";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const templates = [
  { id: 7, name: "Clara Pool", setNames: ["Legacy Set"], customCardIds: [11111111, 11111111, 22222222] },
];

const resolvedCards = [
  { id: 11111111, name: "Turtle Tiger", type: "Normal Monster", frameType: "normal", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 22222222, name: "Mystic Lamp", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "u2", imageUrlSmall: "s2" },
  { id: 33333333, name: "Imported Spell", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "u3", imageUrlSmall: "s3" },
];

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates });
    if (url === "/api/cards/resolve" && method === "POST") return Response.json({ cards: resolvedCards, unknownIds: [] });
    if (url === "/api/draft-templates/7" && method === "PUT") return Response.json({ template: { id: 7, name: "Clara Pool", setNames: [], customCardIds: [33333333] } });
    return Response.json({}, { status: 404 });
  });
}

describe("CubeEditor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("removes one copy of a duplicate card per click", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByText("Clara Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("×2")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));

    await waitFor(() => expect(screen.queryByText("×2")).toBeNull());
    expect(screen.getByRole("button", { name: /remove turtle tiger from cube/i })).toBeTruthy();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it("replaces passcodes from pasted import text and saves cleared sets", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByText("Clara Pool")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "33333333" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/7" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ name: "Clara Pool", setNames: [], customCardIds: [33333333] });
    });
  });
});
```

- [ ] **Step 2: Run editor tests and verify they fail**

Run:

```bash
npx vitest run packages/web/tests/components/cube-editor.test.tsx -c packages/web/vitest.config.ts
```

Expected: FAIL because `CubeEditor` does not exist.

- [ ] **Step 3: Implement `CubeEditor`**

Create `packages/web/src/components/cubes/cube-editor.tsx`:

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import type { CardSummary } from "@/lib/card-types";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { getCached, putCards } from "@/lib/cards-cache";

interface SavedPool {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

const gridClassName = "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";

function signature(name: string, setNames: string[], ids: number[]): string {
  return JSON.stringify({ name, setNames, ids });
}

function idsToText(ids: number[]): string {
  return ids.join("\n");
}

export function CubeEditor({ poolId }: { poolId: number }) {
  const [loadedPool, setLoadedPool] = React.useState<SavedPool | null>(null);
  const [name, setName] = React.useState("");
  const [setNames, setSetNames] = React.useState<string[]>([]);
  const [customCardText, setCustomCardText] = React.useState("");
  const [importText, setImportText] = React.useState("");
  const [cards, setCards] = React.useState<CardSummary[]>([]);
  const [unknownIds, setUnknownIds] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [resolving, setResolving] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const reqId = React.useRef(0);

  const parsed = React.useMemo(() => parseCustomCardIds(customCardText), [customCardText]);
  const importParsed = React.useMemo(() => parseCustomCardIds(importText), [importText]);
  const baseline = loadedPool ? signature(loadedPool.name, loadedPool.setNames, loadedPool.customCardIds) : "";
  const current = signature(name.trim(), setNames, parsed.cardIds);
  const dirty = loadedPool !== null && baseline !== current;

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { templates?: SavedPool[] }) => {
        const pool = (data.templates ?? []).find((template) => template.id === poolId) ?? null;
        if (cancelled) return;
        if (!pool) {
          setError("Saved pool not found.");
          setLoading(false);
          return;
        }
        setLoadedPool(pool);
        setName(pool.name);
        setSetNames(pool.setNames);
        setCustomCardText(idsToText(pool.customCardIds));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load saved pool.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [poolId]);

  React.useEffect(() => {
    if (loading) return;
    const myReq = ++reqId.current;
    const ids = parsed.cardIds;
    if (setNames.length === 0 && ids.length === 0) {
      setCards([]);
      setUnknownIds([]);
      setResolving(false);
      return;
    }
    setResolving(true);
    const { hits, missing } = getCached(ids);
    fetch("/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setNames, cardIds: missing }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("resolve failed"))))
      .then((data: { cards: CardSummary[]; unknownIds: number[] }) => {
        if (myReq !== reqId.current) return;
        putCards(data.cards);
        const byId = new Map<number, CardSummary>();
        for (const card of [...hits, ...data.cards]) byId.set(card.id, card);
        const qty = new Map<number, number>();
        for (const id of ids) qty.set(id, (qty.get(id) ?? 0) + 1);
        setCards([...byId.values()].map((card) => ({ ...card, qty: qty.get(card.id) ?? 1 })));
        setUnknownIds(data.unknownIds);
      })
      .catch(() => {
        if (myReq === reqId.current) setError("Failed to resolve cards.");
      })
      .finally(() => {
        if (myReq === reqId.current) setResolving(false);
      });
  }, [customCardText, setNames, loading, parsed.cardIds]);

  const replaceFromImport = () => {
    setStatus(null);
    setError(null);
    if (importParsed.errors.length > 0) {
      setError(`Remove invalid passcodes: ${importParsed.errors.slice(0, 3).join(", ")}`);
      return;
    }
    if (importParsed.cardIds.length === 0) {
      setError("Paste at least one passcode to import.");
      return;
    }
    setSetNames([]);
    setCustomCardText(idsToText(importParsed.cardIds));
    setStatus(`Imported ${importParsed.cardIds.length} passcode${importParsed.cardIds.length === 1 ? "" : "s"}. Save changes to persist.`);
  };

  const readImportFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const removeOneCopy = (card: CardSummary) => {
    const ids = [...parsed.cardIds];
    const index = ids.indexOf(card.id);
    if (index === -1) return;
    ids.splice(index, 1);
    setCustomCardText(idsToText(ids));
    setStatus(`Removed one copy of ${card.name}. Save changes to persist.`);
  };

  const save = async () => {
    setError(null);
    setStatus(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Pool name is required.");
      return;
    }
    if (parsed.errors.length > 0) {
      setError(`Remove invalid passcodes: ${parsed.errors.slice(0, 3).join(", ")}`);
      return;
    }
    if (setNames.length === 0 && parsed.cardIds.length === 0) {
      setError("Add at least one set or one passcode.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/draft-templates/${poolId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, setNames, customCardIds: parsed.cardIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { template?: SavedPool };
      const saved = data.template ?? { id: poolId, name: trimmedName, setNames, customCardIds: parsed.cardIds };
      setLoadedPool(saved);
      setName(saved.name);
      setSetNames(saved.setNames);
      setCustomCardText(idsToText(saved.customCardIds));
      setStatus("Saved changes.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-text-secondary">Loading saved pool...</p>;

  if (!loadedPool) {
    return (
      <div className="space-y-4">
        <Link href="/cubes" className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to My Cubes
        </Link>
        <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error ?? "Saved pool not found."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/cubes" className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft className="h-4 w-4" /> Back to My Cubes
      </Link>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <input
            aria-label="Pool name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-display text-2xl text-text-primary focus:border-accent-primary focus:outline-none sm:text-3xl"
          />
          <p className="mt-2 text-sm text-text-secondary">
            {parsed.cardIds.length} passcodes · {setNames.length} sets {dirty ? "· Unsaved changes" : ""}
          </p>
        </div>
        <Button type="button" variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}
      {status && <p className="rounded-lg border border-accent-primary/40 bg-accent-primary/10 px-4 py-3 text-sm text-accent-primary">{status}</p>}

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Upload className="h-4 w-4 text-accent-primary" />
          <h2 className="font-display text-lg text-text-primary">Import passcodes</h2>
        </div>
        <label htmlFor="cube-import-file" className="mb-1 block text-sm font-medium text-text-primary">Upload text file</label>
        <input
          id="cube-import-file"
          type="file"
          accept=".txt,text/plain"
          onChange={(event) => readImportFile(event.target.files?.[0] ?? null)}
          className="mb-3 block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-accent-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
        />
        <label htmlFor="cube-import-text" className="mb-1 block text-sm font-medium text-text-primary">Paste passcodes</label>
        <textarea
          id="cube-import-text"
          aria-label="Paste passcodes"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          rows={5}
          placeholder={"46986414\n83764718, 12345678"}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-secondary">Import replaces the current cube contents in this editor. Click Save Changes to persist.</p>
          <Button type="button" variant="secondary" size="sm" onClick={replaceFromImport}>Replace cube with import</Button>
        </div>
      </section>

      <CardPoolGrid
        cards={cards}
        unknownIds={unknownIds}
        loading={resolving}
        emptyMessage="Import passcodes to preview this cube."
        heightClassName="h-[42rem]"
        gridClassName={gridClassName}
        onCardClick={removeOneCopy}
        cardActionLabel={(card) => `Remove ${card.name} from cube`}
      />
    </div>
  );
}
```

- [ ] **Step 4: Add the dynamic editor page**

Create `packages/web/app/(app)/cubes/[id]/page.tsx`:

```tsx
import { CubeEditor } from "@/components/cubes/cube-editor";

export default async function CubeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const poolId = Number.parseInt(id, 10);

  return (
    <div className="mx-auto max-w-7xl">
      <CubeEditor poolId={poolId} />
    </div>
  );
}
```

- [ ] **Step 5: Verify editor tests pass**

Run:

```bash
npx vitest run packages/web/tests/components/cube-editor.test.tsx -c packages/web/vitest.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add 'packages/web/app/(app)/cubes/[id]/page.tsx' packages/web/src/components/cubes/cube-editor.tsx packages/web/tests/components/cube-editor.test.tsx
git commit -m "feat: add cube editor page"
```

## Task 5: Run Focused And Full Verification

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Run focused web component tests**

Run:

```bash
npx vitest run packages/web/tests/nav-items.test.ts packages/web/tests/components/my-cubes-list.test.tsx packages/web/tests/components/card-pool-grid.test.tsx packages/web/tests/components/cube-editor.test.tsx -c packages/web/vitest.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run web test suite**

Run:

```bash
npm test --workspace=@yugioh-discord-bot/web
```

Expected: PASS.

- [ ] **Step 3: Run web typecheck**

Run:

```bash
npm run typecheck --workspace=@yugioh-discord-bot/web
```

Expected: PASS.

- [ ] **Step 4: Build shared outputs for local Docker dev**

Run:

```bash
npm run build --workspace=@yugidraft/shared
```

Expected: PASS and `packages/shared/dist/db/index.js` exists.

- [ ] **Step 5: Restart local web service**

Run:

```bash
env UID="$(id -u)" GID="$(id -g)" docker compose up -d --force-recreate web
```

Expected: `web` service starts.

- [ ] **Step 6: Verify routes respond locally**

Run:

```bash
curl -I http://127.0.0.1:3000/cubes
curl -I http://127.0.0.1:3000/login
```

Expected: `/cubes` redirects unauthenticated users to `/login` or renders authenticated content depending on session; `/login` returns `200`.

- [ ] **Step 7: Commit verification notes only if files changed during verification**

Run:

```bash
git status --short
```

Expected: no new unexpected files except planned source/test changes. Do not commit generated `packages/shared/dist` output if it is ignored or not meant to be tracked.

## Self-Review

- Spec coverage: navigation, `/cubes` list, `/cubes/[id]` editor, passcode-only import, replace semantics, one-copy removal, explicit save, and tests are all covered by tasks.
- Placeholder scan: no placeholder implementation steps remain.
- Type consistency: `SavedPool`, `customCardIds`, `setNames`, `CardSummary`, and API routes match existing code shapes.
