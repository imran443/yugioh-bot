# Design System Unification — Design Spec

**Date:** 2026-05-06
**Worktree:** `.claude/worktrees/design+unify-design-system`
**Branch:** `worktree-design+unify-design-system`
**Status:** Draft — pending user review

## 1. Problem

`packages/web` has a working but inconsistent visual layer.

**What works today:**
- `packages/web/app/globals.css` defines a Tailwind v4 `@theme` block with color, shadow, and font tokens (`bg-deep/surface/elevated`, `text-primary/secondary`, `accent-primary/secondary/cta/gold/success`, `border`, `shadow-card`, `font-display/body`).
- `clsx` + `tailwind-merge` are installed.
- Most components consume the existing tokens correctly (e.g., `text-text-*`, `bg-bg-*`, `border-border`, `shadow-card`).

**What is missing or inconsistent:**

1. **No radius scale.** Components mix `rounded-lg` (48 occurrences), `rounded-xl` (15), `rounded-full` (11), `rounded-md` (4), `rounded-t` (1) ad-hoc. There is no token to enforce a default.
2. **No motion tokens.** Inline durations and easings are repeated across components (e.g., `200ms ease-out` in `globals.css`).
3. **Semantic state gaps.**
   - "Danger" is overloaded onto `accent-cta` — destructive actions and primary CTAs share a color.
   - No `warning` token (`accent-gold` is used informally).
   - No `info` token.
4. **Raw color escapes (3 confirmed):**
   - `packages/web/src/components/draft/set-picker.tsx:95` — `bg-[#141929]` (should be `bg-bg-surface`).
   - `packages/web/src/components/ui/button.tsx:15` — `hover:bg-red-600` (should be a semantic danger-hover token).
   - `packages/web/src/components/draft/card-preview.tsx:79` — same `hover:bg-red-600`.
5. **Arbitrary text sizes** in a few components (`text-[0.7rem]`, `text-[0.95rem]`).
6. **No shared layout/composition primitives.** Feature components reimplement the same patterns: card shells (`bg-bg-surface rounded-lg p-N shadow-card`), labelled form fields, headings, flex stacks.

**Goal:** Lock in a consistent visual language so future work composes from primitives instead of ad-hoc utility blobs, **without breaking existing tests**.

## 2. Constraints

- **Hard constraint:** Existing test suite (`packages/web/tests/**`) must remain green after each step. Tests are mostly behavior-level; classname-coupled assertions get updated alongside the migration that legitimately changes them.
- **No breaking API changes** to existing primitives (`Button`, `Badge`, `Modal`, `Sheet`).
- **Scope limited to `packages/web`.** `packages/bot` (Discord) and `packages/shared` are out of scope.
- **No new tooling** (no Storybook, no Chromatic, no design-token build pipeline). Tailwind v4 `@theme` is the source of truth.

## 3. Approach: Primitives-first, then migrate

A two-phase, additive-then-migrate approach was chosen over big-bang or slice-by-slice because:

- It preserves the no-broken-tests constraint cleanly: Phase 1 is purely additive, so it cannot break consumers.
- It gives a checkpoint between phases — work can be paused after primitives ship if priorities shift.
- Migration can happen one component at a time, so any regression is isolated and trivially revertible.

### Phase 1 — Token + primitive foundation (additive)

#### 1a. Extend `packages/web/app/globals.css` `@theme`

```css
/* Radius scale (new) */
--radius-sm: 4px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;
--radius-full: 9999px;

/* Semantic state colors (new / aliasing) */
--color-state-danger: #F43F5E;          /* alias of accent-cta, semantic name for destructive */
--color-state-danger-hover: #E11D48;
--color-state-warning: #F59E0B;          /* alias of accent-gold */
--color-state-info: #3B82F6;

/* Motion (new) */
--duration-fast: 120ms;
--duration-base: 200ms;
--duration-slow: 320ms;
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

Type scale: keep Tailwind defaults. Convention bans arbitrary `text-[…]` sizes outside `globals.css`.

#### 1b. Add primitives in `packages/web/src/components/ui/`

Each primitive is a thin wrapper using `cn()` (clsx + tailwind-merge), forwards refs, accepts `className` for escape hatches, and ships with a co-located unit test.

| Primitive file | Props / variants | Replaces |
|---|---|---|
| `card.tsx` | `padding: sm \| md \| lg`, `interactive?: boolean` | repeated `bg-bg-surface rounded-lg p-N shadow-card` blocks |
| `container.tsx` | `size: sm \| md \| lg \| full` | ad-hoc `mx-auto max-w-*` |
| `stack.tsx` | `direction: row \| col`, `gap: 1\|2\|3\|4\|6\|8`, `align`, `justify` | repeated flex/gap combinations |
| `heading.tsx` | `level: 1\|2\|3\|4`, applies display font + size token | scattered `text-xl/-2xl + font-display` |
| `text.tsx` | `variant: body \| muted \| caption`, `weight` | `text-text-primary/secondary` patterns |
| `input.tsx` | controlled, error state, prefix/suffix slot | bespoke `<input>` styling in forms |
| `form-field.tsx` | label + `<Input>` + error message + helper | repeated label/error scaffolding |

`button.tsx`, `badge.tsx`, `modal.tsx`, `sheet.tsx` keep their current public APIs in Phase 1.

**Phase 1 invariants:**
- No existing component is modified.
- All existing tests pass unchanged.
- Each new primitive has unit tests covering its variants.

### Phase 2 — Migration (one focused change at a time)

Order by blast radius / value:

1. `packages/web/src/components/ui/button.tsx:15` — `hover:bg-red-600` → `hover:bg-state-danger-hover`.
2. `packages/web/src/components/draft/card-preview.tsx:79` — same fix.
3. `packages/web/src/components/draft/set-picker.tsx:95` — `bg-[#141929]` → `bg-bg-surface`.
4. `draft-card.tsx` + `tournament-card.tsx` → adopt `Card` + `Heading` + `Stack`.
5. `create-draft-form.tsx` + `create-tournament-form.tsx` → adopt `FormField` + `Input`.
6. `pool-panel.tsx`, `seat-list.tsx`, `draft-manage-view.tsx`, `draft-summary-view.tsx` → adopt `Card`, `Stack`, `Heading`, `Text`.
7. `app-shell.tsx`, `sidebar.tsx`, `topbar.tsx`, `mobile-drawer.tsx` → adopt `Container` and `Stack` where appropriate.
8. `set-browser-modal.tsx` — already uses `Modal`; verify token usage only.

After each migration: `npm run typecheck` and `npm test --workspace=@yugioh-discord-bot/web`. If any test asserts a specific classname that changes, the assertion is updated in the same change.

### Phase 3 — Documentation

Under `docs/ui/`:

- `README.md` — overview, when-to-use rules, links to tokens and primitives.
- `tokens.md` — reference table (color, radius, motion).
- `primitives.md` — each primitive's API + one-liner usage example.

Each primitive file additionally carries a single-line JSDoc above the export with a usage snippet. No Storybook.

## 4. Testing strategy

- **Phase 1:** Existing tests must stay green untouched. New primitives ship with their own unit tests under `packages/web/tests/components/` covering each variant and the `className` escape hatch.
- **Phase 2:** After each migrated component, run web typecheck + tests. Update classname-coupled assertions only when migration legitimately changes the rendered classnames; behavior assertions (text, role, click handlers) must keep passing without modification.
- **Phase 3:** `npm run build` for the web workspace as a final sanity check that no imports broke.

No visual regression tooling is introduced.

## 5. Out of scope

- `packages/bot` and `packages/shared` (no UI).
- Storybook, Chromatic, or any visual regression tooling.
- Design-token build pipeline (Style Dictionary, etc.).
- New theming (light mode, density variants) — possible follow-on, not in this spec.

## 6. Follow-on (not part of this work)

Once primitives are in place, a follow-on can add a lint rule (or grep-based CI check) banning raw hex colors and arbitrary `text-[…]` sizes outside `globals.css`. Mentioned only to keep the door open.

## 7. Acceptance

This design is accepted when:

1. The token additions in §3.1a, primitive surface in §3.1b, migration list in §3.2, and docs structure in §3.3 are all approved by the user.
2. The constraints in §2 (especially "no broken tests" and "no breaking primitive APIs") are agreed as binding.
3. The user signals readiness to move to an implementation plan via `superpowers:writing-plans`.
