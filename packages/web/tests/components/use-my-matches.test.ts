import { describe, expect, it } from "vitest";
import { deriveMyMatches } from "../../src/components/tournament/use-my-matches";
import type { TournamentDetail } from "../../src/components/tournament/types";

const base: TournamentDetail = {
  id: 1, name: "RR", format: "round_robin", status: "active",
  createdByUserId: "host", participants: [], isParticipant: true,
  currentUserPlayerId: 10,
  startedAt: null, createdAt: "2026-01-01T00:00:00Z",
  matches: [
    { id: 1, matchId: null, roundNumber: 1, playerOneId: 10, playerTwoId: 20, playerOneName: "Me", playerTwoName: "Bob", status: "open", winnerId: null, reporterId: null, resolvedAt: null, metadata: {} },
    { id: 2, matchId: 5, roundNumber: 1, playerOneId: 20, playerTwoId: 10, playerOneName: "Bob", playerTwoName: "Me", status: "pending_approval", winnerId: 20, reporterId: 20, resolvedAt: null, metadata: {} },
    { id: 3, matchId: null, roundNumber: 1, playerOneId: 20, playerTwoId: 30, playerOneName: "Bob", playerTwoName: "Cy", status: "open", winnerId: null, reporterId: null, resolvedAt: null, metadata: {} },
  ],
};

describe("deriveMyMatches", () => {
  it("returns only the current user's matches", () => {
    const r = deriveMyMatches(base);
    expect(r.mine.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it("counts items needing the user (own open + opponent-pending)", () => {
    const r = deriveMyMatches(base);
    // match 1: my open -> needs me. match 2: opponent reported, pending my approval -> needs me.
    expect(r.needsMeCount).toBe(2);
    expect(r.actionMatch?.id).toBe(1); // first actionable
  });

  it("zero count when not a participant", () => {
    const r = deriveMyMatches({ ...base, currentUserPlayerId: null });
    expect(r.mine).toEqual([]);
    expect(r.needsMeCount).toBe(0);
  });
});
