export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = items.slice();
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface CubeValidationResult {
  ok: boolean;
  error?: string;
}

export function validateCube(
  poolCardIds: number[],
  packSize: number,
  totalPacks: number,
): CubeValidationResult {
  const slots = packSize * totalPacks;

  if (poolCardIds.length < slots) {
    return {
      ok: false,
      error: `Cube too small: this draft needs ${slots} cards (${packSize} per pack × ${totalPacks} packs) but the cube only has ${poolCardIds.length}. Add ${slots - poolCardIds.length} more.`,
    };
  }

  const counts = new Map<number, number>();
  for (const id of poolCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  if (counts.size < packSize) {
    return {
      ok: false,
      error: `Not enough distinct cards: a pack holds ${packSize} different cards but the cube only has ${counts.size} distinct card type(s).`,
    };
  }

  for (const [cardId, count] of counts) {
    if (count > totalPacks) {
      return {
        ok: false,
        error: `Card ${cardId} has ${count} copies but only ${totalPacks} packs exist; a pack cannot hold duplicates. Reduce that card to at most ${totalPacks} copies.`,
      };
    }
  }

  return { ok: true };
}

export function buildDraftPacks(
  poolCardIds: number[],
  packSize: number,
  totalPacks: number,
  draftId: number,
): number[][] {
  const slots = packSize * totalPacks;

  const counts = new Map<number, number>();
  for (const id of poolCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const distinctIds = seededShuffle([...counts.keys()], draftId);

  const usage = new Map<number, number>();
  let assigned = 0;
  for (const id of distinctIds) {
    if (assigned >= slots) break;
    usage.set(id, 1);
    assigned += 1;
  }
  let progressed = true;
  while (assigned < slots && progressed) {
    progressed = false;
    for (const id of distinctIds) {
      if (assigned >= slots) break;
      const used = usage.get(id) ?? 0;
      if (used < (counts.get(id) ?? 0)) {
        usage.set(id, used + 1);
        assigned += 1;
        progressed = true;
      }
    }
  }

  const packs: number[][] = Array.from({ length: totalPacks }, () => []);
  let offset = 0;
  for (const cardId of distinctIds) {
    const used = usage.get(cardId) ?? 0;
    for (let c = 0; c < used; c += 1) {
      packs[(offset + c) % totalPacks].push(cardId);
    }
    offset = (offset + used) % totalPacks;
  }

  return packs;
}
