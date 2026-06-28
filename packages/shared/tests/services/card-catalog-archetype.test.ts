import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

type Mock = Record<string, any[]>;

function setup(cardsByArchetype: Mock = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const catalog = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const archetype = url.searchParams.get("archetype");
      const data = archetype ? cardsByArchetype[archetype] ?? [] : [];
      return { ok: true, async json() { return { data }; } } as Response;
    },
  });
  return { db, catalog };
}

const blueEyes = {
  id: 89631139,
  name: "Blue-Eyes White Dragon",
  type: "Normal Monster",
  frameType: "normal",
  archetype: "Blue-Eyes",
  card_images: [{ image_url: "i", image_url_small: "i" }],
};
const blueEyesTwin = {
  id: 23995346,
  name: "Blue-Eyes Twin Burst Dragon",
  type: "Fusion Monster",
  frameType: "fusion",
  archetype: "Blue-Eyes",
  card_images: [{ image_url: "i", image_url_small: "i" }],
};

describe("card-catalog archetype support", () => {
  it("splits archetype cards into main and extra, keeping extra-deck cards", async () => {
    const { catalog } = setup({ "Blue-Eyes": [blueEyes, blueEyesTwin] });
    const result = await catalog.syncByArchetype("Blue-Eyes");
    expect(result.main.map((c) => c.ygoprodeckId)).toEqual([89631139]);
    expect(result.extra.map((c) => c.ygoprodeckId)).toEqual([23995346]);
  });

  it("stores and returns the archetype on cached cards", async () => {
    const { catalog } = setup({ "Blue-Eyes": [blueEyes] });
    await catalog.syncByArchetype("Blue-Eyes");
    const [card] = catalog.findByIds([89631139]);
    expect(card.archetype).toBe("Blue-Eyes");
  });

  it("passes banlist to the API when provided", async () => {
    const calls: string[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const catalog = createCardCatalogService(db, {
      fetch: async (input) => {
        calls.push(String(input));
        return { ok: true, async json() { return { data: [blueEyes] }; } } as Response;
      },
    });
    await catalog.syncByArchetype("Blue-Eyes", { banlist: "tcg" });
    expect(calls[0]).toContain("archetype=Blue-Eyes");
    expect(calls[0]).toContain("banlist=tcg");
  });

  it("syncStaples pulls staple cards (main pool only)", async () => {
    const pot = {
      id: 55144522,
      name: "Pot of Greed",
      type: "Spell Card",
      frameType: "spell",
      card_images: [{ image_url: "i", image_url_small: "i" }],
    };
    const db = new Database(":memory:");
    migrate(db);
    const catalog = createCardCatalogService(db, {
      fetch: async (input) => {
        const u = new URL(String(input));
        return {
          ok: true,
          async json() { return { data: u.searchParams.get("staple") ? [pot] : [] }; },
        } as Response;
      },
    });
    const staples = await catalog.syncStaples();
    expect(staples.map((c) => c.ygoprodeckId)).toContain(55144522);
  });

  it("syncGenericExtra returns extra-deck cards, XYZ first by default", async () => {
    const xyz = {
      id: 84013237,
      name: "Number 39: Utopia",
      type: "XYZ Monster",
      frameType: "xyz",
      card_images: [{ image_url: "i", image_url_small: "i" }],
    };
    const db = new Database(":memory:");
    migrate(db);
    const catalog = createCardCatalogService(db, {
      fetch: async (input) => {
        const u = new URL(String(input));
        return {
          ok: true,
          async json() { return { data: u.searchParams.get("type") === "XYZ Monster" ? [xyz] : [] }; },
        } as Response;
      },
    });
    const generic = await catalog.syncGenericExtra();
    expect(generic.map((c) => c.ygoprodeckId)).toContain(84013237);
    expect(generic[0].ygoprodeckId).toBe(84013237); // XYZ ordered first
  });
});
