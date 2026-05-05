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

function setup(cardsBySet: Record<string, YgoprodeckCard[]> = {}, cardsByName: Record<string, YgoprodeckCard[]> = {}) {
  const db = new Database(":memory:");
  migrate(db);

  const fetchCalls: string[] = [];
  const catalog = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      fetchCalls.push(url.toString());

      const setName = url.searchParams.get("cardset");
      const cardName = url.searchParams.get("name");
      const data = setName ? cardsBySet[setName] ?? [] : cardName ? cardsByName[cardName] ?? [] : [];

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
});
