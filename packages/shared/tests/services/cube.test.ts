import { describe, expect, it } from "vitest";
import { mulberry32, seededShuffle, validateCube, buildDraftPacks } from "../../src/services/cube.js";

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

  it("validateCube rejects a cube with too few total cards", () => {
    // packSize 8, totalPacks 10 => slots 80
    const result = validateCube([1, 2, 3], 8, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/needs 80/);
  });

  it("validateCube rejects too few distinct card types", () => {
    // 8 distinct needed; only 2 distinct (lots of copies)
    const pool = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 1 : 2));
    const result = validateCube(pool, 8, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/distinct/i);
  });

  it("validateCube rejects a card with more copies than packs", () => {
    // totalPacks 4; card 1 has 5 copies (> 4); pad distinct + total
    const pool = [1, 1, 1, 1, 1, ...Array.from({ length: 27 }, (_, i) => i + 2)]; // 32 total, packSize 8 x 4 packs = 32
    const result = validateCube(pool, 8, 4);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 4 packs/);
  });

  it("validateCube accepts a sufficient cube", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    expect(validateCube(pool, 8, 10)).toEqual({ ok: true });
  });

  it("buildDraftPacks produces totalPacks packs of packSize distinct cards", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    const packs = buildDraftPacks(pool, 8, 10, 12345);
    expect(packs).toHaveLength(10);
    for (const pack of packs) {
      expect(pack).toHaveLength(8);
      expect(new Set(pack).size).toBe(8); // distinct within pack
    }
    expect(packs.flat()).toHaveLength(80);
  });

  it("buildDraftPacks spreads a heavily skewed cube without duplicates in a pack", () => {
    // 4 packs of 4 = 16 slots. Card 1 has 4 copies (== totalPacks, the max).
    // Remaining 12 distinct singles fill the rest.
    const pool = [1, 1, 1, 1, ...Array.from({ length: 12 }, (_, i) => i + 2)];
    const packs = buildDraftPacks(pool, 4, 4, 777);
    expect(packs).toHaveLength(4);
    for (const pack of packs) {
      expect(pack).toHaveLength(4);
      expect(new Set(pack).size).toBe(4);
    }
    // Card 1's 4 copies land in 4 different packs (one each).
    const packsWithCard1 = packs.filter((p) => p.includes(1)).length;
    expect(packsWithCard1).toBe(4);
  });

  it("buildDraftPacks is deterministic for a given draft id", () => {
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    expect(buildDraftPacks(pool, 8, 10, 555)).toEqual(buildDraftPacks(pool, 8, 10, 555));
  });

  it("buildDraftPacks only deals `slots` cards when the cube has extra", () => {
    // 100 distinct in the cube, but only 80 slots — 20 left unused.
    const pool = Array.from({ length: 100 }, (_, i) => i + 1);
    const packs = buildDraftPacks(pool, 8, 10, 1);
    expect(packs.flat()).toHaveLength(80);
  });
});
