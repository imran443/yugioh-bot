import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createScoringService } from "../../src/services/scoring.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const insP = db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)");
  const p1 = Number(insP.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insP.run("g1", "u2", "Kaiba").lastInsertRowid);
  return { db, scoring: createScoringService(db), p1, p2 };
}

// inserts an approved casual match with winner = winnerId
function approvedMatch(db: Database.Database, p1: number, p2: number, winnerId: number): number {
  const r = db
    .prepare(
      `insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source)
       values ('g1', ?, ?, ?, ?, 'approved', 'casual')`,
    )
    .run(p1, p2, winnerId, p1);
  return Number(r.lastInsertRowid);
}

describe("scoring.recordMatchResult", () => {
  it("awards winnings to the winner and updates both ratings", () => {
    const { db, scoring, p1, p2 } = setup();
    const m = approvedMatch(db, p1, p2, p1);
    scoring.recordMatchResult(m);

    const winner = db.prepare("select * from player_ratings where player_id = ?").get(p1) as any;
    const loser = db.prepare("select * from player_ratings where player_id = ?").get(p2) as any;
    expect(winner.career_winnings).toBe(5); // equal elo -> base 5
    expect(winner.elo).toBe(1016);
    expect(loser.elo).toBe(984);

    const standing = db.prepare("select * from season_standings where player_id = ?").get(p1) as any;
    expect(standing.winnings).toBe(5);
    expect(standing.wins).toBe(1);
    expect(standing.current_streak).toBe(1);
  });

  it("is idempotent — re-running does not double-award", () => {
    const { db, scoring, p1, p2 } = setup();
    const m = approvedMatch(db, p1, p2, p1);
    scoring.recordMatchResult(m);
    scoring.recordMatchResult(m);
    const winner = db.prepare("select * from player_ratings where player_id = ?").get(p1) as any;
    expect(winner.career_winnings).toBe(5);
    const awards = db.prepare("select count(*) as c from point_awards where match_id = ?").get(m) as { c: number };
    expect(awards.c).toBe(1);
  });

  it("a loss resets the loser's current streak but never reduces winnings", () => {
    const { db, scoring, p1, p2 } = setup();
    scoring.recordMatchResult(approvedMatch(db, p1, p2, p1)); // p1 beats p2
    scoring.recordMatchResult(approvedMatch(db, p1, p2, p1)); // again
    scoring.recordMatchResult(approvedMatch(db, p1, p2, p2)); // p2 beats p1
    const loser = db.prepare("select * from season_standings where player_id = ?").get(p1) as any;
    expect(loser.current_streak).toBe(0);
    expect(loser.winnings).toBe(10); // unchanged by the loss
  });

  it("tags a tournament match win with its tournament_id", () => {
    const { db, scoring, p1, p2 } = setup();
    const tournamentId = Number(
      db
        .prepare(
          "insert into tournaments (guild_id, name, format, status, created_by_user_id) values ('g1','Cup','round_robin','active','host')",
        )
        .run().lastInsertRowid,
    );
    const matchId = approvedMatch(db, p1, p2, p1);
    db.prepare(
      `insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status)
       values (?, ?, ?, ?, 1, 'completed')`,
    ).run(tournamentId, matchId, p1, p2);

    scoring.recordMatchResult(matchId);

    const award = db
      .prepare("select tournament_id from point_awards where match_id = ? and kind = 'match_win'")
      .get(matchId) as { tournament_id: number | null };
    expect(award.tournament_id).toBe(tournamentId);
  });

  it("leaves tournament_id null for a casual match win", () => {
    const { db, scoring, p1, p2 } = setup();
    const matchId = approvedMatch(db, p1, p2, p1);
    scoring.recordMatchResult(matchId);
    const award = db
      .prepare("select tournament_id from point_awards where match_id = ? and kind = 'match_win'")
      .get(matchId) as { tournament_id: number | null };
    expect(award.tournament_id).toBeNull();
  });
});
