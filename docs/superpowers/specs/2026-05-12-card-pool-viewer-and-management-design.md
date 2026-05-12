# Card pool viewer & management — design

Date: 2026-05-12
Status: approved pending user review

Adds three related capabilities around draft card pools:

1. **Pending-draft pool viewer** — the pending-draft screen shows the draft's frozen
   `poolCardIds` as an inline, scrollable card-image grid with search/filter/sort and a
   hover/tap card preview.
2. **Live pool preview on the create form** — while you build a pool (sets + custom
   passcodes) the same grid previews the resolved cards live, debounced.
3. **Settings card-pool management** — a new "Card Pools" section on the Settings page to
   list / create / edit / rename / delete saved pools, with the same live preview. Saving a
   pool stays available on the create form too; both surfaces share one table and API.

Pools become **pool-only** (`{ setNames, customCardIds }`) — the numeric/behaviour knobs
(`packsPerPlayer`, `pickSeconds`, `alternatePassDirection`, `randomizeSeats`) are no longer
stored on a saved pool. This is backward-compatible: old `draft_templates` rows with extra
keys still load (the extra keys are ignored).

## Architecture

- One shared `POST /api/cards/resolve` endpoint resolves `{ setNames?, customCardIds? }`
  against the local `card_catalog` (no network fetches) → `{ cards, unknownIds }`. The
  create form and the Settings editor call it (debounced, with a client-side cache).
- One draft-scoped `GET /api/drafts/[slug]/pool` resolves the draft's frozen `poolCardIds`
  (fallback to `resolvePoolCardIds(config)` for old drafts) → `{ cards }`.
- One shared presentational `<CardPoolGrid cards={...}>` component carries search / type
  filters / sort / scrollable image grid / hover-or-tap preview. `PoolPanel` (the in-draft
  pool panel) is refactored to wrap it so the grid logic lives in one place.
- One shared `<PoolBuilder>` component (sets picker + custom-IDs textarea + invalid-ID hint
  + live `<CardPoolGrid>` preview) is embedded by both `DraftConfigFields` (create + edit)
  and the Settings pool editor, so the two pool-building surfaces can't drift.

**Tech stack:** Next.js 16 App Router, TypeScript strict, React, Zustand (existing draft
store), `next/image`, `better-sqlite3` via `@yugidraft/shared/db`, Vitest. Visual language
follows the existing `.impeccable.md` system (dark-mode-first competitive UI, high-contrast
card displays, purple/gold accents used sparingly). UX rules below incorporate the
`ui-ux-pro-max` cross-platform accessibility/UX guidance (the web subset).

## 1. Data layer & APIs

### Card detail shape
Reuse the existing `DraftCardDetail` shape (`id`, `name`, `type`, `frameType`, `effectText`,
`imageUrl`, `imageUrlSmall`, optional `atk`, `def`, `attribute`, `level`). Export it from a
neutral location (`packages/web/src/lib/card-types.ts`) under the name `CardSummary`
(`DraftCardDetail` may remain an alias to avoid churning the draft store). Card images keep
flowing through the existing `GET /api/cards/[passcode]/image` route — unchanged.

### `POST /api/cards/resolve`
- Auth: session required (same check as other web routes); 401 otherwise.
- Body: `{ setNames?: string[]; customCardIds?: number[] }`.
- Behaviour: reads `card_catalog` only — **no network fetches**. Resolves set names to
  catalog rows, looks up custom passcodes, dedupes the union, returns
  `{ cards: CardSummary[]; unknownIds: number[] }` where `unknownIds` is the subset of
  requested `customCardIds` not present in the catalog (they get fetched later when a draft
  is actually created, via the existing `cards.syncDraftPool`).
- Implementation: reuse the drafts service's existing catalog-resolution logic. If
  `resolvePoolCardIds` only returns IDs, add an internal sibling that returns full rows
  (or have the route map IDs → catalog rows); either way the set→cards expansion stays
  server-side.

### `GET /api/drafts/[slug]/pool`
- Auth + draft lookup by `web_slug` + guild (same pattern as the other `drafts/[slug]`
  routes); 401 unauthenticated; 404 unknown slug / wrong guild.
- Returns `{ cards: CardSummary[] }` resolved from `config.poolCardIds`. If `poolCardIds`
  is absent (drafts created before the pool-snapshot change), fall back to
  `resolvePoolCardIds(config)` then map those IDs to catalog rows. If the resolved set is
  empty, return `{ cards: [] }` (the UI shows an empty state).

### Client-side resolve cache
A module-level `Map<number, CardSummary>` in `packages/web/src/lib/cards-cache.ts`. Helpers:
`getCached(ids: number[]): { hits: CardSummary[]; missing: number[] }` and
`putCards(cards: CardSummary[]): void`. The create form and Settings editor consult the
cache first, POST only the `missing` IDs to `/api/cards/resolve` (always passing `setNames`
whole, since set expansion is server-side and cheap to re-run), merge results back, and
render cached hits immediately. Cleared on page reload — good enough; the catalog rarely
changes within a session.

## 2. Shared `<CardPoolGrid>` and `PoolPanel` refactor

### `packages/web/src/components/cards/card-pool-grid.tsx`
Pure presentational. Props:
- `cards: CardSummary[]`
- `loading?: boolean` — re-resolve in progress
- `unknownIds?: number[]` — rendered as muted dashed-border placeholder tiles after the
  resolved cards, each showing the passcode and "not in catalog yet", with a `title` /
  `aria-label` (so the state is not conveyed by colour alone)
- `emptyMessage?: string` — shown when `cards` is empty (default `"No cards."`)
- `className?: string`, `heightClassName?: string` — caller controls the scroll-container
  height (pending viewer wants taller than the create-form preview)
- `showSummary?: boolean` — whether to show the monster/spell/trap count row (default true)

Owns: a search input (`aria-label="Search cards"`, ~300ms `useDeferredValue` debounce as in
the current PoolPanel), type-filter pills (All / Effect Monsters / Normal Monsters / Spells
/ Traps, `aria-pressed` on active), sort pills (Newest / Oldest / Name / Type, `aria-pressed`
on active), an optional monster/spell/trap count summary, a fixed-height scrollable `grid` of
card tiles, and hover-or-tap preview via the existing `<CardHoverPopup>`.

Card tiles are real `<button>`s with `aria-label="Preview {name}"`, a visible focus ring, and
≥44px effective hit area (the current PoolPanel tiles already satisfy this). Images use
`next/image` inside an `aspect-[421/614]` box (lazy by default; explicit aspect → no CLS).
On image error, show a `?` placeholder (existing behaviour).

Does **not** own: the draft store, the "Drafted so far" counter, the Export YDK button, the
mobile sheet wrapper — those stay in `PoolPanel`.

Shared type helpers (`isMonster`, `isSpell`, `isTrap`, `isEffectMonster`, `isNormalMonster`,
`getTypeBadgeClass`, `getTypeLabel`) move out of `pool-panel.tsx` into
`packages/web/src/lib/card-types.ts` so both files use them.

### Hover/tap preview
On pointer devices, `<CardHoverPopup>` works as today (it is already standalone and
`lg:block`-gated). Add a touch path: on devices without hover, tapping a tile opens a small
dismissible popover with the same content; dismiss on outside tap or `Escape`. Any
fade/transition on the popup respects `prefers-reduced-motion`. (Rationale: "view the card
with a preview" must work on small screens, where the current `lg:block` popup shows nothing.)

### Performance / virtualization
A pool can be 200+ cards. The grid renders into a fixed-height scroll container. For pools
over ~100 cards, virtualize the rows (lightweight windowing — only render tiles near the
viewport) so scroll stays smooth and memory stays bounded. Below the threshold, render all
tiles (simpler). Use a small dependency-free windowing approach or an existing utility — no
heavy virtualization library required.

### `PoolPanel` refactor
Keep `PoolPanel`'s outer card, "Drafted so far" counter, Export YDK button, and the mobile
sheet trigger + `<Sheet>`. Replace its inner search/filter/sort/grid/hover block with
`<CardPoolGrid cards={myPool} heightClassName="h-[26rem] xl:h-[34rem]" />`. Net effect:
identical behaviour in the live draft, grid logic now centralized. Preserve the
`data-testid="pool-panel-card-grid"` (move it onto the grid inside `<CardPoolGrid>`, or have
`PoolPanel` keep a wrapper carrying it) so the existing PoolPanel tests stay green.

## 3. `<PoolBuilder>` and create-form changes

### `packages/web/src/components/cards/pool-builder.tsx`
Props: `value: { setNames: string[]; customCardText: string }`, `onChange(value)`,
optional `previewHeightClassName`. Renders:
- the Sets picker (`<SetPicker>`)
- the Custom Card IDs `<textarea>` with a visible `<label>`, `parseCustomCardIds` parsing,
  and the existing red "Invalid: …" helper for bad tokens; additionally validates on blur
  for the consumer's submit path
- a debounced (~300ms) effect that watches `setNames` + the parsed `customCardIds`, consults
  `cards-cache`, POSTs the missing IDs (+ all `setNames`) to `/api/cards/resolve`, merges,
  and feeds a `<CardPoolGrid>` labelled "Pool preview — N cards" (count in an `aria-live="polite"`
  region; tabular figures). While a resolve is in flight: count label shows a small spinner
  glyph, grid shows the "updating…" overlay (not a skeleton — prior cards usually still valid).

`DraftConfigFields` embeds `<PoolBuilder>` in place of its current inline Sets picker +
custom-IDs textarea, keeping its own numeric inputs (Packs per Player, Pick Timer) and
checkboxes (Alternate pass, Randomize seats) below it. Because `DraftConfigFields` is shared
with the pending-draft edit panel, the live preview shows up there too — desirable and kept.

### `create-draft-form.tsx`
- **Removed:** nothing structural — the Sets picker, Custom Card IDs textarea, "Saved Pool"
  dropdown, and "Save Pool" button + name field all stay.
- **Changed:** "Save Pool" now persists **only** `{ name, setNames, customCardIds }` (its
  `POST /api/draft-templates` body drops the numeric/behaviour keys). Loading a "Saved Pool"
  from the dropdown fills only `setNames` + `customCardText`; it does **not** touch Packs per
  Player / Pick Timer / Alternate pass / Randomize seats.
- **Added:** the live `<CardPoolGrid>` preview (via `<PoolBuilder>`), with a shorter height
  (`~h-[22rem]`) since the form is already tall. On mobile it is the same scroll container,
  not a separate sheet.

## 4. Pending-draft inline pool viewer

In `DraftManageView`, add a new section **below "Configuration"**, always visible inline:
- Same card-panel chrome as the other sections on that page; heading
  `"Card Pool ({N} cards)"` with `{N}` in tabular figures.
- Body: `<CardPoolGrid cards={poolCards} heightClassName="h-[32rem]" emptyMessage="This draft's pool hasn't been resolved yet." />`
  — full search/filter/sort/hover-or-tap toolkit, **read-only** (tiles open the preview only;
  no pick affordance).
- Data: on mount, fetch `GET /api/drafts/{slug}/pool`. While loading, the grid shows a
  skeleton (~8–12 shimmer tiles). On error, an inline message with a retry button. The
  draft's slug is already available on `draft/[slug]/page.tsx` (it is passed to the summary
  view after the previous change) — thread it into `DraftManageView`.
- Visibility: shown to **everyone** who can see the pending-draft page (creator and
  participants). Nothing sensitive; seeing the cube contents pre-start is useful to all.
- Edit-mode interaction: when the creator is in "Edit Configuration" mode, this read-only
  viewer reflects the **saved** pool (it does not live-update from the edit form — the edit
  form has its own live preview via `<PoolBuilder>`). The page's existing `onUpdate` refresh
  re-fetches `/pool` after save, so the read-only viewer updates then. No special wiring.

## 5. Settings card-pool manager + templates become pool-only

### Templates semantics
`draft_templates.config_json` keeps its column; we just write only
`{ setNames, customCardIds }` going forward and read only those two keys. Old rows with extra
keys still load (extra keys ignored). No DB migration.

### New routes
- `PUT /api/draft-templates/[id]` — body `{ name, setNames, customCardIds }`. Updates the row
  by `id` (enables rename). Auth + guild-scoped (cannot touch another guild's template);
  401; 404 if not found in this guild; 409 if `name` collides with a *different* template in
  the guild.
- `DELETE /api/draft-templates/[id]` — auth + guild-scoped; 401; removes the row; on an
  already-gone id return 404 (assert this in tests).
- `GET /api/draft-templates` (existing) — response per template now also includes the raw
  `setNames` / `customCardIds` so the list can render "`Y` sets · `X` custom IDs" without a
  resolve call per row.
- `POST /api/draft-templates` (existing) — keeps its upsert-by-`(guild_id, name)` behaviour
  but now persists only `{ setNames, customCardIds }` and ignores any numeric keys in the
  body (used by the create form's "Save Pool" and by Settings "New Pool").

### `packages/web/src/components/settings/card-pool-manager.tsx`
- **List view:** one row per pool — pool name (prominent), a muted "`Y` sets · `X` custom IDs"
  line, right-aligned `Edit` and `Delete` icon-buttons (each with `aria-label` like
  "Edit pool {name}" / "Delete pool {name}", visible focus ring, ≥44px hit area). A "New Pool"
  button at the top. Empty state: "No saved pools yet. Create one to reuse it across drafts."
  `Delete` → inline confirm step ("Delete '{name}'? — Delete / Cancel"); the destructive
  button uses the danger colour and is visually separated from `Edit`. After a successful
  delete, a brief success flash; include an "Undo" affordance only if cheap, otherwise the
  confirm step suffices.
- **Editor:** an inline expanding panel (open/close animated ≤300ms, `prefers-reduced-motion`
  aware). Contains a visible-`<label>` name input (required marker), `<PoolBuilder>` (sets +
  custom IDs + invalid-ID hint + live preview), and `Save` / `Cancel`. `Save` → `POST` (new)
  or `PUT` (edit); shows loading, then a success flash or an inline error
  ("A pool named '{name}' already exists"). On validation failure (empty name, or no set and
  no custom ID), focus moves to the first invalid field. `Cancel` while dirty asks for
  confirmation.
- Validation: name required; at least one set **or** at least one custom card ID; no invalid
  passcode tokens.

### Settings page
`app/(app)/settings/page.tsx` renders `<AnnouncementToggles>` then `<CardPoolManager>`.
Widen the container to `max-w-3xl` (or let the pool manager span wider than the toggles) so
the preview grid has room; keep 8px-rhythm spacing between the two sections. No routing
changes.

## 6. UX & accessibility rules applied

- **Loading > 300ms** → skeleton (shimmer card tiles) when the grid is empty; "updating…"
  overlay (keep current content) when re-resolving a non-empty grid. Never a blank box or
  bare spinner.
- **Empty states** everywhere — helpful message + (where relevant) the action that fills it.
  Never blank whitespace.
- **No layout shift** — every card image sits in an `aspect-[421/614]` box; counts use
  tabular figures.
- **Lazy images** — `next/image` (lazy by default) for all card tiles.
- **Virtualize** the grid for pools over ~100 cards.
- **Inline validation on blur** for the custom-IDs textarea (submit path) and the pool-name
  field; submit feedback (loading → success/error) on Save Pool / Save / Delete; focus the
  first invalid field on failure.
- **Visible labels** on all inputs (no placeholder-only labels).
- **Icon-only buttons** (Edit/Delete in the manager) get `aria-label`s; non-colour cues for
  the destructive action; destructive action separated from neighbours.
- **Confirmation** before delete.
- **Touch targets** ≥44px; visible focus rings on tiles and buttons; `aria-pressed` on active
  filter/sort pills; `aria-live="polite"` on the preview count.
- **Touch preview path** for the card popup on no-hover devices.
- **`prefers-reduced-motion`** respected for the popup fade and the Settings editor expand.
- **Dark-mode contrast** — reuse existing semantic colour tokens; no new ad-hoc hex.

## 7. Testing

All Vitest, matching the repo harness (`vi.resetModules()` + temp SQLite dirs for route
tests; `@vitest-environment jsdom` + Testing Library + stubbed `fetch` for components; mock
`createCardCatalogService` / drafts service so no real ygoprodeck calls).

**lib**
- `cards-cache`: caches by ID; `getCached` returns hits + missing; `putCards` merges; a
  re-query for an already-cached ID reports no missing.

**API routes**
- `POST /api/cards/resolve`: resolves set names to catalog rows; resolves custom IDs; dedupes
  the union; returns `unknownIds` for passcodes absent from the catalog; 401 unauthenticated.
- `GET /api/drafts/[slug]/pool`: returns cards for a draft with `poolCardIds`; falls back to
  `resolvePoolCardIds(config)` when `poolCardIds` is absent; returns `{ cards: [] }` for an
  empty/unresolvable pool; 404 unknown slug / wrong guild; 401 unauthenticated.
- `PUT /api/draft-templates/[id]`: updates name + pool; 409 on name collision with a
  *different* template in the guild; 401; guild-scoped (cannot touch another guild's row).
- `DELETE /api/draft-templates/[id]`: removes the row; 404 on already-gone id; 401;
  guild-scoped.
- `POST /api/draft-templates` (existing): now persists only `{ setNames, customCardIds }` and
  ignores numeric keys in the body.

**Components**
- `<CardPoolGrid>`: renders a tile per card with name + image; search narrows; type-filter
  pills narrow; sort pills reorder; empty message when `cards` empty; skeleton when
  `loading && cards.length === 0`; "updating…" overlay when `loading && cards.length > 0`;
  renders `unknownIds` as placeholder tiles showing the passcode; hover/focus on a tile opens
  the preview popup; tile has `aria-label`.
- `<PoolBuilder>`: typing IDs triggers a debounced `/api/cards/resolve` call (fake timers)
  with the parsed IDs + current set names; invalid tokens surface the red helper; resolved
  cards appear in the embedded grid; cached IDs are not re-requested.
- `create-draft-form`: still creates a draft (existing tests stay green); "Save Pool" POSTs a
  pool-only body (`setNames`/`customCardIds`, not `packSize`/`pickSeconds`); loading a "Saved
  Pool" fills only sets + custom IDs and leaves packs/timer/checkboxes untouched; the live
  preview grid appears and reflects typed IDs.
- `draft-manage-view`: renders the read-only "Card Pool" section; fetches
  `/api/drafts/[slug]/pool` on mount and renders the returned cards; empty state when the
  pool is empty; retry on fetch error; the edit-config panel still works (existing assertions
  stay green) and shows its own live preview.
- `<CardPoolManager>`: lists pools from `/api/draft-templates` with the "Y sets · X IDs"
  line; "New Pool" opens the editor; saving POSTs (create) / PUTs (edit) the pool-only
  payload; "Delete" shows the confirm step then calls `DELETE`; rename collision surfaces the
  inline error; icon-buttons have `aria-label`s.
- `<CardHoverPopup>` touch path: opens on tap on a no-hover device; dismisses on outside tap
  / `Escape`.
- `PoolPanel`: existing tests stay green after the refactor (the `data-testid` is preserved).
- Settings page: smoke test that `<AnnouncementToggles>` and `<CardPoolManager>` both mount.

## Out of scope

- Changing how the draft engine deals packs, or how `poolCardIds` is frozen (already done).
- Editing an *active* draft's pool.
- A full card-search/browse experience independent of pools (this is pool-scoped only).
- Importing pools from external formats (.ydk, Draftmancer cube lists, etc.).
- Per-guild vs per-user pool ownership changes — pools stay guild-scoped as `draft_templates`
  is today.
