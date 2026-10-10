import { describe, expect, it } from "vitest";
import { OcgLocation, OcgPosition } from "ocgcore-wasm";
import { chainTargetPhrase, parseTargetCardNote, publicTargetLabel, TARGET_CARD_NOTE_PREFIX } from "../src/target-names.js";
import { isNegatedOnField as isNegatedMulti } from "../src/views.js";
import { isNegatedOnField as isNegatedLegacy } from "../src/legacy/views.js";

describe("target names", () => {
  it("parses a note and rejects malformed ones", () => {
    expect(parseTargetCardNote(`${TARGET_CARD_NOTE_PREFIX}2:4:1:70405001:1`)).toEqual({ controller: 2, location: 4, sequence: 1, code: 70405001, position: 1 });
    expect(parseTargetCardNote(`${TARGET_CARD_NOTE_PREFIX}2:4:1:70405001`)).toBeNull();
    expect(parseTargetCardNote(`${TARGET_CARD_NOTE_PREFIX}a:4:1:70405001:1`)).toBeNull();
    expect(parseTargetCardNote("YGD:CHAIN_TARGET:1;")).toBeNull();
  });

  it("names only what the table can see", () => {
    expect(publicTargetLabel({ location: OcgLocation.MZONE, position: OcgPosition.FACEUP_ATTACK, name: "Black Luster Soldier" })).toBe("Black Luster Soldier");
    expect(publicTargetLabel({ location: OcgLocation.SZONE, position: OcgPosition.FACEDOWN, name: "Mirror Force" })).toBe("a face-down card");
    expect(publicTargetLabel({ location: OcgLocation.MZONE, position: OcgPosition.FACEDOWN_DEFENSE, name: "Dark Magician" })).toBe("a face-down card");
    expect(publicTargetLabel({ location: OcgLocation.GRAVE, position: OcgPosition.FACEDOWN, name: "Monster Reborn" })).toBe("Monster Reborn");
    expect(publicTargetLabel({ location: OcgLocation.REMOVED, position: OcgPosition.FACEDOWN, name: "Secret" })).toBe("a face-down card");
    expect(publicTargetLabel({ location: OcgLocation.HAND, position: OcgPosition.FACEDOWN, name: "Secret" })).toBe("a card");
    expect(publicTargetLabel({ location: OcgLocation.MZONE, position: OcgPosition.FACEUP_ATTACK })).toBe("a card");
  });

  it("joins the targets into a phrase and falls back to the count", () => {
    expect(chainTargetPhrase(["A"], 1)).toBe("A");
    expect(chainTargetPhrase(["A", "B"], 2)).toBe("A and B");
    expect(chainTargetPhrase(["A", "a face-down card", "C"], 3)).toBe("A, a face-down card and C");
    expect(chainTargetPhrase([undefined], 1)).toBe("1 card");
    expect(chainTargetPhrase([undefined, undefined], 2)).toBe("2 cards");
    expect(chainTargetPhrase([], 0)).toBe("0 cards");
    expect(chainTargetPhrase(["A", undefined], 2)).toBe("A and a card");
  });
});

describe.each([["main views", isNegatedMulti], ["legacy views", isNegatedLegacy]])("negated flag (%s)", (_name, isNegated) => {
  const DISABLED = 0x0001;
  it("is set for a face-up monster or Spell/Trap with STATUS_DISABLED", () => {
    expect(isNegated(OcgLocation.MZONE, OcgPosition.FACEUP_ATTACK, DISABLED)).toBe(true);
    expect(isNegated(OcgLocation.MZONE, OcgPosition.FACEUP_DEFENSE, DISABLED | 0x400)).toBe(true);
    expect(isNegated(OcgLocation.SZONE, OcgPosition.FACEUP, DISABLED)).toBe(true);
  });
  it("is never set for a face-down card, a card off the field or a status without the bit", () => {
    expect(isNegated(OcgLocation.MZONE, OcgPosition.FACEDOWN_DEFENSE, DISABLED)).toBe(false);
    expect(isNegated(OcgLocation.SZONE, OcgPosition.FACEDOWN, DISABLED)).toBe(false);
    expect(isNegated(OcgLocation.GRAVE, OcgPosition.FACEUP, DISABLED)).toBe(false);
    expect(isNegated(OcgLocation.HAND, OcgPosition.FACEUP, DISABLED)).toBe(false);
    expect(isNegated(OcgLocation.MZONE, OcgPosition.FACEUP_ATTACK, 0)).toBe(false);
    expect(isNegated(OcgLocation.MZONE, OcgPosition.FACEUP_ATTACK, undefined)).toBe(false);
  });
});
