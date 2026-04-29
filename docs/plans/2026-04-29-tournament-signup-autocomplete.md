# Tournament Signup and Autocomplete Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tournament signup buttons, active tournament listing, creator-seeded participants, tournament autocomplete, context-aware stats, and a help command.

**Architecture:** Keep the bot Discord-native by handling slash command, autocomplete, and button interactions in the existing Discord gateway process. Reuse existing SQLite tables for tournaments and participants, adding service methods rather than schema changes.

**Tech Stack:** TypeScript, discord.js, better-sqlite3, Vitest, Docker.

---

### Task 1: Add Tournament Query Methods

**Files:**
- Modify: `src/services/tournaments.ts`
- Test: existing or new `src/services/tournaments.test.ts`

**Step 1: Write failing tests**

Add tests for:

- `listByStatus(guildId, statuses)` returns tournaments scoped to guild.
- `activeForPlayer(guildId, playerId)` returns active tournaments where the player participates.
- `autocomplete(guildId, query, options)` returns at most 25 case-insensitive matches and can filter by status, creator, and participant.
- `stats(tournamentId, playerId)` counts only approved tournament matches.

**Step 2: Run tests**

Run: `npm test -- src/services/tournaments.test.ts`

Expected: FAIL because methods do not exist.

**Step 3: Implement methods**

Add methods to `createTournamentService(db)`:

- `listByStatus(guildId, statuses)`
- `activeForPlayer(guildId, playerId)`
- `autocomplete(input)`
- `stats(tournamentId, playerId)`

Keep SQL scoped by `guild_id`. Count tournament stats from `matches` where `status = 'approved'` and `tournament_id = ?`.

**Step 4: Verify**

Run: `npm test -- src/services/tournaments.test.ts`

Expected: PASS.

---

### Task 2: Seed Participants at Event Creation

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/commands/handlers.ts`
- Test: existing or new `src/commands/handlers.test.ts`

**Step 1: Write failing tests**

Add tests that `/event create`:

- Creates the tournament.
- Adds optional `player1` through `player8` users as participants.
- Ignores duplicate selected users.
- Allows create with no players.

**Step 2: Run tests**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: FAIL because user slots are not handled.

**Step 3: Update slash command definition**

In `src/commands/definitions.ts`, add optional user options to `/event create`:

- `player1`
- `player2`
- `player3`
- `player4`
- `player5`
- `player6`
- `player7`
- `player8`

**Step 4: Update handler**

In `handleEvent` `create`, after creating the tournament, loop over player slots, upsert each user, and call `deps.tournaments.join(tournament.id, player.id)`.

Reply with created tournament and participant count.

**Step 5: Verify**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: PASS.

---

### Task 3: Add Event List and Signup Commands

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/commands/handlers.ts`
- Test: `src/commands/handlers.test.ts`

**Step 1: Write failing tests**

Add tests for:

- `/event list` shows active and pending tournaments.
- `/event signup` requires creator permissions.
- `/event signup` replies with a public signup message and includes a Join Tournament button payload.

If current command abstraction cannot represent Discord components, extend `CommandInteractionLike.reply` to accept a typed object with `components`.

**Step 2: Run tests**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: FAIL.

**Step 3: Update definitions**

Add subcommands:

- `/event list`
- `/event signup name:<name> role:@Role?`

Set `name` autocomplete on signup.

**Step 4: Update types and handler**

Extend `CommandInteractionLike.options` with `getRole(name, required?)` or use a simple role-like type.

For `list`, call tournament list methods and format active plus pending sections.

For `signup`, require creator, format role mention if provided, and reply with a button custom ID like `join_tournament:${tournament.id}`.

**Step 5: Verify**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: PASS.

---

### Task 4: Handle Join Tournament Button Clicks

**Files:**
- Modify: `src/index.ts`
- Create or Modify: `src/interactions/buttons.ts`
- Test: `src/interactions/buttons.test.ts`

**Step 1: Write failing tests**

Add tests for a pure handler that:

- Parses `join_tournament:<id>`.
- Rejects unknown custom IDs.
- Adds the clicking user to a pending tournament.
- Returns an ephemeral success message.
- Returns an ephemeral error for started/cancelled/completed tournaments via existing `join` validation.

**Step 2: Run tests**

Run: `npm test -- src/interactions/buttons.test.ts`

Expected: FAIL.

**Step 3: Implement pure button handler**

Create a handler that accepts a small interaction-like object with `customId`, `guildId`, `user`, and `reply`.

Upsert the user and call `deps.tournaments.join(tournamentId, player.id)`.

**Step 4: Wire Discord adapter**

In `src/index.ts`, before slash command handling, add:

```ts
if (interaction.isButton()) {
  await handleButton(toButtonInteraction(interaction), deps);
  return;
}
```

**Step 5: Verify**

Run: `npm test -- src/interactions/buttons.test.ts`

Expected: PASS.

---

### Task 5: Add Tournament Autocomplete

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/index.ts`
- Create: `src/interactions/autocomplete.ts`
- Test: `src/interactions/autocomplete.test.ts`

**Step 1: Write failing tests**

Add tests that autocomplete returns expected choices for:

- `/event start`
- `/event signup`
- `/event show`
- `/event report`
- `/event cancel`
- `/stats tournament`

**Step 2: Run tests**

Run: `npm test -- src/interactions/autocomplete.test.ts`

Expected: FAIL.

**Step 3: Update command definitions**

Set `.setAutocomplete(true)` on tournament name string options and `/stats tournament`.

**Step 4: Implement autocomplete handler**

Create `handleAutocomplete(interaction, deps)` that checks command/subcommand/focused option and calls `deps.tournaments.autocomplete` with the correct filters.

Return choices shaped like `{ name: tournament.name, value: tournament.name }`.

**Step 5: Wire Discord adapter**

In `src/index.ts`, add:

```ts
if (interaction.isAutocomplete()) {
  await handleAutocomplete(toAutocompleteInteraction(interaction), deps);
  return;
}
```

**Step 6: Verify**

Run: `npm test -- src/interactions/autocomplete.test.ts`

Expected: PASS.

---

### Task 6: Add Context-Aware Stats

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/commands/handlers.ts`
- Test: `src/commands/handlers.test.ts`

**Step 1: Write failing tests**

Add tests for `/stats`:

- Shows tournament stats when `tournament` is specified.
- Shows active tournament stats when player is in exactly one active tournament.
- Shows lifetime stats when player is in no active tournament.
- Asks for tournament when player is in multiple active tournaments.

**Step 2: Run tests**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: FAIL.

**Step 3: Update definition**

Add optional string option `tournament` to `/stats` and enable autocomplete.

**Step 4: Update handler**

In `handleStats`, resolve target player, then:

- If tournament name exists, find tournament and show tournament stats.
- Else find active tournaments for player.
- If one active tournament, show tournament stats.
- If multiple, reply with names and ask user to specify `tournament`.
- Else use existing lifetime stats.

**Step 5: Verify**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: PASS.

---

### Task 7: Add Help Command

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/commands/handlers.ts`
- Test: `src/commands/handlers.test.ts`

**Step 1: Write failing test**

Add a test that `/help` replies with the expected command categories and mentions core commands.

**Step 2: Run tests**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: FAIL.

**Step 3: Implement command**

Add `/help` to definitions and a `handleHelp` case in `handleCommand`.

Keep copy concise and Discord-readable.

**Step 4: Verify**

Run: `npm test -- src/commands/handlers.test.ts`

Expected: PASS.

---

### Task 8: Update Docs and Manual Test Checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment/operations-checklist.md` if needed

**Step 1: Update README feature list**

Document:

- `/help`
- `/event list`
- `/event signup`
- creator-seeded participants
- stats tournament behavior
- autocomplete note

**Step 2: Update manual tests**

Add manual Discord tests for:

- Deploying updated commands.
- Autocomplete suggestions.
- Signup button flow.
- Role notification mention.
- Direct seeded players.
- `/stats` active tournament behavior.

**Step 3: Verify docs are accurate**

Run: `npm run build`

Expected: PASS.

---

### Task 9: Full Verification

**Files:**
- No edits unless failures require fixes.

**Step 1: Run full checks**

Run:

```bash
npm test
npm run typecheck
npm run build
docker compose build
```

Expected: all pass.

**Step 2: Deploy commands locally**

Run:

```bash
docker compose run --rm bot npm run commands:deploy:prod
```

Expected: command deployment succeeds and command count increases.

**Step 3: Manual Discord smoke test**

Test:

- `/help`
- `/event create` with seeded players
- `/event signup` with a role mention
- Join Tournament button
- `/event list`
- autocomplete for tournament name
- `/stats` inside and outside active tournament context

Expected: all flows work.
