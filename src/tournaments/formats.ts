export type TournamentPairing = {
  playerOneId: number;
  playerTwoId: number;
  roundNumber: number;
};

export type SingleElimFirstRound = {
  byes: number[];
  pairings: TournamentPairing[];
};

export function generateRoundRobin(playerIds: number[]): TournamentPairing[] {
  const pairings: TournamentPairing[] = [];

  for (let i = 0; i < playerIds.length; i += 1) {
    for (let j = i + 1; j < playerIds.length; j += 1) {
      pairings.push({
        playerOneId: playerIds[i],
        playerTwoId: playerIds[j],
        roundNumber: pairings.length + 1,
      });
    }
  }

  return pairings;
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
