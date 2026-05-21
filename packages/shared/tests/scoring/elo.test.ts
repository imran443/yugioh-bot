import { describe, expect, it } from "vitest";
import { expectedScore, nextRating } from "../../src/scoring/elo.js";

describe("elo", () => {
  it("expectedScore is 0.5 for equal ratings", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 5);
  });

  it("higher rating has higher expected score", () => {
    expect(expectedScore(1400, 1000)).toBeGreaterThan(0.9);
    expect(expectedScore(600, 1000)).toBeLessThan(0.1);
  });

  it("winner against equal opponent gains ~K/2 and loser loses ~K/2", () => {
    expect(nextRating(1000, 1000, 1)).toBe(1016); // win, K=32, E=0.5 -> +16
    expect(nextRating(1000, 1000, 0)).toBe(984); // loss -> -16
  });

  it("beating a much stronger player gains more than beating a weaker one", () => {
    const vsStrong = nextRating(1000, 1500, 1) - 1000;
    const vsWeak = nextRating(1000, 600, 1) - 1000;
    expect(vsStrong).toBeGreaterThan(vsWeak);
  });
});
