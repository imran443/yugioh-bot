import {
  BASE_MATCH_WIN,
  OPP_STRENGTH_MAX,
  OPP_STRENGTH_MIN,
  PLACEMENT_BASE,
} from "./constants.js";

export type Placement = keyof typeof PLACEMENT_BASE; // 'champion' | 'runnerUp' | 'top4'

export function opponentStrength(myElo: number, oppElo: number): number {
  const raw = 0.5 + (oppElo - myElo + 400) / 800;
  return Math.min(OPP_STRENGTH_MAX, Math.max(OPP_STRENGTH_MIN, raw));
}

export function sizeMultiplier(participants: number): number {
  if (participants >= 32) return 3;
  if (participants >= 16) return 2;
  if (participants >= 8) return 1.5;
  return 1;
}

export function matchWinPoints(opts: {
  myElo: number;
  oppElo: number;
  seasonMultiplier: number;
}): number {
  return Math.round(
    BASE_MATCH_WIN * opts.seasonMultiplier * opponentStrength(opts.myElo, opts.oppElo),
  );
}

export function placementPoints(placement: Placement, participants: number): number {
  return Math.round(PLACEMENT_BASE[placement] * sizeMultiplier(participants));
}
