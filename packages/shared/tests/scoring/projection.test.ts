import { describe, expect, it } from "vitest";
import { projectMatch } from "../../src/scoring/projection.js";

describe("projectMatch", () => {
  it("loss never costs winnings and rating swings both ways", () => {
    const p = projectMatch({ myElo: 1000, oppElo: 1500, seasonMultiplier: 1 });
    expect(p.loseWinnings).toBe(0);
    expect(p.winWinnings).toBeGreaterThan(0);
    expect(p.winRating).toBeGreaterThan(0);
    expect(p.loseRating).toBeLessThan(0);
  });
});
