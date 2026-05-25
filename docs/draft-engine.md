# Draft Engine Guide

How the draft engine works: the vocabulary, the lifecycle, the deal algorithm, and the
data model. The authoritative logic lives in `@yugidraft/shared`
(`packages/shared/src/services/drafts.ts` and `cube.ts`); this guide is the map, not the
territory — when in doubt, read those two files.

## Mental model

A draft turns a **Cube** (a weighted bag of cards) into a **Deal** (a fixed, pre-computed
sequence of packs), then walks players through that deal one **Pick step** at a time. The
whole deal is computed and persisted once, at start — picking is just consuming it. This
makes the draft deterministic given its inputs, replayable, and safe to resume after a
crash: the engine never re-rolls cards mid-draft.

## Vocabulary

These terms are load-bearing — code, columns, and tests use them precisely. (This section
fills a gap in the root `CONTEXT.md`, which currently only defines tournament/notification
language.)

- **Pool** — the eligible card set *before* multiplicity is applied: the result of
  resolving a draft's config (set names, custom passcodes, include/exclude name lists)
  against `card_catalog`, with Extra Deck cards filtered out. See
  `catalogCardIdsForDraft`.
- **Cube** — the Pool *with multiplicity*: a flat `number[]` of catalog card IDs where a
  card appearing `n` times means "authored weight `n`". Built by `resolveCubeCardIds`.
  Stored on the draft config as `cubeCardIds` (legacy drafts used `poolCardIds`; both are
  read, `cubeCardIds` wins).
- **Deal** — the fully materialized sequence of packs for the whole draft, computed by
  `buildDeal` and persisted flat in the `draft_deal` table (one row per card slot, ordered
  by `position`). This is the source of truth for what every pack contains.
- **Wave** — one full pass of packs around the table. Each player opens one fresh pack per
  wave; a draft has `W = packsPerPlayer` waves. (Historically called "pack round" — the
  TypeScript surface still exposes `currentPackRound` / `packRound` for back-compat, but
  the DB column is `wave_number`.)
- **Pack** — the cards one player is currently choosing from. There are `P` packs per wave
  (one per seat). Packs are passed seat-to-seat between pick steps.
- **Pick step** — one synchronized round of choices: every still-drafting player picks one
  card from their current pack, then packs advance one seat. A wave has `k` pick steps
  (where `k = packSize`).
- **Seat** — a player's fixed position at the table (`seat_index`, 0-based), assigned at
  start. Determines pack-passing order.

### Size symbols (used throughout the code and tests)

| Symbol | Meaning | Source |
|--------|---------|--------|
| `P` | players | count of `draft_players` at start |
| `W` | waves | `config.packsPerPlayer` |
| `k` | pack size | `config.packSize` |
| `C` | cards per wave = `P × k` | derived |
| `S` | total deal slots = `P × W × k` | derived |

A pack at flat index `i` in the deal belongs to wave `floor(i / P)`, seat `i % P` — the
deal is laid out **wave-major, then seat-major**. `buildDeal` emits packs in this order and
`openWave` slices the `draft_deal` table assuming it.

## Lifecycle

```
pending ──start()──> active ──(last card picked)──> completed
   │                   │
   └────cancel()───────┴────cancel()──> cancelled
```

- **pending** — accepting players (min 2 to start). Config can still be edited.
- **active** — deal is computed and persisted; wave 1 is open; players are picking.
- **completed** — every active player has finished (`pick_count >= cardsPerPlayer`) or the
  last wave's cards are exhausted.
- **cancelled** — aborted by the organizer; deal/picks may exist but are inert.

### Start (`startDraft`)

A single transaction:

1. Assert `pending` and `P >= 2`.
2. Assign `seat_index` 0..P-1 by join order.
3. Resolve the Cube (`cubeCardIds` → `poolCardIds` → recompute from catalog).
4. `analyzeCube(cube, P, W, k)` — **authoritative feasibility gate**. Throws if not `ok`.
5. `buildDeal(...)` → persist every card slot into `draft_deal` (flat, by `position`).
6. `openWave(draftId, 1, P, config)` — materialize wave 1's packs and cards.
7. Flip `status='active'`, set `current_wave_number=1`, `current_pick_step=1`, and the
   first `pick_deadline_at`.

> The web create/edit routes also call `analyzeCube`, but there it is **advisory only** —
> it surfaces `warnings`/`errors` in the response without blocking, because the Cube can
> still grow before start. `startDraft` is the one true gate.

## The deal algorithm

### `analyzeCube(cubeCardIds, players, waves, packSize)`

Returns `{ ok, errors[], warnings[] }`.

- **Error (blocks start):** distinct card count `< C = players × packSize`. A wave needs
  `C` *distinct* cards (no card may appear twice in the same wave), so fewer than `C`
  distinct cards is infeasible. The message suggests adding cards or lowering pack size.
- **Warning (non-blocking):** any card authored with more copies than there are waves —
  it will be capped at `W` (one copy per wave).

### `buildDeal(cubeCardIds, { players, waves, packSize, draftId })`

Returns `number[][]` — `P × W` packs of `k` cards each, deterministic in `draftId`. Steps:

1. **Count** authored copies per card; shuffle the distinct IDs with a `draftId`-seeded
   PRNG (`mulberry32` / `seededShuffle`) for a stable order.
2. **Budget** each card at `min(count, waves)` (the per-card cap is one copy per wave),
   then **trim or pad to exactly `S` slots**:
   - *Trim* (total > S): repeatedly drop a copy from the least-budgeted card first, so
     singletons fall away before staples lose weight.
   - *Pad* (total < S): round-robin `+1` across cards that still have headroom
     (`budget < waves`), spreading invented copies. (Unreachable once `analyzeCube`
     passes, but kept for safety.)
3. **Assign** each card's copies to *distinct* waves, most-constrained-first (highest
   budget placed first), always filling the waves with the most remaining capacity (each
   wave capped at `C`). This guarantees **no card appears twice in one wave** — the whole
   point of the feature.
4. **Distribute** each wave's `C` distinct cards round-robin into its `P` packs of `k`,
   using a per-wave seeded shuffle (`draftId + w + 1`).

The determinism (seed = `draftId`) means a given draft always deals the same packs — handy
for debugging and for the legacy/resume guarantees.

## Wave opening and pack passing

### `openWave(draftId, waveNumber, playerCount, config)`

For each seat, slices the wave's packs out of `draft_deal` by `position`
(`globalPack = (waveNumber-1) × P + seat`; slot range
`[globalPack × k, (globalPack+1) × k)`), inserts a `draft_packs` row, and inserts that
pack's `draft_cards`. `pass_direction` alternates per wave when
`config.alternatePassDirection` is set (odd waves pass `+1`, even waves `-1`) — the classic
"pass left, then pass right" booster-draft cadence.

> **Legacy path:** drafts that were already `active` before the Cube/Deal model shipped have
> no `draft_deal` rows. `openWave` detects this (`select 1 from draft_deal ... limit 1`) and
> falls back to the old random-per-slot generator for their remaining waves. New drafts
> always use the deal.

### Picking (`pickCard`)

One transaction per pick. Validates in order: draft is active, player joined, player not
finished and hasn't already picked this step, the card is in the current wave, the player
holds the pack the card is in, and the card is unpicked. Then it marks the card picked,
inserts a `draft_picks` row, and bumps `pick_count` (stamping `finished_at` when the player
reaches `cardsPerPlayer`).

After the pick it checks **step completion** — when every still-active player has picked the
current step:

- If the wave still has unpicked cards → **advance packs** one seat (per each pack's
  `pass_direction`, skipping emptied packs) and increment `current_pick_step`.
- If the wave is exhausted and it was the last wave (`currentPackRound >= W`) →
  `status='completed'`.
- If the wave is exhausted but more waves remain → `openWave(next)` and reset to step 1.

Each transition resets `pick_deadline_at` to `now + pickSeconds`.

### Auto-pick and expiry (`expireCurrentPickStep`)

The bot's draft timer polls active drafts every second and calls `expireCurrentPickStep`.
If the deadline has passed, every player who hasn't picked the current step gets a random
unpicked card from their pack auto-picked (`pick_method='auto'`). This keeps a slow or
absent player from stalling the table. `recordManualPick` runs an expiry sweep first so a
human pick races cleanly against the deadline.

## Config (`DraftConfig`)

Resolved through `normalizeDraftConfig`; defaults in `defaultDraftConfig`:

| Field | Default | Meaning |
|-------|---------|---------|
| `packSize` (`k`) | 8 | cards per pack / pick steps per wave |
| `packsPerPlayer` (`W`) | 5 | number of waves |
| `cardsPerPlayer` | 40 | picks until a player is "finished" |
| `pickSeconds` | 45 | per-step timer before auto-pick |
| `alternatePassDirection` | true | reverse pass direction each wave |
| `randomizeSeats` | false | shuffle seat assignment at start |
| `setNames` / `customCardIds` / `includeNames` / `excludeNames` | — | Pool selection inputs |
| `cubeCardIds` | — | persisted resolved Cube (legacy: `poolCardIds`) |

## Data model

| Table | Role |
|-------|------|
| `drafts` | one row per draft; status, config JSON, `current_wave_number`, `current_pick_step`, `pick_deadline_at` |
| `draft_players` | membership + `seat_index`, `pick_count`, `finished_at` (PK `draft_id, player_id`) |
| `draft_deal` | the materialized deal: one row per card slot, ordered by `position` (PK `draft_id, position`) |
| `draft_packs` | one row per pack per wave: `wave_number`, `origin_seat_index`, `current_holder_seat_index`, `pass_direction` |
| `draft_cards` | the cards inside each pack: `wave_number`, `draft_pack_id`, `catalog_card_id`, `position`, `picked_by_player_id` |
| `draft_picks` | the pick log: `(draft_id, player_id, wave_number, pick_step)` unique; `pick_method` manual/auto |

### Migration notes

`migrate(db)` carries two idempotent renames for this engine, safe to run every startup:

- `draft_cube` → `draft_deal` (copy rows, drop old table).
- `draft_packs.pack_round` → `wave_number` (`alter table ... rename column`, guarded by a
  `pragma table_info` check).

Older `draft_cards` / `draft_picks` already shipped with `wave_number`, so only those two
objects needed renaming.

## Where to look

- `packages/shared/src/services/cube.ts` — `analyzeCube`, `buildDeal`, the seeded PRNG.
- `packages/shared/src/services/drafts.ts` — `startDraft`, `openWave`, `pickCard`,
  `expireCurrentPickStep`, Pool/Cube resolution.
- `packages/shared/src/db/schema.ts` — table definitions and the rename migrations.
- `packages/shared/tests/services/cube.test.ts` — deal feasibility and no-dup-per-wave
  invariants.
