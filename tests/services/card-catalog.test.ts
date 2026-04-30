import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
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

function setup(cardsBySet: Record<string, YgoprodeckCard[]>, cardsByName: Record<string, YgoprodeckCard[]> = {}) {
  const db = new Database(":memory:");
  migrate(db);

  const fetchCalls: string[] = [];
  const catalog = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      fetchCalls.push(url.toString());

      const setName = url.searchParams.get("cardset");
      const cardName = url.searchParams.get("name");
      const data = setName
        ? cardsBySet[setName] ?? []
        : cardName
          ? cardsByName[cardName] ?? []
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

describe("card catalog service", () => {
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
        type: "Spell Card",
        frameType: "spell",
        imageUrl: "https://img/full/raigeki",
        imageUrlSmall: "https://img/small/raigeki",
        cardSets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
      }),
      expect.objectContaining({
        ygoprodeckId: summonedSkull.id,
        name: "Summoned Skull",
        type: "Fiend / Normal Monster",
        frameType: "normal",
        imageUrl: "https://img/full/summoned-skull",
        imageUrlSmall: "https://img/small/summoned-skull",
        cardSets: [{ set_name: "Metal Raiders" }],
      }),
    ]);
    expect(app.db.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 2 });
  });

  it("updates cached cards when a sync sees the same id again", async () => {
    const updatedCard = {
      id: 46986414,
      name: "Dark Magician",
      type: "Spellcaster / Normal Monster",
      frameType: "normal",
      card_images: [{ image_url: "https://img/full/dm-v2", image_url_small: "https://img/small/dm-v2" }],
      card_sets: [{ set_name: "Metal Raiders" }, { set_name: "Starter Deck: Yugi" }],
    } satisfies YgoprodeckCard;

    const updatedApp = setup({ "Metal Raiders": [updatedCard] });
    updatedApp.db.prepare(
      `
        insert into card_catalog (
          ygoprodeck_id,
          name,
          type,
          frame_type,
          image_url,
          image_url_small,
          card_sets_json,
          cached_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      46986414,
      "Dark Magician",
      "Spellcaster / Normal Monster",
      "normal",
      "https://img/full/dm-v1",
      "https://img/small/dm-v1",
      JSON.stringify([{ set_name: "Metal Raiders" }]),
      "2026-01-01T00:00:00Z",
    );

    await updatedApp.catalog.syncDraftPool({
      setNames: ["Metal Raiders"],
      includeNames: [],
      excludeNames: [],
    });

    expect(updatedApp.fetchCalls).toEqual([
      "https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Metal+Raiders",
    ]);
    expect(updatedApp.catalog.findByIds([46986414])).toEqual([
      expect.objectContaining({
        ygoprodeckId: 46986414,
        imageUrl: "https://img/full/dm-v2",
        imageUrlSmall: "https://img/small/dm-v2",
        cardSets: [{ set_name: "Metal Raiders" }, { set_name: "Starter Deck: Yugi" }],
      }),
    ]);
    expect(updatedApp.db.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 1 });
  });

  it("lists all distinct set names from the catalog", async () => {
    const app = setup({
      "Metal Raiders": [
        {
          id: 1,
          name: "Summoned Skull",
          type: "Fiend / Normal Monster",
          frameType: "normal",
          card_images: [{ image_url: "https://img/full/1", image_url_small: "https://img/small/1" }],
          card_sets: [{ set_name: "Metal Raiders" }],
        },
      ],
      "Legend of Blue Eyes White Dragon": [
        {
          id: 2,
          name: "Blue-Eyes White Dragon",
          type: "Dragon / Normal Monster",
          frameType: "normal",
          card_images: [{ image_url: "https://img/full/2", image_url_small: "https://img/small/2" }],
          card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
        },
      ],
    });

    await app.catalog.syncDraftPool({ setNames: ["Metal Raiders", "Legend of Blue Eyes White Dragon"], includeNames: [], excludeNames: [] });

    const sets = app.catalog.listSets();

    expect(sets).toEqual(["Legend of Blue Eyes White Dragon", "Metal Raiders"]);
  });

  it("filters set names by query", async () => {
    const app = setup({
      "Metal Raiders": [
        {
          id: 1,
          name: "Summoned Skull",
          type: "Fiend / Normal Monster",
          frameType: "normal",
          card_images: [{ image_url: "https://img/full/1", image_url_small: "https://img/small/1" }],
          card_sets: [{ set_name: "Metal Raiders" }],
        },
      ],
      "Legend of Blue Eyes White Dragon": [
        {
          id: 2,
          name: "Blue-Eyes White Dragon",
          type: "Dragon / Normal Monster",
          frameType: "normal",
          card_images: [{ image_url: "https://img/full/2", image_url_small: "https://img/small/2" }],
          card_sets: [{ set_name: "Legend of Blue Eyes White Dragon" }],
        },
      ],
    });

    await app.catalog.syncDraftPool({ setNames: ["Metal Raiders", "Legend of Blue Eyes White Dragon"], includeNames: [], excludeNames: [] });

    expect(app.catalog.listSets("metal")).toEqual(["Metal Raiders"]);
    expect(app.catalog.listSets("Dragon")).toEqual(["Legend of Blue Eyes White Dragon"]);
    expect(app.catalog.listSets("xyz")).toEqual([]);
  });

  it("limits set results to 25", async () => {
    const cardsBySet: Record<string, YgoprodeckCard[]> = {};

    for (let i = 0; i < 30; i += 1) {
      cardsBySet[`Set ${i}`] = [
        {
          id: i + 1,
          name: `Card ${i}`,
          type: "Spell Card",
          frameType: "spell",
          card_images: [{ image_url: "https://img/full/1", image_url_small: "https://img/small/1" }],
          card_sets: [{ set_name: `Set ${i}` }],
        },
      ];
    }

    const app = setup(cardsBySet);

    await app.catalog.syncDraftPool({
      setNames: Object.keys(cardsBySet),
      includeNames: [],
      excludeNames: [],
    });

    expect(app.catalog.listSets()).toHaveLength(25);
  });
});
