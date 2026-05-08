export type CustomCardPoolParseResult = {
  cardIds: number[];
  errors: string[];
};

const cardIdSeparatorPattern = /[\s,]+/;
const cardIdPattern = /^\d+$/;

export function parseCustomCardIds(text: string): CustomCardPoolParseResult {
  const seen = new Set<number>();
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

    const cardId = Number(value);
    if (!seen.has(cardId)) {
      seen.add(cardId);
      cardIds.push(cardId);
    }
  }

  return { cardIds, errors };
}
