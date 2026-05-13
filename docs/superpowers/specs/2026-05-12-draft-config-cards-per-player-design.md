# Draft config: explicit "cards per player" + adjustable pack size

## Problem

The draft creation form (and the pending-draft manage view) currently exposes
"Packs per Player" and derives pack size as `ceil(40 / packsPerPlayer)`. Two
problems:

- Pack size is not adjustable. Organizers want bigger packs at the start of a
  draft (e.g. 15 cards per pack) while each player still drafts the same total.
- The "40 cards drafted per player" total is hardcoded in the draft engine, so
  even if the form let you change it, the engine would ignore it.

We want the form to look like the original bot's "Start Game" dialog: a left
input for **rounds / number of cards each player drafts** and a right input for
**size of each pack**, plus pick duration. The two checkboxes ("Alternate pass
direction", "Randomize seats") go away — drafts always randomize seating.

## Design

### Schema / engine (`packages/shared`)

- Add `cardsPerPlayer?: number` to `DraftConfig` (`src/types/index.ts`).
- `defaultDraftConfig` in `src/services/drafts.ts` gains `cardsPerPlayer: 40`,
  and `normalizeConfig` (or the equivalent merge) carries it through.
- In `drafts.ts`, replace the two hardcoded `40`s in `pickCard` — the
  "player has already finished" guard (`pick_count >= 40`) and the
  `finished_at` SQL `case` (`pick_count + 1 >= 40`) — with the per-draft
  `config.cardsPerPlayer ?? 40`.
- Nothing else changes. The wave loop still ends when
  `currentPackRound >= packsPerPlayer`. If the last pack has more cards than the
  player still needs, the player simply stops at `cardsPerPlayer` and the leftover
  cards in that wave stay unpicked; the draft completes once every player has
  finished (existing `remainingPlayers.length === 0` path).

### Form fields (`DraftConfigFields`, shared by Create form + Manage view)

`DraftConfigFieldsValue` replaces `packsPerPlayerText` with
`cardsPerPlayerText` and adds `packSizeText` (string state, consistent with the
existing numeric-as-string pattern):

| Field | Label | Default | Range |
|---|---|---|---|
| Cards per player | "Rounds — cards drafted per player" | `40` | `40`–`60` |
| Size of each pack | "Size of each pack" | `15` | `5`–`{cardsPerPlayer}` |
| Pick duration | "Pick duration (seconds)" | `45` | `5`–`300` |

- Pack size must never exceed cards per player. `validateFields` enforces
  `packSize <= cardsPerPlayer` (and the numeric ranges above).
- Derived (display only): `packsPerPlayer = max(1, ceil(cardsPerPlayer / packSize))`.
- Helper line under the two number inputs:
  *"Each player drafts {cardsPerPlayer} cards across {packsPerPlayer} pack(s) of {packSize} — extra cards in the last pack are left out."*
- Remove the "Alternate pass direction" and "Randomize seats" checkboxes from
  the rendered form entirely.

### Wiring (`draft-config-fields.tsx` helpers)

- `configFromFields(fields)` returns:
  `{ setNames, customCardIds, includeNames: [], excludeNames: [], cardsPerPlayer, packSize, packsPerPlayer: max(1, ceil(cardsPerPlayer / packSize)), pickSeconds, alternatePassDirection: true, randomizeSeats: true }`.
  Values are clamped to the ranges above (defensive, mirrors current clamping).
- `fieldsFromConfig(config, customCardIds?)` reads `config.cardsPerPlayer ?? 40`
  and `config.packSize ?? 15` back into the string fields.
- `CreateDraftForm` initial `fields` state: `cardsPerPlayerText: "40"`,
  `packSizeText: "15"`, `pickSecondsText: "45"` (drops `alternatePass` /
  `randomizeSeats` keys).
- `DraftManageView` uses the same `fieldsFromConfig` / `configFromFields`, so it
  picks this up automatically; just verify nothing references the removed keys.

## Out of scope

- Discord bot's start-draft path and its `defaultDraftConfig` usage stay as-is
  beyond the new `cardsPerPlayer` default flowing through `normalizeConfig`.
- No UI for `alternatePassDirection` / `randomizeSeats` anywhere; they keep their
  config defaults (`true` for both via the form; engine default for the bot).

## Testing

- `packages/shared`: a draft created with `cardsPerPlayer: 50` lets a player
  reach 50 picks (and stops there); `cardsPerPlayer: 40` still stops at 40.
- `packages/web` `create-draft-form.test.tsx`: POSTed config includes
  `cardsPerPlayer`, `packSize`, derived `packsPerPlayer`, `randomizeSeats: true`;
  the "loads a saved pool without touching numeric options" test updates its
  label queries (`/cards drafted per player/i`, `/size of each pack/i`,
  `/pick duration/i`) and no longer asserts on the removed checkboxes.
- `draft-manage-view.test.tsx`: still renders and saves with the new fields.
- Validation: pack size > cards per player surfaces an error; out-of-range
  values surface errors.
