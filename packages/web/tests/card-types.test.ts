import { describe, expect, it } from "vitest";
import {
  isMonster,
  isSpell,
  isTrap,
  isEffectMonster,
  isNormalMonster,
  getTypeLabel,
  tributeTierForLevel,
  type CardSummary,
} from "../src/lib/card-types";

const monster: CardSummary = {
  id: 1, name: "Bujingi Crane", type: "Winged Beast / Effect Monster",
  frameType: "effect", effectText: "...", imageUrl: "u", imageUrlSmall: "s",
};
const trap: CardSummary = {
  id: 2, name: "Mirror Force", type: "Trap Card", frameType: "trap",
  effectText: "...", imageUrl: "u", imageUrlSmall: "s",
};

describe("card-types", () => {
  it("classifies monsters, spells, traps", () => {
    expect(isMonster(monster.type)).toBe(true);
    expect(isTrap(trap.type)).toBe(true);
    expect(isSpell("Spell Card")).toBe(true);
    expect(isSpell(trap.type)).toBe(false);
  });
  it("classifies effect vs normal monsters", () => {
    expect(isEffectMonster(monster)).toBe(true);
    expect(isNormalMonster({ ...monster, type: "Dragon / Normal Monster", frameType: "normal" })).toBe(true);
  });
  it("labels card types", () => {
    expect(getTypeLabel(monster.type)).toBe("Monster");
    expect(getTypeLabel(trap.type)).toBe("Trap");
    expect(getTypeLabel("Spell Card")).toBe("Spell");
  });
  it("maps monster level to a tribute tier", () => {
    expect(tributeTierForLevel(undefined)).toBeNull();
    expect(tributeTierForLevel(null)).toBeNull();
    expect(tributeTierForLevel(1)).toBe("none");
    expect(tributeTierForLevel(4)).toBe("none");
    expect(tributeTierForLevel(5)).toBe("one");
    expect(tributeTierForLevel(6)).toBe("one");
    expect(tributeTierForLevel(7)).toBe("two");
    expect(tributeTierForLevel(12)).toBe("two");
  });
});
