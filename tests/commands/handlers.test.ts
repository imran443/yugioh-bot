import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleCommand, type CommandInteractionLike } from "../../src/commands/handlers.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

type FakeUser = { id: string; username: string };
type FakeRole = { id: string; name: string };

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
  roles?: Record<string, FakeRole>;
  users?: Record<string, FakeUser>;
  strings?: Record<string, string>;
}) {
  const replies: Array<string | { content: string; components?: readonly unknown[] }> = [];
  const interaction: CommandInteractionLike = {
    commandName: input.commandName,
    guildId: "guild-1",
    user: input.user,
    options: {
      getSubcommand: () => input.subcommand ?? "",
      getString: (name) => input.strings?.[name] ?? null,
      getRole: (name) => input.roles?.[name] ?? null,
      getUser: (name) => input.users?.[name] ?? null,
    },
    reply: (message) => {
      replies.push(message);
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

  it("/stats with a tournament replies with tournament-only approved stats", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "loss" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
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
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({
      commandName: "stats",
      user: yugi,
      strings: { tournament: "locals" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi in locals: 1W - 0L (100% win rate)");
  });

  it("/stats without a tournament uses the only active tournament for the target player", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "loss" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
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
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi in locals: 1W - 0L (100% win rate)");
  });

  it("/stats player applies active tournament context to the target player", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
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
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi, users: { player: kaiba } });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Kaiba in locals: 0W - 1L (0% win rate)");
  });

  it("/stats without a tournament falls back to lifetime stats when the player has no active tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "win" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi: 1W - 0L (100% win rate)");
  });

  it("/stats without a tournament asks for scope when the player has multiple active tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    for (const name of ["locals", "regionals"]) {
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          users: { player1: yugi, player2: kaiba },
          strings: { name, format: "round_robin" },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name } }).interaction,
        app,
      );
    }

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi is in multiple active tournaments. Specify one with tournament: locals, regionals");
  });

  it("/stats with an unknown tournament rejects the name", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "stats", user: yugi, strings: { tournament: "missing" } }).interaction,
        app,
      ),
    ).rejects.toThrow("Tournament not found: missing");
  });

  it("/event list shows active tournaments before pending tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "active cup", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi },
        strings: { name: "pending cup", format: "single_elim" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "active cup" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "active cup", result: "win" },
      }).interaction,
      app,
    );

    const { interaction, replies } = fakeInteraction({ commandName: "event", subcommand: "list", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe(
      "Active events:\n- active cup (round_robin): 0 open match(es)\nPending events:\n- pending cup (single_elim): 1 participant(s)",
    );
  });

  it("/event signup requires the creator and posts a join button", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };
    const role = { id: "role-1", name: "Duelists" };

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
        fakeInteraction({ commandName: "event", subcommand: "signup", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");

    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "signup",
      user: yugi,
      roles: { role },
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(replies[0]).toMatchObject({
      content: `<@&${role.id}> Signups are open for locals (round_robin). Click Join Tournament to enter.`,
    });
    expect(replies[0]).not.toHaveProperty("ephemeral", true);
    expect(JSON.parse(JSON.stringify(replies[0])).components[0].components[0].custom_id).toBe(
      `join_tournament:${tournament.id}`,
    );
  });

  it("/event signup only works for pending tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "signup", user: yugi, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Tournament has already started");
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

  it("/event create seeds unique provided players", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };
    const joey = { id: "user-3", username: "Joey" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "create",
      user: yugi,
      users: { player1: yugi, player2: kaiba, player3: yugi, player4: joey },
      strings: { name: "locals", format: "round_robin" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.participants(tournament.id)).toHaveLength(3);
    expect(replies[0]).toBe("Event created: locals (round_robin). Seeded 3 participant(s).");
  });

  it("/event create without seeded players still works", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "create",
      user: yugi,
      strings: { name: "locals", format: "round_robin" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.participants(tournament.id)).toHaveLength(0);
    expect(replies[0]).toBe("Event created: locals (round_robin).");
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
