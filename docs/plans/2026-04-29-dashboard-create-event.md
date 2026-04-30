# Dashboard Create Event Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dashboard-driven tournament creation using a format select followed by a name-only Discord modal.

**Architecture:** Add a `Create Event` dashboard button that replies with a format select menu. Add a select-menu handler that opens a name-only modal with the selected format encoded in the modal custom ID. Add a modal interaction handler that validates `name`, reads the format from the custom ID, and reuses `TournamentService.create`.

**Tech Stack:** TypeScript, discord.js modal builders, better-sqlite3, Vitest, Docker Compose.

---

### Task 1: Dashboard Create Button

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `tests/commands/handlers.test.ts`

**Step 1: Write the failing test**

Update the `/event dashboard replies privately with dashboard buttons` test to assert the dashboard includes `dashboard_create_event`.

```ts
expect(JSON.stringify(replies[0])).toContain("dashboard_create_event");
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: FAIL because the dashboard does not include the create button yet.

**Step 3: Add the dashboard button**

In `src/commands/handlers.ts`, add a `Create Event` button to the first dashboard action row:

```ts
new ButtonBuilder()
  .setCustomId("dashboard_create_event")
  .setLabel("Create Event")
  .setStyle(ButtonStyle.Primary),
```

Keep total buttons per row at five or fewer.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/commands/handlers.test.ts`

Expected: PASS.

---

### Task 2: Create Event Button Shows Format Select

**Files:**
- Modify: `src/interactions/buttons.ts`
- Modify: `tests/interactions/buttons.test.ts`

**Step 1: Write the failing test**

Add:

```ts
it("shows a create event format select from the dashboard", async () => {
  const app = setup();
  const { interaction, replies } = fakeButton({ customId: "dashboard_create_event" });

  await handleButton(interaction, app);

  expect(replies[0]).toMatchObject({ content: "Choose a tournament format:", ephemeral: true });
  expect(JSON.stringify(replies[0])).toContain("dashboard_create_event_format");
  expect(JSON.stringify(replies[0])).toContain("round_robin");
  expect(JSON.stringify(replies[0])).toContain("single_elim");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: FAIL because `dashboard_create_event` does not show the select yet.

**Step 3: Add select response**

In `src/interactions/buttons.ts`, import `StringSelectMenuBuilder` and add:


```ts
if (interaction.customId === "dashboard_create_event") {
  await interaction.reply({
    content: "Choose a tournament format:",
    ephemeral: true,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("dashboard_create_event_format")
          .setPlaceholder("Select tournament format")
          .addOptions(
            { label: "Round Robin", value: "round_robin" },
            { label: "Single Elimination", value: "single_elim" },
          ),
      ),
    ],
  });
  return;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/interactions/buttons.test.ts`

Expected: PASS.

---

### Task 3: Select Menu Opens Name Modal

**Files:**
- Create: `src/interactions/select-menus.ts`
- Create: `tests/interactions/select-menus.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**

Create `tests/interactions/select-menus.test.ts` with tests that `dashboard_create_event_format` opens a modal with custom ID `dashboard_create_event:<format>` and only a `name` input.

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/interactions/select-menus.test.ts`

Expected: FAIL because the select-menu module does not exist.

**Step 3: Implement select-menu handler**

Create `src/interactions/select-menus.ts` to validate `round_robin` or `single_elim`, then call `showModal` with `dashboard_create_event:<format>` and one `name` text input.

**Step 4: Wire select menus in index**

In `src/index.ts`, route `interaction.isStringSelectMenu()` to `handleSelectMenu`.

**Step 5: Run tests to verify they pass**

Run: `npm test -- tests/interactions/select-menus.test.ts tests/interactions/buttons.test.ts`

Expected: PASS.

---

### Task 4: Modal Submit Creates Event

**Files:**
- Create: `src/interactions/modals.ts`
- Create: `tests/interactions/modals.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**

Create `tests/interactions/modals.test.ts` with setup mirroring button tests.

Test valid creation:

```ts
it("creates an event from the dashboard modal", async () => {
  const app = setup();
  const { interaction, replies } = fakeModal({
    customId: "dashboard_create_event:round_robin",
    fields: { name: "locals" },
  });

  await handleModal(interaction, app);

  expect(app.tournaments.findByName("guild-1", "locals")?.createdByUserId).toBe("user-1");
  expect(replies[0]).toEqual({
    content: "Event created: locals (round_robin). Use Creator Tools or /event signup name:locals to manage signups.",
    ephemeral: true,
  });
});
```

Test invalid format:

```ts
it("rejects unsupported dashboard modal formats", async () => {
  const app = setup();
  const { interaction, replies } = fakeModal({
    customId: "dashboard_create_event:swiss",
    fields: { name: "locals" },
  });

  await handleModal(interaction, app);

  expect(app.tournaments.findByName("guild-1", "locals")).toBeUndefined();
  expect(replies[0]).toEqual({
    content: "Format must be round_robin or single_elim.",
    ephemeral: true,
  });
});
```

Test duplicate name:

```ts
it("rejects duplicate pending dashboard modal event names", async () => {
  const app = setup();
  app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
  const { interaction } = fakeModal({
    customId: "dashboard_create_event:single_elim",
    fields: { name: "locals" },
  });

  await expect(handleModal(interaction, app)).rejects.toThrow("An active or pending tournament already uses that name");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/interactions/modals.test.ts`

Expected: FAIL because `src/interactions/modals.ts` does not exist.

**Step 3: Implement modal handler**

Create `src/interactions/modals.ts`:

```ts
import type { DiscordUserLike } from "../commands/handlers.js";
import type { TournamentFormat, TournamentService } from "../services/tournaments.js";

export type ModalInteractionLike = {
  customId: string;
  guildId: string | null;
  user: DiscordUserLike;
  fields: { getTextInputValue(name: string): string };
  reply(message: { content: string; ephemeral: boolean }): Promise<void> | void;
};

type ModalDependencies = {
  tournaments: TournamentService;
};

function requireGuildId(interaction: ModalInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This interaction can only be used in a server");
  }
  return interaction.guildId;
}

function parseFormat(value: string): TournamentFormat | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "round_robin" || normalized === "single_elim") {
    return normalized;
  }
  return undefined;
}

export async function handleModal(interaction: ModalInteractionLike, deps: ModalDependencies): Promise<void> {
  if (interaction.customId !== "dashboard_create_event") {
    throw new Error("Unsupported modal interaction");
  }

  const guildId = requireGuildId(interaction);
  const name = interaction.fields.getTextInputValue("name").trim();
  const format = parseFormat(interaction.fields.getTextInputValue("format"));

  if (!name) {
    await interaction.reply({ content: "Event name is required.", ephemeral: true });
    return;
  }

  if (!format) {
    await interaction.reply({ content: "Format must be round_robin or single_elim.", ephemeral: true });
    return;
  }

  const tournament = deps.tournaments.create(guildId, name, format, interaction.user.id);
  await interaction.reply({
    content: `Event created: ${tournament.name} (${tournament.format}). Use Creator Tools or /event signup name:${tournament.name} to manage signups.`,
    ephemeral: true,
  });
}
```

**Step 4: Wire modal interactions in index**

In `src/index.ts`, import `handleModal` and add before chat command handling:

```ts
if (interaction.isModalSubmit()) {
  await handleModal(toModalInteraction(interaction), deps);
  return;
}
```

Add `toModalInteraction` mapping `customId`, `guildId`, `user`, `fields`, and `reply`.

**Step 5: Run tests to verify they pass**

Run: `npm test -- tests/interactions/modals.test.ts tests/interactions/buttons.test.ts tests/commands/handlers.test.ts`

Expected: PASS.

---

### Task 4: Final Verification

**Files:**
- Verify all changed files.

**Step 1: Run tests**

Run: `npm test`

Expected: all tests pass.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: no TypeScript errors.

**Step 3: Run build**

Run: `npm run build`

Expected: build succeeds.

**Step 4: Run Docker build**

Run: `docker compose build`

Expected: image builds successfully.

**Step 5: Commit only if requested**

If the user asks for a commit, commit with:

```bash
git add src/commands/handlers.ts src/interactions/buttons.ts src/interactions/modals.ts src/index.ts tests/commands/handlers.test.ts tests/interactions/buttons.test.ts tests/interactions/modals.test.ts docs/plans/2026-04-29-dashboard-create-event-design.md docs/plans/2026-04-29-dashboard-create-event.md
git commit -m "feat: add dashboard event creation"
```
