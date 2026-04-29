# Tournament Signup and Autocomplete Design

## Goal

Add Discord-native tournament discovery and signup features without adding a web server.

## Scope

- Add a help command.
- Add an active and pending tournament list.
- Let tournament creators seed participants at creation time.
- Let tournament creators post a signup message with a Join Tournament button.
- Let signup messages optionally mention a Discord role for notification only.
- Add tournament-name autocomplete to relevant commands.
- Make `/stats` show active tournament stats when applicable, otherwise lifetime stats.

## Discord Interaction Model

The signup link will be a Discord button, not an external URL. The bot posts a message with a `Join Tournament` button whose custom ID contains the tournament ID. Clicking it adds the user to that tournament if the tournament is still pending.

This keeps the bot Discord-native and avoids adding Express, public hosting, callback URLs, or signed web tokens.

## Commands

Add `/help` with concise usage for duel, approval, stats, rankings, and event commands.

Add `/event list` to show active tournaments first, then pending tournaments.

Add `/event signup name:<name> role:@Role?` to post a signup message. The role is only mentioned to notify people. Anyone can click the button and join.

Update `/event create` with optional fixed player slots. Discord slash commands do not support an arbitrary number of repeated user options, so use `player1` through `player8` first. This is enough for small local tournaments and can be expanded later if needed.

Update `/stats` with optional `tournament:<name>` autocomplete. If no tournament is provided, the bot checks active tournaments for the selected player.

## Stats Behavior

- If `tournament` is provided, show tournament-only wins and losses for that player.
- If no tournament is provided and the player is in exactly one active tournament, show tournament-only stats for that active tournament.
- If no tournament is provided and the player is in no active tournaments, show lifetime stats.
- If no tournament is provided and the player is in multiple active tournaments, ask the user to specify `tournament`.

Only approved matches count.

## Autocomplete Behavior

Enable autocomplete for tournament name options:

- `/event start`: pending tournaments created by the user.
- `/event signup`: pending tournaments created by the user.
- `/event show`: pending, active, completed, and cancelled tournaments in the server.
- `/event report`: active tournaments where the user is a participant.
- `/event cancel`: pending or active tournaments created by the user.
- `/stats tournament`: active tournaments first, then recent completed tournaments.

Discord allows up to 25 autocomplete choices. Matching should be case-insensitive and scoped to the current guild.

## Data Model

No schema changes are required for the first implementation.

Existing tables already store tournaments, participants, matches, and tournament matches. Signup button interactions can use existing `tournament_participants` rows.

## Error Handling

- Joining a started tournament returns an ephemeral error.
- Clicking a stale signup button for a cancelled or completed tournament returns an ephemeral error.
- Starting still requires at least two participants.
- Only the creator can start, cancel, or post signup messages for their tournament.
- Directly seeded players are inserted with `insert or ignore`, so duplicates are harmless.

## Testing

Add unit tests around command handling and tournament service methods. Add a small interaction adapter test for button custom ID parsing if the handler is extracted. Manual Discord testing should cover command deployment, autocomplete, signup button click, direct seeded participants, and stats fallback.
