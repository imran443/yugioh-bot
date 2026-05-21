import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createMatchService } from "../../src/services/matches.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const insP = db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)");
  const p1 = Number(insP.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insP.run("g1", "u2", "Kaiba").lastInsertRowid);
  return { db, matches: createMatchService(db), p1, p2 };
}

describe("matches → scoring integration", () => {
  it("approving a casual match awards winnings and a season is auto-created", () => {
    const { db, matches, p1, p2 } = setup();
    const reported = matches.report({ guildId: "g1", reporterId: p1, opponentId: p2, winnerId: p1, source: "casual" });
    matches.approve(reported.id, p2);

    const season = db.prepare("select * from seasons where guild_id='g1' and status='active'").get();
    expect(season).toBeTruthy();
    const winner = db.prepare("select career_winnings from player_ratings where player_id=?").get(p1) as any;
    expect(winner.career_winnings).toBeGreaterThan(0);
  });
});
