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
});
