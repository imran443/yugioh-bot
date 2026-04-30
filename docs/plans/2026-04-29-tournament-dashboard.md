# Tournament Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `/event dashboard`, a private Discord dashboard that lets users discover tournament actions, join events, report tournament matches, approve or deny pending results, view stats, and access creator tools without remembering every slash command.

**Architecture:** Keep the current command/service structure. Add the slash subcommand in `src/commands/definitions.ts`, route `/event dashboard` through `src/commands/handlers.ts`, and expand `src/interactions/buttons.ts` to handle dashboard navigation and actions. Reuse existing services where possible, adding only small query helpers for dashboard-specific lookups.

**Tech Stack:** TypeScript, discord.js builders/components, better-sqlite3, Vitest, Docker Compose.

---

## Notes

- All dashboard replies should be ephemeral.
- Do not hard-delete tournaments.
- Creator-only actions must keep existing authorization rules.
- Button custom IDs must include enough context to avoid storing temporary UI state.
- Keep labels short because Discord button labels and rows are limited.
- Only commit if the user explicitly asks for a commit.

---

### Task 1: Add `/event dashboard` Command Definition

**Files:**
- Modify: `src/commands/definitions.ts`
- Test: `tests/commands/handlers.test.ts`

**Step 1: Write the failing test**

Add a test near the `/help` or event command tests:

```ts
it("/event dashboard replies privately with dashboard buttons", async () => {
  const app = setup();
  const yugi = { id: "user-1", username: "Yugi" };
  const { interaction, replies } = fakeInteraction({
    commandName: "event",
    subcommand: "dashboard",
    user: yugi,
  });

  await handleCommand(interaction, app);

  expect(replies[0]).toMatchObject({
    content: expect.stringContaining("Tournament Dashboard"),
    ephemeral: true,
  });
  expect(JSON.stringify(replies[0])).toContain("dashboard_open_events");
  expect(JSON.stringify(replies[0])).toContain("dashboard_report_match");
  expect(JSON.stringify(replies[0])).toContain("dashboard_pending_approvals");
});
```

Update the test helper type if needed so object replies can include `ephemeral`.

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: FAIL because `dashboard` is unsupported.

**Step 3: Add command definition**

In `src/commands/definitions.ts`, add an event subcommand:

```ts
.addSubcommand((subcommand) =>
  subcommand.setName("dashboard").setDescription("Open your private tournament dashboard"),
)
```

Place it near `list` so the command reads naturally.

**Step 4: Add minimal handler**

In `src/commands/handlers.ts`, add `dashboard` to the help message and event switch.

Create a small formatter:

```ts
function tournamentDashboardReply(): CommandReplyLike {
  return {
    content: [
      "Tournament Dashboard",
      "Use these buttons to find events, join, report matches, approve results, and see command help.",
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("dashboard_open_events").setLabel("Open Events").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("dashboard_my_events").setLabel("My Events").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("dashboard_report_match").setLabel("Report Match").setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("dashboard_pending_approvals").setLabel("Approvals").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("dashboard_stats").setLabel("Stats").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("dashboard_creator_tools").setLabel("Creator Tools").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("dashboard_help").setLabel("Help").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
```

Then in `handleEvent`:

```ts
case "dashboard": {
  await interaction.reply(tournamentDashboardReply());
  return;
}
```

**Step 5: Run test to verify it passes**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: changed command files and tests.

---

### Task 2: Expand Button Interaction Types For Dashboard Replies

**Files:**
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write the failing test**

Add a test for the dashboard help button:

```ts
it("shows dashboard help privately", async () => {
  const app = setup();
  const { interaction, replies } = fakeButton({ customId: "dashboard_help" });

  await handleButton(interaction, app);

  expect(replies[0]).toMatchObject({
    content: expect.stringContaining("Tournament commands"),
    ephemeral: true,
  });
});
```

Update `fakeButton` reply capture to allow `components`:

```ts
const replies: Array<{ content: string; ephemeral?: boolean; components?: readonly unknown[] }> = [];
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL with `Unsupported button interaction`.

**Step 3: Add button reply type support**

In `src/interactions/buttons.ts`, update `ButtonInteractionLike.reply` to support components:

```ts
reply(message: { content: string; ephemeral: boolean; components?: InteractionReplyOptions["components"] }): Promise<void> | void;
```

Import `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle`, and `type InteractionReplyOptions` from `discord.js`.

**Step 4: Add help button handling**

Add a branch before the existing unsupported error:

```ts
if (interaction.customId === "dashboard_help") {
  await interaction.reply({
    content: [
      "Tournament commands:",
      "- Open the dashboard: /event dashboard",
      "- Create an event: /event create",
      "- Join from dashboard: Open Events > Join",
      "- Report from dashboard: Report Match",
      "- Approve or deny from dashboard: Approvals",
    ].join("\n"),
    ephemeral: true,
  });
  return;
}
```

**Step 5: Run test to verify it passes**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: changed button files and tests.

---

### Task 3: Add Open Events Button With Join Buttons

**Files:**
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write the failing test**

Add:

```ts
it("lists open events with join buttons", async () => {
  const app = setup();
  const locals = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
  app.tournaments.create("guild-1", "win-a-mat", "single_elim", "creator-1");
  const { interaction, replies } = fakeButton({ customId: "dashboard_open_events" });

  await handleButton(interaction, app);

  expect(replies[0]).toMatchObject({
    content: expect.stringContaining("Open events"),
    ephemeral: true,
  });
  expect(replies[0].content).toContain("locals");
  expect(JSON.stringify(replies[0])).toContain(`join_tournament:${locals.id}`);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because `dashboard_open_events` is unsupported.

**Step 3: Implement open events formatter**

In `src/interactions/buttons.ts`, add a helper that uses `deps.tournaments.listByStatus(guildId, ["pending"])`.

Keep only the first 5 tournaments because Discord allows 5 buttons per row:

```ts
function openEventsReply(tournaments: ReturnType<TournamentService["listByStatus"]>) {
  if (tournaments.length === 0) {
    return { content: "No open events right now.", ephemeral: true };
  }

  const visible = tournaments.slice(0, 5);
  return {
    content: [
      "Open events:",
      ...visible.map((tournament) => `- ${tournament.name} (${tournament.format})`),
      ...(tournaments.length > visible.length ? [`...and ${tournaments.length - visible.length} more event(s).`] : []),
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...visible.map((tournament) =>
          new ButtonBuilder()
            .setCustomId(`join_tournament:${tournament.id}`)
            .setLabel(`Join ${tournament.name}`.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    ],
  };
}
```

Add handling:

```ts
if (interaction.customId === "dashboard_open_events") {
  const guildId = requireGuildId(interaction);
  await interaction.reply(openEventsReply(deps.tournaments.listByStatus(guildId, ["pending"])));
  return;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 5: Check worktree**

Run: `git status --short`

Expected: changed button files and tests.

---

### Task 4: Add My Events And Stats Buttons

**Files:**
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write failing tests**

Add a test for `dashboard_my_events`:

```ts
it("lists the user's tournaments", async () => {
  const app = setup();
  const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
  const player = app.players.upsert("guild-1", "user-1", "Yugi");
  app.tournaments.join(tournament.id, player.id);
  const { interaction, replies } = fakeButton({ customId: "dashboard_my_events" });

  await handleButton(interaction, app);

  expect(replies[0]).toMatchObject({ content: expect.stringContaining("Your events"), ephemeral: true });
  expect(replies[0].content).toContain("locals");
});
```

Add a test for `dashboard_stats`:

```ts
it("shows dashboard stats privately", async () => {
  const app = setup();
  const { interaction, replies } = fakeButton({ customId: "dashboard_stats" });

  await handleButton(interaction, app);

  expect(replies[0]).toEqual({ content: "Yugi: 0W - 0L (0% win rate)", ephemeral: true });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because the buttons are unsupported.

**Step 3: Add service helper for user tournaments**

In `src/services/tournaments.ts`, add:

```ts
forPlayer(guildId: string, playerId: number): Tournament[] {
  return db
    .prepare(
      `
      select t.* from tournaments t
      inner join tournament_participants tp on tp.tournament_id = t.id
      where t.guild_id = ?
        and tp.player_id = ?
        and t.status in ('pending', 'active')
      order by case t.status when 'active' then 0 else 1 end, t.created_at asc, t.id asc
    `,
    )
    .all(guildId, playerId)
    .map(mapTournament);
},
```

**Step 4: Implement button handlers**

In `src/interactions/buttons.ts`, import `formatStats` from `../formatters/stats.js`.

For `dashboard_my_events`:

```ts
if (interaction.customId === "dashboard_my_events") {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const tournaments = deps.tournaments.forPlayer(guildId, player.id);
  await interaction.reply({
    content: tournaments.length === 0
      ? "You are not in any pending or active events."
      : ["Your events:", ...tournaments.map((t) => `- ${t.name} (${t.status}, ${t.format})`)].join("\n"),
    ephemeral: true,
  });
  return;
}
```

For `dashboard_stats`, mirror `/stats` behavior:

```ts
if (interaction.customId === "dashboard_stats") {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const activeTournaments = deps.tournaments.activeForPlayer(guildId, player.id);
  if (activeTournaments.length === 1) {
    const tournament = activeTournaments[0];
    await interaction.reply({ content: formatStats(`${player.displayName} in ${tournament.name}`, deps.tournaments.stats(tournament.id, player.id)), ephemeral: true });
    return;
  }
  await interaction.reply({ content: formatStats(player.displayName, deps.matches.stats(player.id)), ephemeral: true });
  return;
}
```

Add `matches: MatchService` to `ButtonDependencies` and update test setup.

**Step 5: Run tests to verify they pass**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: changed service, button, and test files.

---

### Task 5: Add Report Match Flow

**Files:**
- Modify: `src/services/tournaments.ts`
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write failing tests**

Add a test that `dashboard_report_match` lists open matches for the user's only active tournament:

```ts
it("starts dashboard match reporting for a user's active tournament", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
  app.tournaments.join(tournament.id, yugi.id);
  app.tournaments.join(tournament.id, kaiba.id);
  app.tournaments.start(tournament.id);
  const openMatch = app.tournaments.openMatches(tournament.id)[0];
  const { interaction, replies } = fakeButton({ customId: "dashboard_report_match" });

  await handleButton(interaction, app);

  expect(replies[0]).toMatchObject({ content: expect.stringContaining("Choose a match"), ephemeral: true });
  expect(replies[0].content).toContain("Kaiba");
  expect(JSON.stringify(replies[0])).toContain(`dashboard_report_match:${openMatch.id}`);
});
```

Add a test that choosing a result creates a pending report:

```ts
it("reports a dashboard match result from buttons", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
  app.tournaments.join(tournament.id, yugi.id);
  app.tournaments.join(tournament.id, kaiba.id);
  app.tournaments.start(tournament.id);
  const openMatch = app.tournaments.openMatches(tournament.id)[0];
  const { interaction, replies } = fakeButton({ customId: `dashboard_report_result:${openMatch.id}:win` });

  await handleButton(interaction, app);

  expect(replies[0]).toEqual({
    content: expect.stringContaining("Match reported as win"),
    ephemeral: true,
  });
  expect(app.tournaments.openMatches(tournament.id)[0].status).toBe("pending_approval");
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because reporting buttons are unsupported.

**Step 3: Add tournament match lookup helpers**

In `src/services/tournaments.ts`, add:

```ts
findTournamentMatchById(tournamentMatchId: number): TournamentMatch {
  const row = db.prepare("select * from tournament_matches where id = ?").get(tournamentMatchId);
  if (!row) {
    throw new Error("Tournament match not found");
  }
  return mapTournamentMatch(row);
},

openMatchesForPlayer(tournamentId: number, playerId: number): TournamentMatch[] {
  return db
    .prepare(
      `
      select * from tournament_matches
      where tournament_id = ?
        and status = 'open'
        and (player_one_id = ? or player_two_id = ?)
      order by round_number asc, id asc
    `,
    )
    .all(tournamentId, playerId, playerId)
    .map(mapTournamentMatch);
},
```

**Step 4: Add player-name helper in button module**

Use `deps.tournaments.participantRecords(tournamentId)` to map player IDs to display names. Keep this local to avoid a larger repository change.

**Step 5: Implement `dashboard_report_match`**

In `src/interactions/buttons.ts`:

```ts
if (interaction.customId === "dashboard_report_match") {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const activeTournaments = deps.tournaments.activeForPlayer(guildId, player.id);

  if (activeTournaments.length === 0) {
    await interaction.reply({ content: "You are not in any active tournaments with matches to report.", ephemeral: true });
    return;
  }

  if (activeTournaments.length > 1) {
    await interaction.reply({
      content: "Choose a tournament to report from:",
      ephemeral: true,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...activeTournaments.slice(0, 5).map((tournament) =>
          new ButtonBuilder().setCustomId(`dashboard_report_tournament:${tournament.id}`).setLabel(tournament.name.slice(0, 80)).setStyle(ButtonStyle.Primary),
        ),
      )],
    });
    return;
  }

  await interaction.reply(reportMatchChoicesReply(deps, activeTournaments[0].id, player.id));
  return;
}
```

Add `dashboard_report_tournament:<id>` to call the same `reportMatchChoicesReply` helper after validating the tournament belongs to the guild and the user participates.

**Step 6: Implement match choice and result buttons**

For `dashboard_report_match:<tournamentMatchId>`, show:

```ts
components: [
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`dashboard_report_result:${match.id}:win`).setLabel("I Won").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dashboard_report_result:${match.id}:loss`).setLabel("I Lost").setStyle(ButtonStyle.Danger),
  ),
]
```

For `dashboard_report_result:<tournamentMatchId>:win|loss`:

- Load guild ID and player.
- Load tournament match by ID.
- Load tournament by `match.tournamentId`.
- Validate tournament guild matches interaction guild.
- Validate user is `playerOneId` or `playerTwoId`.
- Determine opponent ID.
- Winner is reporter for `win`, opponent for `loss`.
- Call `deps.tournaments.report(tournament.id, reporter.id, opponentId, winnerId)`.
- Reply privately with `Match reported as win. Your opponent must approve or deny it. Match #<id>`.

**Step 7: Run tests to verify they pass**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 8: Check worktree**

Run: `git status --short`

Expected: changed tournament service, button, and test files.

---

### Task 6: Add Pending Approval Buttons

**Files:**
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write failing tests**

Add a test that pending approvals show approve and deny buttons:

```ts
it("shows pending approvals with approve and deny buttons", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const match = app.matches.report({ guildId: "guild-1", reporterId: yugi.id, opponentId: kaiba.id, winnerId: yugi.id, source: "casual" });
  const { interaction, replies } = fakeButton({ customId: "dashboard_pending_approvals", user: { id: "user-2", username: "Kaiba" } });

  await handleButton(interaction, app);

  expect(replies[0].content).toContain(`Match #${match.id}`);
  expect(JSON.stringify(replies[0])).toContain(`dashboard_approve:${match.id}`);
  expect(JSON.stringify(replies[0])).toContain(`dashboard_deny:${match.id}`);
});
```

Add a test that approve resolves a match:

```ts
it("approves a match from the dashboard", async () => {
  const app = setup();
  const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
  const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
  const match = app.matches.report({ guildId: "guild-1", reporterId: yugi.id, opponentId: kaiba.id, winnerId: yugi.id, source: "casual" });
  const { interaction, replies } = fakeButton({ customId: `dashboard_approve:${match.id}`, user: { id: "user-2", username: "Kaiba" } });

  await handleButton(interaction, app);

  expect(replies[0]).toEqual({ content: `Approved match #${match.id}.`, ephemeral: true });
  expect(app.matches.stats(yugi.id)).toEqual({ wins: 1, losses: 0 });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because approval buttons are unsupported.

**Step 3: Implement pending approvals list**

For `dashboard_pending_approvals`:

- Upsert current user.
- Call `deps.matches.latestPendingForOpponent(player.id)`.
- If missing, reply `You have no pending approvals.`.
- If present, show match ID and approve/deny buttons.

**Step 4: Implement approve and deny buttons**

For `dashboard_approve:<matchId>`:

- Upsert current user.
- Call `deps.matches.approve(matchId, player.id)`.
- Reply `Approved match #<id>.`.

For `dashboard_deny:<matchId>`:

- Upsert current user.
- Call `deps.matches.deny(matchId, player.id)`.
- Reply `Denied match #<id>.`.

Let `MatchService` enforce opponent-only authorization.

**Step 5: Run tests to verify they pass**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: changed button and test files.

---

### Task 7: Add Creator Tools Button

**Files:**
- Modify: `src/interactions/buttons.ts`
- Test: `tests/interactions/buttons.test.ts`

**Step 1: Write failing test**

Add:

```ts
it("shows creator tools for tournaments created by the user", async () => {
  const app = setup();
  const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
  const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools" });

  await handleButton(interaction, app);

  expect(replies[0].content).toContain("Creator tools");
  expect(replies[0].content).toContain("locals");
  expect(JSON.stringify(replies[0])).toContain(`dashboard_start:${tournament.id}`);
  expect(JSON.stringify(replies[0])).toContain(`dashboard_cancel:${tournament.id}`);
});
```

Add one authorization test for direct action button:

```ts
it("rejects non-creators from dashboard cancel", async () => {
  const app = setup();
  const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
  const { interaction } = fakeButton({ customId: `dashboard_cancel:${tournament.id}` });

  await expect(handleButton(interaction, app)).rejects.toThrow("Only the event creator can do that");
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because creator buttons are unsupported.

**Step 3: Add creator tools list**

Use existing `deps.tournaments.autocomplete({ guildId, query: "", statuses: ["pending", "active"], createdByUserId: interaction.user.id })` to avoid a new service method.

Reply with at most one or two tournaments initially. Prefer the first tournament to keep buttons under Discord row limits.

**Step 4: Implement creator action buttons**

For `dashboard_start:<tournamentId>`:

- Load tournament.
- Validate guild.
- Validate creator.
- Call `deps.tournaments.start(tournament.id)`.
- Reply privately.

For `dashboard_cancel:<tournamentId>`:

- Load tournament.
- Validate guild.
- Validate creator.
- Call `deps.tournaments.cancel(tournament.id)`.
- Reply privately.

For `dashboard_participants:<tournamentId>`:

- Load tournament and validate guild.
- Use `deps.tournaments.participantRecords(tournament.id)`.
- Reply privately with participants.

For signup post, do not send a public signup post from an ephemeral dashboard button in v1 unless the target channel behavior is explicitly chosen. Show guidance: `Use /event signup name:<name> to post a public signup message.`

**Step 5: Run tests to verify they pass**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: changed button and test files.

---

### Task 8: Update Help Text And Docs

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `README.md`
- Test: `tests/commands/handlers.test.ts`

**Step 1: Write failing test**

Update `/help` test to expect `/event dashboard`.

```ts
expect(replies[0]).toEqual(expect.stringContaining("/event dashboard"));
```

**Step 2: Run test to verify it fails if not already added**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: FAIL until help text includes dashboard.

**Step 3: Update help text**

In `src/commands/handlers.ts`, include `/event dashboard` first in the tournament commands line.

**Step 4: Update README**

In `README.md`, add a short section:

```md
### Tournament Dashboard

Use `/event dashboard` to open a private control panel. It lets you see open events, join with a button, report tournament matches, approve or deny pending results, view stats, and find creator tools without remembering every command.
```

**Step 5: Run focused tests**

Run: `npm test -- tests/commands/handlers.test.ts tests/interactions/buttons.test.ts`

Expected: PASS.

**Step 6: Check worktree**

Run: `git status --short`

Expected: README, command handler, and tests changed.

---

### Task 9: Final Verification

**Files:**
- Verify all changed files.

**Step 1: Run full tests**

Run: `npm test`

Expected: all tests pass.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: no TypeScript errors.

**Step 3: Run build**

Run: `npm run build`

Expected: build succeeds.

**Step 4: Build Docker image**

Run: `docker compose build`

Expected: image builds successfully.

**Step 5: Review diff**

Run: `git diff -- src/commands/definitions.ts src/commands/handlers.ts src/interactions/buttons.ts src/services/tournaments.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts README.md docs/plans/2026-04-29-tournament-dashboard-design.md docs/plans/2026-04-29-tournament-dashboard.md`

Expected: changes match the dashboard design and no unrelated files are modified.

**Step 6: Commit only if requested**

If the user explicitly asks for a commit, run the required git safety checks first, then commit with:

```bash
git add src/commands/definitions.ts src/commands/handlers.ts src/interactions/buttons.ts src/services/tournaments.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts README.md docs/plans/2026-04-29-tournament-dashboard-design.md docs/plans/2026-04-29-tournament-dashboard.md
git commit -m "feat: add tournament dashboard"
```
