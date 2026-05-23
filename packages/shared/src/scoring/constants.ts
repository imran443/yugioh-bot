export const ELO_K = 32;
export const ELO_DEFAULT = 1000;

export const BASE_MATCH_WIN = 5;
export const PLACEMENT_BASE = { champion: 50, runnerUp: 30, top4: 15 } as const;

// opponentStrength clamp bounds
export const OPP_STRENGTH_MIN = 0.5;
export const OPP_STRENGTH_MAX = 2.0;

export const SEASON_MULTIPLIER_DEFAULT = 1;

// rank thresholds by minimum rating
export const RANK_THRESHOLDS = [
  { name: "Diamond", min: 1600 },
  { name: "Platinum", min: 1350 },
  { name: "Gold", min: 1100 },
  { name: "Silver", min: 900 },
  { name: "Bronze", min: 0 },
] as const;
