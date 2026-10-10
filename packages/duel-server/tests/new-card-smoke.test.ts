import { describe, expect, it } from "vitest";
import type { DuelPrompt } from "@yugidraft/shared/duels";
import { smokeLocations, makeSmokeCases } from "../scripts/lib/new-card-smoke-board.js";
import { SmokeBot } from "../scripts/lib/new-card-smoke-bot.js";

describe("new card engine smoke setup and choices", () => {
  it("covers main monsters, Extra Deck monsters, field spells, traps, and pendulums", () => {
    expect(smokeLocations(0x21, "Banish this card from your GY" )).toEqual(["hand", "field", "grave", "banished", "deck"]);
    expect(smokeLocations(0x800021, "detach 1 material")).toEqual(["field", "grave", "banished", "extra"]);
    expect(smokeLocations(0x80002, "Field Spell")).toContain("field");
    expect(smokeLocations(0x4, "Trap")).toContain("set");
    expect(smokeLocations(0x1000021, "Pendulum Effect")).toContain("pendulum");
  });
  it("makes reproducible Standard and Domain cases and FFA cases on request", () => {
    const card = { code: 55144522, type: 2, description: "Draw 2 cards." };
    const cases = makeSmokeCases(card, { seed: 7, formats: ["1v1", "ffa3", "ffa4"] });
    expect(cases).toEqual(makeSmokeCases(card, { seed: 7, formats: ["1v1", "ffa3", "ffa4"] }));
    expect(new Set(cases.map(c => c.mode))).toEqual(new Set(["normal", "domain"]));
    expect(new Set(cases.map(c => c.format))).toEqual(new Set(["1v1", "ffa3", "ffa4"]));
    expect(cases.every(c => c.board.p0?.deck?.length)).toBe(true);
  });
  it("starts monster-as-spell effects and gives threshold effects five legal support spells", () => {
    expect(smokeLocations(8225, "While this card is treated as a Continuous Spell")).toContain("spell-zone");
    const cases = makeSmokeCases({ code: 101402095, type: 524290, description: 'The number of "Angelechy" Monster Cards in your Spell & Trap Zone.' },
      { spellCompanions: [1, 2, 3, 4, 5], extraCompanions: [6, 7] });
    const test = cases.find(c => c.location === "spell-support")!;
    expect(test.board.p0?.spells).toHaveLength(5);
    expect(test.board.p0?.field).toEqual({ card: 101402095, pos: "up" });
    expect(test.board.p0?.extra).toContain(6);
  });
  it("tries distinct effects before repeating one, including chains and yes/no triggers", () => {
    const bot = new SmokeBot(42);
    const prompt: DuelPrompt = { id: "p", seat: 0, kind: "choice", title: "Action", context: { type: "action", phase: "main" },
      options: [{ id: "activate:0", label: "first", card: { code: 42 } as never, effectText: "draw" },
        { id: "activate:1", label: "second", card: { code: 42 } as never, effectText: "destroy" }, { id: "to_ep", label: "End" }] };
    expect(bot.answer(prompt).choice).toBe("activate:0");
    expect(bot.answer(prompt).choice).toBe("activate:1");
    const chain = { ...prompt, context: { type: "chain", forced: false } as const, options: [{ ...prompt.options[0]!, id: "card:0", effectText: "banish" }] };
    expect(bot.answer(chain).choice).toBe("card:0");
    const yes: DuelPrompt = { ...prompt, source: { code: 42, name: "test", seat: 0, text: "effect" }, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
    expect(bot.answer(yes).choice).toBe("yes");
    expect(bot.offered.size).toBe(4);
  });
  it("tries both effects even when their displayed effect text is identical", () => {
    const bot = new SmokeBot(42);
    const prompt: DuelPrompt = { id: "p", seat: 0, kind: "choice", title: "Action", context: { type: "action", phase: "main" },
      options: [0, 1].map(i => ({ id: `activate:${i}`, label: "same", card: { code: 42 } as never, effectText: "same" })) };
    expect(bot.answer(prompt).choice).toBe("activate:0");
    expect(bot.answer(prompt).choice).toBe("activate:1");
  });
  it("covers card-bound operation modes without changing opponent or position choices", () => {
    const bot = new SmokeBot(42);
    const prompt: DuelPrompt = { id: "p", seat: 0, kind: "choice", title: "Select an effect", source: { code: 42, name: "Test", seat: 0, text: "effect" },
      options: [{ id: "opt:0", label: "Draw", effectText: "Draw" }, { id: "opt:1", label: "Damage", effectText: "Damage" }] };
    expect(bot.answer(prompt).choice).toBe("opt:0");
    expect(bot.answer(prompt).choice).toBe("opt:1");
    expect(bot.activated.size).toBe(0);
  });
  it("does not count a selection or an interrupted chain as a resolved effect", () => {
    const bot = new SmokeBot(42);
    const prompt: DuelPrompt = { id: "p", seat: 0, kind: "choice", title: "Action", context: { type: "action", phase: "main" },
      options: [{ id: "activate:0", label: "Draw", effectText: "Draw", card: { code: 42 } as never }] };
    bot.answer(prompt);
    expect(bot.activated.size).toBe(0);
    bot.resolved({ id: "effect", label: "Draw" }, false);
    expect(bot.activated.size).toBe(0);
    bot.resolved({ id: "effect", label: "Draw" }, true);
    expect(bot.activated.has("effect")).toBe(true);
  });
  it("counts a mandatory trigger without a selection when its chain resolves", () => {
    const bot = new SmokeBot(42);
    bot.resolved({ id: "forced", label: "Mandatory trigger" }, true);
    expect(bot.activated).toEqual(new Set(["forced"]));
  });
  it("does not run unrelated support combo effects", () => {
    const bot = new SmokeBot(42);
    const prompt: DuelPrompt = { id: "p", seat: 0, kind: "choice", title: "Action", context: { type: "action", phase: "main" },
      options: [{ id: "activate:0", label: "Support combo", card: { code: 22734799 } as never }, { id: "to_ep", label: "End" }] };
    expect(bot.answer(prompt).choice).toBe("to_ep");
  });
  it("keeps support cards for action windows or responses to a started chain", () => {
    const prompt: DuelPrompt = { id: "p", seat: 1, kind: "choice", title: "Chain", cancelable: true, min: 0, context: { type: "chain", forced: false },
      options: [{ id: "card:0", label: "MST", card: { code: 5318639 } as never }] };
    expect(new SmokeBot(42).answer(prompt, { chain: [] } as never).cancel).toBe(true);
    expect(new SmokeBot(42).answer(prompt, { chain: [{ code: 42 }] } as never).choice).toBe("card:0");
  });
  it("uses seeded opponent monster activations and aims removal at seat zero", () => {
    const prompt: DuelPrompt = { id: "p", seat: 1, kind: "choice", title: "Action", context: { type: "action", phase: "main" },
      options: [{ id: "activate:0", label: "Card Trooper", card: { code: 85087012 } as never }, { id: "to_ep", label: "End" }] };
    expect(new SmokeBot(42, 0).answer(prompt).choice).toBe("activate:0");
    expect(new SmokeBot(42, 1).answer(prompt).choice).toBe("to_ep");
    const targets: DuelPrompt = { id: "target", seat: 1, kind: "cards", title: "Destroy", min: 1, max: 1,
      source: { code: 5318639, name: "MST", seat: 1, text: "Destroy" }, options: [
        { id: "own", label: "Opponent spell", controller: 1 }, { id: "seat0", label: "Seat zero spell", controller: 0 },
        { id: "tested", label: "Tested card", controller: 0, card: { code: 42 } as never }] };
    expect(new SmokeBot(42, 0).answer(targets).selected).toEqual(["tested"]);
  });
});
