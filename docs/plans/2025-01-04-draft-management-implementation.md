# Draft Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a draft detail page at `/draft/[slug]` that shows management controls for pending drafts, the draft room for active drafts, and a summary view for completed/cancelled drafts.

**Architecture:** Single page router that fetches draft data and conditionally renders one of three views based on status. API routes already exist for CRUD operations.

**Tech Stack:** Next.js 16 App Router, React, SWR, TailwindCSS v4, lucide-react, better-sqlite3

---

### Task 1: Create DraftManageView Component

**Files:**
- Create: `packages/web/src/components/draft/draft-manage-view.tsx`

**Code:**

```tsx
"use client";

import { useState } from "react";
import { Users, Settings, Play, Pencil, X, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DraftManageViewProps {
  draft: {
    id: number;
    name: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
    };
    players: Array<{
      playerId: number;
      displayName: string;
      seatIndex?: number;
      pickCount: number;
      finishedAt?: string;
      joinedAt: string;
    }>;
    playerCount: number;
  };
  isCreator: boolean;
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
  onUpdate: (data: { name?: string; config?: unknown }) => Promise<void>;
}

export function DraftManageView({
  draft,
  isCreator,
  onStart,
  onCancel,
  onUpdate,
}: DraftManageViewProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(draft.name);
  const [loading, setLoading] = useState<string | null>(null);

  const handleStart = async () => {
    setLoading("start");
    try {
      await onStart();
    } finally {
      setLoading(null);
    }
  };

  const handleCancel = async () => {
    if (!confirm("Are you sure you want to cancel this draft?")) return;
    setLoading("cancel");
    try {
      await onCancel();
    } finally {
      setLoading(null);
    }
  };

  const handleSave = async () => {
    if (!editName.trim()) return;
    setLoading("update");
    try {
      await onUpdate({ name: editName });
      setEditing(false);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="flex items-start justify-between">
          <div>
            {editing ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="rounded-lg border border-border bg-bg-deep px-3 py-1.5 text-lg font-semibold text-text-primary"
                  autoFocus
                />
                <button
                  onClick={handleSave}
                  disabled={loading === "update"}
                  className="rounded-lg bg-accent-success p-1.5 text-white hover:bg-accent-success/80"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  onClick={() => { setEditing(false); setEditName(draft.name); }}
                  className="rounded-lg bg-surface p-1.5 text-text-muted hover:text-text-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <h1 className="font-display text-2xl text-text-primary">
                  {draft.name}
                </h1>
                {isCreator && (
                  <button
                    onClick={() => setEditing(true)}
                    className="rounded-lg p-1.5 text-text-muted hover:text-text-secondary"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            <div className="mt-2 flex items-center gap-3">
              <Badge variant="warning">Pending</Badge>
              <span className="text-sm text-text-muted">
                Created {new Date(draft.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        {isCreator && (
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={handleStart}
              disabled={loading === "start" || draft.playerCount < 2}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-success px-4 py-2 text-sm font-semibold text-white hover:bg-accent-success/80 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {loading === "start" ? "Starting..." : "Start Draft"}
            </button>
            <button
              onClick={handleCancel}
              disabled={loading === "cancel"}
              className="inline-flex items-center gap-2 rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-4 py-2 text-sm font-semibold text-accent-danger hover:bg-accent-danger/20 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              {loading === "cancel" ? "Cancelling..." : "Cancel Draft"}
            </button>
            {draft.playerCount < 2 && (
              <span className="text-xs text-text-muted">
                Need at least 2 players to start
              </span>
            )}
          </div>
        )}

        {!isCreator && (
          <div className="mt-6 rounded-lg border border-border bg-bg-deep p-4">
            <p className="text-sm text-text-secondary">
              Waiting for the creator to start this draft.
            </p>
          </div>
        )}
      </div>

      {/* Players */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-5 w-5 text-text-secondary" />
          <h2 className="font-body text-lg font-semibold text-text-primary">
            Players ({draft.playerCount})
          </h2>
        </div>
        <div className="space-y-2">
          {draft.players.map((player) => (
            <div
              key={player.playerId}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-deep px-4 py-3"
            >
              <span className="font-body text-sm text-text-primary">
                {player.displayName}
              </span>
              <span className="text-xs text-text-muted">
                Joined {new Date(player.joinedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Config */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-2">
          <Settings className="h-5 w-5 text-text-secondary" />
          <h2 className="font-body text-lg font-semibold text-text-primary">
            Draft Config
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Pack Size</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.packSize ?? 8} cards
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Packs Per Player</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.packsPerPlayer ?? 5}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Pick Time</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.pickSeconds ?? 45}s
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Sets</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.setNames?.join(", ") ?? "All"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-manage-view.tsx
git commit -m "feat: add DraftManageView component for pending draft management"
```

---

### Task 2: Create DraftSummaryView Component

**Files:**
- Create: `packages/web/src/components/draft/draft-summary-view.tsx`

**Code:**

```tsx
"use client";

import { Users, Settings, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DraftSummaryViewProps {
  draft: {
    id: number;
    name: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
    };
    players: Array<{
      playerId: number;
      displayName: string;
      seatIndex?: number;
      pickCount: number;
      finishedAt?: string;
      joinedAt: string;
    }>;
    playerCount: number;
  };
  isParticipant: boolean;
  onExportYdk: () => Promise<string>;
}

export function DraftSummaryView({
  draft,
  isParticipant,
  onExportYdk,
}: DraftSummaryViewProps) {
  const statusVariant =
    draft.status === "completed" ? "default" : "danger";

  const handleExport = async () => {
    try {
      const ydk = await onExportYdk();
      const blob = new Blob([ydk], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.name.replace(/\s+/g, "-").toLowerCase()}.ydk`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Failed to export deck");
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-display text-2xl text-text-primary">
              {draft.name}
            </h1>
            <div className="mt-2 flex items-center gap-3">
              <Badge variant={statusVariant}>
                {draft.status.charAt(0).toUpperCase() + draft.status.slice(1)}
              </Badge>
              <span className="text-sm text-text-muted">
                {draft.endedAt
                  ? `Ended ${new Date(draft.endedAt).toLocaleDateString()}`
                  : `Created ${new Date(draft.createdAt).toLocaleDateString()}`}
              </span>
            </div>
          </div>
        </div>

        {isParticipant && draft.status === "completed" && (
          <div className="mt-6">
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary"
            >
              <Download className="h-4 w-4" />
              Export Deck (.ydk)
            </button>
          </div>
        )}
      </div>

      {/* Players */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-5 w-5 text-text-secondary" />
          <h2 className="font-body text-lg font-semibold text-text-primary">
            Players ({draft.playerCount})
          </h2>
        </div>
        <div className="space-y-2">
          {draft.players.map((player) => (
            <div
              key={player.playerId}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-deep px-4 py-3"
            >
              <span className="font-body text-sm text-text-primary">
                {player.displayName}
              </span>
              <span className="text-xs text-text-muted">
                {player.pickCount} picks
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Config */}
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-2">
          <Settings className="h-5 w-5 text-text-secondary" />
          <h2 className="font-body text-lg font-semibold text-text-primary">
            Draft Config
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Pack Size</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.packSize ?? 8} cards
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Packs Per Player</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.packsPerPlayer ?? 5}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Pick Time</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.pickSeconds ?? 45}s
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg-deep px-4 py-3">
            <span className="text-xs text-text-muted">Sets</span>
            <p className="font-body text-sm text-text-primary">
              {draft.config.setNames?.join(", ") ?? "All"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add packages/web/src/components/draft/draft-summary-view.tsx
git commit -m "feat: add DraftSummaryView component for completed/cancelled drafts"
```

---

### Task 3: Update Draft Detail Page

**Files:**
- Modify: `packages/web/app/draft/[slug]/page.tsx`

**Replace entire file with:**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { DraftManageView } from "@/components/draft/draft-manage-view";
import { DraftSummaryView } from "@/components/draft/draft-summary-view";
import { CardGrid } from "@/components/draft/card-grid";
import { TimerBar } from "@/components/draft/timer-bar";
import { SeatList } from "@/components/draft/seat-list";
import { PoolPanel } from "@/components/draft/pool-panel";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useDraftWebsocket } from "@/lib/hooks/use-draft-websocket";

interface DraftData {
  id: number;
  name: string;
  status: string;
  createdByUserId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  config: {
    packSize?: number;
    packsPerPlayer?: number;
    pickSeconds?: number;
    setNames?: string[];
  };
  players: Array<{
    playerId: number;
    displayName: string;
    seatIndex?: number;
    pickCount: number;
    finishedAt?: string;
    joinedAt: string;
  }>;
  playerCount: number;
}

export default function DraftDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const { data: session } = useSession();

  const [draft, setDraft] = useState<DraftData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setFromServer = useDraftStore((s) => s.setFromServer);
  useDraftWebsocket(slug);

  const fetchDraft = useCallback(async () => {
    try {
      const res = await fetch(`/api/drafts/${slug}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error("Draft not found");
        if (res.status === 401) {
          router.push("/api/auth/signin");
          return;
        }
        throw new Error("Failed to load draft");
      }
      const data = await res.json();
      setDraft(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }, [slug, router]);

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft]);

  const handleStart = async () => {
    const res = await fetch(`/api/drafts/${slug}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to start draft");
    }
    await fetchDraft();
    // Refresh to show draft room
    router.refresh();
  };

  const handleCancel = async () => {
    const res = await fetch(`/api/drafts/${slug}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to cancel draft");
    }
    await fetchDraft();
  };

  const handleUpdate = async (data: { name?: string; config?: unknown }) => {
    const res = await fetch(`/api/drafts/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to update draft");
    }
    await fetchDraft();
  };

  const handleExportYdk = async () => {
    if (!session?.user?.id || !draft) throw new Error("Not authenticated");
    const res = await fetch(`/api/drafts/${slug}/export`);
    if (!res.ok) throw new Error("Failed to export deck");
    return res.text();
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </main>
    );
  }

  if (error || !draft) {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error ?? "Draft not found"}
          </div>
        </div>
      </main>
    );
  }

  const isCreator = session?.user?.id === draft.createdByUserId;
  const isParticipant = draft.players.some(
    (p) => String(p.playerId) === session?.user?.id
  );

  // Active draft → show draft room
  if (draft.status === "active") {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="sticky top-0 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3 sm:hidden">
          <TimerBar />
        </div>
        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <div className="mb-6 sm:hidden">
            <SeatList />
          </div>
          <div className="flex flex-col gap-6 sm:flex-row sm:gap-8 lg:gap-8">
            <aside className="hidden w-64 shrink-0 flex-col gap-4 lg:flex">
              <TimerBar />
              <SeatList />
            </aside>
            <section className="min-w-0 flex-1">
              <div className="mb-4 flex items-center justify-between">
                <h1 className="font-display text-xl text-text-primary sm:text-2xl">
                  {draft.name}
                </h1>
                <span className="text-sm text-text-secondary">
                  Pack {draft.config.packsPerPlayer ?? 5}
                </span>
              </div>
              <CardGrid />
            </section>
            <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex sm:w-64 lg:hidden">
              <TimerBar />
              <SeatList />
              <PoolPanel />
            </aside>
            <aside className="hidden w-64 shrink-0 lg:block">
              <PoolPanel />
            </aside>
          </div>
          <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-deep/95 backdrop-blur-sm p-4 sm:hidden">
            <PoolPanel />
          </div>
          <div className="h-20 sm:hidden" />
        </div>
      </main>
    );
  }

  // Pending draft → show management view
  if (draft.status === "pending") {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-3xl p-4 sm:p-6 lg:p-8">
          <DraftManageView
            draft={draft}
            isCreator={isCreator}
            onStart={handleStart}
            onCancel={handleCancel}
            onUpdate={handleUpdate}
          />
        </div>
      </main>
    );
  }

  // Completed/Cancelled → show summary view
  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <div className="mx-auto max-w-3xl p-4 sm:p-6 lg:p-8">
        <DraftSummaryView
          draft={draft}
          isParticipant={isParticipant}
          onExportYdk={handleExportYdk}
        />
      </div>
    </main>
  );
}
```

**Step 4: Verify page compiles**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: No errors related to draft/[slug]/page.tsx

**Step 5: Commit**

```bash
git add packages/web/app/draft/\[slug\]/page.tsx
git commit -m "feat: implement draft detail page with status-based routing"
```

---

### Task 4: Add Export YDK API Route

**Files:**
- Create: `packages/web/app/api/drafts/[slug]/export/route.ts`

**Code:**

```tsx
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createDraftService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const draft = db
      .prepare("select id from drafts where web_slug = ?")
      .get(slug) as { id: number } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const player = db
      .prepare(
        "select player_id from draft_players where draft_id = ? and player_id = (select id from players where discord_user_id = ?)"
      )
      .get(draft.id, session.user.id) as { player_id: number } | undefined;

    if (!player) {
      return NextResponse.json({ error: "Not a participant" }, { status: 403 });
    }

    const drafts = createDraftService(db);
    const ydk = drafts.exportYdk(draft.id, player.player_id);

    return new NextResponse(ydk, {
      headers: { "Content-Type": "text/plain" },
    });
  } catch (error) {
    console.error("[api/drafts/[slug]/export] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to export" },
      { status: 400 }
    );
  }
}
```

**Step 4: Verify route compiles**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/web/app/api/drafts/\[slug\]/export/route.ts
git commit -m "feat: add YDK export API route for completed drafts"
```

---

### Task 5: Run Full Typecheck and Tests

**Step 1: Run typecheck**

```bash
npx tsc --noEmit -p packages/web/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: All packages typecheck clean

**Step 2: Run tests**

```bash
npm test
```

Expected: All existing tests pass (37/37)

**Step 3: Commit**

```bash
git add .
git commit -m "chore: verify typecheck and tests pass after draft management changes"
```

---

### Task 6: Verify End-to-End Flow

**Manual testing checklist:**

1. Create a draft via Discord or web
2. Navigate to `/drafts` → verify pending draft card is clickable
3. Click pending draft → verify management view loads
4. As creator: verify Start, Edit, Cancel buttons work
5. As non-creator: verify read-only view with "Waiting for creator" message
6. Start draft → verify redirects to draft room view
7. Complete draft → verify summary view with export button
8. Cancel draft → verify status changes to cancelled

**Step 1: Commit final**

```bash
git commit --allow-empty -m "feat: complete draft management implementation"
```
