import { describe, expect, it } from "vitest";
import { rankForRating } from "../../src/scoring/rank.js";

describe("rankForRating", () => {
  it("maps ratings to named ranks", () => {
    expect(rankForRating(800).name).toBe("Bronze");
    expect(rankForRating(950).name).toBe("Silver");
    expect(rankForRating(1200).name).toBe("Gold");
    expect(rankForRating(1400).name).toBe("Platinum");
    expect(rankForRating(1700).name).toBe("Diamond");
  });

  it("returns nextAt for sub-Diamond ranks and null for Diamond", () => {
    expect(rankForRating(950).nextAt).toBe(1100); // Silver -> Gold at 1100
    expect(rankForRating(1700).nextAt).toBeNull();
  });
});
