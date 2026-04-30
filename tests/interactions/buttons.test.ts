import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleButton, type ButtonInteractionLike } from "../../src/interactions/buttons.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    matches: createMatchService(db),
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

function fakeButton(input: Partial<ButtonInteractionLike> = {}) {
  const replies: Array<{ content: string; ephemeral?: boolean; components?: readonly unknown[] }> = [];
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

  it("shows dashboard help privately", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "dashboard_help" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Tournament commands"),
      ephemeral: true,
    });
  });

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

  it("limits the user's tournament list to fit Discord replies", async () => {
    const app = setup();
    const player = app.players.upsert("guild-1", "user-1", "Yugi");

    for (let index = 1; index <= 30; index += 1) {
      const tournament = app.tournaments.create(
        "guild-1",
        `event-${index.toString().padStart(2, "0")}-${"x".repeat(80)}`,
        "round_robin",
        "creator-1",
      );
      app.tournaments.join(tournament.id, player.id);
    }

    const { interaction, replies } = fakeButton({ customId: "dashboard_my_events" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("...and 20 more event(s).");
    expect(replies[0].content.length).toBeLessThanOrEqual(2000);
  });

  it("shows dashboard stats privately", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "dashboard_stats" });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: "Yugi: 0W - 0L (0% win rate)", ephemeral: true });
  });

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

  it("rejects stale dashboard match result buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);
    const openMatch = app.tournaments.openMatches(tournament.id)[0];
    app.tournaments.report(tournament.id, yugi.id, kaiba.id, yugi.id);
    const { interaction } = fakeButton({ customId: `dashboard_report_result:${openMatch.id}:win` });

    await expect(handleButton(interaction, app)).rejects.toThrow("Tournament match is not open");
  });

  it("shows pending approvals with approve and deny buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const match = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    const { interaction, replies } = fakeButton({
      customId: "dashboard_pending_approvals",
      user: { id: "user-2", username: "Kaiba" },
    });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain(`Match #${match.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_approve:${match.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_deny:${match.id}`);
  });

  it("approves a match from the dashboard", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const match = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    const { interaction, replies } = fakeButton({
      customId: `dashboard_approve:${match.id}`,
      user: { id: "user-2", username: "Kaiba" },
    });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: `Approved match #${match.id}.`, ephemeral: true });
    expect(app.matches.stats(yugi.id)).toEqual({ wins: 1, losses: 0 });
  });

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

  it("lets creators choose which event to manage when they own multiple events", async () => {
    const app = setup();
    const locals = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const weekly = app.tournaments.create("guild-1", "weekly", "single_elim", "user-1");
    const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("Choose an event to manage");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${locals.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${weekly.id}`);
  });

  it("paginates creator tools when a creator owns more than five events", async () => {
    const app = setup();
    const tournaments = [];

    for (let index = 1; index <= 6; index += 1) {
      tournaments.push(app.tournaments.create("guild-1", `event-${index}`, "round_robin", "user-1"));
    }

    const firstPage = fakeButton({ customId: "dashboard_creator_tools" });
    await handleButton(firstPage.interaction, app);

    expect(JSON.stringify(firstPage.replies[0])).toContain("dashboard_creator_tools_page:5");
    expect(JSON.stringify(firstPage.replies[0])).not.toContain(`dashboard_creator_event:${tournaments[5].id}`);

    const secondPage = fakeButton({ customId: "dashboard_creator_tools_page:5" });
    await handleButton(secondPage.interaction, app);

    expect(secondPage.replies[0].content).toContain("event-6");
    expect(JSON.stringify(secondPage.replies[0])).toContain(`dashboard_creator_event:${tournaments[5].id}`);
    expect(JSON.stringify(secondPage.replies[0])).toContain("dashboard_creator_tools_page:0");
  });

  it("paginates creator tools beyond autocomplete limits", async () => {
    const app = setup();
    const tournaments = [];

    for (let index = 1; index <= 26; index += 1) {
      tournaments.push(app.tournaments.create("guild-1", `event-${index}`, "round_robin", "user-1"));
    }

    const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools_page:25" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("event-26");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${tournaments[25].id}`);
  });

  it("shows creator actions for a selected creator event", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const { interaction, replies } = fakeButton({ customId: `dashboard_creator_event:${tournament.id}` });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("Creator tools: locals");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_start:${tournament.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_cancel:${tournament.id}`);
  });

  it("rejects non-creators from dashboard cancel", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction } = fakeButton({ customId: `dashboard_cancel:${tournament.id}` });

    await expect(handleButton(interaction, app)).rejects.toThrow("Only the event creator can do that");
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
