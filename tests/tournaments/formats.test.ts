import { describe, expect, it } from "vitest";
import {
  generateRoundRobin,
  generateSingleElimFirstRound,
} from "../../src/tournaments/formats.js";

describe("tournament format generators", () => {
  it("creates every unique round robin pairing once", () => {
    expect(generateRoundRobin([1, 2, 3, 4])).toEqual([
      { playerOneId: 1, playerTwoId: 2, roundNumber: 1 },
      { playerOneId: 1, playerTwoId: 3, roundNumber: 2 },
      { playerOneId: 1, playerTwoId: 4, roundNumber: 3 },
      { playerOneId: 2, playerTwoId: 3, roundNumber: 4 },
      { playerOneId: 2, playerTwoId: 4, roundNumber: 5 },
      { playerOneId: 3, playerTwoId: 4, roundNumber: 6 },
    ]);
  });

  it("creates deterministic single elimination first-round pairings", () => {
    expect(generateSingleElimFirstRound([1, 2, 3, 4])).toEqual({
      byes: [],
      pairings: [
        { playerOneId: 1, playerTwoId: 4, roundNumber: 1 },
        { playerOneId: 2, playerTwoId: 3, roundNumber: 1 },
      ],
    });
  });

  it("handles odd single elimination participant counts with a bye", () => {
    expect(generateSingleElimFirstRound([1, 2, 3])).toEqual({
      byes: [1],
      pairings: [{ playerOneId: 2, playerTwoId: 3, roundNumber: 1 }],
    });
  });
});
