import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";

function tables(db: Database.Database): string[] {
  return (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe("gamification schema", () => {
  it("creates all gamification tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const t = tables(db);
    for (const name of ["seasons", "player_ratings", "point_awards", "season_standings", "player_achievements"]) {
      expect(t).toContain(name);
    }
  });

  it("enforces one active season per guild", () => {
    const db = new Database(":memory:");
    migrate(db);
    const ins = db.prepare(
      "insert into seasons (guild_id, number, status) values (?, ?, 'active')",
    );
    ins.run("g1", 1);
    expect(() => ins.run("g1", 2)).toThrow();
    // a different guild is fine
    expect(() => ins.run("g2", 1)).not.toThrow();
    // an ended season does not block a new active one
    db.prepare("update seasons set status='ended' where guild_id='g1'").run();
    expect(() => ins.run("g1", 2)).not.toThrow();
  });

  it("prevents duplicate placement awards for the same tournament+player", () => {
    const db = new Database(":memory:");
    migrate(db);
    // Disable FK enforcement so we can insert rows without real players/seasons rows
    db.pragma("foreign_keys = off");
    db.prepare("insert into seasons (guild_id, number, status) values ('g1', 1, 'active')").run();
    const ins = db.prepare(
      `insert into point_awards (guild_id, season_id, player_id, kind, tournament_id, points)
       values ('g1', 1, 7, 'placement', 99, 100)`,
    );
    ins.run();
    expect(() => ins.run()).toThrow();
  });
});
