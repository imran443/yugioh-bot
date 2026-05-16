# Finite Cube Multiplicity + Reusable Pool Panel — Design

Date: 2026-05-15
Status: Approved (pending spec review)

## Problem

Two user-visible issues, one architectural root:

1. During a draft, the same card appears many times — sometimes twice in the
   same pack. This is not a feature; it is the current pack generator picking
   each pack slot independently at random **with replacement** from the deduped
   unique pool (`openWave`, `packages/shared/src/services/drafts.ts:373-380`).
2. The `×N` quantity badge in the card pool preview is dead code. Card IDs are
   deduped at three layers (`parseCustomCardIds`, `catalogCardIdsForDraft`'s
   `new Set(...)`, and the pool route's count map can never see repeats), so a
   pool is always a set of distinct card types and `qty` is always 1.

Users want a **finite physical cube**: a pool that holds a specific number of
copies of each card, dealt out like a real card box (each physical card dealt
exactly once), with the copy count surfaced as the `×N` badge. They also want
the pool preview to be a single reusable component and to use large screens
better.

## Requirements (resolved during brainstorming)

- **Copy semantics:** finite physical cube. Packs are dealt *without
  replacement* from a finite multiset.
- **Copy input:** repeat the passcode in the existing Custom Card IDs textarea.
  No new syntax.
- **Set contribution:** a card from a selected set = 1 copy baseline. If the
  same card is also pasted N times in the textarea, total = 1 + N (additive).
- **Undersized cube:** the cube is defined at create time; player count is only
  known at draft start. Validate at **draft start** and block with a clear
  "needs X, cube has Y, add Z" message. Create-time UI shows the per-player
  minimum as guidance. No extra "max players" field.
- **Pack distinctness:** a single pack must always hold `packSize` *distinct*
  cards. If the shuffle would place two copies of a card in one pack, the extra
  copy flows into a later pack. The same card may still appear across different
  packs up to its copy count.
- **Reusable component:** a full `<CardPoolPanel>` owning the chrome (container,
  header, count, loading/error state) plus the grid+badge. Props-driven, no
  data fetching inside it.
- **Responsive grid:** container-aware (CSS container query + auto-fill),
  keyed to the panel's own width, not the viewport.

## Chosen approach

**Approach 1 — materialize the cube into a table at draft start.** At start
(players known), expand the resolved multiset into one DB row per physical
card, shuffle once seeded by draft id, persist into a new `draft_cube` table,
then deal sequentially without replacement. Rejected alternatives: a persisted
shuffle cursor (fragile crash-safety), and an explicit counts map with
dual-mode pack generation (two code paths forever, inconsistent mental model).

## Section 1 — The cube engine

### Config representation

`DraftConfig.poolCardIds` stays `number[]` but **allows repeats** — the
multiset is the array itself (`[dm, dm, dm, bes, bes, pot, …]`). Existing
drafts have unique arrays → naturally "1 copy each". No config schema
migration; only behavior changes.

### Parsing — `packages/web/src/lib/custom-card-pool.ts`

`parseCustomCardIds` stops deduping: returns ids **in order, with repeats**,
still collecting invalid tokens as today. A new helper `toCardCounts(ids):
Map<number, number>` becomes the single place counts are derived. Callers
needing distinct ids use `[...counts.keys()]`.

### Pool resolution — `packages/shared/src/services/drafts.ts`

`resolvePoolCardIds` / `catalogCardIdsForDraft` produce a **multiset**:
set-sourced cards contribute 1 each; custom repeats add on top (a set card also
pasted 3× → 1 + 3 = 4). Today's `new Set(config.customCardIds)` becomes a count
merge.

### New table — `draft_cube`

Additive migration following the existing `schema.ts` pattern
(`CREATE TABLE IF NOT EXISTS` / `addColumnIfMissing`):

```
draft_cube(draft_id INTEGER, position INTEGER, catalog_card_id INTEGER)
```

One row per physical card; `position` is the shuffled order.

### Generation — at draft start (replaces per-slot RNG in `openWave`)

1. Expand the resolved multiset → one row per physical card.
2. Shuffle once, **seeded by draft id** (reproducible for debugging).
3. Persist into `draft_cube` with positions `0..N-1`.
4. `openWave` no longer RNGs. It **deals without replacement** from
   `draft_cube` and **guarantees distinct-within-a-pack** by *spreading each
   card's copies across distinct packs*, not by a naive forward stream (a
   forward stream fails on skewed cubes — e.g. 1000× card A + 14 others cannot
   fill a second distinct pack). Algorithm: enumerate the `totalPacks =
   players × packsPerPlayer` packs in shuffled order; for each distinct card,
   distribute its `c` copies into `c` *different* packs (round-robin over the
   shuffled pack order, offset by the seeded shuffle so placement varies per
   draft); fill any remaining pack slots from the unused single-copy pool.
   Each pack ends with `packSize` distinct cards; a card appears across
   different packs up to its copy count, never twice in one pack.

### Validation — at draft start (player count known)

- Require `packSize × players × packsPerPlayer` total physical cards. If short,
  block start: "needs X, cube has Y, add Z".
- Require **distinct count ≥ packSize** (can't build a `packSize`-distinct pack
  from fewer distinct cards). Separate, clear error.
- Require **no single card has more copies than `totalPacks` (players ×
  packsPerPlayer)** — more copies than packs makes distinct-within-pack
  impossible. Block at start: "card X has N copies but only M packs exist;
  reduce to ≤ M". (Cannot be fully checked at create time since players are
  unknown; create-time UI may warn against extreme counts but the hard gate is
  at start.)
- Create-time UI shows the per-player minimum as guidance only.

### Backward compatibility (in-flight and historical drafts)

- **Completed drafts:** untouched. Generation runs only at start/wave-open;
  completed drafts have their `draft_packs`/`draft_cards`/`draft_picks` rows
  already written and are never regenerated. Their pool view reads existing
  rows; `poolCardIds` is unique on old drafts → all `qty` 1 → no badge →
  identical to today.
- **Active drafts mid-flight at deploy:** `openWave` checks for `draft_cube`
  rows for the draft. **None present → that draft finishes all remaining waves
  on the legacy per-slot generator.** The materialized-cube path applies only
  to drafts whose cube was built at start (started after deploy). No backfill,
  no half-migrated drafts.
- **Pending drafts (created pre-deploy, started post-deploy):** `poolCardIds`
  is unique → cube materializes as 1-copy-each, dealt without replacement →
  they get the bug fix, no breakage.

This is a deliberate behavior change for new drafts with unique pools: a 1-copy
card now appears in at most one pack (was: random with replacement). That is
the intended fix for the duplicate bug, applied as one universal new-draft code
path.

## Section 2 — Reusable `<CardPoolPanel>` + container-aware grid

New component `packages/web/src/components/cards/card-pool-panel.tsx` owns the
chrome currently duplicated at four call sites:

- Bordered/elevated container + header row.
- Configurable `title` + count display showing **distinct types and total
  copies** (e.g. `94 cards · 200 copies`); collapses to just `94 cards` when
  every qty is 1, so existing pages read unchanged.
- Loading / "resolving…" state and an error slot.
- Renders the existing `CardPoolGrid` internally (grid, search, filter/sort,
  hover popup, `×N` badge). `CardPoolGrid` stays the inner presentational
  piece; the panel is the wrapper.

Props (data-driven, no fetching): `cards`, `loading`, `unknownIds?`, `title`,
`emptyMessage`, `error?`, `heightClassName?`, `showSummary?`,
`countMode?: "distinct" | "copies"`. Call sites keep their own fetch
hook/effect and pass `cards` down.

Refactored call sites:

1. `create-draft-form.tsx` right column (replaces ~lines 268-290).
2. `pool-builder.tsx` preview block (replaces the `showPreview` JSX).
3. `draft-manage-view.tsx` left sticky pool (replaces ~lines 311-330).
4. `pool-panel.tsx` (drafting screen) — wraps its grouped pool via the panel.

Container-aware grid: in `CardPoolGrid`, the fixed `grid-cols-2 …
2xl:grid-cols-3` is replaced with a container query keyed to the panel's own
width. The panel sets `@container`; the grid uses
`repeat(auto-fill, minmax(~9rem, 1fr))`. Narrow sidebar → 2-3 columns; wide
manage view → 5-6+; correct on ultrawide. Tailwind v4 / Next 16 container-query
support confirmed in the plan; small arbitrary-CSS fallback if the plugin is
not wired. No behavior risk — consolidation plus a CSS grid swap.

## Section 3 — Ripple effects + testing

**Templates.** `handleSaveTemplate` uses `parseCustomCardIds`, which now
preserves repeats → templates store multiplicities naturally; `applyTemplate`
re-joins ids with `\n`, repeats intact. Old templates (unique) behave as
before. No template schema change.

**Bot.** Multiset logic lives in `@yugidraft/shared`, so the bot inherits it.
Verify in the plan: (1) the bot's `/draft create` custom-id parsing preserves
repeats the same way; (2) the bot's draft-start path triggers the same cube
materialization + start-time validation, surfacing "cube too small / not enough
distinct" as Discord replies. No bot-specific model logic.

**Web routes.** `/api/drafts` and `/api/drafts/[slug]` already snapshot
`poolCardIds = resolvePoolCardIds(config)` — now a multiset.
`/api/drafts/[slug]/pool` already computes `qty` from occurrences
(`pool/route.ts:35-50`) → returns real counts with zero route changes.
Draft-start endpoints add the validation gate.

**Testing (TDD per plan task):**

- `shared`: `parseCustomCardIds` keeps repeats + flags invalid;
  `resolvePoolCardIds` multiset math (set=1, custom additive); materialization
  (expand + seeded shuffle deterministic); deal is without-replacement and
  distinct-within-pack including skewed cubes (copies spread across packs);
  start-time validation (too-few-total, too-few-distinct, a card with
  copies > totalPacks); legacy guard (no `draft_cube` rows → old generator).
- `web`: `CardPoolPanel` renders chrome/count/copies and delegates to grid;
  `CardPoolGrid` `×N` badge (already added); container grid renders; pool route
  returns copy counts. Keep the two regression tests already added.
- `bot`: draft-create with repeated ids carries multiplicities; draft-start
  surfaces validation errors.
- Existing suites stay green; the 4 known pre-existing bot failures are out of
  scope.

## Out of scope

- Multiplier syntax (`3x ID`), per-card stepper UI, global-default copies.
- Auto-refill on cube exhaustion.
- Backfilling `draft_cube` for drafts that started before deploy.
- Changing the rotisserie pass/rotation mechanics.
