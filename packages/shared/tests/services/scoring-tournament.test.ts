import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createScoringService } from "../../src/services/scoring.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const insP = db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)");
  // 16 distinct participants so sizeMultiplier(16) = 2
  const ids = Array.from({ length: 16 }, (_, i) => Number(insP.run("g1", "u" + i, "u" + i).lastInsertRowid));
  const t = Number(
    db.prepare(
      "insert into tournaments (guild_id, name, format, status, created_by_user_id) values ('g1','Cup','single_elim','completed','u1')",
    ).run().lastInsertRowid,
  );
  const insPart = db.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)");
  for (const pid of ids) insPart.run(t, pid);
  return { db, scoring: createScoringService(db), ids, t };
}

describe("scoring.recordTournamentResult", () => {
  it("awards a champion placement bonus scaled by tournament size", () => {
    const { db, scoring, ids, t } = setup();
    // champion ranking via metadata: pass an explicit standings list
    scoring.recordTournamentResult(t, { champion: ids[0], runnerUp: ids[1], top4: [ids[2], ids[3]] });
    const champ = db.prepare("select points from point_awards where tournament_id=? and player_id=? and kind='placement'")
      .get(t, ids[0]) as { points: number };
    expect(champ.points).toBe(100); // 50 * sizeMultiplier(16=2)
  });

  it("is idempotent for placement", () => {
    const { db, scoring, ids, t } = setup();
    const placement = { champion: ids[0], runnerUp: ids[1], top4: [ids[2], ids[3]] };
    scoring.recordTournamentResult(t, placement);
    scoring.recordTournamentResult(t, placement);
    const c = db.prepare("select count(*) as c from point_awards where tournament_id=? and kind='placement'").get(t) as { c: number };
    expect(c.c).toBe(4); // champion + runnerUp + 2 top4, no duplicates
  });
});
