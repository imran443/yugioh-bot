export interface RankVisual {
  /** text + border base color */
  color: string;
  /** gem gradient top stop */
  gradientFrom: string;
  /** gem gradient bottom stop */
  gradientTo: string;
  /** idle-animation utility class, "" for the calm entry tier */
  idleClass: string;
  /** render the in-place twinkle sparkles (top tier only) */
  twinkle?: boolean;
}

export const RANK_VISUALS: Record<string, RankVisual> = {
  Diamond: { color: "#a78bfa", gradientFrom: "#c4b5fd", gradientTo: "#a78bfa", idleClass: "rank-idle-diamond", twinkle: true },
  Platinum: { color: "#7dd3fc", gradientFrom: "#bae6fd", gradientTo: "#7dd3fc", idleClass: "rank-idle-platinum" },
  Gold: { color: "#f5c451", gradientFrom: "#ffe9a8", gradientTo: "#f5c451", idleClass: "rank-idle-gold" },
  Silver: { color: "#cbd5e1", gradientFrom: "#f1f5f9", gradientTo: "#cbd5e1", idleClass: "rank-idle-silver" },
  Bronze: { color: "#d6a06a", gradientFrom: "#e8c39e", gradientTo: "#d6a06a", idleClass: "" },
};

export const FALLBACK_VISUAL: RankVisual = {
  color: "#9aa0b8",
  gradientFrom: "#c7ccda",
  gradientTo: "#9aa0b8",
  idleClass: "",
};

export function visualForRank(rank: string): RankVisual {
  return RANK_VISUALS[rank] ?? FALLBACK_VISUAL;
}
