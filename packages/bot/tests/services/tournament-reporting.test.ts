import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "@yugidraft/shared/services";
import { createTournamentService } from "@yugidraft/shared/services";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    matches: createMatchService(db),
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
  };
}

describe("tournament reporting", () => {
  it("starting a round robin tournament creates all tournament matches", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.join(tournament.id, joey.id);
    app.tournaments.start(tournament.id);

    expect(app.tournaments.openMatches(tournament.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerOneId: yugi.id, playerTwoId: kaiba.id, status: "open" }),
      expect.objectContaining({ playerOneId: yugi.id, playerTwoId: joey.id, status: "open" }),
      expect.objectContaining({ playerOneId: kaiba.id, playerTwoId: joey.id, status: "open" }),
    ]));
  });

  it("reporting a tournament match creates a pending approved-stats match tied to the tournament", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);

    const reported = app.tournaments.report(tournament.id, yugi.id, kaiba.id, yugi.id);

    expect(reported.status).toBe("pending");
    expect(reported.tournamentId).toBe(tournament.id);
    expect(app.tournaments.openMatches(tournament.id)[0].status).toBe("pending_approval");
  });

  it("approving a tournament result completes the tournament match", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);

    const reported = app.tournaments.report(tournament.id, yugi.id, kaiba.id, yugi.id);
    app.matches.approve(reported.id, kaiba.id);

    expect(app.tournaments.matches(tournament.id)[0].status).toBe("completed");
    expect(app.matches.stats(yugi.id)).toEqual({ wins: 1, losses: 0 });
  });

  it("advances single elimination winners after a round is complete", () => {
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

    const first = app.tournaments.report(tournament.id, yugi.id, mai.id, yugi.id);
    app.matches.approve(first.id, mai.id);
    const second = app.tournaments.report(tournament.id, kaiba.id, joey.id, kaiba.id);
    app.matches.approve(second.id, joey.id);

    expect(app.tournaments.openMatches(tournament.id)).toEqual([
      expect.objectContaining({ playerOneId: yugi.id, playerTwoId: kaiba.id, roundNumber: 2 }),
    ]);
  });

  it("marks a round-robin tournament completed once all matches are approved", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");

    for (const player of [yugi, kaiba, joey]) {
      app.tournaments.join(tournament.id, player.id);
    }
    app.tournaments.start(tournament.id);

    const allMatches = app.tournaments.openMatches(tournament.id);
    expect(allMatches).toHaveLength(3);

    const [m1, m2, m3] = allMatches;

    const r1 = app.tournaments.report(tournament.id, m1.playerOneId, m1.playerTwoId!, m1.playerOneId);
    app.matches.approve(r1.id, m1.playerTwoId!);
    expect(app.tournaments.findById(tournament.id).status).toBe("active");

    const r2 = app.tournaments.report(tournament.id, m2.playerOneId, m2.playerTwoId!, m2.playerOneId);
    app.matches.approve(r2.id, m2.playerTwoId!);
    expect(app.tournaments.findById(tournament.id).status).toBe("active");

    const r3 = app.tournaments.report(tournament.id, m3.playerOneId, m3.playerTwoId!, m3.playerOneId);
    app.matches.approve(r3.id, m3.playerTwoId!);

    expect(app.tournaments.findById(tournament.id).status).toBe("completed");
  });
});
