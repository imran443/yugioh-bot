// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DuelCard } from "@yugidraft/shared/duels";
import { CardFace } from "@/components/duel/card-face";
import { cardExtraLines, NEGATED_LINE } from "@/components/duel/inspector";
import { logKind } from "@/components/duel/log-line";
import { categoryForLogText } from "@/components/duel/log-category";

afterEach(() => cleanup());

const MZONE = 4;
const FACEUP_ATTACK = 1;
const FACEDOWN_DEFENSE = 8;
const card = (extra: Partial<DuelCard> = {}): DuelCard => ({
  controller: 0, location: MZONE, sequence: 0, position: FACEUP_ATTACK, code: 65504487, name: "Toy Soldier", ...extra,
});

describe("negated card mark", () => {
  it("draws the mark, with its name, and flags the art of a face-up negated card", () => {
    const { container } = render(<CardFace card={card({ negated: true })} />);
    const mark = container.querySelector("[data-negation-mark]");
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveAttribute("aria-label", "Effects negated");
    expect(mark).toHaveAttribute("role", "img");
    expect(container.querySelector("[data-negated='true']")).toBeInTheDocument();
  });

  it("draws nothing for a card that is not negated", () => {
    const { container } = render(<CardFace card={card({ negated: false })} />);
    expect(container.querySelector("[data-negation-mark]")).toBeNull();
    expect(container.querySelector("[data-negated]")).toBeNull();
    cleanup();
    const other = render(<CardFace card={card()} />);
    expect(other.container.querySelector("[data-negation-mark]")).toBeNull();
  });

  it("never marks a face-down card, even if a flag arrived", () => {
    const { container } = render(<CardFace card={card({ position: FACEDOWN_DEFENSE, code: undefined, negated: true })} />);
    expect(container.querySelector("[data-negation-mark]")).toBeNull();
    expect(container.querySelector("[data-negated]")).toBeNull();
  });

  it("adds the inspector line first, and only for a negated card", () => {
    expect(cardExtraLines(card({ negated: true, counters: [{ type: 1, count: 2 }] }))).toEqual([NEGATED_LINE, "Counter 1: 2"]);
    expect(NEGATED_LINE).toBe("Effects negated");
    expect(cardExtraLines(card())).toEqual([]);
  });

  it("files the target lines of the log under the chain", () => {
    for (const text of ["Chain Link 2: Effect Veiler targets Black Luster Soldier - Soldier of Light and Darkness", "Chain Link 1: Mind Crush targets a face-down card", "Only legal target: Toy Soldier"]) {
      expect(categoryForLogText(text), text).toBe("chain");
      expect(logKind(text), text).toBe("chain");
    }
  });
});
