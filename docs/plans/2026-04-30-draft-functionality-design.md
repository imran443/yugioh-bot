# Draft Functionality Design

## Goal

Add Discord-native draft functionality to the bot. Drafts should let players join from a public button, draft Yugioh cards with images, finish with exactly 40 Main Deck cards, and download a `.ydk` file for their drafted deck.

## Scope

- Drafts are separate from tournaments in v1.
- Drafts may be linked to events later, but v1 focuses on card drafting and deck export.
- Draft creators choose official sets and optional card-name overrides.
- Card metadata and images come from YGOPRODeck.
- Extra Deck monsters are excluded in v1 so every export is a 40-card Main Deck.
- The bot does not enforce banlists, archetype rules, or max-copy limits in v1.

## Discord UX

Add a `/draft` command group and draft dashboard, separate from `/event`.

Primary actions:

- `/draft dashboard` opens a private draft dashboard.
- `Create Draft` opens modal text fields for draft name, comma-separated set names, and optional card-name include/exclude lists.
- Creating a draft posts a public signup message with a `Join Draft` button.
- The draft creator is auto-joined as the first player.
- Other players join with the public `Join Draft` button.
- The creator starts the draft from dashboard creator tools.
- Players click `Pick Cards` when pinged to receive a private 8-card picker.
- Finished players can use `Deck Export` to receive their `.ydk` file.

Draft pings use the channel where the draft was created. The bot posts public prompts such as `<@user>, you are up in Draft Name` with a `Pick Cards` button. Discord cannot proactively send ephemeral messages, so the private card grid is shown only after the player clicks.

## Draft Model

Drafts use synchronized wave-based picking.

- Each draft has a finite current wave pool.
- A wave opens one 8-card pack per active player.
- Every active player is prompted at the same time for each pick step.
- Each player privately sees 8 cards from the current wave pool.
- The player picks one card with numbered controls.
- The picked card is assigned to that player and removed from the wave pool.
- Unpicked cards remain in the current wave pool and can appear in later choices.
- The bot waits until every active player has picked once for the step.
- When everyone has picked for that step, the bot sends the next set of prompts.
- When the current wave pool is empty, the bot opens the next wave.
- After 5 waves, each player has 40 drafted cards.
- When all players have 40 cards, the draft completes.

This keeps drafting fair: fast players cannot keep taking cards while slower players are still on the same pick step.

## Card Source

Use YGOPRODeck as the card source for v1.

Relevant endpoints:

- `https://db.ygoprodeck.com/api/v7/cardsets.php` lists official set names.
- `https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=<set name>` fetches cards from a set.
- `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=<card name>` fetches exact card names.
- The `name` parameter supports multiple exact names separated by `|`.

The bot should fetch card metadata by selected set names and optional card names, then cache the result in SQLite. Required metadata includes:

- YGOPRODeck card ID.
- Card name.
- Type/frame information needed to exclude Extra Deck monsters.
- Set names.
- Image URL.

For v1, packs are randomized from the configured eligible Main Deck card pool. They do not need to simulate official set rarity, collation, or sealed product ratios.

YGOPRODeck rate limits the API at 20 requests per second and asks clients to store fetched data locally. The bot should cache card metadata and avoid repeated API calls for the same cards or sets.

## Image Picker

The best Discord UI is a generated grid image rather than one embed per card.

- The bot renders one numbered PNG containing up to 8 card images.
- The reply includes numbered pick controls for cards `1` through `8`.
- If image generation fails, the bot falls back to a numbered text list with card names so the draft can continue.
- Card images must be downloaded and cached under `data/card-images` instead of hotlinked from YGOPRODeck.

## Data Model

Add SQLite tables for draft state and cached cards.

Core tables:

- `drafts`: guild, channel, name, status, creator, setup config, timestamps.
- `draft_players`: joined players, pick counts, finished state.
- `draft_cards`: card instances assigned to a draft, wave number, picked state.
- `draft_picks`: audit trail of player picks.
- `card_catalog`: cached YGOPRODeck card metadata.

Draft names should be unique per guild while a draft is pending or active, matching tournament name behavior.

## Services

Add services beside the existing tournament and match services.

- `DraftService`: create, join, start, open waves, produce pick options, record picks, advance pick steps, complete drafts, export YDK data.
- `CardCatalogService`: fetch, normalize, filter, and cache YGOPRODeck card metadata.
- `DraftImageService`: download/cache card images and render numbered 8-card grid PNGs.

Pick recording should run inside a transaction so the same draft card cannot be assigned twice if players pick concurrently.

## YDK Export

At completion, each player can download a `.ydk` file.

The v1 export should contain exactly 40 card IDs under `#main` and no Extra Deck cards.

```text
#created by Yugioh Discord Bot
#main
<40 drafted card ids>
#extra
!side
```

## Error Handling

- Missing guild context returns a server-only error.
- Missing or unknown set names return `Set not found` with the unmatched names.
- Empty eligible card pools return `No main-deck cards found`.
- Starting requires at least 2 players.
- Starting requires enough eligible cards to open the first wave.
- If a wave cannot open because the source pool is exhausted, the draft reports `Not enough cards to open the next wave`.
- Clicking `Pick Cards` when not in the draft returns an ephemeral rejection.
- Clicking after already picking for the current step returns an ephemeral status message.
- Export before 40 picks returns an ephemeral `Deck is not complete yet` message.

## Testing

Tests should cover:

- Schema migrations for new draft and catalog tables.
- Card catalog filtering, including Extra Deck exclusion.
- Draft creation, duplicate active name rejection, auto-joining creator, and public signup reply.
- Join button behavior and no duplicate players.
- Start validation and first wave creation.
- Synchronized pick steps.
- Recycled unpicked cards staying in the wave pool.
- Pick transactions preventing duplicate assignments.
- Wave advancement and draft completion after 40 picks per player.
- YDK export formatting.
- Dashboard, modal, button, and select-menu handlers.

## Deferred

- Tournament integration.
- Banlist enforcement.
- Max-copy enforcement.
- Official rarity/collation simulation.
- Timed picks or auto-picks.
- Extra Deck drafting.
- Large file import for cube lists.
