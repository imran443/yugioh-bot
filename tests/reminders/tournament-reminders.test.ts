import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { selectTournamentReminderTargets } from "../../src/reminders/tournament-reminders.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    db,
    matches: createMatchService(db),
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

describe("tournament reminders", () => {
  it("selects open round robin tournament matches", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);

    expect(selectTournamentReminderTargets(app.db)).toEqual([
      {
        guildId: "guild-1",
        tournamentName: "locals",
        roundNumber: 1,
        playerOneDiscordUserId: "user-1",
        playerTwoDiscordUserId: "user-2",
      },
    ]);
  });

  it("does not select completed tournament matches", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);
    const report = app.tournaments.report(tournament.id, yugi.id, kaiba.id, yugi.id);
    app.matches.approve(report.id, kaiba.id);

    expect(selectTournamentReminderTargets(app.db)).toEqual([]);
  });

  it("selects only active single elimination matches", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "finals", "single_elim", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    const mai = app.players.upsert("guild-1", "user-4", "Mai");

    for (const player of [yugi, kaiba, joey, mai]) {
      app.tournaments.join(tournament.id, player.id);
    }

    app.tournaments.start(tournament.id);

    expect(selectTournamentReminderTargets(app.db)).toEqual([
      expect.objectContaining({ tournamentName: "finals", playerOneDiscordUserId: "user-1", playerTwoDiscordUserId: "user-4" }),
      expect.objectContaining({ tournamentName: "finals", playerOneDiscordUserId: "user-2", playerTwoDiscordUserId: "user-3" }),
    ]);
  });
});
