import { nextRating } from "./elo.js";
import { matchWinPoints } from "./winnings.js";

export type MatchProjection = {
  winWinnings: number;
  winRating: number; // positive delta
  loseWinnings: 0;
  loseRating: number; // negative delta
};

export function projectMatch(opts: {
  myElo: number;
  oppElo: number;
  seasonMultiplier: number;
}): MatchProjection {
  return {
    winWinnings: matchWinPoints(opts),
    winRating: nextRating(opts.myElo, opts.oppElo, 1) - opts.myElo,
    loseWinnings: 0,
    loseRating: nextRating(opts.myElo, opts.oppElo, 0) - opts.myElo,
  };
}
