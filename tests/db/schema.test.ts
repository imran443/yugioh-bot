import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";

describe("database schema", () => {
  it("creates all bot tables", () => {
    const db = new Database(":memory:");

    migrate(db);

    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual([
      "matches",
      "players",
      "tournament_matches",
      "tournament_participants",
      "tournaments",
    ]);
  });
});
