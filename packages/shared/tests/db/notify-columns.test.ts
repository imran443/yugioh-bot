import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe("matches notify columns", () => {
  it("adds notify_channel_id and notify_message_id to matches", () => {
    const db = new Database(":memory:");
    migrate(db);
    const cols = columns(db, "matches");
    expect(cols).toContain("notify_channel_id");
    expect(cols).toContain("notify_message_id");
  });

  it("is idempotent when migrate runs twice", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db);
    expect(columns(db, "matches").filter((c) => c === "notify_channel_id")).toHaveLength(1);
  });
});
