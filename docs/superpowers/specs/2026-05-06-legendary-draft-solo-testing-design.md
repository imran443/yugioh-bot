# Legendary Draft Solo Testing — Design Spec

**Date:** 2026-05-06  
**Status:** Approved  
**Scope:** Three targeted changes to enable a complete solo test run of a Yu-Gi-Oh draft from the web UI before release.

---

## Problem

The "Legendary Draft" demo entry is seeded as `status: "active"` with packs and cards pre-generated. This bypasses the entire pending-lobby experience, making it impossible to test adding sets, configuring the draft, and starting it. Additionally, picks submitted from the web card-grid are never persisted (the store is purely optimistic with no server call), and the pending lobby has no way to edit configuration inline. Together these gaps prevent a full end-to-end test.

---

## Section 1: Seed Fix — Reset Legendary Draft to Pending

**Goal:** When the seed script runs, "Legendary Draft" should land in `pending` state so the creator can configure it, add card sets, and start it from the lobby.

**Changes to `scripts/seed.ts`:**

- Set `status: "pending"` (was `"active"`)
- Remove `started_at` (null or omit)
- Set `current_wave_number: 0` and `current_pick_step: 0`
- Remove all pack (`draft_packs`) and card (`draft_cards`, `draft_picks`) seed inserts that were written assuming an active draft
- Keep the `draft_players` rows for fake players (`fake_yugi`, `fake_kaiba`, etc.) so the lobby shows them as joined participants

**Fake players to keep in seed:**  
The `fake_*` Discord IDs (e.g., `fake_yugi`, `fake_kaiba`) are used as seeded participants. They must remain in `draft_players` so that when the creator starts the draft, there are enough players to run.

---

## Section 2: Inline Config Editing in the Pending Lobby

**Goal:** The creator can edit card sets, pack size, packs/player, and pick timer directly from the `DraftManageView` before starting. Currently this panel is read-only.

**Trigger:** A new "Edit Configuration" button appears below the read-only config display (creator-only). Clicking it switches the Configuration section into edit mode in-place.

**Edit mode fields:**
| Field | Component | Validation |
|---|---|---|
| Card Sets | Existing `SetPicker` component | At least 1 set required to start |
| Pack Size | `<input type="number" min="1" max="45">` | Integer, 1–45 |
| Packs / Player | `<input type="number" min="1" max="10">` | Integer, 1–10 |
| Pick Timer | `<input type="number" min="10" max="300">` | Seconds, 10–300 |

**Save flow:**
1. Click "Save Configuration" (or press Enter in a field)
2. Call existing `PUT /api/drafts/[slug]` with `{ config: { setNames, packSize, packsPerPlayer, pickSeconds } }`
3. On success: exit edit mode, parent `fetchDraft` re-renders panel with updated values
4. On error: display inline error message, stay in edit mode

**Cancel:** "Cancel" button exits edit mode without saving; resets field state to current `draft.config`.

**No new API needed** — the PUT endpoint already accepts the full config object and updates `config_json`.

---

## Section 3: Pick API + Auto-pick for Fake Players

**Goal:** Picks submitted from the web card-grid are actually persisted, and fake-player seats auto-pick immediately after the real player picks — enabling a solo test without needing other people.

### 3a. New REST Endpoint

**`POST /api/drafts/[slug]/pick`**

Request body:
```json
{ "cardId": 12345 }
```

Handler steps:
1. Require auth session; 401 if no user
2. Look up `players` row by `guild_id` + `discord_user_id = session.user.id`; 400 if not a participant
3. Call `drafts.pickCard(draftId, playerId, cardId, "manual")`  
   - Validates active draft, player joined, not already finished, card in player's pack
   - Writes `draft_cards.picked_by_player_id`, inserts `draft_picks`, increments `pick_count`
   - If all players have picked this step: rotates packs, advances `current_pick_step`; if all steps done, completes draft
4. **Auto-pick loop (dev/fake-player logic):**
   - Query `draft_players` joined with `players` where `discord_user_id LIKE 'fake_%'` and player hasn't picked `current_pick_step` yet (check `draft_picks` for current wave/step)
   - For each pending fake player: get their current pack via `drafts.currentPackOptionsInternal`, pick a random card, call `drafts.pickCard(draftId, fakePlayerId, randomCardId, "auto")`
   - Repeat until no pending fake players remain for the current step (handles the case where a real player's pick triggers step advancement and fake players need to pick in the new step too — but actually fake players need to pick in the *same* step, so one pass is enough)
5. Call the same GET logic to build and return the full updated state (same shape as `GET /api/drafts/[slug]`)
6. 400 for validation errors from `pickCard`, 500 for unexpected errors

### 3b. Client Changes — `card-grid.tsx`

Current `handleCardClick` and keyboard `Enter` handler both call `useDraftStore.pickCard(cardId)` (optimistic only). After the optimistic call:

1. POST to `/api/drafts/[slug]/pick` with `{ cardId }`
2. On success: call `setFromServer(response)` to sync the returned full state (new pack, updated pool, turn status)
3. On error: re-fetch full draft state via the page's `fetchDraft` to restore consistent UI; surface a toast or inline error

The store's optimistic `pickCard` keeps the UI feeling instant. The server response replaces that optimistic state with the authoritative one (including what the fake players picked, new pack contents, updated timer).

### 3c. Auto-pick Scope

This is **dev/testing-only** behavior — not a user-facing feature. The auto-pick fires on fake players only (identified by `discord_user_id LIKE 'fake_%'`). In production, real players will always be present for all seats and this code path never fires. No feature flag needed — the condition is inherently scoped to fake seed data.

---

## Data Flow Summary

```
User clicks card
  → optimistic store update (instant UI)
  → POST /api/drafts/[slug]/pick
      → pickCard(real player)
      → auto-pick loop (fake players, dev only)
      → return full updated state
  → setFromServer(response) — authoritative state replaces optimistic
```

---

## Out of Scope

- WebSocket pick emission (WS server has no DB connection; REST + re-fetch is sufficient for solo testing)
- Fake player pick delays or animation (immediate is fine for testing)
- UI for fake player picks beyond the state update (pool panel and seat list update automatically via setFromServer)
- Making config editing available to non-creators
- Removing fake players from the seed entirely

---

## Files Affected

| File | Change |
|---|---|
| `scripts/seed.ts` | Status → pending, remove pack/card inserts |
| `packages/web/src/components/draft/draft-manage-view.tsx` | Add inline config edit mode |
| `packages/web/app/api/drafts/[slug]/pick/route.ts` | New file — pick endpoint + auto-pick loop |
| `packages/web/src/components/draft/card-grid.tsx` | Wire pick to REST endpoint, call setFromServer |
