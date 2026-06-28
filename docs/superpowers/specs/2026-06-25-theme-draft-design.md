# Theme Draft Mode — Design Spec

**Date:** 2026-06-25
**Status:** Draft (awaiting owner review)
**Author:** Brainstorm session (Sulman + Claude)

## Summary

A new draft mode, `theme`, that sits alongside the existing booster draft. Instead of
shared booster packs rotating between seats, **each player drafts privately from their own
theme-restricted pool** (e.g. Blue-Eyes, Dark Magician, Stun). Each round players are shown
**a host-configured number of choices** (`themePackSize`, default 3 but the admin sets any X)
and pick one at a time until they have a 40-card main deck, then — **only if the host enables
it** — a shorter phase for a ~15-card Extra Deck. "Multiplayer" means everyone is in the same draft
room on a shared pick timer, drafting **simultaneously**, then plays each other afterward.
The draft scales to **as many players as the host wants, up to the number of curated themes** —
one distinct theme per player by default.

The goal: keep the fun decision-making of drafting while guaranteeing **no deck is wildly
overpowered**, because every player's pool is a curated, roughly power-balanced theme.

## Goals

- A `theme` draft mode reusing the existing draft lifecycle, pick UI, bots, timer, and
  tournament/season integration as much as possible.
- Themes are **archetype core + a curated staple layer**, seeded from the YGOPRODeck API and
  trimmable by an admin (the "hybrid" model) — e.g. an archetype theme like **Blue-Eyes**.
  Non-archetype strategies (e.g. **Stun**) are hand-built themes using the same structure.
- **Admin authoring is fully flexible**: an admin can build a theme **from scratch** (card-by-card
  *or* by **importing card passcodes**, exactly like the My Cubes editor), seed one **from a
  ygoprodeck archetype** and then **add/remove any cards** on top of it, or **merge** API-pulled
  cards with hand-picked customs in the same theme. A seeded theme is just a starting point,
  never a locked list.
- **The theme editor reuses the full My Cubes creation screen** (`CardPoolEditor`) — every
  feature there (passcode import, file upload, fuzzy single-card add, grid preview with
  multiplicity) is useful here, so we extend it rather than rebuild.
- **Number of choices per pick is admin-configurable** (`themePackSize`), not fixed at 3. The
  default is 3 but the host sets any X when creating the draft.
- Host-configurable theme assignment: the host curates a pool of **X allowed themes** (typically
  one per archetype). **Player count can be as many as you want, up to the number of curated
  themes** — by default every player holds a distinct theme. Each player's theme is either
  **player-picked** (they choose from the pool), **randomly assigned** by the admin from the
  pool, or **explicitly host-assigned**.
- A `burnUnpicked` toggle controlling whether unpicked choices are discarded (draft-authentic,
  needs large pools) or returned to the pool (guarantees completion, friendlier to small
  archetypes).
- **Main deck + optional Extra Deck**: draft 40 main-deck cards, then — only if the host
  enables the Extra phase — a short second phase to draft ~15 Extra Deck cards from the theme's
  Extra pool. The host can turn the Extra phase off entirely for main-deck-only drafts.
- Fully testable **solo with the existing draft bots** before real players are involved.

## Non-goals (v1)

- Bots that auto-play/auto-report matches. The existing bot functionality covers drafting
  only; match simulation is a documented follow-up (see "Future work").
- Deck legality enforcement beyond deck-size limits (no banlist-count enforcement inside a
  drafted deck — the *pool* is already archetype-curated by the admin).
- Side decks, deck import/export to external formats (YDK), or in-app dueling.
- Changing the booster draft mode's behavior.

## Background — what we reuse

Verified against the current code:

- **Draft lifecycle** (`packages/shared/src/services/drafts.ts`): `create`, `join`, `start`,
  `currentPackOptions`, `pickCard`, `expireCurrentPickStep`. State advances via
  `current_wave_number` and `current_pick_step` on the `drafts` row.
- **Pick UI** (`packages/web/app/(app)/draft/[slug]/page.tsx`): `<CardGrid>` renders the
  player's `currentPack`, `<PoolPanel>` shows cards already picked, `<TimerBar>` shows the
  deadline, `<SeatList>` shows other players' pick status. The page reads `currentPack` from
  `GET /api/drafts/[slug]`.
- **Cube / pool editor UI** (`packages/web/src/components/cubes/card-pool-editor.tsx`, the My
  Cubes creation screen) + `parseCustomCardIds` (`packages/web/src/lib/custom-card-pool.ts`) +
  `POST /api/cards/resolve`: passcode import (paste **and** `.txt` upload, repeats preserved,
  invalid codes flagged), fuzzy single-card add with hover preview, a card grid with
  per-card multiplicity and click-to-remove, unknown-ID flagging, and a local cards cache. The
  theme editor **extends this component** (see Host & player experience).
- **Bots** (`packages/web/app/api/drafts/[slug]/join-bot/route.ts`, dev-only via
  `NODE_ENV !== "production"`): a bot is a `players` row with `discord_user_id` prefixed
  `bot_player_dev_`. There is **no `is_bot` column**. Bot picks reuse the auto-pick path:
  - The web pick route (`api/drafts/[slug]/pick/route.ts`) auto-picks for any player whose
    `discord_user_id LIKE 'fake_%' OR LIKE 'bot_%'` right after a human pick.
  - `expireCurrentPickStep(draftId, now)` auto-picks a random option from each pending
    player's `currentPackOptions(...)`. The Discord `draft-timer.ts` calls it every second.
- **Config** (`packages/shared/src/types/index.ts`, `DraftConfig`): normalized by
  `normalizeDraftConfig()` with `defaultDraftConfig` in `drafts.ts`.
- **Card pool / deal**: `DraftConfig.cubeCardIds: number[]` resolved at `start`, distributed
  by `buildDeal(...)` into the `draft_deal` table, then `openWave()` reads `draft_deal` to
  populate per-pack `draft_cards`.
- **Card catalog** (`packages/shared/src/services/card-catalog.ts`): syncs from
  `https://db.ygoprodeck.com/api/v7/cardinfo.php`. `card_catalog` columns: `ygoprodeck_id,
  name, type, frame_type, effect_text, atk, def, attribute, level, image_url,
  image_url_small, card_sets_json, cached_at`. **No `archetype` column today.**
- **Integration**: `createTournamentFromDraft(...)` builds a tournament from a completed
  draft; matches feed `scoring`/`seasons`/leaderboard untouched.

## Key concept — map "theme draft" onto the existing pack model

The cleanest reuse: in theme mode, **each player gets their own private "pack" of choices each
round, and that pack never rotates to another seat.** This lets `currentPackOptions`,
`pickCard`, the `<CardGrid>` pick UI, the bots, and the timer all work with minimal change.
The differences from booster mode are localized to:

1. **Pool source** — per-player theme pools instead of one shared `buildDeal` distribution.
2. **Choice generation** — each round, deal `themePackSize` (default 3) cards from the
   player's remaining pool into their pack (no passing).
3. **Round/phase advancement** — pick exactly 1 per round; run `cardsPerPlayer` (40) main
   rounds, then (only if the host enabled the Extra phase) `extraDeckSize` (~15) extra rounds,
   then complete.
4. **Burn vs return** — what happens to the `themePackSize - 1` unpicked cards each round.

### Round/phase modeling (pin this down)

To avoid overloading existing columns, theme mode uses **`current_wave_number` as a single
global round counter** `1 .. totalRounds`, where
`totalRounds = cardsPerPlayer + (extraDeckEnabled ? extraDeckSize : 0)` (e.g. 1..55 with Extra
on, or 1..40 with Extra off). **Phase is derived**, not stored: round `r ≤ cardsPerPlayer` ⇒
`main`, else `extra`. With the Extra phase disabled there are no `extra` rounds at all.
`current_pick_step` stays `1` every round (each round is exactly one simultaneous pick per
player).

This keeps the existing machinery correct without changes:

- Each round creates **one pack per player** keyed by the round, satisfying
  `draft_packs`'s `unique (draft_id, wave_number, origin_seat_index)` (one pack per seat per
  round).
- `currentPackOptions` already filters `draft_cards` by `wave_number = current_wave_number`,
  so it returns the player's current `themePackSize`-card choice set unchanged.

## Configuration — `DraftConfig` additions

New optional fields (all backward-compatible; absent ⇒ booster mode behaves as today):

```ts
export interface DraftConfig {
  // ...existing fields...

  /** Draft mode. Absent or "booster" => existing behavior. */
  mode?: "booster" | "theme";

  // ----- theme mode -----
  /** Theme ids the host allows for this draft (the "X" pool). */
  allowedThemeIds?: number[];
  /** How each player's theme is chosen. Default "player_pick". */
  themeSelection?: "host_assigned" | "random" | "player_pick";
  /** Optional explicit seat/player -> theme map for host_assigned. */
  themeAssignments?: Record<string /* playerId */, number /* themeId */>;
  /** If true (default), every player gets a distinct theme, so max players =
   *  allowedThemeIds.length. If false, themes may repeat and the player cap is lifted. */
  uniqueThemes?: boolean;
  /** Number of choices shown per pick. Admin-set; default 3, any X >= 2. */
  themePackSize?: number;
  /** Main deck size to draft. Reuses cardsPerPlayer; default 40. */
  // cardsPerPlayer (existing)
  /** Whether to run the Extra Deck draft phase at all. Default true.
   *  When false, the draft is main-deck-only and completes after cardsPerPlayer rounds. */
  extraDeckEnabled?: boolean;
  /** Extra Deck cards to draft in phase 2 (ignored when extraDeckEnabled is false). Default 15. */
  extraDeckSize?: number;
  /** If true, the (themePackSize - 1) unpicked cards are discarded each round.
   *  If false (default), they return to the player's pool. */
  burnUnpicked?: boolean;
  // pickSeconds (existing) reused for both phases.
}
```

Defaults added to `defaultDraftConfig` / `normalizeDraftConfig()` for theme mode:
`themePackSize: 3`, `extraDeckEnabled: true`, `extraDeckSize: 15`, `burnUnpicked: false`,
`themeSelection: "player_pick"`, `uniqueThemes: true`, `cardsPerPlayer: 40`.

## Data model — a "Theme" is a reusable, structured pool

**Mechanically a theme is the same shape as a cube** — a curated list of card-catalog IDs.
Today a cube is just a `number[]` of card IDs consumed by `analyzeCube(cubeCardIds)` /
`buildDeal(cubeCardIds)` in `cube.ts`; a theme is that same list, persisted in `theme_cards`
(split main/extra) and **seeded by pulling one or more archetypes' full card lists** from
`cardinfo.php?archetype=`. So "admin selects a few archetypes → pull all their cards → draft
from them" is exactly the cube flow, just sourced from archetypes instead of hand-listed IDs.

Themes are persisted (not embedded per-draft) so they accumulate and are reusable. New schema
(all via `addColumnIfMissing` / `create table if not exists` in `schema.ts`):

```sql
-- The reusable theme definition.
create table if not exists themes (
  id integer primary key autoincrement,
  guild_id text not null,
  name text not null,                 -- "Blue-Eyes", "Stun"
  archetype text,                     -- primary seeding archetype (display only); null for custom
                                      --   or multi-archetype themes — the cards live in theme_cards
  banlist text,                       -- optional "tcg" | "ocg" | null banlist used when seeding
  created_by_user_id text not null,
  created_at text not null,
  updated_at text not null
);

-- Cards belonging to a theme, split into main vs extra pool.
create table if not exists theme_cards (
  theme_id integer not null references themes(id),
  catalog_card_id integer not null references card_catalog(ygoprodeck_id),
  pool text not null,                 -- "main" | "extra"
  max_copies integer not null default 3,
  primary key (theme_id, catalog_card_id)
);

-- Per-player theme assignment for a theme draft.
create table if not exists draft_player_theme (
  draft_id integer not null references drafts(id),
  player_id integer not null references players(id),
  theme_id integer not null references themes(id),
  primary key (draft_id, player_id)
);
```

Add to `card_catalog` (so we can filter the cache locally and seed pools):

```sql
alter table card_catalog add column archetype text;  -- via addColumnIfMissing
```

Optional convenience cache of the archetype list for the picker (else fetch on demand):

```sql
create table if not exists archetypes (
  name text primary key,
  synced_at text not null
);
```

**Reuse for per-round choices:** theme mode continues to use the existing `draft_packs` /
`draft_cards` / `draft_picks` tables. Each round, one pack per player is created with
`origin_seat_index = current_holder_seat_index = that player's seat` and a `pass_direction`
that never moves it. `draft_deal` is **not** used in theme mode (pools are per-player and
generated round-by-round from the theme + a seeded RNG).

## Card catalog & theme seeding (the YGOPRODeck side)

**Data source.** v1 uses **YGOPRODeck only** (`db.ygoprodeck.com/api/v7`) — it has the best
archetype support (`archetypes.php` + `?archetype=`), is free, and is what `card-catalog.ts`
already uses. Other sources were evaluated and **deferred**: cardcluster.com and Format Library
have no public API, and [YGOJSON](https://github.com/iconmaster5326/YGOJSON) (MIT bulk JSON
mirror) is noted only as a possible future robustness layer — not used in v1.

API levers (verified against the v7 API guide):

- `cardinfo.php?archetype=Blue-Eyes` → all cards tagged in that archetype (includes Extra Deck
  cards — we now **keep** these for the extra pool).
- `cardinfo.php?staple=yes` (optionally `&banlist=tcg`) → generic staple cards for the staple
  layer.
- **Generic Extra-Deck staples:** `cardinfo.php?type=XYZ Monster` (and `Synchro Monster`,
  `Link Monster`), optionally `&banlist=tcg`, filtered to **generic-material** monsters whose
  summoning materials are *not* archetype-locked (e.g. "2 Level 4 monsters" Rank-4 toolbox,
  generic Links/Synchros). These slot into any archetype's Extra pool and are used to **top up**
  a theme whose own Extra cards are too few. The default top-up leans on generic **XYZ** (the
  most universally castable) and adds generic Link/Synchro as needed.
- `archetypes.php` → full list of archetype names for the theme picker. The admin **multi-selects
  a few** from this flat list; each selection pulls all of that archetype's cards.
- `banlist` (optional) → restrict seeding to a legal pool. **`format` is intentionally not used** —
  themes are categorized by archetype + admin curation, not by ygoprodeck format/era.

Card catalog service changes (`card-catalog.ts`):

- Add `archetype?: string` to the `YgoprodeckCard` type and store it in `card_catalog`
  (upsert + mapping).
- Add `syncByArchetype(archetype, opts?: { banlist?: string })`: fetches the archetype's cards,
  **splits main vs extra by `isExtraDeckCard`** (do NOT strip extra-deck cards here, unlike
  `syncDraftPool`), upserts them, and returns `{ main: Card[]; extra: Card[] }`.
- Add `syncStaples(opts?: { banlist?: string })` returning staple cards (main-pool only).
- Add `syncGenericExtra(opts?: { banlist?: string; types?: ("xyz"|"synchro"|"link")[] })`
  returning **generic-material Extra-Deck** cards (default XYZ first, then Link/Synchro) for the
  Extra-pool top-up. Like `syncByArchetype`, it **keeps** extra-deck cards (does not strip them).
- Add `listArchetypes(query?)` backed by `archetypes.php` (cached in `archetypes` table).

Theme service (`packages/shared/src/services/themes.ts`, new). The authoring API treats a theme
as an **editable card set** regardless of how it was first populated — there is no difference
between a "custom" theme and an "archetype" theme after creation; both are just rows in
`theme_cards` that the admin can keep editing:

- `createFromArchetype(guildId, archetype, opts)`: seeds a theme = archetype main cards +
  optional staple layer in the main pool, archetype extra cards in the extra pool; default
  `max_copies = 3`. Persists `themes` + `theme_cards`. The result is fully editable afterward.
  **Extra-pool top-up:** when the archetype's own Extra cards fall short of the Extra-pool size
  the config needs, auto-add **generic-material Extra-Deck staples** (generic XYZ first, then
  Link/Synchro) via `syncGenericExtra` up to the needed count — so an archetype thin on its own
  Extra monsters still has enough castable Extra options. Controlled by
  `topUpExtraWithGenerics` (default `true`); generic cards are tagged in `theme_cards` (e.g.
  `source = "generic-extra"`) so the admin can see and trim them in the editor.
- `createBlank(guildId, name)`: a fully custom theme with zero cards, built up via `addCard`.
- `addCard(themeId, catalogCardId, pool, maxCopies?)` / `removeCard(themeId, catalogCardId)` /
  `setMaxCopies(...)`: the admin uses these to (a) hand-build a non-archetype theme like Stun
  card-by-card, (b) **trim**
  an archetype-seeded theme, **(c) add custom cards on top of an archetype-seeded theme**, or
  (d) **merge** more archetype/staple cards into a custom theme. Card search reuses the existing
  fuzzy lookup, and `addCard` auto-syncs the card into `card_catalog` if it is missing. So any
  theme can freely mix ygoprodeck-pulled cards and hand-picked customs.
- `importPasscodes(themeId, codes, opts?)`: the service side of the editor's passcode import —
  parse the codes (reuse `parseCustomCardIds`), auto-sync any missing cards into `card_catalog`,
  and add each, routed to main/extra by `isExtraDeckCard` unless `opts.pool` forces one. Lets an
  admin build a whole theme from a pasted/uploaded passcode list.
- `seedArchetypeInto(themeId, archetype, opts?)`: pull an archetype's cards into an **existing**
  theme (additively), for the "start custom, then bulk-add an archetype" flow.
- `listThemes(guildId)` / `getThemePools(themeId) => { main: ThemeCard[]; extra: ThemeCard[] }`.
- `analyzeTheme(themeId, config)`: validation (see "Validation").

## Engine changes (`drafts.ts`)

Branch on `config.mode === "theme"`; keep booster untouched.

- **`start(draftId)`**:
  - Resolve theme assignments per `themeSelection`:
    - `host_assigned`: read `config.themeAssignments`; require every player mapped.
    - `random`: seeded random assignment from `allowedThemeIds`. **Spread assignments across
      the allowed pool** — deal *distinct* themes to players (and to bots) as far as the pool
      size allows before repeating, even when `uniqueThemes` is false, so a draft exercises a
      variety of themes rather than clustering on one. With `uniqueThemes` true, distinct is
      required (and start fails if `allowedThemeIds.length < playerCount`).
    - `player_pick`: read claims made in the lobby (see UI); fall back to random for any
      unassigned player (covers bots — bots never pick a theme themselves).
  - Write `draft_player_theme` rows. Assign seats. Set `current_wave_number = 1` (global round
    1, phase derived = main), `current_pick_step = 1`, status `active`, deadline =
    now + `pickSeconds`.
  - Generate round-1 packs via `openThemeRound(draftId)`.
- **`openThemeRound(draftId)`** (new, replaces `openWave` for theme mode): for each active
  player, draw `themePackSize` distinct cards from their remaining pool (a seeded shuffle of
  their theme pool expanded by `max_copies`, for the current derived phase main/extra), create
  a private pack (`origin_seat_index = current_holder_seat_index = player's seat`,
  `wave_number = current_wave_number`) + its `draft_cards`. The player's "remaining pool" is
  the theme pool minus already-picked cards, minus burned cards (if `burnUnpicked`). **If fewer
  than `themePackSize` cards remain** (a thin Extra pool that passed only as a warning), deal
  whatever is left; if **zero** remain for that player this round, the player's deck just ends
  shorter than the target (no error) — this is the graceful-degradation path the Extra-pool
  warning anticipates.
- **`pickCard(...)`**: signature unchanged, but two booster assumptions must be made
  theme-aware (NOT just "add branching"):
  - **Finish gate.** Booster `pickCard` sets `finished_at` and rejects further picks once
    `pick_count >= cardsPerPlayer` (40). In theme mode the per-player total is
    `totalRounds = cardsPerPlayer + (extraDeckEnabled ? extraDeckSize : 0)` (~55 with Extra on,
    40 with it off), so this gate must compare against `totalRounds` in theme mode, or every
    Extra-Deck pick is rejected (Extra on) / the draft never finishes correctly.
  - **Advancement.** If `burnUnpicked`, mark the other options in the pack burned for the
    player. When **all active players have picked the current round**, advance the global
    round: `current_wave_number++` and `openThemeRound`, until `current_wave_number >
    totalRounds`, then **complete** the draft. Phase (main vs extra) is derived from the round
    number; no separate phase column. `pick_step` stays `1`.
- **`expireCurrentPickStep(...)`**: unchanged — already auto-picks a random option from each
  pending player's `currentPackOptions`. Works for theme mode bots and humans who time out.
- **`currentPackOptions(draftId, playerId)`**: unchanged — returns unpicked cards in the
  player's current pack, which in theme mode is their private `themePackSize`-card choice set.

The seeded RNG reuses `mulberry32` / `seededShuffle` from `cube.ts` so a draft is reproducible
(seed derived from `draftId` + `playerId` + round).

## Validation (`analyzeTheme`)

Per theme, given `themePackSize`, `cardsPerPlayer`, `extraDeckSize`, `burnUnpicked`, and
`extraDeckEnabled` — counting copies (`max_copies`) — the required pool size depends on
`burnUnpicked`:
- **burnUnpicked = true** → `cardsPerPlayer * themePackSize` for main (e.g. 40 × 3 = 120), and
  `extraDeckSize * themePackSize` for extra.
- **burnUnpicked = false** → `cardsPerPlayer + (themePackSize - 1)` for main (e.g. 42), and
  `extraDeckSize + (themePackSize - 1)` for extra.

Severity differs by pool:
- **Main pool short ⇒ hard `error`.** The main deck can't be filled, so the draft cannot start
  with this theme. (Fix by adding the staple layer or more cards in the editor.)
- **Extra pool short ⇒ try `syncGenericExtra` top-up first** (when `extraDeckEnabled` and
  `topUpExtraWithGenerics`). If the pool still falls short after top-up, that is a **non-blocking
  `warning`, not an error** — the draft may proceed; the engine simply deals fewer than
  `themePackSize` Extra choices when a player's Extra pool runs low (the player may end with
  fewer than `extraDeckSize` Extra cards).
- Extra-pool checks are **skipped entirely when `extraDeckEnabled` is false** (main-deck-only).
- **Balance warning** if a theme is much smaller/larger than its peers in `allowedThemeIds`.
  Surfaced when the host builds the allowed pool.

**Start-time pre-flight.** On Start, after themes are assigned, the flow re-runs `analyzeTheme`
for every *assigned* theme under the chosen config and:
- **blocks** start on any hard `error` (main-pool shortfall, or `uniqueThemes` with fewer
  allowed themes than players), mirroring how `analyzeCube` gates booster drafts today;
- **surfaces a dismissible warning** listing any theme still short on Extra after top-up, so the
  host can **re-roll the assignment** (re-run random selection), **swap or edit the theme**,
  **turn the Extra phase off**, or **proceed anyway**. This is the moment the host learns a
  random assignment landed on a thin theme and can re-roll before committing.

## Host & player experience

**Draft-type chooser (new in-between step).** Today the **+ New Draft** button on the Drafts
page (`packages/web/app/(app)/drafts/page.tsx`) links straight to `/drafts/new`, which renders
the single cube `CreateDraftForm`. With two modes, **+ New Draft** now lands on a chooser screen
that asks **which kind of draft** to create — **Cube Draft** or **Theme Draft** — each as a
card/button with a one-line description, then routes into the matching create flow:
- **Cube Draft** → the existing form (unchanged), moved to its own route (`/drafts/new/cube`).
- **Theme Draft** → the new theme create form (`/drafts/new/theme`).

`/drafts/new` itself becomes the chooser. This keeps each flow's form focused (no giant
mode-toggle form) and leaves the cube experience byte-for-byte the same.

**Create — Theme Draft (host, web):** the theme create form. Host sets player count (capped at
the number of curated themes when `uniqueThemes` is on — the default), `pickSeconds`,
**main-deck size** (`cardsPerPlayer`, exposed in the form — already supported; default 40, so
hosts can run fast 30-card games or full 40), `burnUnpicked`, `themePackSize` (admin-chosen
choices-per-pick, default 3), an **Extra Deck phase on/off toggle** (`extraDeckEnabled`) with
`extraDeckSize` (default 15) shown only when on, `themeSelection`, `uniqueThemes`, and curates
`allowedThemeIds` (pick X themes from the guild's saved themes). It POSTs a `DraftConfig` with
`mode: "theme"` to the existing `/api/drafts` create endpoint.

**Theme editor (admin):** built on the existing **`CardPoolEditor`** (the My Cubes creation
screen, `packages/web/src/components/cubes/card-pool-editor.tsx`) and **inherits all of its
features**, since they're equally useful for themes:

- **Import card codes (passcodes)** — paste a comma/newline-separated list **or upload a `.txt`
  file**, parsed by the existing `parseCustomCardIds`; repeats preserved, invalid codes flagged.
  This is how an admin **builds a custom theme/archetype entirely from scratch**, identical to
  building a cube.
- **Add single card** by fuzzy name search with the hover-preview popup (`/api/cards/resolve`),
  one copy per click.
- **Card grid preview** with quantities, click-a-card-to-remove-one-copy, unknown-ID flagging,
  the local cards-cache, and dirty / unsaved-changes tracking + save.

Theme-specific additions layered on top of the cube editor:

- **Two pools (main / extra)** shown side-by-side. Imported/added cards are auto-routed by
  `isExtraDeckCard` (Extra-Deck frame types → extra pool); the admin can move a card between
  pools.
- **Per-card `max_copies`** — the cube editor's finite multiplicity, surfaced as the
  `theme_cards.max_copies` field (default 3).
- **Seed-from-archetype** and **bulk-add-an-archetype** buttons, so a theme can start from an
  archetype pull and then be edited card-by-card (or the reverse: start custom, then bulk-add an
  archetype).

Saved themes are reusable across drafts.

**Lobby:** players join. Theme selection UI depends on `themeSelection`:
- `player_pick`: each player chooses a theme from the allowed pool (claimed themes greyed out
  if `uniqueThemes`).
- `host_assigned`: host assigns a theme to each joined player (stored in `themeAssignments`,
  keyed by `playerId`; seats are assigned later at `start`).
- `random`: themes are hidden until start, then revealed.

**Theme preview (lobby).** Each allowed theme shows a small **preview**: name, archetype tag,
main/extra pool sizes, and a few sample card images (reuse the existing card-image rendering).
This makes `player_pick` and `host_assigned` informed choices instead of blind ones, and lets
the host eyeball rough balance across the allowed pool before starting. For `random`, the
preview is hidden until reveal.

Bots are added via the **existing** dev-only `join-bot` endpoint; they receive a random theme
from the allowed pool at start regardless of mode.

**Draft:** reuses the existing pick screen. `<CardGrid>` shows the player's `themePackSize`
choices (3 by default), `<PoolPanel>` shows their growing deck, `<TimerBar>` the shared
deadline, `<SeatList>` who has picked. A small **phase indicator** (e.g. Main 12/40, then
Extra 3/15 when the Extra phase is on) is added; with Extra off it shows Main progress only.

**Complete:** each player has a `cardsPerPlayer`-card main deck plus an optional ≤`extraDeckSize`
Extra deck (when the Extra phase was enabled) as a **decklist**, viewable/exportable (reuse the
existing pool route/panel; add an Extra section, hidden when Extra was off). Host can spin up a
tournament via the existing `createTournamentFromDraft`; results feed ELO/season/leaderboard
with no changes.

## WebSocket events

Reuse existing draft events (`packages/shared/src/ws/events.ts`): `pick`, `status`, `seats`,
`resync`, `complete`. Add a `phase` field (`"main" | "extra"`) to the resync/status payloads so
clients can render the phase indicator. No new event types required.

## Bot-based testing (solo)

Reuses existing functionality end-to-end for the **draft**:

1. Host creates a theme draft and curates the allowed themes.
2. Host adds N bots via the existing `join-bot` endpoint (dev-only).
3. Host starts; bots get random themes from the allowed pool, **spread to be distinct** where
   the pool allows, so one bot run exercises several theme pools at once.
4. The host clicks through their own picks (the web pick route auto-picks for `bot_`/`fake_`
   players after each human pick), or the Discord `draft-timer` drives auto-picks on the
   deadline. Either way a full main (+ Extra, if the host enabled it) theme draft completes
   unattended.
5. Inspect the resulting per-player decklists.

This validates pool generation, choice dealing, burn/return, phase transition, and completion
without real players. (Auto-reported bot **matches** are out of scope — see Future work.)

## Testing strategy

- **Unit (shared):** `themes` service (seeding split main/extra, max_copies, Extra top-up with
  generics), `analyzeTheme` thresholds for both burn settings **and both `extraDeckEnabled`
  values** (Extra-pool checks skipped when off; soft warning vs hard error), per-player pool
  generation determinism (seeded), phase transition math (40 main → 15 extra → complete, and
  the **main-only** 40 → complete path), `totalRounds` for a non-default `themePackSize`, burn
  vs return pool accounting, and the graceful degraded-deal path (fewer than `themePackSize`
  remaining). Card-catalog `syncByArchetype`/`syncGenericExtra` mapping (archetype captured,
  extra kept).
- **Integration (shared):** full theme draft via the service layer with simulated picks
  (2–4 players), asserting each ends with `cardsPerPlayer` main + ≤`extraDeckSize` extra and no
  duplicate beyond `max_copies`. Cover both an Extra-on draft and an **Extra-off (main-only)**
  draft, and at least one run with `themePackSize ≠ 3`.
- **Web:** create-form validation, lobby theme claim (unique vs not), pick route auto-pick of
  bots in theme mode, decklist endpoint returns main+extra, and theme-editor passcode import
  (paste + `.txt` upload) routing cards to main/extra by `isExtraDeckCard`.
- **Manual/bot:** the solo bot run above.

Follow existing patterns: `npx vitest run packages/shared/tests/...` and
`-c packages/web/vitest.config.ts` for web.

## Phasing

- **Phase 1 — Catalog & themes:** `card_catalog.archetype`, `syncByArchetype`/`syncStaples`/
  `syncGenericExtra`/`listArchetypes`, `themes`/`theme_cards` schema (with generic-extra
  tagging) + `themes` service (custom + archetype + `seedArchetypeInto` + Extra top-up) +
  `analyzeTheme` (hard main-error / soft extra-warning) + `importPasscodes`. Admin theme editor
  (extend `CardPoolEditor` — passcode import/upload, fuzzy add, grid — with the main/extra split
  and per-card `max_copies`). Unit tests.
- **Phase 2 — Engine:** `DraftConfig` additions, `mode === "theme"` branch in `start`/
  `openThemeRound`/`pickCard`, per-player pools, burn/return, phase transition. Integration
  tests with simulated picks.
- **Phase 3 — UI & assignment:** draft-type chooser (Cube vs Theme) at `/drafts/new` + theme
  create form (main-deck size + Extra toggle exposed), lobby
  theme selection (3 modes) with **theme preview**, distinct-spread random/bot assignment,
  start-time pre-flight (block on error, warn-to-reroll on thin Extra), phase indicator,
  decklist view with Extra section. Bot solo run.
- **Phase 4 — Polish:** WS `phase` field, validation surfacing in the host UI, tournament
  hand-off verification.

## Future work (explicitly out of scope for v1)

- Bots that auto-report match results so the **whole** loop (draft → tournament → ELO/season)
  runs unattended. No such functionality exists today; it would be a separate `match`
  simulation utility.
- Theme balance tooling (auto power-scoring via views/upvotes/rarity from `misc=yes`).
- **Player re-roll / mulligan tokens** — give each player N re-rolls of their current pick
  choices to soften bad RNG draws (especially with burn off). Fun, but adds per-player state to
  the engine; deferred to keep v1 simple.
- Side decks, YDK import/export, per-deck banlist-count enforcement.

## Open decisions (resolved this session)

- Multiplayer **simultaneous** drafting (not passing packs). ✔
- Themes = **hybrid**: archetype core auto-seeded + staple layer, admin-trimmable; non-archetype
  themes hand-built. ✔
- **Main + optional small Extra Deck** (~15) via a second draft phase the **host can toggle
  on/off**; off ⇒ main-deck-only draft. ✔
- **Choices-per-pick is admin-set** (`themePackSize`), not fixed at 3. ✔
- **Admin can build fully custom themes and freely edit archetype-seeded ones** (mix API +
  custom cards). ✔
- **Burn is a toggle**, default **off** (return unpicked) for completion safety. ✔
- Theme assignment is **host-configurable**: host curates X allowed themes; assignment is
  player-pick (players choose), random, or explicit host-assign. ✔
- **Player count scales up to the number of curated themes**, one distinct theme per player by
  default (`uniqueThemes` defaults **on**); turning it off lifts the cap and allows repeats. ✔
- Testing uses the **existing draft bots**; match auto-play is deferred. ✔
