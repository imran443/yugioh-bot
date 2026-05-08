import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const players = createPlayerRepository(db);
  const matches = createMatchService(db);
  const tournaments = createTournamentService(db);

  return { matches, players, tournaments };
}

describe("match service", () => {
  it("requires opponent approval before counting stats", () => {
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

    expect(match.status).toBe("pending");
    expect(app.matches.stats(yugi.id)).toEqual({ wins: 0, losses: 0 });

    app.matches.approve(match.id, kaiba.id);

    expect(app.matches.stats(yugi.id)).toEqual({ wins: 1, losses: 0 });
    expect(app.matches.stats(kaiba.id)).toEqual({ wins: 0, losses: 1 });
  });

  it("prevents the reporter from approving their own report", () => {
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

    expect(() => app.matches.approve(match.id, yugi.id)).toThrow(
      "Only the opponent can approve this match",
    );
    expect(app.matches.stats(yugi.id)).toEqual({ wins: 0, losses: 0 });
  });

  it("does not count denied matches", () => {
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

    app.matches.deny(match.id, kaiba.id);

    expect(app.matches.stats(yugi.id)).toEqual({ wins: 0, losses: 0 });
    expect(app.matches.stats(kaiba.id)).toEqual({ wins: 0, losses: 0 });
  });

  it("finds the latest pending match involving a player", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    const match = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: kaiba.id,
      source: "casual",
    });

    expect(app.matches.latestPendingForPlayer(kaiba.id)?.id).toBe(match.id);
  });

  it("finds the latest pending match where the player is the opponent", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    const needsKaibaApproval = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    app.matches.report({
      guildId: "guild-1",
      reporterId: kaiba.id,
      opponentId: yugi.id,
      winnerId: kaiba.id,
      source: "casual",
    });

    expect(app.matches.latestPendingForOpponent(kaiba.id)?.id).toBe(needsKaibaApproval.id);
  });

  it("builds a leaderboard from approved matches only", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");

    const approved = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    app.matches.approve(approved.id, kaiba.id);
    app.matches.report({
      guildId: "guild-1",
      reporterId: joey.id,
      opponentId: kaiba.id,
      winnerId: joey.id,
      source: "casual",
    });

    expect(app.matches.leaderboard("guild-1")).toEqual([
      { playerId: yugi.id, displayName: "Yugi", wins: 1, losses: 0 },
      { playerId: joey.id, displayName: "Joey", wins: 0, losses: 0 },
      { playerId: kaiba.id, displayName: "Kaiba", wins: 0, losses: 1 },
    ]);
  });

  it("does not advance or complete a tournament that is no longer active", () => {
    const app = setup();
    const t = app.tournaments.create("g1", "Locals", "single_elim", "u1");
    const yugi = app.players.upsert("g1", "u1", "Yugi");
    const kaiba = app.players.upsert("g1", "u2", "Kaiba");
    app.tournaments.join(t.id, yugi.id);
    app.tournaments.join(t.id, kaiba.id);
    app.tournaments.start(t.id);

    const openMatches = app.tournaments.openMatches(t.id);
    const tm = openMatches[0];
    const reported = app.tournaments.report(t.id, yugi.id, kaiba.id, yugi.id);

    // Cancel the tournament before approval
    app.tournaments.cancel(t.id);

    // Approve should NOT complete the tournament
    app.matches.approve(reported.id, kaiba.id);

    const tournamentAfter = app.tournaments.findById(t.id);
    expect(tournamentAfter.status).toBe("cancelled");
  });
});
