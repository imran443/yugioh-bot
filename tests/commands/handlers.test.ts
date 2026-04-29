import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleCommand, type CommandInteractionLike } from "../../src/commands/handlers.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

type FakeUser = { id: string; username: string };

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const players = createPlayerRepository(db);
  const matches = createMatchService(db);
  const tournaments = createTournamentService(db);

  return { matches, players, tournaments };
}

function fakeInteraction(input: {
  commandName: string;
  user: FakeUser;
  subcommand?: string;
  users?: Record<string, FakeUser>;
  strings?: Record<string, string>;
}) {
  const replies: string[] = [];
  const interaction: CommandInteractionLike = {
    commandName: input.commandName,
    guildId: "guild-1",
    user: input.user,
    options: {
      getSubcommand: () => input.subcommand ?? "",
      getString: (name) => input.strings?.[name] ?? null,
      getUser: (name) => input.users?.[name] ?? null,
    },
    reply: (message) => {
      replies.push(typeof message === "string" ? message : message.content);
    },
  };

  return { interaction, replies };
}

describe("command handlers", () => {
  it("/duel creates a pending match and /approve finalizes it", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "duel",
        user: yugi,
        users: { player: kaiba },
        strings: { result: "win" },
      }).interaction,
      app,
    );

    const kaibaPlayer = app.players.findByDiscordId("guild-1", kaiba.id)!;
    expect(app.matches.latestPendingForPlayer(kaibaPlayer.id)?.status).toBe("pending");

    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const yugiPlayer = app.players.findByDiscordId("guild-1", yugi.id)!;
    expect(app.matches.stats(yugiPlayer.id)).toEqual({ wins: 1, losses: 0 });
  });

  it("/stats replies with a player's record", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toContain("Yugi: 0W - 0L");
  });

  it("handles event create, join, start, report, and cancel", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "join", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "join", user: kaiba, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.openMatches(tournament.id)).toHaveLength(1);

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "locals", result: "win" },
      }).interaction,
      app,
    );

    expect(app.tournaments.openMatches(tournament.id)[0].status).toBe("pending_approval");

    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "cancel", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    expect(app.tournaments.findByName("guild-1", "locals")?.status).toBe("cancelled");
  });

  it("prevents non-creators from starting or cancelling events", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "start", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "cancel", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");
  });
});
