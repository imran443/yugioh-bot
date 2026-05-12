# Draft fixes & tournament hand-off — design

Date: 2026-05-12
Status: approved pending user review

Covers five related changes to the draft system. Each is independent enough to land as
its own commit but they share the create/edit form and the `DraftConfig` type.

## 1. Pool source is snapshotted at draft creation

### Problem
A draft's pool is currently re-resolved from the live `card_catalog` every time a wave
opens (`catalogCardIdsForDraft` in `packages/shared/src/services/drafts.ts`). The daily
sets sync can add new cards to a set the draft uses, so the pool silently grows between
waves or between drafts created from the same template. For a curated cube this is wrong —
the creator picked a pool and expects exactly that pool.

### Decision
Snapshot the resolved pool **at draft creation time** and store it in the draft config.

- Extend `DraftConfig` with `poolCardIds?: number[]` — the frozen list of catalog
  `ygoprodeck_id`s the draft will deal from. `setNames` / `customCardIds` / `includeNames`
  / `excludeNames` are retained as the *recipe* (for display and for re-snapshotting on
  edit) but are no longer consulted once `poolCardIds` is set.
- On `POST /api/drafts` (create): after building the recipe, call
  `cards.syncDraftPool(recipe)` (so any custom passcodes are fetched into the catalog),
  then `drafts.resolvePoolCardIds(recipe)` to compute and store `poolCardIds`.
- `openWave` reads `config.poolCardIds` directly; only falls back to
  `catalogCardIdsForDraft` if `poolCardIds` is absent (older drafts).
- Editing a pending draft's pool (sets or custom IDs) re-runs sync + resolve and rewrites
  `poolCardIds`. So "adding a set" is the only way more cards enter the pool — exactly the
  requested behaviour.
- `cards.syncDraftPool` is no longer called from `POST /api/drafts/[slug]` (start),
  because the pool is already frozen. (Keep a defensive call only if `poolCardIds` is
  empty, for old drafts.)

### New service surface
`createDraftService(db)` gains:
- `resolvePoolCardIds(recipe: PoolRecipe): number[]` — extracts the existing
  `catalogCardIdsForDraft` logic, made callable directly.
- `create(...)` accepts a config that already contains `poolCardIds`, or we resolve it
  inside `create` if absent. (Resolving in the route is cleaner because the route also owns
  the `syncDraftPool` await — a service shouldn't do network I/O. Decision: route resolves,
  service just persists.)

### Edge cases
- Empty resolved pool → reject creation with a clear error ("No cards matched the selected
  sets / passcodes").
- A draft created before this change has no `poolCardIds`; `openWave` falls back to the old
  path, so nothing breaks.

## 2. Editing a pending draft's configuration

### Problem (from the screenshot)
The "Edit Configuration" panel on `DraftManageView`:
1. Hard-requires ≥1 set (`if (editSetNames.length < 1) ...`), so a custom-pool-only draft
   (0 sets, N passcodes — the "My Cube" case) can't be edited at all.
2. On save it sends only `{ setNames, packSize, packsPerPlayer, pickSeconds }`. The PUT
   route does `update drafts set config_json = ?` with that object, **dropping**
   `customCardIds`, `includeNames`, `excludeNames`, `alternatePassDirection`,
   `randomizeSeats`, and (after change #1) `poolCardIds`.

### Decision: full parity with the create form
Refactor the pool + numeric controls out of `CreateDraftForm` into a shared
`<DraftConfigFields>` component used by both the create page and the edit panel.

- Edit panel shows: Sets (`SetPicker`), Custom Card IDs (`textarea` with `parseCustomCardIds`),
  Packs/Player (see #3), Pick Timer (see #5), Alternate pass, Randomize seats.
- Validation matches create: "at least one set **or** at least one custom card ID"
  (`validatePool`), no invalid passcodes.
- PUT route: when `config` is present, **merge** onto the existing config rather than
  replacing, then (because pool inputs may have changed) re-run `syncDraftPool` + re-resolve
  `poolCardIds`. Validate the merged config server-side (reject empty pool, bad numbers).
  Keeping a server-side guard matters because the route is the trust boundary.
- The `onUpdate` contract stays `{ name?, config? }`; the page's `handleUpdate` is unchanged.

### Why a shared component, not just patching the panel
The two forms have already drifted (different validation, the edit panel silently dropping
keys). One source of truth removes the class of bug.

## 3. Pack Size / Packs-per-Player simplified to one knob

### Problem
Two independent number inputs ("Pack Size", "Packs/Player") whose product determines how
many cards a player drafts. A YGO main deck is exactly 40 cards, so the product must be 40
(currently the default 8×5 happens to work, but nothing enforces it and the relationship is
invisible). Users don't know what to enter.

### What other tools do
- **Draftmancer / Cockatrice cube drafts**: you set "boosters per player" and "cards per
  booster" independently — same confusion, but cube players tolerate it because they know
  MTG decks are 40 + lands.
- **MTG Arena / paper booster draft**: fixed 3 packs × 15 cards = 45 seen, build 40.
- The clean move for a fixed-40 game: expose **one** primary knob and derive the other.

### Decision
Single input: **"Packs per player"** (integer, 1–10, default 5). The form derives and shows
**cards per pack = `Math.ceil(40 / packsPerPlayer)`** as read-only helper text, e.g.
*"Each player drafts 40 cards across 5 packs of 8."* Larger packs are reached by choosing
fewer packs (2 → 20-card packs, 1 → one 40-card rotisserie pack).

- The draft engine already stops each player at 40 picks (`pick_count >= 40`) and completes
  the draft when every player is finished, so when `packsPerPlayer * cardsPerPack > 40` the
  tail of the last pack is simply never reached — harmless. (e.g. 3 packs × 14 = 42, last 2
  cards untouched.)
- `DraftConfig` still stores both `packSize` (= derived cardsPerPack) and `packsPerPlayer`
  so the engine and all existing display code keep working unchanged. Only the *input* is
  consolidated.
- Server-side (`POST/PUT /api/drafts`): clamp `packsPerPlayer` to 1–10, recompute
  `packSize = ceil(40/packsPerPlayer)` from it (ignore any client-sent `packSize`), so the
  invariant can't be violated.
- Display surfaces (`DraftManageView` read view, `DraftSummaryView`, draft detail page's
  `totalDraftCards`) change "Pack Size / Packs/Player" tiles to "Packs/Player" +
  "Cards/Pack" with the derived value, and `totalDraftCards` becomes a constant 40.

## 4. Create a tournament when a draft completes

### Decision
On a completed draft, the **creator** can create a tournament seeded with the draft's
players, choosing the format (round-robin or single-elim). Available from both the web
summary screen and a Discord button.

### Web
- `DraftSummaryView` (shown when `draft.status === "completed"`) gets a "Create Tournament"
  block visible only to the creator and only if no tournament has been created from this
  draft yet: a small format selector (Round Robin / Single Elimination) + button.
- New route `POST /api/drafts/[slug]/tournament` `{ format }`:
  - auth; must be the draft creator; draft must be `completed`.
  - idempotency: store `tournamentId` on the draft once created (new nullable column
    `drafts.tournament_id`, added via `addColumnIfMissing`). If already set, return 409 with
    the existing slug.
  - `tournaments.create(guildId, name, format, createdByUserId)` where `name` defaults to
    the draft name (on name clash, append " Draft" / a counter — reuse the retry pattern, or
    just surface the existing "name already used" error to the user to rename — decision:
    surface the error, simplest).
  - for each `drafts.players(draftId)` → `tournaments.join(tournamentId, playerId)`.
  - persist `drafts.tournament_id`.
  - response `{ id, name, webSlug, format }`; web redirects to `/tournament/{webSlug}` (or
    wherever tournaments live — confirm route during implementation).

### Discord
- New announce flow: when a draft transitions to `completed`, the bot posts a "Draft
  complete" message with a `Create Tournament` button (custom id `draft:create-tournament:<draftId>`).
  - Completion is detected in two places today — the bot's `draft-timer` poll
    (`packages/bot/src/services/draft-timer.ts`, already sees `status === "completed"`) and
    the web pick route (`POST /api/drafts/[slug]/pick`, when `pickCard` returns a state that
    completed the draft). The draft-timer path can post directly. The web path already calls
    `notifyWs(... "complete" ...)`; add a parallel `announceToBot({ kind: "draft-completed", draftId, channelId, name, webSlug })`.
  - Add `onDraftCompleted` to the bot announce server + a guard so the message is only posted
    once (check `drafts.tournament_id is null` and a new `drafts.completed_announced_at`-style
    flag, or simply that we haven't posted — reuse `status_message_id` style tracking via a
    new column `drafts.complete_message_id`). Decision: new nullable column
    `drafts.complete_message_id`; only post if null, then store the id.
  - Button handler: parse `draftId`, verify the clicker is the draft creator, present a
    select menu or two buttons for format, then run the same tournament-creation logic
    (extract it into a shared `createTournamentFromDraft(db, draftId, format, userId)` helper
    in `packages/shared/src/services` so bot + web share it), then edit the message to link
    the tournament.

### Shared helper
`packages/shared/src/services/draft-tournament.ts` (or a method on an existing service):
`createTournamentFromDraft(db, { draftId, format, createdByUserId }): Tournament` —
does the validation (creator, completed, not already linked), creation, participant seeding,
and `drafts.tournament_id` write in one transaction. Both the web route and the bot button
call this; only the surrounding auth/UX differs.

## 5. Pick-timer input can't be cleared

### Problem
`onChange={(e) => setPickSeconds(Math.max(5, parseInt(e.target.value) || 45))}` — clearing
the field gives `""` → `parseInt` → `NaN` → `|| 45` → the box snaps back to 45 mid-edit, so
you can't type a new value (e.g. you want "120": deleting "45" instantly refills it). Same
pattern on `packSize`/`packsPerPlayer` in the create form and the edit panel.

### Decision
Hold the numeric inputs as **strings** in component state (`pickSecondsText`, etc.), let the
user type freely (including empty), and coerce + clamp only when building the config for
submit (and show inline validation if out of range). This is the standard React controlled-
number-input pattern. Applies to: Packs/Player and Pick Timer (the only remaining numeric
inputs after #3). Range for pick timer: 5–300 s; on submit, empty/invalid → validation error,
not a silent reset.

## Testing

All changes get tests; mostly unit/integration at the service + route + component level
(Vitest, the repo's existing harness).

- **shared/drafts**: `resolvePoolCardIds` returns the recipe-filtered list; `create` persists
  `poolCardIds`; `openWave` deals only from `poolCardIds` and ignores catalog rows added
  afterwards; falls back to catalog when `poolCardIds` absent (old draft).
- **shared/draft-tournament**: `createTournamentFromDraft` — happy path seeds all players;
  rejects non-creator, non-completed, already-linked; respects chosen format; idempotent.
- **web/drafts route (POST)**: stores `poolCardIds`; rejects empty pool; clamps
  `packsPerPlayer` and derives `packSize`.
- **web/drafts/[slug] route (PUT)**: merges config without dropping keys; allows 0 sets when
  custom IDs present; re-resolves `poolCardIds`; rejects bad numbers; still 400s on
  non-pending.
- **web/drafts/[slug]/tournament route**: creator-only, completed-only, idempotent (409 on
  second call), seeds participants.
- **components/create-draft-form** & **draft-manage-view**: pick-timer / packs-per-player
  can be cleared and retyped; derived cards-per-pack text updates; "at least one set or
  custom ID" validation; edit panel pre-fills custom IDs and saves them.
- **components/draft-summary-view**: shows "Create Tournament" with format choice for the
  creator on a completed draft; hidden once linked / for non-creators.
- **bot**: `onDraftCompleted` posts the message once and not again; button handler verifies
  creator and calls the shared helper; draft-timer posts on completion.

## Out of scope
- Changing how active drafts behave mid-flight (no live re-pooling).
- Tournament UI beyond the create hand-off.
- Backfilling `poolCardIds` for historical drafts (fallback path covers them).
</content>
</invoke>
