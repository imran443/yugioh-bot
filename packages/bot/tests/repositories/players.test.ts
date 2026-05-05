import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return createPlayerRepository(db);
}

describe("player repository", () => {
  it("creates a player once per guild and user", () => {
    const players = setup();

    const first = players.upsert("guild-1", "user-1", "Yugi");
    const second = players.upsert("guild-1", "user-1", "Yugi Moto");

    expect(first.id).toBe(second.id);
    expect(second.displayName).toBe("Yugi Moto");
  });
});
