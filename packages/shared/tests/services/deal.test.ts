import { describe, expect, it } from "vitest";
import { mulberry32, seededShuffle, analyzeCube, buildDeal } from "../../src/services/deal.js";

describe("cube engine", () => {
  it("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA[0]).toBeGreaterThanOrEqual(0);
    expect(seqA[0]).toBeLessThan(1);
  });

  it("seededShuffle is deterministic and a permutation", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = seededShuffle(input, 99);
    const s2 = seededShuffle(input, 99);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input not mutated
  });

  it("analyzeCube errors when distinct < players × packSize", () => {
    // 3 players × 8 packSize => need 24 distinct; provide 10
    const cube = Array.from({ length: 10 }, (_, i) => i + 1);
    const r = analyzeCube(cube, 3, 5, 8);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/at least 24 distinct/);
  });

  it("analyzeCube accepts when distinct == players × packSize (boundary)", () => {
    const cube = Array.from({ length: 24 }, (_, i) => i + 1);
    const r = analyzeCube(cube, 3, 5, 8);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("analyzeCube warns (not errors) when a card has more copies than waves", () => {
    // 2 players × 4 packSize => 8 distinct needed; card 1 has 6 copies, waves = 3
    const cube = [1, 1, 1, 1, 1, 1, ...Array.from({ length: 7 }, (_, i) => i + 2)];
    const r = analyzeCube(cube, 2, 3, 4);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/card 1/i);
    expect(r.warnings.join(" ")).toMatch(/capped at 3/);
  });

  // pack at flat index i is in wave floor(i / players)
  function wavesOf(packs: number[][], players: number): number[][] {
    const waves: number[][] = [];
    packs.forEach((pack, i) => {
      const w = Math.floor(i / players);
      (waves[w] ??= []).push(...pack);
    });
    return waves;
  }

  it("buildDeal: every pack has packSize distinct cards, total = S", () => {
    const cube = Array.from({ length: 80 }, (_, i) => i + 1);
    const packs = buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 12345 });
    expect(packs).toHaveLength(10); // P*W
    for (const pack of packs) {
      expect(pack).toHaveLength(8);
      expect(new Set(pack).size).toBe(8);
    }
    expect(packs.flat()).toHaveLength(80); // S = 2*5*8
  });

  it("buildDeal: no card appears more than once within a wave", () => {
    const cube = Array.from({ length: 80 }, (_, i) => i + 1);
    const packs = buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 999 });
    for (const wave of wavesOf(packs, 2)) {
      expect(new Set(wave).size).toBe(wave.length);
    }
  });

  it("buildDeal: draft-34 regression — 7×4×13 has zero within-wave duplicates", () => {
    const cube = Array.from({ length: 239 }, (_, i) => i + 1); // 239 distinct, 1 copy each
    const packs = buildDeal(cube, { players: 7, waves: 4, packSize: 13, draftId: 34 });
    expect(packs).toHaveLength(28);
    expect(packs.flat()).toHaveLength(364); // S
    for (const wave of wavesOf(packs, 7)) {
      expect(wave).toHaveLength(91); // C = 7*13
      expect(new Set(wave).size).toBe(91); // all distinct in the wave
    }
  });

  it("buildDeal: a card's copies land in distinct waves, capped at waves", () => {
    // card 1 authored 10x but only 3 waves => at most 3 copies, in 3 distinct waves
    const cube = [...Array(10).fill(1), ...Array.from({ length: 30 }, (_, i) => i + 2)];
    const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 5 });
    const waves = wavesOf(packs, 2);
    const wavesWithCard1 = waves.filter((w) => w.includes(1)).length;
    const copiesOfCard1 = packs.flat().filter((c) => c === 1).length;
    expect(copiesOfCard1).toBeLessThanOrEqual(3);
    expect(copiesOfCard1).toBe(wavesWithCard1); // one per wave it appears in
  });

  it("buildDeal: pads a too-small cube by reusing cards across waves", () => {
    // 24 distinct, S = 2*3*4 = 24 ... make it smaller: 12 distinct, S = 24 => must pad
    const cube = Array.from({ length: 12 }, (_, i) => i + 1);
    const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 7 });
    expect(packs.flat()).toHaveLength(24);
    for (const wave of wavesOf(packs, 2)) {
      expect(new Set(wave).size).toBe(8); // C = 8, still all distinct in-wave
    }
  });

  it("buildDeal: weight-proportional — heavier authored card gets >= copies", () => {
    // card 1 authored 3x, others 1x; cube larger than S so trimming happens
    const cube = [1, 1, 1, ...Array.from({ length: 40 }, (_, i) => i + 2)];
    const packs = buildDeal(cube, { players: 2, waves: 3, packSize: 4, draftId: 11 });
    const flat = packs.flat();
    const c1 = flat.filter((c) => c === 1).length;
    // a singleton that survived, for comparison
    const survivor = [...new Set(flat)].find((id) => id !== 1)!;
    const cs = flat.filter((c) => c === survivor).length;
    expect(c1).toBeGreaterThanOrEqual(cs);
  });

  it("buildDeal is deterministic for a given draftId", () => {
    const cube = Array.from({ length: 80 }, (_, i) => i + 1);
    expect(buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 555 }))
      .toEqual(buildDeal(cube, { players: 2, waves: 5, packSize: 8, draftId: 555 }));
  });
});
