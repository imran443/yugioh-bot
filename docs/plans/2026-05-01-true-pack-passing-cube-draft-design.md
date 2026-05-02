# True Pack-Passing Cube Draft Design

## Goal

Replace the current shared-pool draft flow with a true pack-passing cube draft that works naturally in Discord.

The draft should:

- Keep coordination in the draft channel, not DMs.
- Let each player privately view and pick from their current pack.
- Pass packs between players after each pick step.
- Show a live public timer.
- Auto-pick for missing players when the timer expires.
- Let each player view their current drafted pool during the draft.

## Discord Constraints

Discord supports this flow, but the design must respect interaction limits.

- Bots cannot proactively send ephemeral messages. Ephemeral pickers must be opened by a user clicking a public button or using a command.
- Every slash command, button, and select menu interaction must be acknowledged within 3 seconds.
- Slow pick UI work should use `deferReply({ ephemeral: true })` before image generation or database work.
- Components are limited to 5 action rows per message.
- Select menus support up to 25 options, so pack sizes up to 25 are feasible for selection.
- A single Discord message is not a good place for 15 large card images. Larger packs should use paged ephemeral image views.
- No message-content intent is needed. The bot should continue using slash commands and components only.

## Confirmed UX Direction

Use one public draft status message as the table view.

The public message shows:

- Draft name.
- Pack round and pick step.
- Timer.
- Picked count.
- Waiting players.
- `Pick Card` button.
- `View My Pool` button.

Players click `Pick Card` for each pick step. The bot replies ephemerally with that player's current pack.

This extra click is required because Discord cannot automatically create the next ephemeral picker for the player after the table advances.

## Draft Settings

The draft should store these settings in `drafts.config_json` or explicit columns:

- `packSize`: cards in each opened pack.
- `packsPerPlayer`: number of packs each player opens.
- `pickSeconds`: duration for each pick step.
- `randomizeSeats`: whether to randomize table order at start.
- `alternatePassDirection`: whether pack passing alternates by pack round.
- `autoPickEnabled`: initially always true for active timed drafts.

Recommended defaults:

- `packSize`: 8.
- `packsPerPlayer`: 5.
- `pickSeconds`: 45.
- `alternatePassDirection`: true.

The default production format is `5 x 8 = 40`, so each player drafts exactly 40 cards.

The data model should also support traditional cube settings such as `3 x 15 = 45` cards per player. For 15-card packs, the private picker should paginate full-size images while keeping one select menu with all current pack cards.

## Data Model

The current `draft_cards` wave model is not enough for true pack passing. Add pack-specific state.

Core additions:

- `draft_players.seat_index`: stable table position assigned when the draft starts.
- `drafts.current_wave_number` exposed in TypeScript as `currentPackRound`: current pack round, 1-based. Reusing the existing column avoids a table rewrite.
- `drafts.current_pick_step`: current pick within the current pack round, 1-based.
- `drafts.pick_deadline_at`: timestamp for the current pick deadline.
- `drafts.status_message_id`: Discord message ID for the public draft status message.
- `draft_packs`: one pack per player per pack round.
- `draft_cards.draft_pack_id`: assigns existing draft card instances to a pack.
- `draft_cards.position`: stable card ordering within a pack.
- `draft_picks.pick_method`: `manual` or `auto`.

Suggested pack table:

```sql
draft_packs (
  id integer primary key autoincrement,
  draft_id integer not null,
  pack_round integer not null,
  origin_seat_index integer not null,
  current_holder_seat_index integer not null,
  pass_direction integer not null,
  created_at text not null default current_timestamp
)
```

The existing `draft_cards` table should remain the card-instance table. True pack passing adds `draft_pack_id` and `position` to it instead of creating a separate card-instance table. The existing `draft_picks` table remains the audit trail and records round, pick step, and whether the pick was manual or automatic.

## Pack-Passing Algorithm

At draft start:

- Validate at least 2 players.
- Assign each player a stable `seat_index`.
- Optionally randomize seat order.
- Open pack round 1 by creating one pack per player.
- Set each pack holder to the pack's origin seat.
- Set `current_pick_step = 1`.
- Set `pick_deadline_at = now + pickSeconds`.
- Post the public draft status message.

For each player, the current pack is the pack whose `current_holder_seat_index` equals that player's `seat_index`.

When a player manually picks:

- Validate the player is in the draft.
- Validate the draft is active.
- Validate the selected card belongs to that player's current pack.
- Validate the player has not already picked this step.
- Mark the pack card as picked.
- Insert a `manual` draft pick.
- Update the ephemeral response with the picked card and pool count.
- Refresh the public status message.

When all active players have picked:

- Advance immediately instead of waiting for the timer.
- If packs still have cards, pass every non-empty pack to the next seat and increment `current_pick_step`.
- If all current packs are empty, open the next pack round.
- If all pack rounds are complete, mark the draft completed.
- Reset the deadline whenever a new pick step starts.

Pass direction:

- Odd pack rounds pass one direction.
- Even pack rounds pass the opposite direction when `alternatePassDirection` is true.

## Timer And Auto-Pick

The public status message should show a live countdown.

Recommended timer behavior:

- Store `pick_deadline_at` in the database.
- Edit the public draft message every 5 seconds while the deadline is more than 10 seconds away.
- Edit every 1-2 seconds in the final 10 seconds if rate limits allow it.
- Always include Discord's native relative timestamp, such as `<t:unix:R>`, as a fallback.
- Catch Discord rate-limit responses and skip non-critical visual updates if needed.

At timeout:

- Find players who have not picked in the current step.
- For each pending player, choose a random available card from their current pack.
- Record the pick as `auto`.
- If a manual pick races with the timeout, the database transaction should allow only one pick for that player and step.
- Announce auto-picks in the public status message only as status, not card names.
- Advance to the next pick step or pack round.

Startup recovery:

- On bot ready, scan active drafts.
- If a deadline has expired, run the auto-pick transition immediately.
- If a deadline is still active, resume timer updates.
- If the public status message is missing or cannot be edited, post a replacement and store the new message ID.

## Private Pick UI

The `Pick Card` button opens an ephemeral picker for the clicking player.

The picker should include:

- Current pack round and pick step.
- Time remaining.
- Separate readable card images.
- Text labels matching each image number.
- Numbered `Pick 1` through `Pick 8` buttons for the current pack.
- A compact pool summary.
- `View My Pool` button.

Discord does not allow bot interactions directly on an image attachment or embed image. The image is visual only. The interactive control is the matching numbered button below the images.

For 8-card packs:

- Show all 8 cards with image and text in one ephemeral response if Discord limits allow it.
- Use two action rows of numbered pick buttons, such as `Pick 1` through `Pick 8`.
- Include `View My Pool` in a separate action row.

For larger packs, such as 15 cards:

- Show paged card images, such as 5 or 8 per page.
- Keep card numbering stable across pages.
- Show pick buttons for the full current pack when component limits allow it.
- Add `Previous` and `Next` buttons for image pages when not all images fit in one response.
- Keep card numbering stable across pages.

If image loading fails:

- Still show the select menu and numbered card names.
- Tell the player images are unavailable but picking can continue.

## View My Pool

Use the term `pool`, not `deck`, during the draft. The player is drafting cards, not necessarily submitting a legal final deck yet.

Entry points:

- Public `View My Pool` button on the draft status message.
- Ephemeral `View My Pool` button inside the pick UI.
- Optional `/draft pool name:<draft>` command later.

Pool view should be ephemeral and image-and-text based.

The first version should show paged card images with text labels:

```text
Your pool: 17 cards
Page 1 / 4

Monsters 11 | Spells 4 | Traps 2

1. Gene-Warped Warwolf
[card image]

2. Cyber Dragon
[card image]

3. Book of Moon
[card image]

[Previous] [Next]
```

The pool view should also support a compact text summary at the top:

```text
Your pool: 17 cards
Monsters 11 | Spells 4 | Traps 2
Last pick: Book of Moon
```

Pool images are for the player's own drafted pool only. They are not posted publicly.

If images fail to load, fall back to grouped text:

```text
Your pool: 17 cards

Monsters (11)
1. Gene-Warped Warwolf
2. Cyber Dragon

Spells (4)
1. Book of Moon

Traps (2)
1. Torrential Tribute
```

During timed picks, pool browsing must remain private and paginated so it does not overload a single Discord response.

The pick UI should also show a compact pool summary, such as:

```text
Pool so far: 12 cards
Monsters 8 | Spells 3 | Traps 1
Last pick: Book of Moon
```

## Image Generation

Current behavior renders one small `4 x 2` grid with `100 x 145` images. This should change.

New behavior:

- Cache individual card images under `data/card-images`.
- Prefer larger YGOPRODeck images for the private picker.
- Normalize cached images to a readable Discord size, not the current `100 x 145` thumbnails.
- Send separate card images or embeds in the ephemeral picker and pool view.
- Preserve numbering so images match select-menu options.

The bot should prefetch or warm cache images for the next active packs when a pick step advances. This reduces the chance of missing Discord's interaction window.

## Public Status Message

Example:

```text
Cube Draft: Edison Cube
Pack 2 / 5
Pick 4 / 8
Time left: 00:32 (ends <t:1770000000:R>)

Picked: 2 / 4
Waiting on: @Yugi, @Joey

Click Pick Card to choose from your current pack.
```

Buttons:

```text
[Pick Card] [View My Pool]
```

After completion:

```text
Cube Draft: Edison Cube completed.
Use /draft export to download your drafted pool.
```

## Error Handling

- Non-players clicking `Pick Card` receive an ephemeral rejection.
- Players who already picked receive an ephemeral waiting status.
- Players clicking after timeout receive the next available state if the draft advanced.
- Players with no current pack receive a clear status, not a crash.
- If the timer worker fails to edit the public message, auto-pick and draft advancement still continue.
- If image generation fails, the text picker still works.
- If the bot restarts, active draft timers resume from persisted deadlines.

## Cancellation And Cleanup

Cancelling a draft should soft-cancel it instead of deleting rows from SQLite.

Reasons:

- It preserves an audit trail for who joined and what happened.
- It avoids accidental data loss if a creator cancels the wrong draft.
- It keeps foreign-key relationships simple for draft packs, cards, and picks.
- It allows support/debugging after a failed or cancelled draft.

On cancel:

- Set `drafts.status = 'cancelled'`.
- Set `drafts.ended_at`.
- Stop active timers for that draft.
- Edit the public status message to show the draft was cancelled.
- Disable draft action buttons where possible.
- Do not delete `draft_packs`, `draft_cards`, or `draft_picks` immediately.

Cleanup should be separate from cancellation.

Recommended cleanup policy:

- Keep completed and cancelled draft records by default.
- Add a future admin cleanup command or scheduled job only if DB size becomes an issue.
- If cleanup is added, delete only terminal drafts older than a retention window, such as 30 or 90 days.
- Delete child rows first, then the draft row, inside one transaction.
- Never cleanup active or pending drafts.

Card image cleanup remains cache-size based. Since card images are shared by many drafts, cancelling a draft should not delete card image files. The existing image cache cleanup can continue removing oldest cached images when the cache exceeds the configured size limit.

## Testing

Tests should cover:

- Seat assignment at draft start.
- Pack creation: one pack per player per pack round.
- Current pack lookup by player seat.
- Manual pick validation.
- Pack rotation after every player picks.
- Alternating pass direction by pack round.
- Opening the next pack round when current packs are empty.
- Draft completion after all pack rounds finish.
- Auto-pick for pending players at timeout.
- Manual pick vs auto-pick race safety.
- Public status message content.
- No DM prompt behavior.
- Ephemeral pick UI uses separate card images plus numbered pick buttons.
- Pool view uses private paged card images plus text labels and counts.
- Startup recovery for expired and active deadlines.

## Migration Strategy

This is a breaking internal draft-engine change, but current active drafts are not expected to be preserved across the rewrite.

Implementation should:

- Keep completed draft export behavior working where possible.
- Add new columns/tables without deleting existing data.
- Treat old active wave-based drafts as unsupported if any exist, or require cancellation before deploy.
- Update tests before implementation to lock in true pack-passing behavior.

## Open Decisions

- None for the first true pack-passing implementation.
