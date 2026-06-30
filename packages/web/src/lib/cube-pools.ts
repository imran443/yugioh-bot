import type { CardSummary } from "@/lib/card-types";

const EXTRA_FRAMES = new Set(["fusion", "synchro", "xyz", "link"]);

/** Client-side mirror of the shared isExtraDeckFrame — routes a card to main/extra. */
export function isExtraDeckCardClient(card: { frameType: string; type: string }): boolean {
  return (
    EXTRA_FRAMES.has(card.frameType.toLowerCase()) ||
    /(Fusion|Synchro|Xyz|XYZ|Link) Monster/.test(card.type)
  );
}

export type CubePoolName = "main" | "extra";

export interface CubeCardDto {
  catalogCardId: number;
  pool: CubePoolName;
  maxCopies: number;
  source?: string;
}

export interface CubePoolsDto {
  main: CubeCardDto[];
  extra: CubeCardDto[];
}

/** Build CardPoolGrid inputs for one pool: qty = maxCopies; ids without catalog data are unknown. */
export function poolToGridCards(
  pool: CubeCardDto[],
  cardsById: Map<number, CardSummary>,
): { cards: CardSummary[]; unknownIds: number[] } {
  const cards: CardSummary[] = [];
  const unknownIds: number[] = [];
  for (const entry of pool) {
    const card = cardsById.get(entry.catalogCardId);
    if (card) {
      cards.push({ ...card, qty: entry.maxCopies });
    } else {
      unknownIds.push(entry.catalogCardId);
    }
  }
  return { cards, unknownIds };
}
