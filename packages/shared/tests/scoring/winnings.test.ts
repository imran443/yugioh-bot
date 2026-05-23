import { describe, expect, it } from "vitest";
import {
  opponentStrength,
  sizeMultiplier,
  matchWinPoints,
  placementPoints,
} from "../../src/scoring/winnings.js";

describe("winnings", () => {
  it("opponentStrength: ~1 for equal, higher vs stronger, clamped", () => {
    expect(opponentStrength(1000, 1000)).toBeCloseTo(1.0, 2);
    expect(opponentStrength(1000, 1400)).toBeGreaterThan(1.0);
    expect(opponentStrength(1000, 9999)).toBeLessThanOrEqual(2.0);
    expect(opponentStrength(1000, 1)).toBeGreaterThanOrEqual(0.5);
  });

  it("sizeMultiplier scales up in buckets", () => {
    expect(sizeMultiplier(4)).toBe(1);
    expect(sizeMultiplier(8)).toBe(1.5);
    expect(sizeMultiplier(16)).toBe(2);
    expect(sizeMultiplier(32)).toBe(3);
    expect(sizeMultiplier(64)).toBe(3);
  });

  it("matchWinPoints = base * season * opponentStrength, rounded", () => {
    // equal opponents, season 1 -> 5 * 1 * 1 = 5
    expect(matchWinPoints({ myElo: 1000, oppElo: 1000, seasonMultiplier: 1 })).toBe(5);
    // stronger opponent earns more
    expect(matchWinPoints({ myElo: 1000, oppElo: 1500, seasonMultiplier: 1 })).toBeGreaterThan(5);
  });

  it("placementPoints scales by finish and tournament size", () => {
    expect(placementPoints("champion", 16)).toBe(100); // 50 * 2
    expect(placementPoints("runnerUp", 16)).toBe(60); // 30 * 2
    expect(placementPoints("top4", 8)).toBe(23); // round(15 * 1.5) = round(22.5) = 23
  });
});
