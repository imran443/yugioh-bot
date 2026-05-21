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
  const scoring = createScoringService(db);
  const m = (winner: number) =>
    Number(
      db.prepare(
        `insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source)
         values ('g1', ?, ?, ?, ?, 'approved', 'casual')`,
      ).run(p1, p2, winner, p1).lastInsertRowid,
    );
  return { db, scoring, p1, p2, m };
}

describe("scoring reads", () => {
  it("getLeaderboard ranks by season winnings desc and includes rank+rating", () => {
    const { scoring, p1, p2, m } = setup();
    scoring.recordMatchResult(m(p1));
    scoring.recordMatchResult(m(p1));
    const lb = scoring.getLeaderboard("g1", "season");
    expect(lb[0].playerId).toBe(p1);
    expect(lb[0].winnings).toBeGreaterThan(0);
    expect(lb[0].rank).toBeTruthy();
    expect(typeof lb[0].rating).toBe("number");
  });

  it("getProfile returns season + career figures and recent results", () => {
    const { scoring, p1, m } = setup();
    scoring.recordMatchResult(m(p1));
    const profile = scoring.getProfile("g1", p1, "season");
    expect(profile.winnings).toBeGreaterThan(0);
    expect(profile.careerWinnings).toBeGreaterThan(0);
    expect(profile.rank.name).toBeTruthy();
    expect(profile.recent.length).toBeGreaterThan(0);
  });

  it("rebuildStandings reproduces the cache from the ledger", () => {
    const { db, scoring, p1, m } = setup();
    scoring.recordMatchResult(m(p1));
    const before = db.prepare("select winnings from season_standings where player_id=?").get(p1) as { winnings: number };
    db.prepare("update season_standings set winnings = 9999 where player_id=?").run(p1);
    scoring.rebuildStandings("g1");
    const after = db.prepare("select winnings from season_standings where player_id=?").get(p1) as { winnings: number };
    expect(after.winnings).toBe(before.winnings);
  });
});
