# Draft Card Preview Responsive Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fixed desktop draft card preview grow to the largest readable size allowed by the real left-side layout without crossing into the active pack area.

**Architecture:** Keep the change isolated to `DraftCardPreview` and its component test. The preview remains a fixed bottom-left desktop overlay, but its horizontal offset and width will be derived from the known app-shell/sidebar and draft-page desktop layout constants instead of a viewport-only clamp.

**Tech Stack:** Next.js React client component, Zustand draft store, `next/image`, Tailwind CSS, Vitest, Testing Library, jsdom.

---

## File Structure

- Modify: `packages/web/src/components/draft/draft-card-preview.tsx`
  - Owns desktop preview rendering, desktop positioning, and responsive image sizing hints.
- Modify: `packages/web/tests/components/draft-card-preview.test.tsx`
  - Owns regression coverage for desktop preview visibility, sizing classes, and image behavior.
- Read-only reference: `docs/superpowers/specs/2026-05-10-draft-card-preview-responsive-sizing-design.md`
  - Approved sizing contract and desktop behavior.
- Read-only reference: `packages/web/src/components/layout/sidebar.tsx`
  - Defines expanded/collapsed sidebar widths used by the desktop shell.
- Read-only reference: `packages/web/app/(app)/draft/[slug]/page.tsx`
  - Defines the centered draft page width plus desktop seat/pool columns that bound the preview.

## Task 1: Lock In The Left-Space-Bounded Sizing Contract

**Files:**
- Modify: `packages/web/tests/components/draft-card-preview.test.tsx`

- [ ] **Step 1: Update the desktop sizing expectations to the left-space-bounded contract**

Replace the sizing assertions inside `it("renders the full-resolution image without card detail text", ...)` with:

```tsx
    expect(preview).toHaveClass("fixed");
    expect(preview).toHaveClass("pointer-events-none");
    expect(preview).toHaveClass("bottom-[5.625rem]");
    expect(preview).toHaveClass("left-[15rem]");
    expect(preview).toHaveClass("hidden");
    expect(preview).toHaveClass("xl:block");
    expect(preview).toHaveClass("w-[calc(17rem+max(0px,(100vw-114rem)/2))]");
    expect(preview).toHaveClass("min-w-[16rem]");
    expect(preview).toHaveClass("max-w-[34rem]");
    expect(art).toHaveClass("aspect-[421/614]");
    expect(image).toHaveAttribute("src", "https://img/full/101");
    expect(image).toHaveAttribute("sizes", "(min-width: 1280px) 34rem, 0px");
    expect(image).toHaveClass("object-contain");
```

- [ ] **Step 2: Run the preview test and verify it fails for the expected reason**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/draft-card-preview.test.tsx
```

Expected: FAIL because `DraftCardPreview` still uses the smaller viewport-only classes (`left-[15.5rem]`, `w-[clamp(11rem,14vw,20rem)]`, and `sizes="(min-width: 1280px) 14vw, 0px"`).

## Task 2: Implement The Grid-Aware Preview Sizing

**Files:**
- Modify: `packages/web/src/components/draft/draft-card-preview.tsx`

- [ ] **Step 1: Replace the viewport-only preview classes with left-space-bounded sizing**

In `packages/web/src/components/draft/draft-card-preview.tsx`, replace the `className` string on the outer preview wrapper:

```tsx
        "pointer-events-none fixed bottom-[5.625rem] left-[15.5rem] z-30 hidden w-[clamp(11rem,14vw,20rem)] rounded-xl border border-border bg-surface p-2 shadow-card xl:block",
```

with:

```tsx
        "pointer-events-none fixed bottom-[5.625rem] left-[15rem] z-30 hidden w-[calc(17rem+max(0px,(100vw-114rem)/2))] min-w-[16rem] max-w-[34rem] rounded-xl border border-border bg-surface p-2 shadow-card xl:block",
```

Why these values:

- `114rem` is the approximate point where the `max-w-[1600px]` (100rem) content area stops growing its outer margins against the expanded `14rem` sidebar.
- `left-[15rem]` anchors the preview safely to the right of the sidebar in both expanded and collapsed states.
- `w-[calc(17rem+max(0px,(100vw-114rem)/2))]` perfectly fills the available empty space between the sidebar and the `CardGrid`'s left edge on any monitor larger than 1080p.
- `max-w-[34rem]` caps the card at a highly readable 544px wide so it doesn't look absurdly huge on ultrawide monitors.

- [ ] **Step 2: Update the responsive image hint to match the new preferred width**

In the same file, replace:

```tsx
            sizes="(min-width: 1280px) 14vw, 0px"
```

with:

```tsx
            sizes="(min-width: 1280px) 34rem, 0px"
```

- [ ] **Step 3: Run the preview test and verify it passes**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/draft-card-preview.test.tsx
```

Expected: PASS with `3 passed (3)`.

## Task 3: Verify The Follow-Up Branch End-To-End

**Files:**
- Modify: none

- [ ] **Step 1: Run the targeted draft UI regression suite**

Run:

```bash
npm run test --workspace=@yugioh-discord-bot/web -- tests/components/card-grid.test.tsx tests/components/draft-card-preview.test.tsx tests/components/timer-bar.test.tsx tests/components/pool-panel.test.tsx
```

Expected: PASS with all 4 files green.

- [ ] **Step 2: Build the shared workspace, then the web workspace**

Run:

```bash
npm run build --workspace=@yugidraft/shared && npm run build --workspace=@yugioh-discord-bot/web
```

Expected: PASS. The existing Turbopack workspace-root and NFT warnings may remain, but the build must exit successfully.

- [ ] **Step 3: Commit the responsive sizing follow-up**

Run:

```bash
git add packages/web/src/components/draft/draft-card-preview.tsx packages/web/tests/components/draft-card-preview.test.tsx docs/superpowers/specs/2026-05-10-draft-card-preview-responsive-sizing-design.md docs/superpowers/plans/2026-05-10-draft-card-preview-responsive-sizing.md
git commit -m "fix(web): size draft preview from available desktop space"
```

Expected: a single commit containing the preview sizing change and its spec/plan docs. Do not stage `package-lock.json`.

## Self-Review

- Spec coverage: Task 1 locks in the new sizing contract from the spec, Task 2 implements the actual left-space-bounded sizing rule and image hint, and Task 3 verifies the draft UI and build behavior on the follow-up branch.
- Placeholder scan: No `TODO`, `TBD`, or implicit “fix later” steps remain.
- Type consistency: The plan keeps the existing `DraftCardPreview` API and only changes class strings plus the `sizes` attribute, so no new type or prop drift is introduced.
