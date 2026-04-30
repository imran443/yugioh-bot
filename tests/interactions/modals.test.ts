import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CommandReplyLike } from "../../src/commands/handlers.js";
import { migrate } from "../../src/db/schema.js";
import { handleModal, type ModalInteractionLike } from "../../src/interactions/modals.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    tournaments: createTournamentService(db),
  };
}

function fakeModal(input: {
  customId?: string;
  fields?: Record<string, string>;
  guildId?: string | null;
  user?: { id: string; username: string };
}) {
  const replies: CommandReplyLike[] = [];
  const fields = input.fields ?? {};
  const interaction: ModalInteractionLike = {
    customId: input.customId ?? "dashboard_create_event",
    guildId: input.guildId === undefined ? "guild-1" : input.guildId,
    user: input.user ?? { id: "user-1", username: "Yugi" },
    fields: {
      getTextInputValue: (name) => fields[name] ?? "",
    },
    reply: (message) => {
      replies.push(message);
    },
  };

  return { interaction, replies };
}

describe("modal interactions", () => {
  it("creates an event from the dashboard modal", async () => {
    const app = setup();
    const { interaction, replies } = fakeModal({
      customId: "dashboard_create_event:round_robin",
      fields: { name: "locals" },
    });

    await handleModal(interaction, app);

    expect(app.tournaments.findByName("guild-1", "locals")?.createdByUserId).toBe("user-1");
    expect(replies[0]).toMatchObject({
      content:
        "Signups are open for locals (round_robin). Click Join Tournament to enter.",
    });
    expect(replies[0]).not.toHaveProperty("ephemeral", true);
    expect(JSON.stringify(replies[0])).toContain("join_tournament");
  });

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

  it("rejects duplicate pending dashboard modal event names", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const { interaction } = fakeModal({
      customId: "dashboard_create_event:single_elim",
      fields: { name: "locals" },
    });

    await expect(handleModal(interaction, app)).rejects.toThrow(
      "An active or pending tournament already uses that name",
    );
  });
});
