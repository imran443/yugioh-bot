import { ELO_K } from "./constants.js";

export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

// actual: 1 for a win, 0 for a loss
export function nextRating(rating: number, opponent: number, actual: 0 | 1, k = ELO_K): number {
  return Math.round(rating + k * (actual - expectedScore(rating, opponent)));
}
