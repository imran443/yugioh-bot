import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
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

    expect(() => app.tournaments.join(tournament.id, yugi.id)).toThrow("You have already joined this tournament");

    expect(app.tournaments.participants(tournament.id)).toEqual([yugi.id]);
  });

  it("lists tournament participant records in join order", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");

    app.tournaments.join(tournament.id, joey.id);
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);

    expect(app.tournaments.participantRecords(tournament.id)).toEqual([
      { playerId: joey.id, displayName: "Joey" },
      { playerId: yugi.id, displayName: "Yugi" },
      { playerId: kaiba.id, displayName: "Kaiba" },
    ]);
  });

  it("returns no participant records for an empty tournament", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");

    expect(app.tournaments.participantRecords(tournament.id)).toEqual([]);
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

  it("cancels a tournament", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");

    expect(app.tournaments.cancel(tournament.id).status).toBe("cancelled");
  });

  it("allows reusing a tournament name after cancellation", () => {
    const app = setup();
    const cancelled = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");

    app.tournaments.cancel(cancelled.id);
    const replacement = app.tournaments.create("guild-1", "locals", "single_elim", "user-1");

    expect(replacement.id).not.toBe(cancelled.id);
    expect(replacement.name).toBe("locals");
    expect(replacement.status).toBe("pending");
    expect(app.tournaments.findByName("guild-1", "locals")?.id).toBe(replacement.id);
  });

  it("prevents duplicate pending tournament names", () => {
    const app = setup();

    app.tournaments.create("guild-1", "locals", "round_robin", "user-1");

    expect(() => app.tournaments.create("guild-1", "locals", "single_elim", "user-1")).toThrow(
      "An active or pending tournament already uses that name",
    );
  });

  it("lists tournaments by status within a guild", () => {
    const app = setup();
    const pending = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const cancelled = app.tournaments.create("guild-1", "finals", "single_elim", "user-1");
    app.tournaments.create("guild-2", "remote", "round_robin", "user-1");

    app.tournaments.cancel(cancelled.id);

    expect(app.tournaments.listByStatus("guild-1", ["pending", "cancelled"])).toEqual([
      expect.objectContaining({ id: pending.id, guildId: "guild-1", status: "pending" }),
      expect.objectContaining({ id: cancelled.id, guildId: "guild-1", status: "cancelled" }),
    ]);
  });

  it("lists active tournaments where a player participates", () => {
    const app = setup();
    const active = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const pending = app.tournaments.create("guild-1", "finals", "round_robin", "user-1");
    const remote = app.tournaments.create("guild-2", "remote", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const remoteYugi = app.players.upsert("guild-2", "user-1", "Yugi");
    const remoteKaiba = app.players.upsert("guild-2", "user-2", "Kaiba");

    for (const tournament of [active, pending]) {
      app.tournaments.join(tournament.id, yugi.id);
      app.tournaments.join(tournament.id, kaiba.id);
    }
    app.tournaments.join(remote.id, remoteYugi.id);
    app.tournaments.join(remote.id, remoteKaiba.id);
    app.tournaments.start(active.id);
    app.tournaments.start(remote.id);

    expect(app.tournaments.activeForPlayer("guild-1", yugi.id)).toEqual([
      expect.objectContaining({ id: active.id, guildId: "guild-1", status: "active" }),
    ]);
  });

  it("autocompletes at most 25 case-insensitive guild-scoped matches", () => {
    const app = setup();

    for (let index = 1; index <= 30; index += 1) {
      app.tournaments.create("guild-1", `Locals ${index.toString().padStart(2, "0")}`, "round_robin", "user-1");
    }
    app.tournaments.create("guild-2", "Locals remote", "round_robin", "user-1");

    const results = app.tournaments.autocomplete({ guildId: "guild-1", query: "locals" });

    expect(results).toHaveLength(25);
    expect(results[0]).toEqual(expect.objectContaining({ name: "Locals 01" }));
    expect(results.at(-1)).toEqual(expect.objectContaining({ name: "Locals 25" }));
    expect(results.every((tournament) => tournament.guildId === "guild-1")).toBe(true);
  });

  it("autocompletes by status, creator, and participant", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const target = app.tournaments.create("guild-1", "Spring Locals", "round_robin", "creator-1");
    const wrongStatus = app.tournaments.create("guild-1", "Spring Finals", "round_robin", "creator-1");
    const wrongCreator = app.tournaments.create("guild-1", "Spring Remote", "round_robin", "creator-2");
    const wrongParticipant = app.tournaments.create("guild-1", "Spring Side", "round_robin", "creator-1");

    app.tournaments.join(target.id, yugi.id);
    app.tournaments.join(wrongStatus.id, yugi.id);
    app.tournaments.join(wrongCreator.id, yugi.id);
    app.tournaments.join(wrongParticipant.id, kaiba.id);
    app.tournaments.cancel(wrongStatus.id);

    expect(
      app.tournaments.autocomplete({
        guildId: "guild-1",
        query: "spring",
        statuses: ["pending"],
        createdByUserId: "creator-1",
        participantPlayerId: yugi.id,
      }),
    ).toEqual([expect.objectContaining({ id: target.id, name: "Spring Locals" })]);
  });

  it("counts tournament stats from approved tournament matches only", () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const otherTournament = app.tournaments.create("guild-1", "finals", "round_robin", "user-1");
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");

    const approvedWin = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "tournament",
      tournamentId: tournament.id,
    });
    const pendingLoss = app.matches.report({
      guildId: "guild-1",
      reporterId: kaiba.id,
      opponentId: yugi.id,
      winnerId: kaiba.id,
      source: "tournament",
      tournamentId: tournament.id,
    });
    const otherTournamentLoss = app.matches.report({
      guildId: "guild-1",
      reporterId: kaiba.id,
      opponentId: yugi.id,
      winnerId: kaiba.id,
      source: "tournament",
      tournamentId: otherTournament.id,
    });
    const casualLoss = app.matches.report({
      guildId: "guild-1",
      reporterId: kaiba.id,
      opponentId: yugi.id,
      winnerId: kaiba.id,
      source: "casual",
    });

    app.matches.approve(approvedWin.id, kaiba.id);
    app.matches.approve(otherTournamentLoss.id, yugi.id);
    app.matches.approve(casualLoss.id, yugi.id);

    expect(pendingLoss.status).toBe("pending");
    expect(app.tournaments.stats(tournament.id, yugi.id)).toEqual({ wins: 1, losses: 0 });
  });
});
