import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleButton, type ButtonInteractionLike } from "../../src/interactions/buttons.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

function fakeButton(input: Partial<ButtonInteractionLike> = {}) {
  const replies: Array<{ content: string; ephemeral?: boolean }> = [];
  const interaction: ButtonInteractionLike = {
    customId: "join_tournament:1",
    guildId: "guild-1",
    user: { id: "user-1", username: "Yugi" },
    reply: (message) => {
      replies.push(message);
    },
    ...input,
  };

  return { interaction, replies };
}

describe("button interactions", () => {
  it("joins a pending tournament and replies ephemerally", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction, replies } = fakeButton({ customId: `join_tournament:${tournament.id}` });

    await handleButton(interaction, app);

    const player = app.players.findByDiscordId("guild-1", "user-1")!;
    expect(app.tournaments.participants(tournament.id)).toEqual([player.id]);
    expect(replies[0]).toEqual({ content: "Joined event: locals.", ephemeral: true });
  });

  it("rejects non-join button custom IDs", async () => {
    const app = setup();
    const { interaction } = fakeButton({ customId: "other:1" });

    await expect(handleButton(interaction, app)).rejects.toThrow("Unsupported button interaction");
  });

  it("requires a guild", async () => {
    const app = setup();
    const { interaction } = fakeButton({ guildId: null });

    await expect(handleButton(interaction, app)).rejects.toThrow("This interaction can only be used in a server");
  });

  it("rejects button clicks from a different guild", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction } = fakeButton({
      customId: `join_tournament:${tournament.id}`,
      guildId: "guild-2",
    });

    await expect(handleButton(interaction, app)).rejects.toThrow("Tournament not found in this server");
    expect(app.players.findByDiscordId("guild-2", "user-1")).toBeUndefined();
    expect(app.tournaments.participants(tournament.id)).toEqual([]);
  });
});
