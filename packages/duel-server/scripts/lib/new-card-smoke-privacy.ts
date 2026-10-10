import type { DuelCard, DuelZoneRef } from "@yugidraft/shared/duels";
import { OcgMessageType, type OcgMessage } from "ocgcore-wasm";
import { publicHandEffectOnField, type NViews } from "../../tests/fuzz-n/invariants.js";

const OPAQUE_KEYS = new Set(["controller", "location", "sequence", "position", "handId"]);
const slot = (zone: DuelZoneRef) => `${zone.controller}:${zone.location}:${zone.sequence}`;

/** Confirmations identify a copy at its live coordinates, until it moves or its zone shuffles. */
export class SmokePrivacyEvidence {
  private readonly confirmations = new Map<number, Map<string, number>>();
  private readonly activating = new Map<number, { code: number; zone: DuelZoneRef }>();
  observe(message: OcgMessage): void {
    const clear = (controller: number, location: number) => {
      for (const revealed of this.confirmations.values()) for (const key of revealed.keys()) {
        if (key.startsWith(`${controller}:${location}:`)) revealed.delete(key);
      }
    };
    if (message.type === OcgMessageType.CHAINING) {
      this.activating.set(message.chain_size, { code: message.code, zone: { controller: message.controller, location: message.location, sequence: message.sequence } });
    } else if (message.type === OcgMessageType.CHAIN_END) {
      this.activating.clear();
    } else if (message.type === OcgMessageType.CONFIRM_CARDS) {
      let revealed = this.confirmations.get(message.player);
      if (!revealed) this.confirmations.set(message.player, revealed = new Map());
      for (const card of message.cards) revealed.set(slot(card), card.code);
    } else if (message.type === OcgMessageType.SHUFFLE_HAND || message.type === OcgMessageType.SHUFFLE_EXTRA) {
      const location = message.type === OcgMessageType.SHUFFLE_HAND ? 2 : 64;
      clear(message.player, location);
      for (const [index, active] of this.activating) if (active.zone.controller === message.player && active.zone.location === location) {
        // A unique public handler can be followed through the core's permutation. Duplicate
        // codes make the copy ambiguous, so no hidden copy inherits that activation's exemption.
        const positions = message.cards.flatMap((code, sequence) => (code & 0x7fffffff) === active.code ? [sequence] : []);
        if (positions.length === 1) active.zone = { ...active.zone, sequence: positions[0]! };
        else this.activating.delete(index);
      }
    } else if (message.type === OcgMessageType.SHUFFLE_SET_CARD) {
      for (const card of message.cards) clear(card.from.controller, card.from.location);
      for (const [index, active] of this.activating) if (message.cards.some(card => slot(card.from) === slot(active.zone))) this.activating.delete(index);
    } else if (message.type === OcgMessageType.MOVE || message.type === OcgMessageType.REMOVE_CARDS) {
      const moves = message.type === OcgMessageType.MOVE ? [{ from: message.from, to: message.to }] : [...message.cards]
        .sort((a, b) => a.controller - b.controller || a.location - b.location || b.sequence - a.sequence)
        .map(from => ({ from, to: { ...from, location: 0 } }));
      for (const { from, to } of moves) {
        const shift = (zone: DuelZoneRef) => {
          let sequence = zone.sequence;
          if (from.location === 2 && zone.controller === from.controller && zone.location === 2 && sequence > from.sequence) sequence--;
          if (to.location === 2 && zone.controller === to.controller && zone.location === 2 && sequence >= to.sequence) sequence++;
          return { ...zone, sequence };
        };
        for (const revealed of this.confirmations.values()) {
          const remaining = [...revealed].filter(([key]) => key !== slot(from));
          revealed.clear();
          for (const [key, code] of remaining) {
            const [controller, location, sequence] = key.split(":").map(Number);
            revealed.set(slot(shift({ controller: controller!, location: location!, sequence: sequence! })), code);
          }
        }
        for (const [index, active] of this.activating) {
          if (slot(active.zone) === slot(from)) this.activating.delete(index);
          else active.zone = shift(active.zone);
        }
      }
    }
  }
  revealed(viewer: number, card: DuelCard): boolean {
    return card.code != null && (this.confirmations.get(viewer)?.get(slot(card)) === card.code
      || [...this.activating.values()].some(active => active.code === card.code && slot(active.zone) === slot(card)));
  }
}
/** Structural checks for every seat and the spectator, including face-down Extra Deck and banished cards. */
export function hiddenSmokeViolations(views: NViews, evidence = new SmokePrivacyEvidence()): string[] {
  const failures: string[] = [];
  for (const [viewer, view] of [...views.seats, views.spectator].entries()) {
    const spectator = viewer === views.seats.length;
    const publicHand = publicHandEffectOnField(view);
    const hands = new Map<string, number>();
    for (const event of view.events) {
      if (event.kind === "move") {
        // Hand indices shift on arrivals/departures; immutable hand IDs remain per-copy evidence.
        for (const zone of [event.from, event.zone]) if (zone?.location === 2) {
          if (event.handShuffled) for (const key of hands.keys()) if (key.startsWith(`${zone.controller}:`)) hands.delete(key);
        }
        if (event.zone?.location === 2 && event.card && event.handId && !event.handShuffled) hands.set(`${event.zone.controller}:${event.handId}`, event.card.code);
      }
    }
    view.seats.forEach((seat, owner) => {
      if (!spectator && owner === viewer) return;
      const check = (card: DuelCard | null, zone: string) => {
        if (!card || !(card.position & 0xa)) return;
        if (zone === "hand" && publicHand) return;
        if (evidence.revealed(spectator ? -1 : viewer, card)) return;
        if (zone === "hand" && card.code && card.handId && hands.get(`${owner}:${card.handId}`) === card.code) return;
        const identity = Object.keys(card).filter(key => !OPAQUE_KEYS.has(key));
        if (identity.length) failures.push(`privacy structure: viewer ${spectator ? "spectator" : viewer} sees ${zone} metadata of seat ${owner} (${identity.join(", ")})`);
      };
      seat.hand.forEach(c => check(c, "hand")); seat.monsters.forEach(c => check(c, "monster"));
      seat.spells.forEach(c => check(c, "spell/trap")); seat.extra.forEach(c => check(c, "Extra Deck")); seat.banished.forEach(c => check(c, "banished"));
    });
  }
  return failures;
}
