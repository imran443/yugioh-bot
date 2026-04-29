import { describe, expect, it } from "vitest";
import { formatLeaderboard, formatStats } from "../../src/formatters/stats.js";

describe("stats formatters", () => {
  it("formats a player with no matches", () => {
    expect(formatStats("Yugi", { wins: 0, losses: 0 })).toBe("Yugi: 0W - 0L (0% win rate)");
  });

  it("formats a normal record with rounded win rate", () => {
    expect(formatStats("Kaiba", { wins: 2, losses: 1 })).toBe("Kaiba: 2W - 1L (67% win rate)");
  });

  it("formats leaderboard rows", () => {
    expect(
      formatLeaderboard([
        { playerId: 1, displayName: "Yugi", wins: 2, losses: 0 },
        { playerId: 2, displayName: "Kaiba", wins: 1, losses: 1 },
      ]),
    ).toBe("1. Yugi: 2W - 0L\n2. Kaiba: 1W - 1L");
  });

  it("formats an empty leaderboard", () => {
    expect(formatLeaderboard([])).toBe("No players have been tracked yet.");
  });
});
