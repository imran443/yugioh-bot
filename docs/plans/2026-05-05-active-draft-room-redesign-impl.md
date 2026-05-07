# Active Draft Room Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the active draft room into an arena table layout with a wide center stage, compact fixed rails, and no nested card containers.

**Architecture:** Replace the current multi-card container layout with a flat three-column CSS Grid on desktop. Remove rounded containers from the center stage, tighten side rails, and prevent the fallback state from collapsing the layout.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS, Zustand, Vitest.

---

### Task 1: Restructure Active Draft Page Layout

**Files:**
- Modify: `packages/web/app/(app)/draft/[slug]/page.tsx:233-309`
- Test: `packages/web/tests/drafts-route.test.ts` (existing)

**Step 1: Update the desktop grid columns**

In `page.tsx`, change the active draft layout grid from:

```tsx
<div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_19rem]">
```

To:

```tsx
<div className="grid gap-6 xl:grid-cols-[15rem_minmax(0,1fr)_17.5rem]">
```

**Step 2: Remove the rounded container around the title header**

Replace the title header block (lines ~252-287) from:

```tsx
<div className="mb-5 rounded-2xl border border-border bg-surface p-4 sm:p-5">
  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
        Live Draft Room
      </p>
      <h1 className="font-display text-2xl leading-tight text-text-primary sm:text-3xl">
        {draft.name}
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        Pack {draft.packRound ?? draft.currentPackRound ?? 1}, Pick {draft.pickStep ?? draft.currentPickStep ?? 1}
      </p>
    </div>

    {draft.config.setNames && draft.config.setNames.length > 0 && (
      <div className="flex flex-wrap gap-2 lg:max-w-[28rem] lg:justify-end">
        {draft.config.setNames.map((setName) => (
          <span
            key={setName}
            className="rounded-full border border-accent-primary/25 bg-accent-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent-primary"
          >
            {setName}
          </span>
        ))}
      </div>
    )}
  </div>

  <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm text-text-secondary">
    <span className="rounded-full bg-bg-elevated px-3 py-1 font-medium text-text-primary">
      {draft.currentPack?.length ?? 0} cards in pack
    </span>
    <span>{draft.playerCount} players in table</span>
    <span>{draft.pickSeconds ?? draft.config.pickSeconds ?? 60}s pick timer</span>
  </div>
</div>
```

With a flat header block:

```tsx
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
      Pack {draft.packRound ?? draft.currentPackRound ?? 1} · Pick {draft.pickStep ?? draft.currentPickStep ?? 1}
    </span>
    <span>{draft.currentPack?.length ?? 0} cards in pack</span>
    <span>{draft.playerCount} players</span>
    <span>{draft.pickSeconds ?? draft.config.pickSeconds ?? 60}s timer</span>
  </div>
</div>
```

**Step 3: Ensure CardGrid has no outer wrapper**

Keep `<CardGrid />` directly inside the `<section className="min-w-0">` with no additional container around it.

**Step 4: Run draft route tests**

Run:
```bash
cd packages/web && npx vitest run tests/drafts-route.test.ts
```

Expected: PASS (layout changes should not break API behavior).

**Step 5: Commit**

```bash
git add packages/web/app/(app)/draft/[slug]/page.tsx
git commit -m "refactor(draft): flatten center stage header and tighten grid columns"
```

---

### Task 2: Fix Card Grid Container and Fallback State

**Files:**
- Modify: `packages/web/src/components/draft/card-grid.tsx:98-121` and `123-132`
- Test: `packages/web/tests/components/card-grid.test.tsx` (existing)

**Step 1: Remove outer rounded container from fallback state**

Replace the empty-pack fallback (lines ~98-121) from:

```tsx
if (currentPack.length === 0) {
  return (
    <div className={cn("relative", className)}>
      <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-10 sm:px-8 sm:py-12">
        <div className="mx-auto max-w-2xl text-left">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-primary">
            Draft feed syncing
          </p>
          <h2 className="mt-3 font-display text-2xl text-text-primary sm:text-3xl">
            Waiting for the current pack to arrive.
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-text-secondary sm:text-base">
            The draft room is connected, but your live pack has not populated yet. As soon as the current state arrives, your card stage will render here.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 text-sm text-text-secondary">
            <span className="rounded-full bg-bg-elevated px-3 py-1">Live websocket state</span>
            <span className="rounded-full bg-bg-elevated px-3 py-1">Keyboard picks enabled</span>
            <span className="rounded-full bg-bg-elevated px-3 py-1">Pack preview ready</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

With:

```tsx
if (currentPack.length === 0) {
  return (
    <div className={cn("relative flex min-h-[24rem] flex-col items-center justify-center", className)}>
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-primary">
          Draft feed syncing
        </p>
        <h2 className="mt-2 font-display text-xl text-text-primary sm:text-2xl">
          Waiting for pack...
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          The current pack will appear here once the draft state arrives.
        </p>
      </div>
    </div>
  );
}
```

**Step 2: Remove outer rounded container from card grid**

Replace the grid container (lines ~124-132) from:

```tsx
<div className={cn("relative", className)}>
  <div
    className={cn(
      "grid gap-4",
      "grid-cols-2",
      "sm:grid-cols-3",
      "xl:grid-cols-4"
    )}
    ...
  >
```

With:

```tsx
<div className={cn("relative", className)}>
  <div
    className={cn(
      "grid gap-4",
      "grid-cols-2",
      "sm:grid-cols-3",
      "xl:grid-cols-4"
    )}
    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
    ...
  >
```

**Step 3: Run card grid tests**

Run:
```bash
cd packages/web && npx vitest run tests/components/card-grid.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/web/src/components/draft/card-grid.tsx
git commit -m "refactor(draft): remove card containers from grid and center fallback state"
```

---

### Task 3: Compact TimerBar

**Files:**
- Modify: `packages/web/src/components/draft/timer-bar.tsx:28-40`

**Step 1: Reduce padding and remove label**

Change the outer container from:

```tsx
<div
  className={cn(
    "flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card",
    className
  )}
>
```

To:

```tsx
<div
  className={cn(
    "flex flex-col gap-2 rounded-xl border border-border bg-surface p-3",
    className
  )}
>
```

Change the label row (lines ~34-41) from:

```tsx
<div className="flex items-center justify-between text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-text-muted">
  <span>Draft Clock</span>
  ...
</div>
```

To:

```tsx
<div className="flex items-center justify-end text-[0.7rem] font-semibold uppercase tracking-[0.22em]">
  {!completed && (
    <span className={cn(isUrgent ? "text-accent-cta" : "text-accent-primary")}>
      {isUrgent ? "Urgent" : "Live"}
    </span>
  )}
</div>
```

**Step 2: Commit**

```bash
git add packages/web/src/components/draft/timer-bar.tsx
git commit -m "refactor(draft): compact timer bar styling"
```

---

### Task 4: Compact SeatList

**Files:**
- Modify: `packages/web/src/components/draft/seat-list.tsx:16-20` and `36-45`

**Step 1: Lighten outer container**

Change from:

```tsx
<div
  className={cn(
    "flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card",
    className
  )}
>
```

To:

```tsx
<div
  className={cn(
    "flex flex-col gap-3 rounded-xl border border-border bg-surface p-3",
    className
  )}
>
```

**Step 2: Reduce row padding**

Change player row class from:

```tsx
className={cn(
  "flex items-center gap-3 rounded-lg border p-2.5 motion-safe:transition-colors",
  ...
)}
```

To:

```tsx
className={cn(
  "flex items-center gap-3 rounded-lg border p-2 motion-safe:transition-colors",
  ...
)}
```

**Step 3: Commit**

```bash
git add packages/web/src/components/draft/seat-list.tsx
git commit -m "refactor(draft): compact seat list styling"
```

---

### Task 5: Tighten PoolPanel and Remove Redundancy

**Files:**
- Modify: `packages/web/src/components/draft/pool-panel.tsx:42-80` and `111-119`

**Step 1: Remove redundant "Total cards" row**

Delete the entire "Total" block (lines ~74-80):

```tsx
{/* Total */}
<div className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated/50 px-3 py-2">
  <div className="flex items-center gap-2">
    <Layers className="h-4 w-4 text-text-secondary" aria-hidden="true" />
    <span className="text-sm text-text-secondary">Total cards</span>
  </div>
  <span className="font-display text-lg text-text-primary">{myPool.length}</span>
</div>
```

**Step 2: Reduce panel padding**

Change the desktop panel container from:

```tsx
<div
  className={cn(
    "hidden rounded-2xl border border-border bg-surface p-4 shadow-card sm:block",
    className
  )}
>
```

To:

```tsx
<div
  className={cn(
    "hidden rounded-xl border border-border bg-surface p-3 sm:block",
    className
  )}
>
```

**Step 3: Reduce stats grid gap**

Change stats grid from:

```tsx
<div className="grid grid-cols-3 gap-2">
```

To:

```tsx
<div className="grid grid-cols-3 gap-1.5">
```

And reduce stat cell padding from `p-2` to `p-1.5`.

**Step 4: Commit**

```bash
git add packages/web/src/components/draft/pool-panel.tsx
git commit -m "refactor(draft): tighten pool panel and remove redundant total row"
```

---

### Task 6: Verify Full Test Suite

**Files:**
- All modified files above

**Step 1: Run the full web test suite**

```bash
cd packages/web && npx vitest run
```

Expected: All tests pass (currently 57+).

**Step 2: If any tests fail, fix them**

Likely failures:
- Snapshot tests if they exist (update snapshots).
- Tests that assert on specific class names or DOM structure (update selectors).

**Step 3: Commit**

```bash
git add -A
git commit -m "test(draft): verify suite passes after layout redesign"
```

---

## Verification Checklist

After all tasks are complete, verify in browser:

1. [ ] `/draft/legendary-draft` shows a wide center stage on desktop (1280px+).
2. [ ] The fallback state (when pack is empty) is centered and does not collapse the layout width.
3. [ ] Left rail (timer + seats) and right rail (pool) are compact and visually subordinate to the center.
4. [ ] No nested rounded card containers in the center stage.
5. [ ] Title, set chips, and metadata strip are flat and left-aligned.
6. [ ] Card grid uses `minmax(180px, 1fr)` and does not collapse.
7. [ ] Mobile layout still works: sticky timer top, bottom pool trigger.
8. [ ] All web tests pass.
