import { describe, expect, it } from "vitest";
import { parseCustomCardIds, toCardCounts } from "../src/lib/custom-card-pool.js";

describe("custom card pool parser", () => {
  it("preserves repeated passcodes from newline comma and whitespace separated text", () => {
    expect(parseCustomCardIds("46986414\n83764718, 46986414\t12345678")).toEqual({
      cardIds: [46986414, 83764718, 46986414, 12345678],
      errors: [],
    });
  });

  it("reports invalid tokens without dropping valid passcodes", () => {
    expect(parseCustomCardIds("46986414\nDark Magician\n123x\n83764718")).toEqual({
      cardIds: [46986414, 83764718],
      errors: ["Dark", "Magician", "123x"],
    });
  });

  it("toCardCounts tallies occurrences per id", () => {
    expect(toCardCounts([5, 5, 5, 7, 7, 9])).toEqual(
      new Map([
        [5, 3],
        [7, 2],
        [9, 1],
      ]),
    );
  });
});
