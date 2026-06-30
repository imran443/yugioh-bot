import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createCubeService } from "../../src/services/cubes.js";
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
  const cubes = createCubeService(db, emptyCatalog(db));
  seedCard(db, 1, "Main A", "Normal Monster", "normal");
  seedCard(db, 2, "Xyz B", "XYZ Monster", "xyz");
  return { db, cubes };
}

describe("cube service core", () => {
  it("creates a blank cube and adds/removes cards", () => {
    const { cubes } = setup();
    const cube = cubes.createBlank("g", "Stun", "u");
    cubes.addCard(cube.id, 1, "main");
    cubes.addCard(cube.id, 2, "extra", 1);
    let pools = cubes.getCubePools(cube.id);
    expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
    expect(pools.extra).toEqual([
      { catalogCardId: 2, pool: "extra", maxCopies: 1, source: undefined },
    ]);
    cubes.removeCard(cube.id, 1);
    pools = cubes.getCubePools(cube.id);
    expect(pools.main).toEqual([]);
  });

  it("setMaxCopies updates a card's copies", () => {
    const { cubes } = setup();
    const cube = cubes.createBlank("g", "Stun", "u");
    cubes.addCard(cube.id, 1, "main");
    cubes.setMaxCopies(cube.id, 1, 2);
    expect(cubes.getCubePools(cube.id).main[0].maxCopies).toBe(2);
  });

  it("lists cubes for a guild", () => {
    const { cubes } = setup();
    cubes.createBlank("g", "Stun", "u");
    cubes.createBlank("g", "Blue-Eyes", "u");
    expect(cubes.listCubes("g").map((t) => t.name).sort()).toEqual(["Blue-Eyes", "Stun"]);
  });

  it("renameCube renames and rejects a duplicate name", () => {
    const { cubes } = setup();
    const a = cubes.createBlank("g", "Stun", "u");
    cubes.createBlank("g", "Blue-Eyes", "u");
    expect(cubes.renameCube(a.id, "Goat Stun")).toEqual({ ok: true });
    expect(cubes.findCube(a.id).name).toBe("Goat Stun");
    expect(cubes.renameCube(a.id, "Blue-Eyes")).toEqual({ error: 'A cube named "Blue-Eyes" already exists' });
  });

  it("deleteCube removes the cube and its cards", () => {
    const { db, cubes } = setup();
    const cube = cubes.createBlank("g", "Stun", "u");
    cubes.addCard(cube.id, 1, "main");
    cubes.deleteCube(cube.id);
    expect(() => cubes.findCube(cube.id)).toThrow();
    const cards = db.prepare("select count(*) as c from cube_cards where cube_id = ?").get(cube.id) as { c: number };
    expect(cards.c).toBe(0);
  });

  it("seeds a cube from an archetype and tops up thin extra with generics", async () => {
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
    const cubes = createCubeService(db, catalog);
    const cube = await cubes.createFromArchetype("g", "Blue-Eyes", "u", { extraTarget: 2, topUpExtraWithGenerics: true });
    const pools = cubes.getCubePools(cube.id);
    expect(pools.main.map((c) => c.catalogCardId)).toContain(10);
    expect(pools.extra.map((c) => c.catalogCardId)).toEqual(expect.arrayContaining([11, 12]));
    expect(pools.extra.find((c) => c.catalogCardId === 12)?.source).toBe("generic-extra");
    expect(cube.archetype).toBe("Blue-Eyes");
  });

  it("imports passcodes, routing extra-deck cards to the extra pool", async () => {
    const { db, cubes } = setup(); // id 1 = normal, id 2 = xyz already in catalog
    const cube = cubes.createBlank("g", "Custom", "u");
    const res = await cubes.importPasscodes(cube.id, [1, 2]);
    expect(res.added).toBe(2);
    expect(res.unknown).toEqual([]);
    const pools = cubes.getCubePools(cube.id);
    expect(pools.main.map((c) => c.catalogCardId)).toEqual([1]);
    expect(pools.extra.map((c) => c.catalogCardId)).toEqual([2]);
    void db;
  });

  it("collapses repeated passcodes into max_copies (capped at 3)", async () => {
    const { cubes } = setup();
    const cube = cubes.createBlank("g", "Custom", "u");
    await cubes.importPasscodes(cube.id, [1, 1, 1, 1]);
    expect(cubes.getCubePools(cube.id).main[0].maxCopies).toBe(3);
  });

  it("reports unknown passcodes that cannot be synced", async () => {
    const { cubes } = setup(); // empty catalog: fetch returns []
    const cube = cubes.createBlank("g", "Custom", "u");
    const res = await cubes.importPasscodes(cube.id, [1, 9999999]);
    expect(res.added).toBe(1);
    expect(res.unknown).toEqual([9999999]);
  });

  it("seedArchetypeInto additively pulls an archetype into an existing cube", async () => {
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
    const cubes = createCubeService(db, catalog);
    const cube = cubes.createBlank("g", "Mixed", "u");
    const res = await cubes.seedArchetypeInto(cube.id, "Blue-Eyes");
    expect(res.added).toBe(1);
    expect(cubes.getCubePools(cube.id).main.map((c) => c.catalogCardId)).toEqual([10]);
  });

  it("flags a main-short cube as an error (burn off)", () => {
    const { cubes } = setup();
    const t = cubes.createBlank("g", "Tiny", "u");
    cubes.addCard(t.id, 1, "main", 3); // 3 main copies, far short of 42
    const a = cubes.analyzeCubePools(t.id, {
      themePackSize: 3,
      cardsPerPlayer: 40,
      extraDeckSize: 15,
      burnUnpicked: false,
      extraDeckEnabled: false,
    });
    expect(a.ok).toBe(false);
    expect(a.errors[0]).toMatch(/main/i);
  });

  it("passes a main-sufficient cube and skips extra when extra disabled", () => {
    const { db, cubes } = setup();
    const t = cubes.createBlank("g", "Big", "u");
    for (let i = 100; i < 142; i++) {
      seedCard(db, i, `C${i}`, "Normal Monster", "normal");
      cubes.addCard(t.id, i, "main", 1);
    }
    const a = cubes.analyzeCubePools(t.id, {
      themePackSize: 3,
      cardsPerPlayer: 40,
      extraDeckSize: 15,
      burnUnpicked: false,
      extraDeckEnabled: false,
    });
    expect(a.ok).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  it("warns (not errors) on a thin extra pool when extra enabled", () => {
    const { db, cubes } = setup();
    const t = cubes.createBlank("g", "Big", "u");
    for (let i = 100; i < 142; i++) {
      seedCard(db, i, `C${i}`, "Normal Monster", "normal");
      cubes.addCard(t.id, i, "main", 1);
    }
    const a = cubes.analyzeCubePools(t.id, {
      themePackSize: 3,
      cardsPerPlayer: 40,
      extraDeckSize: 15,
      burnUnpicked: false,
      extraDeckEnabled: true,
    });
    expect(a.ok).toBe(true); // warnings don't fail ok
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it("requires more cards under burnUnpicked (multiplied requirement)", () => {
    const { db, cubes } = setup();
    const t = cubes.createBlank("g", "Big", "u");
    for (let i = 100; i < 142; i++) {
      seedCard(db, i, `C${i}`, "Normal Monster", "normal");
      cubes.addCard(t.id, i, "main", 1);
    }
    const burnOn = cubes.analyzeCubePools(t.id, {
      themePackSize: 3,
      cardsPerPlayer: 40,
      extraDeckSize: 15,
      burnUnpicked: true,
      extraDeckEnabled: false,
    });
    expect(burnOn.ok).toBe(false);
  });
});

describe("cube service Discord-template-compatible ops", () => {
  it("save round-trips the draft config, findByName/list read it back", () => {
    const { cubes } = setup();
    const config = { setNames: ["Metal Raiders"], packsPerPlayer: 5, packSize: 8 };
    const saved = cubes.save("g", "My Booster", config, "u");
    expect(saved.name).toBe("My Booster");
    expect(saved.config).toEqual(config);

    const found = cubes.findByName("g", "My Booster");
    expect(found?.config).toEqual(config);
    expect(cubes.list("g").map((c) => c.name)).toContain("My Booster");
  });

  it("save upserts on (guild, name) conflict", () => {
    const { cubes } = setup();
    cubes.save("g", "T", { packsPerPlayer: 3 }, "u");
    cubes.save("g", "T", { packsPerPlayer: 7 }, "u");
    expect(cubes.findByName("g", "T")?.config.packsPerPlayer).toBe(7);
    expect(cubes.list("g").filter((c) => c.name === "T")).toHaveLength(1);
  });

  it("delete removes a template cube by name", () => {
    const { cubes } = setup();
    cubes.save("g", "T", {}, "u");
    cubes.delete("g", "T");
    expect(cubes.findByName("g", "T")).toBeUndefined();
  });
});
