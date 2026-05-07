# Add Bot Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Add Bot" button to the pending draft creator UI that calls the dev-only `/api/drafts/[slug]/join-bot` endpoint, so local E2E testing doesn't require manual API calls.

**Architecture:** Prop-driven — `page.tsx` owns the API call and passes `onAddBot` + `isDev` down to `DraftManageView`, consistent with how `onStart`/`onJoin` are already handled. `isDev` is derived from `process.env.NODE_ENV !== "production"`, which Next.js bakes in at build time so the button tree-shakes out of production bundles entirely.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest + Testing Library (jsdom)

---

### Task 1: Extend `DraftManageView` with the Add Bot button

**Files:**
- Modify: `packages/web/src/components/draft/draft-manage-view.tsx`
- Create: `packages/web/tests/components/draft-manage-view.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/tests/components/draft-manage-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftManageView } from "../../src/components/draft/draft-manage-view";

const baseDraft = {
  id: 1,
  name: "Legendary Draft",
  status: "pending",
  createdByUserId: "creator-1",
  createdAt: "2026-05-06T12:00:00.000Z",
  config: {
    packSize: 5,
    packsPerPlayer: 3,
    pickSeconds: 60,
    setNames: ["Legend of Blue Eyes White Dragon"],
  },
  players: [],
  playerCount: 0,
};

const baseProps = {
  draft: baseDraft,
  isCreator: true,
  isParticipant: true,
  onStart: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn().mockResolvedValue(undefined),
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onJoin: vi.fn().mockResolvedValue(undefined),
};

describe("DraftManageView — Add Bot button", () => {
  it("shows Add Bot button when isDev=true and isCreator=true", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={true} onAddBot={onAddBot} />);
    expect(screen.getByRole("button", { name: /add bot/i })).toBeInTheDocument();
  });

  it("hides Add Bot button when isDev=false", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={false} onAddBot={onAddBot} />);
    expect(screen.queryByRole("button", { name: /add bot/i })).not.toBeInTheDocument();
  });

  it("hides Add Bot button when isDev=true but isCreator=false", () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(
      <DraftManageView
        {...baseProps}
        isCreator={false}
        isDev={true}
        onAddBot={onAddBot}
      />
    );
    expect(screen.queryByRole("button", { name: /add bot/i })).not.toBeInTheDocument();
  });

  it("calls onAddBot when the button is clicked", async () => {
    const onAddBot = vi.fn().mockResolvedValue(undefined);
    render(<DraftManageView {...baseProps} isDev={true} onAddBot={onAddBot} />);
    await userEvent.click(screen.getByRole("button", { name: /add bot/i }));
    expect(onAddBot).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /home/imran/yugioh-discord-bot/packages/web
npm run test -- draft-manage-view.test.tsx
```

Expected: FAIL — `isDev` and `onAddBot` props don't exist yet.

- [ ] **Step 3: Add props, state, and button to `DraftManageView`**

In `packages/web/src/components/draft/draft-manage-view.tsx`, make these changes:

**3a. Extend the props interface** (after the existing `onJoin` line):

```ts
interface DraftManageViewProps {
  // ... existing props unchanged ...
  onAddBot?: () => Promise<void>;
  isDev?: boolean;
}
```

**3b. Destructure the new props** in the function signature:

```ts
export function DraftManageView({
  draft,
  isCreator,
  isParticipant,
  onStart,
  onCancel,
  onUpdate,
  onJoin,
  onAddBot,
  isDev,
}: DraftManageViewProps) {
```

**3c. Add `addingBot` state** alongside the existing loading states (after `const [joining, setJoining] = React.useState(false);`):

```ts
const [addingBot, setAddingBot] = React.useState(false);
```

**3d. Add `handleAddBot` handler** after `handleJoin`:

```ts
const handleAddBot = async () => {
  if (!onAddBot) return;
  setAddingBot(true);
  setError(null);
  try {
    await onAddBot();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to add bot");
  } finally {
    setAddingBot(false);
  }
};
```

**3e. Add the button inside `getActionSection()`**, in the creator branch, next to the existing Start/Cancel buttons. Replace the creator button group:

```tsx
{showCancelConfirm ? (
  <>
    <span className="flex items-center text-sm text-text-secondary">
      Are you sure?
    </span>
    <Button
      variant="danger"
      size="sm"
      loading={cancelling}
      onClick={handleCancel}
    >
      Yes, Cancel
    </Button>
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setShowCancelConfirm(false)}
    >
      No, Go Back
    </Button>
  </>
) : (
  <>
    <Button
      variant="primary"
      loading={starting}
      onClick={handleStart}
    >
      Start Draft
    </Button>
    {isDev && onAddBot && (
      <Button
        variant="secondary"
        size="sm"
        loading={addingBot}
        onClick={handleAddBot}
      >
        Add Bot
      </Button>
    )}
    <Button
      variant="secondary"
      onClick={() => setShowCancelConfirm(true)}
    >
      Cancel Draft
    </Button>
  </>
)}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd /home/imran/yugioh-discord-bot/packages/web
npm run test -- draft-manage-view.test.tsx
```

Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
cd /home/imran/yugioh-discord-bot
git add packages/web/src/components/draft/draft-manage-view.tsx \
        packages/web/tests/components/draft-manage-view.test.tsx
git commit -m "feat(draft): add dev-only Add Bot button to DraftManageView"
```

---

### Task 2: Wire `handleAddBot` into the draft page

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx`

- [ ] **Step 1: Add `handleAddBot` to `DraftDetailPage`**

In `packages/web/app/(app)/draft/[slug]/page.tsx`, add this function after `handleJoin`:

```ts
const handleAddBot = async () => {
  const res = await fetch(`/api/drafts/${slug}/join-bot`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? "Failed to add bot");
  }
  await fetchDraft();
};
```

- [ ] **Step 2: Pass the new props to `DraftManageView`**

Replace the existing `<DraftManageView ... />` call in the `draft.status === "pending"` branch:

```tsx
if (draft.status === "pending") {
  return (
    <div>
      <DraftManageView
        draft={draft}
        isCreator={isCreator}
        isParticipant={isParticipant}
        onStart={handleStart}
        onCancel={handleCancel}
        onUpdate={handleUpdate}
        onJoin={handleJoin}
        onAddBot={handleAddBot}
        isDev={process.env.NODE_ENV !== "production"}
      />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/imran/yugioh-discord-bot
npm run typecheck
```

Expected: All 4 workspaces pass with no errors.

- [ ] **Step 4: Run the full web test suite**

```bash
cd /home/imran/yugioh-discord-bot/packages/web
npm run test
```

Expected: All tests pass (existing 83 + 4 new = 87).

- [ ] **Step 5: Commit**

```bash
cd /home/imran/yugioh-discord-bot
git add packages/web/app/\(app\)/draft/\[slug\]/page.tsx
git commit -m "feat(draft): wire Add Bot button into draft page (dev only)"
```

---

### Verification Snapshot

After both tasks:

- `npm run typecheck` — PASS
- `cd packages/web && npm run test` — 87/87 green
- Dev server: open a pending draft as creator, confirm "Add Bot" appears between Start and Cancel
- Clicking it adds "Bot (Dev)" to the players list without page reload
