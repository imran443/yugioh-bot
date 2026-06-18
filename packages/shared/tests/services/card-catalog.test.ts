import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

type YgoprodeckCard = {
  id: number;
  name: string;
  type: string;
  frameType: string;
  card_images: Array<{
    image_url: string;
    image_url_small: string;
  }>;
  card_sets?: Array<{
    set_name: string;
  }>;
};

function setup(
  cardsBySet: Record<string, YgoprodeckCard[]> = {},
  cardsByName: Record<string, YgoprodeckCard[]> = {},
  cardsById: Record<string, YgoprodeckCard[]> = {},
  cardsByFuzzyName: Record<string, YgoprodeckCard[]> = {},
) {
  const db = new Database(":memory:");
  migrate(db);

  const fetchCalls: string[] = [];
  const catalog = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      fetchCalls.push(url.toString());

      const setName = url.searchParams.get("cardset");
      const cardName = url.searchParams.get("name");
      const fuzzyName = url.searchParams.get("fname");
      const cardId = url.searchParams.get("id");
      const data = setName
        ? cardsBySet[setName] ?? []
        : cardName
          ? cardsByName[cardName] ?? []
          : fuzzyName
            ? cardsByFuzzyName[fuzzyName] ?? []
            : cardId
              ? cardsById[cardId] ?? []
              : [];

      return {
        ok: true,
        async json() {
          return { data };
        },
      } as Response;
    },
  });

  return { catalog, db, fetchCalls };
}

describe("shared card catalog service", () => {
  it("syncs selected sets plus explicit includes while filtering excluded and Extra Deck cards", async () => {
    const summonedSkull = {
      id: 70781052,
      name: "Summoned Skull",
      type: "Fiend / Normal Monster",
      frameType: "normal",
      card_images: [{ image_url: "https://img/full/summoned-skull", image_url_small: "https://img/small/summoned-skull" }],
      card_sets: [{ set_name: "Metal Raiders" }],
    } satisfies YgoprodeckCard;
    const timeWizard = {
      id: 71625222,
      name: "Time Wizard",
      type: "Spellcaster / Effect Monster",
      frameType: "effect",
      card_images: [{ image_url: "https://img/full/time-wizard", image_url_small: "https://img/small/time-wizard" }],
      card_sets: [{ set_name: "Metal Raiders" }],
    } satisfies YgoprodeckCard;
    const thousandDragon = {
      id: 11829830,
      name: "Thousand Dragon",
      type: "Dragon / Fusion Monster",
      frameType: "fusion",
      card_images: [{ image_url: "https://img/full/thousand-dragon", image_url_small: "https://img/small/thousand-dragon" }],
      card_sets: [{ set_name: "Metal Raiders" }],
    } satisfies YgoprodeckCard;
    const raigeki = {
      id: 12580477,
      name: "Raigeki",
      type: "Spell Card",
      frameType: "spell",
      card_images: [{ image_url: "https://img/full/raigeki", image_url_small: "https://img/small/raigeki" }],
      card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
    } satisfies YgoprodeckCard;

    const app = setup(
      {
        "Metal Raiders": [summonedSkull, timeWizard, thousandDragon],
      },
      {
        Raigeki: [raigeki],
      },
    );

    await app.catalog.syncDraftPool({
      setNames: ["Metal Raiders"],
      includeNames: ["Raigeki"],
      excludeNames: ["Time Wizard"],
    });

    expect(app.fetchCalls).toEqual([
      "https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Metal+Raiders",
      "https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Raigeki",
    ]);
    expect(app.catalog.findByIds([raigeki.id, summonedSkull.id, timeWizard.id, thousandDragon.id])).toEqual([
      expect.objectContaining({
        ygoprodeckId: raigeki.id,
        name: "Raigeki",
      }),
      expect.objectContaining({
        ygoprodeckId: summonedSkull.id,
        name: "Summoned Skull",
      }),
    ]);
    expect(app.db.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 2 });
  });

  it("syncs custom card ids into the local catalog", async () => {
    const summonedSkull = {
      id: 70781052,
      name: "Summoned Skull",
      type: "Fiend / Normal Monster",
      frameType: "normal",
      card_images: [{ image_url: "https://img/full/summoned-skull", image_url_small: "https://img/small/summoned-skull" }],
      card_sets: [{ set_name: "Metal Raiders" }],
    } satisfies YgoprodeckCard;
    const app = setup({}, {}, { "70781052": [summonedSkull] });

    await app.catalog.syncDraftPool({
      setNames: [],
      customCardIds: [70781052],
      includeNames: [],
      excludeNames: [],
    });

    expect(app.fetchCalls).toEqual(["https://db.ygoprodeck.com/api/v7/cardinfo.php?id=70781052"]);
    expect(app.catalog.findByIds([70781052])).toEqual([
      expect.objectContaining({
        ygoprodeckId: 70781052,
        name: "Summoned Skull",
      }),
    ]);
  });

  it("syncs one card by exact name into the local catalog", async () => {
    const monsterReborn = {
      id: 83764718,
      name: "Monster Reborn",
      type: "Spell Card",
      frameType: "spell",
      card_images: [{ image_url: "https://img/full/monster-reborn", image_url_small: "https://img/small/monster-reborn" }],
      card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
    } satisfies YgoprodeckCard;
    const app = setup({}, { "Monster Reborn": [monsterReborn] });

    const card = await app.catalog.syncCardByName("Monster Reborn");

    expect(app.fetchCalls).toEqual(["https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Monster+Reborn"]);
    expect(card).toEqual(expect.objectContaining({ ygoprodeckId: 83764718, name: "Monster Reborn" }));
    expect(app.catalog.findByIds([83764718])).toEqual([
      expect.objectContaining({ ygoprodeckId: 83764718, name: "Monster Reborn" }),
    ]);
  });

  it("returns undefined when exact-name sync finds no cards", async () => {
    const app = setup({}, { "Missing Card": [] });

    await expect(app.catalog.syncCardByName("Missing Card")).resolves.toBeUndefined();

    expect(app.fetchCalls).toEqual(["https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Missing+Card"]);
    expect(app.db.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 0 });
  });

  it("syncs multiple cards by fuzzy name into the local catalog", async () => {
    const blueEyesWhiteDragon = {
      id: 89631139,
      name: "Blue-Eyes White Dragon",
      type: "Dragon / Normal Monster",
      frameType: "normal",
      card_images: [{ image_url: "https://img/full/bewd", image_url_small: "https://img/small/bewd" }],
      card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
    } satisfies YgoprodeckCard;
    const blueEyesUltimateDragon = {
      id: 23995346,
      name: "Blue-Eyes Ultimate Dragon",
      type: "Dragon / Fusion Monster",
      frameType: "fusion",
      card_images: [{ image_url: "https://img/full/beud", image_url_small: "https://img/small/beud" }],
      card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
    } satisfies YgoprodeckCard;
    const app = setup({}, {}, {}, { "blue-eyes": [blueEyesWhiteDragon, blueEyesUltimateDragon] });

    const result = await app.catalog.syncCardsByFuzzyName("blue-eyes");

    expect(app.fetchCalls).toEqual(["https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=blue-eyes"]);
    expect(result.map((c) => c.name)).toEqual(["Blue-Eyes White Dragon"]);
    expect(app.catalog.findByIds([89631139, 23995346, 46986414]).map((c) => c.name)).toEqual(["Blue-Eyes White Dragon"]);
  });
});
