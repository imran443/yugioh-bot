import { describe, expect, it } from "vitest";
import {
  generateRoundRobin,
  generateSingleElimFirstRound,
} from "../../src/tournaments/formats.js";

describe("tournament format generators", () => {
  describe("generateRoundRobin (circle method)", () => {
    it("schedules N-1 rounds for N even players, with N/2 matches per round", () => {
      const pairings = generateRoundRobin([1, 2, 3, 4]);
      const rounds = new Map<number, Array<[number, number]>>();
      for (const p of pairings) {
        const r = rounds.get(p.roundNumber) ?? [];
        r.push([p.playerOneId, p.playerTwoId!]);
        rounds.set(p.roundNumber, r);
      }
      expect(rounds.size).toBe(3);
      for (const [, matches] of rounds) {
        expect(matches.length).toBe(2);
        const players = matches.flatMap((m) => m);
        expect(new Set(players).size).toBe(4);
      }
    });

    it("schedules N rounds for N odd players, each round having one bye", () => {
      const pairings = generateRoundRobin([1, 2, 3]);
      const rounds = new Map<number, Array<{ p1: number; p2: number | null }>>();
      for (const p of pairings) {
        const r = rounds.get(p.roundNumber) ?? [];
        r.push({ p1: p.playerOneId, p2: p.playerTwoId });
        rounds.set(p.roundNumber, r);
      }
      expect(rounds.size).toBe(3);
      let byes = 0;
      for (const [, ms] of rounds) {
        const byeMatches = ms.filter((m) => m.p2 === null);
        byes += byeMatches.length;
      }
      expect(byes).toBe(3);
    });

    it("ensures every distinct pair plays exactly once", () => {
      const pairings = generateRoundRobin([1, 2, 3, 4, 5, 6]);
      const seen = new Set<string>();
      let realMatches = 0;
      for (const p of pairings) {
        if (p.playerTwoId === null) continue;
        const key = [p.playerOneId, p.playerTwoId].sort().join("-");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        realMatches += 1;
      }
      expect(realMatches).toBe(15); // C(6, 2)
    });
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
