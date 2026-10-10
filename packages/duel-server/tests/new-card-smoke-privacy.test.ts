import { expect, it } from "vitest";
import { hiddenSmokeViolations, SmokePrivacyEvidence } from "../scripts/lib/new-card-smoke-privacy.js";
import { OcgMessageType } from "ocgcore-wasm";
import type { NViews } from "./fuzz-n/invariants.js";

function views(zone: string, card: unknown): NViews {
  const seats = Array.from({ length: 3 }, () => ({ hand: [], monsters: [], spells: [], extra: [], banished: [], graveyard: [] }));
  Object.assign(seats[(card as { controller?: number } | null)?.controller ?? 0]!, { [zone]: [card] });
  const view = { seats, prompt: null, log: [], chain: [], events: [] };
  return { seats: [structuredClone(view), structuredClone(view), structuredClone(view)], spectator: structuredClone(view) } as unknown as NViews;
}
it.each(["extra", "banished", "hand", "monsters", "spells"])("rejects hidden card identity in %s for FFA viewers", zone => {
  const card = { code: 42, name: "Secret", position: 2, controller: 0, location: 32, sequence: 0 };
  expect(hiddenSmokeViolations(views(zone, card))).not.toEqual([]);
});
it("rejects hidden metadata even if the code is absent", () => {
  expect(hiddenSmokeViolations(views("banished", { name: "Secret", position: 2 }))).not.toEqual([]);
});
it("allows opaque hidden cards and public cards", () => {
  expect(hiddenSmokeViolations(views("extra", { position: 2, controller: 0, location: 64, sequence: 0 }))).toEqual([]);
  expect(hiddenSmokeViolations(views("banished", { code: 42, name: "Public", position: 1 }))).toEqual([]);
});
it("allows legal public-hand effects without allowing hidden Extra Deck metadata", () => {
  const publicViews = views("hand", { code: 42, name: "Revealed", position: 2 });
  for (const view of [...publicViews.seats, publicViews.spectator]) view.seats[0]!.monsters = [{ code: 20228463, position: 1 } as never];
  expect(hiddenSmokeViolations(publicViews)).toEqual([]);
  publicViews.spectator.seats[1]!.extra = [{ code: 43, name: "Secret", position: 2 } as never];
  expect(hiddenSmokeViolations(publicViews).some(v => v.includes("Extra Deck"))).toBe(true);
});
it.each(["confirm", "summon", "chain"])("does not let a %s reveal hide a second copy of the same code", kind => {
  const copies = views("hand", { code: 42, name: "Secret", position: 2, controller: 0, location: 2, sequence: 1, handId: "second" });
  for (const view of [...copies.seats, copies.spectator]) {
    view.events = [{ id: 1, kind: kind === "chain" ? "activate" : kind, card: { code: 42, name: "Secret" }, zone: { controller: 0, location: 2, sequence: 0 } } as never];
    view.chain = [{ code: 42, zone: { controller: 0, location: 2, sequence: 0 } } as never];
    view.log = [{ text: "Confirmed Secret" } as never];
  }
  expect(hiddenSmokeViolations(copies).length).toBeGreaterThan(0);
});
it("allows only the confirmed copy, invalidating its slot when a hand departure shifts another copy into it", () => {
  const v = views("hand", null);
  const evidence = new SmokePrivacyEvidence();
  const card = { code: 42, name: "Secret", position: 2, controller: 1, location: 2, sequence: 0, handId: "first" };
  for (const view of [...v.seats, v.spectator]) {
    view.seats = [
      { hand: [], monsters: [], spells: [], extra: [], banished: [], graveyard: [] },
      { hand: [card], monsters: [], spells: [], extra: [], banished: [], graveyard: [] },
      { hand: [], monsters: [], spells: [], extra: [], banished: [], graveyard: [] },
    ] as never;
    view.events = [{ id: 1, kind: "confirm", card: { code: 42 }, zone: { controller: 1, location: 2, sequence: 0 } } as never];
  }
  for (const player of [0, 2, -1]) evidence.observe({ type: OcgMessageType.CONFIRM_CARDS, player, cards: [{ ...card, code: 42 }] } as never);
  expect(hiddenSmokeViolations(v, evidence)).toEqual([]);
  for (const view of [...v.seats, v.spectator]) {
    view.seats[1]!.hand[0] = { ...card, handId: "second" };
    view.events.push({ id: 2, kind: "move", from: { controller: 1, location: 2, sequence: 0 }, zone: { controller: 1, location: 16, sequence: 0 } } as never);
  }
  evidence.observe({ type: OcgMessageType.MOVE, card: 42, from: card, to: { controller: 1, location: 16, sequence: 0 } } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
it.each([OcgMessageType.SHUFFLE_HAND, OcgMessageType.SHUFFLE_EXTRA, OcgMessageType.SHUFFLE_SET_CARD])("forgets a confirmed copy after core shuffle %s, even without a move event", type => {
  const location = type === OcgMessageType.SHUFFLE_HAND ? 2 : type === OcgMessageType.SHUFFLE_EXTRA ? 64 : 8;
  const zone = location === 2 ? "hand" : location === 64 ? "extra" : "spells";
  const card = { code: 42, name: "Secret", position: 2, controller: 0, location, sequence: 0, handId: "first" };
  const v = views(zone, card), evidence = new SmokePrivacyEvidence();
  for (const player of [0, 1, 2, -1]) evidence.observe({ type: OcgMessageType.CONFIRM_CARDS, player, cards: [card] } as never);
  expect(hiddenSmokeViolations(v, evidence)).toEqual([]);
  evidence.observe({ type, player: 0, location, cards: type === OcgMessageType.SHUFFLE_SET_CARD ? [{ from: card, to: card }] : [42] } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
it("allows only the live activating copy in a hidden hand", () => {
  const card = { code: 42, name: "Activating", position: 2, controller: 0, location: 2, sequence: 0 };
  const v = views("hand", card), evidence = new SmokePrivacyEvidence();
  evidence.observe({ type: OcgMessageType.CHAINING, chain_size: 1, ...card } as never);
  for (const view of [...v.seats, v.spectator]) view.chain = [{ code: 42, zone: card } as never];
  expect(hiddenSmokeViolations(v, evidence)).toEqual([]);
  for (const view of [...v.seats, v.spectator]) view.seats[0]!.hand.push({ ...card, sequence: 1 } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
it("follows a unique activating handler through a hand shuffle and forgets ambiguous copies", () => {
  const card = { code: 42, name: "Activating", position: 2, controller: 0, location: 2, sequence: 1 };
  const v = views("hand", card), evidence = new SmokePrivacyEvidence();
  evidence.observe({ type: OcgMessageType.CHAINING, chain_size: 1, ...card, sequence: 0 } as never);
  evidence.observe({ type: OcgMessageType.SHUFFLE_HAND, player: 0, cards: [43, 42] } as never);
  expect(hiddenSmokeViolations(v, evidence)).toEqual([]);
  evidence.observe({ type: OcgMessageType.SHUFFLE_HAND, player: 0, cards: [42, 42] } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
it("forgets an activating copy after a set-card shuffle swaps identical codes", () => {
  const card = { code: 42, name: "Activating", position: 2, controller: 0, location: 8, sequence: 0 };
  const v = views("spells", card), evidence = new SmokePrivacyEvidence();
  evidence.observe({ type: OcgMessageType.CHAINING, chain_size: 1, ...card } as never);
  evidence.observe({ type: OcgMessageType.SHUFFLE_SET_CARD, location: 8, cards: [{ from: card, to: { ...card, sequence: 1 } }, { from: { ...card, sequence: 1 }, to: card }] } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
it("removes confirmations using the original coordinates for multiple hand departures", () => {
  const card = { code: 42, name: "Unconfirmed replacement", position: 2, controller: 0, location: 2, sequence: 0 };
  const v = views("hand", card), evidence = new SmokePrivacyEvidence();
  for (const player of [1, 2, -1]) evidence.observe({ type: OcgMessageType.CONFIRM_CARDS, player, cards: [{ ...card, sequence: 1 }] } as never);
  expect(evidence.revealed(1, { ...card, sequence: 1 } as never)).toBe(true);
  evidence.observe({ type: OcgMessageType.REMOVE_CARDS, cards: [card, { ...card, sequence: 1 }] } as never);
  expect(hiddenSmokeViolations(v, evidence).length).toBeGreaterThan(0);
});
