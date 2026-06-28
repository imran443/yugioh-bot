import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createThemesService } from "../../src/services/themes.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";

function emptyCatalog(db: Database.Database) {
  return createCardCatalogService(db, {
    fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response,
  });
}

function seedCard(
  db: Database.Database,
  id: number,
  name: string,
  type: string,
  frameType: string,
) {
  db.prepare(
    `insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
     values (?,?,?,?,?,?,?,?)`,
  ).run(id, name, type, frameType, "i", "i", "[]", "t");
}

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const themes = createThemesService(db, emptyCatalog(db));
  seedCard(db, 1, "Main A", "Normal Monster", "normal");
  seedCard(db, 2, "Xyz B", "XYZ Monster", "xyz");
  return { db, themes };
}

describe("themes service core", () => {
  it("creates a blank theme and adds/removes cards", () => {
    const { themes } = setup();
    const theme = themes.createBlank("g", "Stun", "u");
    themes.addCard(theme.id, 1, "main");
    themes.addCard(theme.id, 2, "extra", 1);
    let pools = themes.getThemePools(theme.id);
    expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
    expect(pools.extra).toEqual([
      { catalogCardId: 2, pool: "extra", maxCopies: 1, source: undefined },
    ]);
    themes.removeCard(theme.id, 1);
    pools = themes.getThemePools(theme.id);
    expect(pools.main).toEqual([]);
  });

  it("setMaxCopies updates a card's copies", () => {
    const { themes } = setup();
    const theme = themes.createBlank("g", "Stun", "u");
    themes.addCard(theme.id, 1, "main");
    themes.setMaxCopies(theme.id, 1, 2);
    expect(themes.getThemePools(theme.id).main[0].maxCopies).toBe(2);
  });

  it("lists themes for a guild", () => {
    const { themes } = setup();
    themes.createBlank("g", "Stun", "u");
    themes.createBlank("g", "Blue-Eyes", "u");
    expect(themes.listThemes("g").map((t) => t.name).sort()).toEqual(["Blue-Eyes", "Stun"]);
  });

  it("seeds a theme from an archetype and tops up thin extra with generics", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const archMain = { id: 10, name: "BEWD", type: "Normal Monster", frameType: "normal", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
    const archExtra = { id: 11, name: "BE Twin", type: "Fusion Monster", frameType: "fusion", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
    const genXyz = { id: 12, name: "Utopia", type: "XYZ Monster", frameType: "xyz", card_images: [{ image_url: "i", image_url_small: "i" }] };
    const catalog = createCardCatalogService(db, {
      fetch: async (input) => {
        const u = new URL(String(input));
        const a = u.searchParams.get("archetype");
        const ty = u.searchParams.get("type");
        const data = a === "Blue-Eyes" ? [archMain, archExtra] : ty === "XYZ Monster" ? [genXyz] : [];
        return { ok: true, async json() { return { data }; } } as Response;
      },
    });
    const themes = createThemesService(db, catalog);
    const theme = await themes.createFromArchetype("g", "Blue-Eyes", "u", { extraTarget: 2, topUpExtraWithGenerics: true });
    const pools = themes.getThemePools(theme.id);
    expect(pools.main.map((c) => c.catalogCardId)).toContain(10);
    expect(pools.extra.map((c) => c.catalogCardId)).toEqual(expect.arrayContaining([11, 12]));
    expect(pools.extra.find((c) => c.catalogCardId === 12)?.source).toBe("generic-extra");
    expect(theme.archetype).toBe("Blue-Eyes");
  });

  it("imports passcodes, routing extra-deck cards to the extra pool", async () => {
    const { db, themes } = setup(); // id 1 = normal, id 2 = xyz already in catalog
    const theme = themes.createBlank("g", "Custom", "u");
    const res = await themes.importPasscodes(theme.id, [1, 2]);
    expect(res.added).toBe(2);
    expect(res.unknown).toEqual([]);
    const pools = themes.getThemePools(theme.id);
    expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
    expect(pools.extra.map((c) => c.catalogCardId)).toEqual([2]);
    void db;
  });

  it("collapses repeated passcodes into max_copies (capped at 3)", async () => {
    const { themes } = setup();
    const theme = themes.createBlank("g", "Custom", "u");
    await themes.importPasscodes(theme.id, [1, 1, 1, 1]);
    expect(themes.getThemePools(theme.id).main[0].maxCopies).toBe(3);
  });

  it("reports unknown passcodes that cannot be synced", async () => {
    const { themes } = setup(); // empty catalog: fetch returns []
    const theme = themes.createBlank("g", "Custom", "u");
    const res = await themes.importPasscodes(theme.id, [1, 9999999]);
    expect(res.added).toBe(1);
    expect(res.unknown).toEqual([9999999]);
  });

  it("seedArchetypeInto additively pulls an archetype into an existing theme", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const archMain = { id: 10, name: "BEWD", type: "Normal Monster", frameType: "normal", archetype: "Blue-Eyes", card_images: [{ image_url: "i", image_url_small: "i" }] };
    const catalog = createCardCatalogService(db, {
      fetch: async (input) => {
        const u = new URL(String(input));
        const data = u.searchParams.get("archetype") === "Blue-Eyes" ? [archMain] : [];
        return { ok: true, async json() { return { data }; } } as Response;
      },
    });
    const themes = createThemesService(db, catalog);
    const theme = themes.createBlank("g", "Mixed", "u");
    const res = await themes.seedArchetypeInto(theme.id, "Blue-Eyes");
    expect(res.added).toBe(1);
    expect(themes.getThemePools(theme.id).main.map((c) => c.catalogCardId)).toEqual([10]);
  });
});
