import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
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

describe("tournament service", () => {
  it("creates multiple tournaments in one guild", () => {
    const app = setup();

    const locals = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const finals = app.tournaments.create("guild-1", "finals", "single_elim", "user-1");

    expect(locals.name).toBe("locals");
    expect(finals.name).toBe("finals");
    expect(locals.id).not.toBe(finals.id);
  });

  it("allows players to join before a tournament starts", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");

    app.tournaments.join(tournament.id, yugi.id);

    expect(app.tournaments.participants(tournament.id)).toEqual([yugi.id]);
  });

  it("does not duplicate tournament participants", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, yugi.id);

    expect(app.tournaments.participants(tournament.id)).toEqual([yugi.id]);
  });

  it("prevents players from joining after a tournament starts", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");

    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);

    expect(() => app.tournaments.join(tournament.id, joey.id)).toThrow(
      "Tournament has already started",
    );
  });
});
