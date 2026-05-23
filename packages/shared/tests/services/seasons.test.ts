import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createSeasonService } from "../../src/services/seasons.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, seasons: createSeasonService(db) };
}

describe("seasons", () => {
  it("ensureActive auto-creates Season 1", () => {
    const { seasons } = setup();
    const s = seasons.ensureActive("g1", "u1");
    expect(s.number).toBe(1);
    expect(s.status).toBe("active");
    // idempotent
    expect(seasons.ensureActive("g1", "u1").id).toBe(s.id);
  });

  it("end then start increments the season number", () => {
    const { seasons } = setup();
    const s1 = seasons.ensureActive("g1", "u1");
    seasons.end("g1", "u1");
    expect(seasons.getActive("g1")).toBeUndefined();
    const s2 = seasons.start("g1", "u1");
    expect(s2.number).toBe(2);
    expect(s2.id).not.toBe(s1.id);
  });

  it("start throws if a season is already active", () => {
    const { seasons } = setup();
    seasons.ensureActive("g1", "u1");
    expect(() => seasons.start("g1", "u1")).toThrow();
  });
});
