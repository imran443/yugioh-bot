export type TournamentPairing = {
  playerOneId: number;
  playerTwoId: number | null;
  roundNumber: number;
};

export type SingleElimFirstRound = {
  byes: number[];
  pairings: TournamentPairing[];
};

export function generateRoundRobin(playerIds: number[]): TournamentPairing[] {
  if (playerIds.length < 2) return [];
  const ghost = -1;
  const ids = playerIds.length % 2 === 1 ? [...playerIds, ghost] : [...playerIds];
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const out: TournamentPairing[] = [];

  // Standard circle rotation: fix index 0, rotate the rest.
  let order = ids.slice();
  for (let r = 1; r <= rounds; r += 1) {
    for (let i = 0; i < half; i += 1) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a === ghost) {
        out.push({ playerOneId: b, playerTwoId: null, roundNumber: r });
      } else if (b === ghost) {
        out.push({ playerOneId: a, playerTwoId: null, roundNumber: r });
      } else {
        out.push({ playerOneId: a, playerTwoId: b, roundNumber: r });
      }
    }
    order = [order[0], ...order.slice(2), order[1]];
  }

  return out;
}

export function generateSingleElimFirstRound(playerIds: number[]): SingleElimFirstRound {
  const byes = playerIds.length % 2 === 1 ? [playerIds[0]] : [];
  const remainingPlayerIds = playerIds.slice(byes.length);
  const pairings: TournamentPairing[] = [];

  for (let i = 0; i < remainingPlayerIds.length / 2; i += 1) {
    pairings.push({
      playerOneId: remainingPlayerIds[i],
      playerTwoId: remainingPlayerIds[remainingPlayerIds.length - 1 - i],
      roundNumber: 1,
    });
  }

  return { byes, pairings };
}