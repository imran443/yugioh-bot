import { beforeEach, describe, expect, it } from "vitest";
import { getCached, putCards, clearCardsCache } from "../src/lib/cards-cache";
import type { CardSummary } from "../src/lib/card-types";

const a: CardSummary = { id: 1, name: "A", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "", imageUrlSmall: "" };
const b: CardSummary = { id: 2, name: "B", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "", imageUrlSmall: "" };

describe("cards-cache", () => {
  beforeEach(() => clearCardsCache());

  it("returns all ids as missing when empty", () => {
    expect(getCached([1, 2])).toEqual({ hits: [], missing: [1, 2] });
  });

  it("returns hits for cached ids and missing for the rest", () => {
    putCards([a]);
    expect(getCached([1, 2])).toEqual({ hits: [a], missing: [2] });
  });

  it("reports no missing once everything is cached", () => {
    putCards([a, b]);
    expect(getCached([1, 2])).toEqual({ hits: [a, b], missing: [] });
  });

  it("dedupes requested ids", () => {
    putCards([a]);
    expect(getCached([1, 1, 2])).toEqual({ hits: [a], missing: [2] });
  });
});
