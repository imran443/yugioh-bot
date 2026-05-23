import { RANK_THRESHOLDS } from "@yugidraft/shared/scoring";

// ascending by rating: index 0 = lowest tier (Bronze) ... highest = Diamond
const ORDER: string[] = [...RANK_THRESHOLDS]
  .sort((a, b) => a.min - b.min)
  .map((t) => t.name);

export function rankIndex(rank: string): number {
  return ORDER.indexOf(rank);
}

export function didRankUp(prev: string | null, curr: string): boolean {
  if (prev === null) return false;
  const p = rankIndex(prev);
  const c = rankIndex(curr);
  if (p < 0 || c < 0) return false;
  return c > p;
}
