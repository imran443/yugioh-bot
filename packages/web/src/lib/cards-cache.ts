import type { CardSummary } from "./card-types";

const cache = new Map<number, CardSummary>();

export function getCached(ids: number[]): { hits: CardSummary[]; missing: number[] } {
  const seen = new Set<number>();
  const hits: CardSummary[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = cache.get(id);
    if (card) hits.push(card);
    else missing.push(id);
  }
  return { hits, missing };
}

export function putCards(cards: CardSummary[]): void {
  for (const card of cards) cache.set(card.id, card);
}

export function clearCardsCache(): void {
  cache.clear();
}
