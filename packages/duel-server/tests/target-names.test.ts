import { beforeAll, describe, expect, it } from "vitest";
import { OcgLocation, OcgMessageType, OcgPosition, type OcgMessage } from "ocgcore-wasm";
import { chainTargetPhrase, parseTargetCardNote, publicTargetLabel, TARGET_CARD_NOTE_PREFIX } from "../src/target-names.js";
import { isNegatedOnField as isNegatedMulti } from "../src/views.js";
import { isNegatedOnField as isNegatedLegacy } from "../src/legacy/views.js";
import * as mainViews from "../src/views.js";
import * as legacyViews from "../src/legacy/views.js";
import { loadCardDatabase, type CardDatabase } from "../src/cards.js";
import { engineDataDirectory } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";

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

function targetTrackingTests<Context>(name: string, views: {
  createEventContext(): Context;
  noteTargetCardLog(ctx: Context, text: string): boolean;
  nameLinkTargets(ctx: Context, link: mainViews.StoredChainLink, cards: CardDatabase): boolean;
  observeChainTargetEvents(message: OcgMessage, chain: mainViews.StoredChainLink[], id: number, ctx?: Context, cards?: CardDatabase): mainViews.StoredDuelEvent[];
  linkTargetPhrase(link: mainViews.StoredChainLink): string;
  snapshotLinkTargets(link: mainViews.StoredChainLink): mainViews.StoredChainLink;
  targetEventText(link: mainViews.StoredChainLink): string;
  targetEventLabels(link: mainViews.StoredChainLink): string[];
}) {
  describeWithCores(`target tracking (${name})`, [needs.cards(engineDataDirectory)], () => {
    let cards: CardDatabase;
    beforeAll(() => { cards = loadCardDatabase(engineDataDirectory); });
    const grave = (sequence: number) => ({ controller: 0 as const, location: OcgLocation.GRAVE, sequence });
    const field = (sequence: number) => ({ controller: 0 as const, location: OcgLocation.MZONE, sequence });
    const link = (): mainViews.StoredChainLink => ({ index: 1, seat: 0, code: 83764718, zone: field(0), targets: [] });

    it("keeps each target's name through graveyard compaction, a move and a swap", () => {
      const ctx = views.createEventContext();
      const chain = [link()];
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:16:0:46986414:1`);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:16:1:89631139:1`);
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...grave(0), position: OcgPosition.FACEUP_ATTACK }, { ...grave(1), position: OcgPosition.FACEUP_ATTACK }] }, chain, 1, ctx, cards);
      views.nameLinkTargets(ctx, chain[0]!, cards);
      expect(views.linkTargetPhrase(chain[0]!)).toBe("Dark Magician and Blue-Eyes White Dragon");
      views.observeChainTargetEvents({ type: OcgMessageType.MOVE, card: 46986414, from: { ...grave(0), position: 1 }, to: { ...field(0), position: 1 } }, chain, 2, ctx, cards);
      expect(chain[0]!.targets).toEqual([field(0), grave(0)]);
      expect(views.linkTargetPhrase(chain[0]!)).toBe("Dark Magician and Blue-Eyes White Dragon");
      views.observeChainTargetEvents({ type: OcgMessageType.SWAP, card1: { ...field(0), code: 46986414, position: 1 }, card2: { ...grave(0), code: 89631139, position: 1 } }, chain, 3, ctx, cards);
      expect(views.linkTargetPhrase(chain[0]!)).toBe("Dark Magician and Blue-Eyes White Dragon");
    });

    it("still matches a late name to the original card after its coordinates change", () => {
      const ctx = views.createEventContext();
      const chain = [link()];
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...grave(1), position: OcgPosition.FACEUP_ATTACK }] }, chain, 1, ctx, cards);
      views.observeChainTargetEvents({ type: OcgMessageType.REMOVE_CARDS, cards: [{ ...grave(0), position: OcgPosition.FACEUP_ATTACK }] }, chain, 2, ctx, cards);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:16:1:89631139:1`);
      expect(views.nameLinkTargets(ctx, chain[0]!, cards)).toBe(true);
      expect(chain[0]!.targets).toEqual([grave(0)]);
      expect(views.linkTargetPhrase(chain[0]!)).toBe("Blue-Eyes White Dragon");
    });

    it("settles the original two-target announcement after both cards move and their hidden pile shuffles", () => {
      const ctx = views.createEventContext();
      const chain = [link()];
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...grave(0), position: OcgPosition.FACEUP_ATTACK }, { ...grave(1), position: OcgPosition.FACEUP_ATTACK }] }, chain, 1, ctx, cards);
      const announcement = views.snapshotLinkTargets(chain[0]!);
      const hand = { controller: 0 as const, location: OcgLocation.HAND, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE };
      views.observeChainTargetEvents({ type: OcgMessageType.MOVE, card: 46986414, from: { ...grave(0), position: 1 }, to: hand }, chain, 2, ctx, cards);
      views.observeChainTargetEvents({ type: OcgMessageType.MOVE, card: 89631139, from: { ...grave(0), position: 1 }, to: { ...hand, sequence: 1 } }, chain, 3, ctx, cards);
      views.observeChainTargetEvents({ type: OcgMessageType.SHUFFLE_HAND, player: 0, cards: [] }, chain, 4, ctx, cards);
      expect(chain[0]!.targets).toEqual([]);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:16:0:46986414:1`);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:16:1:89631139:1`);
      expect(views.nameLinkTargets(ctx, announcement, cards)).toBe(true);
      expect(announcement.targets).toEqual([grave(0), grave(1)]);
      expect(views.targetEventText(announcement)).toBe("Chain Link 1 targets Dark Magician and Blue-Eyes White Dragon");
      expect(views.targetEventLabels(announcement)).toEqual(["Dark Magician", "Blue-Eyes White Dragon"]);
    });

    it("settles cumulative announcements without adding later targets to the earlier wording", () => {
      const ctx = views.createEventContext();
      const chain = [link()];
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...field(0), position: OcgPosition.FACEUP_ATTACK }] }, chain, 1, ctx, cards);
      const first = views.snapshotLinkTargets(chain[0]!);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:4:0:46986414:1`);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:4:1:89631139:1`);
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...field(1), position: OcgPosition.FACEUP_ATTACK }] }, chain, 2, ctx, cards);
      expect(views.nameLinkTargets(ctx, first, cards)).toBe(true);
      expect(views.targetEventText(first)).toBe("Chain Link 1 targets Dark Magician");
      expect(views.targetEventText(chain[0]!)).toBe("Chain Link 1 targets Dark Magician and Blue-Eyes White Dragon");
    });

    it("keeps hidden targets anonymous in the structured announcement labels", () => {
      const ctx = views.createEventContext();
      const chain = [link()];
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:4:0:46986414:8`);
      views.noteTargetCardLog(ctx, `${TARGET_CARD_NOTE_PREFIX}0:2:0:89631139:8`);
      views.observeChainTargetEvents({ type: OcgMessageType.BECOME_TARGET, cards: [{ ...field(0), position: OcgPosition.FACEDOWN_DEFENSE }, { controller: 0, location: OcgLocation.HAND, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE }] }, chain, 1, ctx, cards);
      expect(views.targetEventLabels(views.snapshotLinkTargets(chain[0]!))).toEqual(["a face-down card", "a card"]);
    });
  });
}
targetTrackingTests("main", mainViews);
targetTrackingTests("legacy", legacyViews);

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
