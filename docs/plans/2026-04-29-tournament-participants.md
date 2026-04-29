# Tournament Participants Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/event participants name:<tournament>` so users can list tournament participants.

**Architecture:** Reuse existing tournament and player tables. Add a tournament service method that joins `tournament_participants` to `players`, then expose it through a new event subcommand with tournament-name autocomplete.

**Tech Stack:** TypeScript, discord.js, better-sqlite3, Vitest.

---

### Task 1: Add Participant Records to Tournament Service

**Files:**
- Modify: `src/services/tournaments.ts`
- Test: `tests/services/tournaments.test.ts`

**Step 1: Write the failing test**

Add a test that creates a tournament, inserts participants, and expects `participantRecords(tournament.id)` to return participant IDs and display names in join order.

Also add an empty tournament test returning `[]`.

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/tournaments.test.ts`

Expected: FAIL because `participantRecords` does not exist.

**Step 3: Implement minimal service method**

Add type:

```ts
export type TournamentParticipant = {
  playerId: number;
  displayName: string;
};
```

Add method:

```ts
participantRecords(tournamentId: number): TournamentParticipant[] {
  return db
    .prepare(`
      select p.id as player_id, p.display_name
      from tournament_participants tp
      inner join players p on p.id = tp.player_id
      where tp.tournament_id = ?
      order by tp.joined_at asc, p.id asc
    `)
    .all(tournamentId)
    .map((row: any) => ({ playerId: row.player_id, displayName: row.display_name }));
}
```

**Step 4: Verify**

Run: `npm test -- tests/services/tournaments.test.ts`

Expected: PASS.

---

### Task 2: Add `/event participants`

**Files:**
- Modify: `src/commands/definitions.ts`
- Modify: `src/commands/handlers.ts`
- Test: `tests/commands/definitions.test.ts`
- Test: `tests/commands/handlers.test.ts`

**Step 1: Write failing tests**

Add definition test that `/event participants` exists with required `name` string option, max length 100, autocomplete enabled.

Add handler tests for:

- Lists participants with count and numbered display names.
- Empty tournament says no participants.
- Long participant list caps output and summarizes hidden participants.

**Step 2: Run tests to verify failure**

Run: `npm test -- tests/commands/definitions.test.ts tests/commands/handlers.test.ts`

Expected: FAIL because command and handler do not exist.

**Step 3: Implement command definition**

Add `/event participants name:<tournament>` with `.setAutocomplete(true)`.

**Step 4: Implement handler**

Add formatter with a safe cap, such as 25 participants:

```text
locals participants (3):
1. Yugi
2. Kaiba
3. Joey
```

For empty:

```text
locals has no participants yet.
```

For hidden participants:

```text
...and 8 more participant(s).
```

**Step 5: Verify**

Run: `npm test -- tests/commands/definitions.test.ts tests/commands/handlers.test.ts`

Expected: PASS.

---

### Task 3: Autocomplete, Help, Docs, and Verification

**Files:**
- Modify: `src/interactions/autocomplete.ts`
- Modify: `tests/interactions/autocomplete.test.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `README.md`

**Step 1: Write failing autocomplete test**

Add `/event participants` to the contexts where `name` autocomplete returns server tournaments, same as `/event show`.

**Step 2: Implement autocomplete**

Route `participants` like `show` in `handleAutocomplete`.

**Step 3: Update help and README**

Add `/event participants` to help text and manual checklist.

**Step 4: Full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
docker compose build
```

Expected: all pass.

**Step 5: Commit**

Commit with:

```bash
git add .
git commit -m "feat: list tournament participants"
```
