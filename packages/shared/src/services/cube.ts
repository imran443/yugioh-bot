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

export interface CubeAnalysis {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function analyzeCube(
  cubeCardIds: number[],
  players: number,
  waves: number,
  packSize: number,
): CubeAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cardsPerWave = players * packSize;

  const counts = new Map<number, number>();
  for (const id of cubeCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const distinct = counts.size;

  if (distinct < cardsPerWave) {
    const maxPackSize = Math.floor(distinct / players);
    errors.push(
      `Cube needs at least ${cardsPerWave} distinct cards for ${players} players × ${packSize} per pack, but has ${distinct}. ` +
        `Add ${cardsPerWave - distinct} more distinct cards, or reduce pack size to ${maxPackSize}.`,
    );
  }

  for (const [cardId, count] of counts) {
    if (count > waves) {
      warnings.push(
        `Card ${cardId} has ${count} copies but a draft has only ${waves} waves; it will be capped at ${waves} (one copy per wave).`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function buildDeal(
  cubeCardIds: number[],
  opts: { players: number; waves: number; packSize: number; draftId: number },
): number[][] {
  const { players, waves, packSize, draftId } = opts;
  const totalPacks = players * waves;
  const cardsPerWave = players * packSize; // C
  const slots = totalPacks * packSize; // S

  // 1. authored counts
  const counts = new Map<number, number>();
  for (const id of cubeCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  // deterministic order
  const distinctIds = seededShuffle([...counts.keys()], draftId);

  // 2. budgets: start at min(count, waves), then trim/pad to exactly `slots`
  const budget = new Map<number, number>();
  let total = 0;
  for (const id of distinctIds) {
    const b = Math.min(counts.get(id) ?? 0, waves);
    budget.set(id, b);
    total += b;
  }
  // trim: drop copies from the least-weighted cards first (singletons fall to zero)
  while (total > slots) {
    let pick: number | undefined;
    let pickB = Infinity;
    for (const id of distinctIds) {
      const b = budget.get(id) ?? 0;
      if (b > 0 && b < pickB) {
        pickB = b;
        pick = id;
      }
    }
    if (pick === undefined) break;
    budget.set(pick, pickB - 1);
    total -= 1;
  }
  // pad: round-robin +1 to cards with headroom (spreads invented copies)
  while (total < slots) {
    let addedThisPass = false;
    for (const id of distinctIds) {
      if (total >= slots) break;
      const b = budget.get(id) ?? 0;
      if (b < waves) {
        budget.set(id, b + 1);
        total += 1;
        addedThisPass = true;
      }
    }
    if (!addedThisPass) break; // unreachable when analyzeCube passed
  }

  // 3. assign each card's copies to distinct waves; balance wave fill (cap C each)
  const waveCards: number[][] = Array.from({ length: waves }, () => []);
  const waveRemaining = new Array<number>(waves).fill(cardsPerWave);
  // most-constrained-first: highest budget placed first
  const assignOrder = [...distinctIds].sort(
    (a, b) => (budget.get(b) ?? 0) - (budget.get(a) ?? 0),
  );
  for (const id of assignOrder) {
    const b = budget.get(id) ?? 0;
    if (b === 0) continue;
    // pick the b waves with the most remaining capacity
    const targets = Array.from({ length: waves }, (_, w) => w)
      .filter((w) => waveRemaining[w] > 0)
      .sort((x, y) => waveRemaining[y] - waveRemaining[x])
      .slice(0, b);
    for (const w of targets) {
      waveCards[w].push(id);
      waveRemaining[w] -= 1;
    }
  }

  // 4. within each wave, round-robin its C distinct cards into P packs of packSize
  const packs: number[][] = Array.from({ length: totalPacks }, () => []);
  for (let w = 0; w < waves; w += 1) {
    const shuffled = seededShuffle(waveCards[w], draftId + w + 1);
    shuffled.forEach((id, i) => {
      const seat = i % players;
      packs[w * players + seat].push(id);
    });
  }

  return packs;
}
