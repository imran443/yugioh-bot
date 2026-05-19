import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { createMatchService } from "../../src/services/matches.js";

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, name: string) {
  return Number(
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
      .run(guildId, discordUserId, name).lastInsertRowid,
  );
}

// Round-robin with 2 players => exactly one match. Report+approve completes the tournament.
function completedRoundRobin() {
  const db = new Database(":memory:");
  migrate(db);
  const tournaments = createTournamentService(db);
  const matches = createMatchService(db);
  const a = insertPlayer(db, "g1", "u-a", "Alice");
  const b = insertPlayer(db, "g1", "u-b", "Bob");
  const t = tournaments.create("g1", "RR", "round_robin", "u-creator");
  tournaments.join(t.id, a);
  tournaments.join(t.id, b);
  tournaments.start(t.id);
  const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
  const reported = tournaments.reportTournamentMatch(tm.id, a, a); // Alice wins
  matches.approve(reported.id, b); // Bob approves -> tournament_match completed, tournament completed
  return { db, tournaments, t, tm, matchId: reported.id, a, b };
}

describe("reopenTournamentMatch", () => {
  it("reopens a completed round-robin match and reactivates the tournament", () => {
    const { db, tournaments, t, tm } = completedRoundRobin();
    expect((db.prepare("select status from tournaments where id = ?").get(t.id) as any).status).toBe("completed");

    tournaments.reopenTournamentMatch(tm.id, "u-creator");

    const tmAfter = db.prepare("select * from tournament_matches where id = ?").get(tm.id) as any;
    expect(tmAfter.status).toBe("open");
    expect(tmAfter.match_id).toBeNull();
    const tour = db.prepare("select * from tournaments where id = ?").get(t.id) as any;
    expect(tour.status).toBe("active");
    expect(tour.ended_at).toBeNull();
    const m = db.prepare("select status from matches where id = ?").get((tm as any).id ? tmAfter.match_id ?? 0 : 0);
    // the prior matches row is now denied so it drops out of standings
    const denied = db.prepare("select status from matches where tournament_id = ? order by id desc limit 1").get(t.id) as any;
    expect(denied.status).toBe("denied");
  });

  it("rejects a non-creator", () => {
    const { tournaments, tm } = completedRoundRobin();
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-not-creator")).toThrow(/organizer/i);
  });

  it("rejects single-elimination tournaments", () => {
    const db = new Database(":memory:");
    migrate(db);
    const tournaments = createTournamentService(db);
    const matches = createMatchService(db);
    const a = insertPlayer(db, "g1", "u-a", "A");
    const b = insertPlayer(db, "g1", "u-b", "B");
    const t = tournaments.create("g1", "SE", "single_elim", "u-creator");
    tournaments.join(t.id, a);
    tournaments.join(t.id, b);
    tournaments.start(t.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
    const reported = tournaments.reportTournamentMatch(tm.id, a, a);
    matches.approve(reported.id, b);
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-creator")).toThrow(/round-robin/i);
  });

  it("rejects a match that is not completed", () => {
    const db = new Database(":memory:");
    migrate(db);
    const tournaments = createTournamentService(db);
    const a = insertPlayer(db, "g1", "u-a", "A");
    const b = insertPlayer(db, "g1", "u-b", "B");
    const t = tournaments.create("g1", "RR", "round_robin", "u-creator");
    tournaments.join(t.id, a);
    tournaments.join(t.id, b);
    tournaments.start(t.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(t.id) as any;
    expect(() => tournaments.reopenTournamentMatch(tm.id, "u-creator")).toThrow(/not completed/i);
  });
});
