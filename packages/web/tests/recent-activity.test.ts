import { describe, expect, it } from "vitest";
import { recentActivityLabel } from "../src/lib/recent-activity";

describe("recentActivityLabel", () => {
  it("labels a tournament match win with the tournament name", () => {
    expect(recentActivityLabel({ kind: "match_win", tournament_name: "Spring Slam" })).toBe(
      "Match win · Spring Slam",
    );
  });

  it("labels a casual match win", () => {
    expect(recentActivityLabel({ kind: "match_win", tournament_name: null })).toBe("Match win · Casual");
  });

  it("labels a placement with the tournament name", () => {
    expect(recentActivityLabel({ kind: "placement", tournament_name: "Winter Cup" })).toBe("Winter Cup");
  });

  it("falls back when a placement has no tournament name", () => {
    expect(recentActivityLabel({ kind: "placement", tournament_name: null })).toBe("Tournament placement");
  });
});
