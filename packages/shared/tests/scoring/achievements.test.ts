import { describe, expect, it } from "vitest";
import { evaluateAchievements, ACHIEVEMENTS } from "../../src/scoring/achievements.js";

describe("achievements", () => {
  it("has a stable registry with keys, names, icons", () => {
    for (const a of ACHIEVEMENTS) {
      expect(a.key).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.icon).toBeTruthy();
    }
  });

  it("unlocks first-tournament-win and 10-win-streak when context matches", () => {
    const keys = evaluateAchievements({
      tournamentTitles: 1,
      bestStreak: 10,
      careerWinnings: 50,
      beatTopRanked: false,
    });
    expect(keys).toContain("first_tournament_win");
    expect(keys).toContain("streak_10");
  });

  it("unlocks giant-slayer only on a top-ranked upset", () => {
    expect(evaluateAchievements({ tournamentTitles: 0, bestStreak: 0, careerWinnings: 0, beatTopRanked: true }))
      .toContain("giant_slayer");
    expect(evaluateAchievements({ tournamentTitles: 0, bestStreak: 0, careerWinnings: 0, beatTopRanked: false }))
      .not.toContain("giant_slayer");
  });
});
