import { describe, it, expect } from "vitest";
import { RANK_THRESHOLDS } from "@yugidraft/shared/scoring";
import { RANK_VISUALS, FALLBACK_VISUAL, visualForRank } from "../../src/components/rank/rank-visuals";

describe("rank-visuals", () => {
  it("has a visual for every tier in RANK_THRESHOLDS", () => {
    for (const t of RANK_THRESHOLDS) {
      expect(RANK_VISUALS[t.name]).toBeDefined();
    }
  });

  it("gives only Bronze an empty idle class", () => {
    expect(RANK_VISUALS.Bronze.idleClass).toBe("");
    expect(RANK_VISUALS.Diamond.idleClass).not.toBe("");
    expect(RANK_VISUALS.Diamond.twinkle).toBe(true);
  });

  it("falls back to a neutral visual for unknown ranks", () => {
    expect(visualForRank("Unranked")).toBe(FALLBACK_VISUAL);
    expect(visualForRank("Gold")).toBe(RANK_VISUALS.Gold);
  });
});
