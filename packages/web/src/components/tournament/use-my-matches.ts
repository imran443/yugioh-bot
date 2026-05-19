import type { Match, TournamentDetail } from "./types";

export interface MyMatches {
  mine: Match[];
  needsMeCount: number;
  actionMatch: Match | null;
}

function isMine(m: Match, playerId: number): boolean {
  return m.playerOneId === playerId || m.playerTwoId === playerId;
}

function needsMe(m: Match, playerId: number): boolean {
  if (!isMine(m, playerId)) return false;
  if (m.status === "open") return true;
  if (m.status === "pending_approval" && m.reporterId !== null && m.reporterId !== playerId) {
    return true;
  }
  return false;
}

export function deriveMyMatches(t: TournamentDetail): MyMatches {
  const playerId = t.currentUserPlayerId;
  if (playerId === null) {
    return { mine: [], needsMeCount: 0, actionMatch: null };
  }
  const mine = t.matches.filter((m) => isMine(m, playerId));
  const actionable = mine.filter((m) => needsMe(m, playerId));
  return {
    mine,
    needsMeCount: actionable.length,
    actionMatch: actionable[0] ?? null,
  };
}
