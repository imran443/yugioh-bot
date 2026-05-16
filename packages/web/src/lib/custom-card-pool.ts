export type CustomCardPoolParseResult = {
  cardIds: number[];
  errors: string[];
};

const cardIdSeparatorPattern = /[\s,]+/;
const cardIdPattern = /^\d+$/;

/**
 * Parse passcodes. Repeats are PRESERVED in order — a passcode pasted N times
 * means N physical copies. Invalid tokens are collected, valid ones kept.
 */
export function parseCustomCardIds(text: string): CustomCardPoolParseResult {
  const cardIds: number[] = [];
  const errors: string[] = [];

  for (const token of text.split(cardIdSeparatorPattern)) {
    const value = token.trim();
    if (!value) {
      continue;
    }

    if (!cardIdPattern.test(value)) {
      errors.push(value);
      continue;
    }

    cardIds.push(Number(value));
  }

  return { cardIds, errors };
}

/** Single place card multiplicities are derived from an id list. */
export function toCardCounts(ids: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}
