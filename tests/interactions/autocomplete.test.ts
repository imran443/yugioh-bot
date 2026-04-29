import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  handleAutocomplete,
  type AutocompleteInteractionLike,
} from "../../src/interactions/autocomplete.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    db,
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

function fakeAutocomplete(input: Partial<AutocompleteInteractionLike> = {}) {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction: AutocompleteInteractionLike = {
    commandName: "event",
    guildId: "guild-1",
    user: { id: "creator-1", username: "Yugi" },
    options: {
      getSubcommand: () => "signup",
      getFocused: () => ({ name: "name", value: "cup" }),
    },
    respond: (choices) => {
      responses.push(choices);
    },
    ...input,
  };

  return { interaction, responses };
}

describe("autocomplete interactions", () => {
  function startTournament(app: ReturnType<typeof setup>, name: string, createdByUserId = "creator-1") {
    const tournament = app.tournaments.create("guild-1", name, "round_robin", createdByUserId);
    const yugi = app.players.upsert("guild-1", "creator-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", `${name}-user-2`, "Kaiba");
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);

    return app.tournaments.start(tournament.id);
  }

  function completeTournament(app: ReturnType<typeof setup>, tournamentId: number) {
    app.db.prepare("update tournaments set status = 'completed' where id = ?").run(tournamentId);
  }

  it("suggests pending signup tournaments created by the user", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    app.tournaments.create("guild-1", "Other Cup", "round_robin", "other-user");
    app.tournaments.create("guild-2", "Other Guild Cup", "round_robin", "creator-1");
    const activeTournament = app.tournaments.create("guild-1", "Active Cup", "round_robin", "creator-1");
    const yugi = app.players.upsert("guild-1", "creator-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    app.tournaments.join(activeTournament.id, yugi.id);
    app.tournaments.join(activeTournament.id, kaiba.id);
    app.tournaments.start(activeTournament.id);
    const { interaction, responses } = fakeAutocomplete();

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([{ name: "Creator Cup", value: "Creator Cup" }]);
  });

  it("suggests pending start tournaments created by the user", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    app.tournaments.create("guild-1", "Other Cup", "round_robin", "other-user");
    startTournament(app, "Active Cup");
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "start", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([{ name: "Creator Cup", value: "Creator Cup" }]);
  });

  it("suggests show tournaments in any status for the current guild", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Pending Cup", "round_robin", "creator-1");
    startTournament(app, "Active Cup");
    const cancelled = app.tournaments.create("guild-1", "Cancelled Cup", "round_robin", "creator-1");
    const completed = startTournament(app, "Completed Cup");
    app.tournaments.create("guild-2", "Other Guild Cup", "round_robin", "creator-1");
    app.tournaments.cancel(cancelled.id);
    completeTournament(app, completed.id);
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "show", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([
      { name: "Pending Cup", value: "Pending Cup" },
      { name: "Active Cup", value: "Active Cup" },
      { name: "Cancelled Cup", value: "Cancelled Cup" },
      { name: "Completed Cup", value: "Completed Cup" },
    ]);
  });

  it("suggests active report tournaments where the user is a participant", async () => {
    const app = setup();
    startTournament(app, "Participant Cup");
    const nonParticipant = app.tournaments.create("guild-1", "Other Cup", "round_robin", "other-user");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    app.tournaments.join(nonParticipant.id, kaiba.id);
    app.tournaments.join(nonParticipant.id, joey.id);
    app.tournaments.start(nonParticipant.id);
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "report", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([{ name: "Participant Cup", value: "Participant Cup" }]);
  });

  it("does not create a player while suggesting report tournaments", async () => {
    const app = setup();
    startTournament(app, "Participant Cup");
    const { interaction, responses } = fakeAutocomplete({
      user: { id: "missing-user", username: "Missing" },
      options: { getSubcommand: () => "report", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
    expect(app.players.findByDiscordId("guild-1", "missing-user")).toBeUndefined();
  });

  it("suggests pending or active cancel tournaments created by the user", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Pending Cup", "round_robin", "creator-1");
    startTournament(app, "Active Cup");
    app.tournaments.create("guild-1", "Other Cup", "round_robin", "other-user");
    const completed = startTournament(app, "Completed Cup");
    completeTournament(app, completed.id);
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "cancel", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([
      { name: "Pending Cup", value: "Pending Cup" },
      { name: "Active Cup", value: "Active Cup" },
    ]);
  });

  it("suggests active and completed tournaments for stats", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Pending Cup", "round_robin", "creator-1");
    startTournament(app, "Active Cup");
    const completed = startTournament(app, "Completed Cup");
    completeTournament(app, completed.id);
    const { interaction, responses } = fakeAutocomplete({
      commandName: "stats",
      options: { getSubcommand: () => "", getFocused: () => ({ name: "tournament", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([
      { name: "Active Cup", value: "Active Cup" },
      { name: "Completed Cup", value: "Completed Cup" },
    ]);
  });

  it("returns no choices for unsupported command autocomplete contexts", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    const { interaction, responses } = fakeAutocomplete({ commandName: "duel" });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });

  it("returns no choices for unsupported event subcommands", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "unknown", getFocused: () => ({ name: "name", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });

  it("returns no choices outside a guild", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    const { interaction, responses } = fakeAutocomplete({ guildId: null });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });

  it("returns no choices for event autocomplete on unsupported focused options", async () => {
    const app = setup();
    app.tournaments.create("guild-1", "Creator Cup", "round_robin", "creator-1");
    const { interaction, responses } = fakeAutocomplete({
      options: { getSubcommand: () => "signup", getFocused: () => ({ name: "role", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });

  it("returns no choices for stats autocomplete on unsupported focused options", async () => {
    const app = setup();
    startTournament(app, "Active Cup");
    const { interaction, responses } = fakeAutocomplete({
      commandName: "stats",
      options: { getSubcommand: () => "", getFocused: () => ({ name: "player", value: "cup" }) },
    });

    await handleAutocomplete(interaction, app);

    expect(responses[0]).toEqual([]);
  });
});
