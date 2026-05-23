import { describe, it, expect } from "vitest";
import { rankIndex, didRankUp } from "../../src/components/rank/rank-up";

describe("rank-up", () => {
  it("orders tiers ascending (Bronze lowest, Diamond highest)", () => {
    expect(rankIndex("Bronze")).toBe(0);
    expect(rankIndex("Diamond")).toBe(4);
    expect(rankIndex("Gold")).toBeGreaterThan(rankIndex("Silver"));
  });

  it("returns -1 for an unknown rank", () => {
    expect(rankIndex("Nope")).toBe(-1);
  });

  it("celebrates only on a genuine increase", () => {
    expect(didRankUp("Silver", "Gold")).toBe(true);
    expect(didRankUp("Gold", "Gold")).toBe(false);
    expect(didRankUp("Diamond", "Gold")).toBe(false);
  });

  it("never celebrates a first-ever view", () => {
    expect(didRankUp(null, "Diamond")).toBe(false);
  });

  it("never celebrates when either rank is unknown", () => {
    expect(didRankUp("Garbage", "Gold")).toBe(false);
    expect(didRankUp("Gold", "Garbage")).toBe(false);
  });
});
