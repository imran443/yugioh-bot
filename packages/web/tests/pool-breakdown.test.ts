import { describe, expect, it } from "vitest";
import { attributeBreakdown, typeBreakdown } from "../src/lib/pool-breakdown";
import type { CardSummary } from "../src/lib/card-types";

const card = (over: Partial<CardSummary>): CardSummary => ({
  id: 0, name: "x", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "", imageUrlSmall: "", ...over,
});

const cards: CardSummary[] = [
  card({ id: 1, type: "Effect Monster", attribute: "DARK" }),
  card({ id: 2, type: "Effect Monster", attribute: "DARK" }),
  card({ id: 3, type: "Normal Monster", attribute: "LIGHT" }),
  card({ id: 4, type: "Spell Card", attribute: "SPELL" }),
  card({ id: 5, type: "Trap Card", attribute: "TRAP" }),
];

describe("pool breakdown", () => {
  it("counts attributes, excluding SPELL/TRAP, sorted by count desc", () => {
    expect(attributeBreakdown(cards)).toEqual([
      { label: "DARK", count: 2 },
      { label: "LIGHT", count: 1 },
    ]);
  });

  it("counts type categories, sorted by count desc", () => {
    expect(typeBreakdown(cards)).toEqual([
      { label: "Effect Monster", count: 2 },
      { label: "Normal Monster", count: 1 },
      { label: "Spell Card", count: 1 },
      { label: "Trap Card", count: 1 },
    ]);
  });

  it("returns empty arrays for no cards", () => {
    expect(attributeBreakdown([])).toEqual([]);
    expect(typeBreakdown([])).toEqual([]);
  });
});
