import { RANK_THRESHOLDS } from "./constants.js";

export type Rank = { name: string; min: number; nextAt: number | null };

// thresholds are highest-first; ascending copy for nextAt lookup
const ascending = [...RANK_THRESHOLDS].sort((a, b) => a.min - b.min);

export function rankForRating(rating: number): Rank {
  const tier = RANK_THRESHOLDS.find((t) => rating >= t.min) ?? RANK_THRESHOLDS[RANK_THRESHOLDS.length - 1];
  const idx = ascending.findIndex((t) => t.name === tier.name);
  const next = ascending[idx + 1];
  return { name: tier.name, min: tier.min, nextAt: next ? next.min : null };
}
